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

// PUSH_NEW_ADVERT (0x8a): a full 148-byte contact record, pushed when the radio
// REFUSED to store the advertising node. Refused => not on radio => the
// `shouldAutoAdd` gate decides whether to walk CMD_GET_CONTACTS.
function refusedAdvert(pubkeyHex: string, advType: number): Buffer {
  const frame = Buffer.alloc(148);
  frame[0] = PUSH.NEW_ADVERT;
  Buffer.from(pubkeyHex, 'hex').copy(frame, 1);
  frame[33] = advType;
  frame[35] = 0xff; // out_path_len = direct
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

function autoAddConfig(flagsByte: number): Buffer {
  return Buffer.from([RESP.AUTOADD_CONFIG, flagsByte, 0]);
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

  it('walks contacts for a deselected kind when bit 0 is clear', async () => {
    vi.useFakeTimers();
    const { transport } = makeSession();

    deliver(transport, selfInfo(0x00)); // radio auto-adds every kind
    deliver(transport, autoAddConfig(CHAT_ONLY)); // ...so these flags are inert
    const before = walks(transport).length;

    deliver(transport, refusedAdvert(PK, ADV_TYPE.REPEATER));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(walks(transport).length).toBe(before + 1);
  });
});
