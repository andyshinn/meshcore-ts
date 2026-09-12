import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Transports } from '../../../src/index.js';
import { ADV_TYPE, CMD, PUSH, RESP } from '../../../src/protocol/codes';
import { frameBuf } from '../../support/frames';
import { deliver, makeSession } from '../../support/harness';

// The post-advert re-sync is gated on `shouldAutoAdd`, whose master switch is
// bit 0 of the radio's `_prefs.manual_add_contacts` (RESP_SELF_INFO byte 47) —
// NOT the app-side `AutoAddConfig.mode`, which the library never writes. Every
// frame here is a real inbound frame, so the whole mirror path is exercised.

const PK = 'dd'.repeat(32);
const PK2 = 'ee'.repeat(32);

// PUSH_NEW_ADVERT (0x8a): a full 148-byte contact record, pushed when the radio
// REFUSED to store the advertising node. Refused => not on radio => the
// `shouldAutoAdd` gate decides whether to walk CMD_GET_CONTACTS.
//
// `outPathLen` is the packed firmware path_len byte (bits 7-6 = hashSize-1,
// bits 5-0 = hop count); 0xff is flood/unknown. Pass a hop count to model an
// advert that reached us the long way round.
function refusedAdvert(pubkeyHex: string, advType: number, outPathLen = 0xff): Buffer {
  const frame = Buffer.alloc(148);
  frame[0] = PUSH.NEW_ADVERT;
  Buffer.from(pubkeyHex, 'hex').copy(frame, 1);
  frame[33] = advType;
  frame[35] = outPathLen;
  if (outPathLen !== 0xff) {
    // One hash byte per hop, matching hashSize 1 (bits 7-6 clear).
    for (let i = 0; i < (outPathLen & 0x3f); i++) frame[36 + i] = 0xa0 + i;
  }
  Buffer.from('Rita', 'utf8').copy(frame, 100);
  return frame;
}

// The captured RESP_SELF_INFO with `_prefs.manual_add_contacts` (byte 47)
// forced: 0x00 = radio auto-adds everything, 0x01 = radio honours its per-kind
// autoadd_config.
function selfInfo(manualAddContacts: number): Buffer {
  const frame = frameBuf('selfInfo');
  frame[47] = manualAddContacts;
  return frame;
}

// RESP_AUTOADD_CONFIG: [0x19][flags u8][autoadd_max_hops u8]. flags bits are
// overwrite_oldest 0x01 | chat 0x02 | repeater 0x04 | room 0x08 | sensor 0x10.
const CHAT_ONLY = 0x01 | 0x02; // repeater/room/sensor deselected

function autoAddConfig(flagsByte: number, radioMaxHops = 0): Buffer {
  return Buffer.from([RESP.AUTOADD_CONFIG, flagsByte, radioMaxHops]);
}

/** Every CMD_GET_CONTACTS walk the session has written so far. */
function walks(transport: Transports.Loopback): Buffer[] {
  return transport.sent.map((f) => Buffer.from(f)).filter((f) => f[0] === CMD.GET_CONTACTS);
}

describe('post-advert re-sync gate (manual_add_contacts bit 0)', () => {
  afterEach(() => vi.useRealTimers());

  it('does not walk contacts for a deselected kind when bit 0 is set', async () => {
    vi.useFakeTimers();
    const { transport } = makeSession();

    deliver(transport, selfInfo(0x01)); // radio honours its per-kind flags
    deliver(transport, autoAddConfig(CHAT_ONLY)); // repeaters deselected
    const before = walks(transport).length;

    deliver(transport, refusedAdvert(PK, ADV_TYPE.REPEATER));
    await vi.advanceTimersByTimeAsync(2_000); // well past the 1.5s debounce

    expect(walks(transport).length).toBe(before);
  });

  it('still walks contacts for a selected kind when bit 0 is set', async () => {
    vi.useFakeTimers();
    const { transport } = makeSession();

    deliver(transport, selfInfo(0x01));
    deliver(transport, autoAddConfig(CHAT_ONLY)); // chat IS selected
    const before = walks(transport).length;

    deliver(transport, refusedAdvert(PK, ADV_TYPE.CHAT));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(walks(transport).length).toBe(before + 1);
  });

  // Drives byte 47 0x01 -> 0x00 rather than delivering a bare 0x00, because a
  // bare 0x00 would exercise nothing: the connect-session fixture's byte 47 is
  // already 0x00 and so is DEFAULT_AUTO_ADD_CONFIG.manualAddContacts, so the
  // change guard in src/features/selfInfo.ts skips `setAutoAddConfig` and the
  // case would pass on the default rather than on the mirror. Asserting both
  // legs of the flip — gate closed, then open — is what makes this a test of
  // the RESP_SELF_INFO mirror this file's header advertises.
  it('reopens the gate when the mirrored byte 47 flips back to 0x00', async () => {
    vi.useFakeTimers();
    const { session, transport } = makeSession();
    const mirrored: number[] = [];
    session.events.on('autoAddConfig', (cfg) => {
      if (mirrored.at(-1) !== cfg.manualAddContacts) mirrored.push(cfg.manualAddContacts);
    });

    deliver(transport, selfInfo(0x01)); // radio honours its per-kind flags...
    deliver(transport, autoAddConfig(CHAT_ONLY)); // ...and repeaters are deselected
    const beforeSet = walks(transport).length;
    deliver(transport, refusedAdvert(PK, ADV_TYPE.REPEATER));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(walks(transport).length).toBe(beforeSet); // gate closed

    deliver(transport, selfInfo(0x00)); // radio flips back to auto-adding every kind
    expect(session.state.getAutoAddConfig().repeater).toBe(false); // flags untouched...
    const beforeClear = walks(transport).length;
    deliver(transport, refusedAdvert(PK2, ADV_TYPE.REPEATER));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(walks(transport).length).toBe(beforeClear + 1); // ...but now inert: gate open

    // Both values reached the mirror through RESP_SELF_INFO. Without this the
    // 0x00 leg could not tell a working mirror from no mirror at all.
    expect(mirrored).toEqual([0x01, 0x00]);
  });

  // INTENTIONAL RESIDUAL — a deliberate pin, not an accident. PUSH_NEW_ADVERT is
  // also how the radio reports a refusal for exceeding `getAutoAddMaxHops()`, and
  // for that refusal the kind is ENABLED, so `shouldAutoAdd` says yes and we walk
  // contacts the walk can never produce. The hop count IS available at the gate
  // (`record.outPathLen` / `hopsFromOutPathLen`), so this is declined, not
  // infeasible: gating would mean guessing the firmware's exact comparison, and a
  // wrong gate suppresses legitimate re-syncs — see the (b) note at the
  // `scheduleContactsResync` call site in src/features/contacts.ts. Anyone adding
  // that gate must change THIS test knowingly.
  it('still walks for a max-hop refusal of an enabled kind (intentional residual)', async () => {
    vi.useFakeTimers();
    const { session, transport } = makeSession();

    deliver(transport, selfInfo(0x01)); // radio honours its per-kind flags
    deliver(transport, autoAddConfig(CHAT_ONLY, 1)); // chat selected, limit 1 hop
    expect(session.state.getAutoAddConfig().radioMaxHops).toBe(1);
    const before = walks(transport).length;

    // Chat IS selected, but this advert arrived over 3 hops — past the radio's
    // own limit, which is why the radio refused it. We do not model that reason.
    deliver(transport, refusedAdvert(PK, ADV_TYPE.CHAT, 0x03));
    expect(session.state.discovered.list().find((c) => c.publicKeyHex === PK)?.hops).toBe(3);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(walks(transport).length).toBe(before + 1);
  });
});
