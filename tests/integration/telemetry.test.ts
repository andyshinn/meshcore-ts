import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { Errors, Models, Protocol } from '../../src/index.js';
import { frameBuf } from '../support/frames';
import { deliver, flush, makeSession } from '../support/harness';

// Telemetry additions for 0.9.0: self telemetry, binary-request RESP_SENT info
// + abort + RESP_ERR, write-order reply correlation, telemetry policy
// read-back, per-contact telemetry permissions, and generic custom vars.

const PK = 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';
/** Pubkey of the captured RESP_SELF_INFO fixture. */
const OWNER_PK = '1a3d3c6a09f057457bcf0ae5403e5c60072919d193ed8caff58501b7590dd5d5';

const RESP_OK = Buffer.from([0x00]);
const respErr = (code: number) => Buffer.from([0x01, code]);

function respSent(tagHex: string, opts: { flood?: boolean; estTimeoutMs?: number } = {}): Buffer {
  const out = Buffer.alloc(10);
  out[0] = 0x06;
  out[1] = opts.flood ? 1 : 0;
  Buffer.from(tagHex, 'hex').copy(out, 2);
  out.writeUInt32LE(opts.estTimeoutMs ?? 0, 6);
  return out;
}

function binaryResponse(tagHex: string, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x8c, 0x00]), Buffer.from(tagHex, 'hex'), body]);
}

function telemetryPush(pubkeyHex: string, lpp: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x8b, 0x00]), Buffer.from(pubkeyHex.slice(0, 12), 'hex'), lpp]);
}

function repeater(overrides: Partial<Models.Contact> = {}): Models.Contact {
  return { key: `c:${PK}`, publicKeyHex: PK, name: 'Rpt', kind: 'repeater', ...overrides };
}

/** Put PK in the discovered pool (and, when on-radio, the contact list) with
 *  the given firmware flags byte and out_path_len. */
function seedRadioContact(
  session: ReturnType<typeof makeSession>['session'],
  opts: { flags: number; outPathLen?: number; outPathHex?: string; onRadio?: boolean },
): void {
  const record = {
    publicKeyHex: PK,
    type: 2,
    flags: opts.flags,
    outPathLen: opts.outPathLen ?? 0xff,
    outPathHex: opts.outPathHex ?? '',
    name: 'Rpt',
    lastAdvertUnix: 1_700_000_000,
    gpsLat: 30.25,
    gpsLon: -97.75,
    lastmod: 1_700_000_100,
  };
  session.state.discovered.upsert(record, { onRadio: opts.onRadio ?? true, nowMs: 1_700_000_000_000, heardLive: true });
  if (opts.onRadio !== false) {
    session.state.upsertContact(
      repeater({ favourite: (opts.flags & 1) !== 0, telemetryPerms: Models.telemetryPermsFromFlags(opts.flags) }),
    );
  }
}

type Loopback = ReturnType<typeof makeSession>['transport'];

/** A started session whose transport reports connected, so commands that gate
 *  on a live radio run. The handshake it kicks off writes DEVICE_QUERY and then
 *  waits on timers, so it never answers or awaits anything these tests send. */
function connected(): ReturnType<typeof makeSession> {
  const h = makeSession();
  h.transport.setState('connected');
  return h;
}

/** The most recent frame written with opcode `op`. */
function lastOp(transport: Loopback, op: number): Buffer {
  const frame = transport.sent.filter((f) => f[0] === op).at(-1);
  if (!frame) throw new Error(`no frame with opcode 0x${op.toString(16)} written`);
  return Buffer.from(frame);
}

describe('requestSelfTelemetry', () => {
  it('writes the 4-byte self request and resolves the radio LPP verbatim', async () => {
    const { session, transport } = connected();
    deliver(transport, frameBuf('selfInfo'));
    const repeaterEvents: unknown[] = [];
    session.events.on('repeaterTelemetry', (e) => repeaterEvents.push(e));

    const p = session.requestSelfTelemetry();
    await flush();
    expect(lastOp(transport, 0x27).toString('hex')).toBe('27000000');

    const lpp = Buffer.from('0174019a0167010e', 'hex'); // ch1 voltage 4.10V, ch1 temp 27.0°C
    deliver(transport, telemetryPush(OWNER_PK, lpp));
    const out = await p;
    expect(out.toString('hex')).toBe(lpp.toString('hex'));
    expect(repeaterEvents).toHaveLength(0);
    expect(Protocol.parseTelemetryLpp(out).map((f) => f.value)).toEqual([4.1, 27]);
  });

  it('leaves a repeater telemetry push to the repeaterTelemetry event while waiting', async () => {
    const { session, transport } = connected();
    deliver(transport, frameBuf('selfInfo'));
    session.state.upsertContact(repeater());
    const repeaterEvents: Array<{ contactKey: string }> = [];
    session.events.on('repeaterTelemetry', (e) => repeaterEvents.push(e));

    const p = session.requestSelfTelemetry();
    await flush();
    deliver(transport, telemetryPush(PK, Buffer.from('0174019a', 'hex')));
    expect(repeaterEvents.map((e) => e.contactKey)).toEqual([`c:${PK}`]);
    deliver(transport, telemetryPush(OWNER_PK, Buffer.from('0174017c', 'hex')));
    await expect(p.then((b) => b.toString('hex'))).resolves.toBe('0174017c');
  });

  it('rejects with an "unsupported" ProtocolError on ERR_CODE_UNSUPPORTED_CMD', async () => {
    const { session, transport } = connected();
    deliver(transport, frameBuf('selfInfo'));
    const p = session.requestSelfTelemetry();
    await flush();
    deliver(transport, respErr(0x01));
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Errors.ProtocolError);
    expect((err as Errors.ProtocolError).errorCode).toBe(0x01);
    expect((err as Error).message).toContain('unsupported');
  });

  it('does not emit repeaterTelemetry for a late self reply', async () => {
    const { session, transport } = connected();
    deliver(transport, frameBuf('selfInfo'));
    const repeaterEvents: unknown[] = [];
    session.events.on('repeaterTelemetry', (e) => repeaterEvents.push(e));
    deliver(transport, telemetryPush(OWNER_PK, Buffer.from('0174019a', 'hex')));
    expect(repeaterEvents).toHaveLength(0);
  });
});

describe('sendBinaryRequest', () => {
  it('calls onSent with flood + estTimeoutMs from RESP_SENT', async () => {
    const { session, transport } = connected();
    session.state.upsertContact(repeater());
    const infos: Array<{ flood: boolean; estTimeoutMs: number }> = [];
    const p = session.sendBinaryRequest(`c:${PK}`, Buffer.from([0x03]), { onSent: (i) => infos.push(i) });
    await flush();
    deliver(transport, respSent('01020304', { flood: true, estTimeoutMs: 12_345 }));
    expect(infos).toEqual([{ flood: true, estTimeoutMs: 12_345 }]);
    deliver(transport, binaryResponse('01020304', Buffer.from([0xaa])));
    await expect(p.then((b) => b.toString('hex'))).resolves.toBe('aa');
  });

  it('rejects with ProtocolError on RESP_ERR instead of timing out', async () => {
    const { session, transport } = connected();
    session.state.upsertContact(repeater());
    const p = session.sendBinaryRequest(`c:${PK}`, Buffer.from([0x03]));
    await flush();
    deliver(transport, respErr(0x02)); // NOT_FOUND
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Errors.ProtocolError);
    expect((err as Errors.ProtocolError).errorCode).toBe(0x02);
    expect((err as Error).message).toContain('NOT_FOUND');
  });

  it('abort after RESP_SENT rejects with AbortError and releases the tag', async () => {
    const { session, transport } = connected();
    session.state.upsertContact(repeater());
    const ac = new AbortController();
    const p = session.sendBinaryRequest(`c:${PK}`, Buffer.from([0x03]), { signal: ac.signal });
    await flush();
    deliver(transport, respSent('0a0b0c0d'));
    ac.abort();
    const err = await p.catch((e: unknown) => e);
    expect((err as Error).name).toBe('AbortError');
    // The tag awaiter is gone, so a late reply finds nothing to wake.
    expect(session.admin.resolveTag('0a0b0c0d', Buffer.alloc(0))).toBe(false);
  });

  it('abort before RESP_SENT still consumes that RESP_SENT, so the next send gets its own', async () => {
    const { session, transport } = connected();
    session.state.upsertContact(repeater());
    const ac = new AbortController();
    const aborted = session.sendBinaryRequest(`c:${PK}`, Buffer.from([0x03]), { signal: ac.signal });
    await flush();
    ac.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });

    const next = session.sendBinaryRequest(`c:${PK}`, Buffer.from([0x05, 0, 0]));
    await flush();
    deliver(transport, respSent('11111111')); // the aborted request's
    deliver(transport, respSent('22222222')); // the second request's
    deliver(transport, binaryResponse('11111111', Buffer.from([0x01])));
    deliver(transport, binaryResponse('22222222', Buffer.from([0x02])));
    await expect(next.then((b) => b.toString('hex'))).resolves.toBe('02');
  });

  it('a DM written before a binary request keeps its own RESP_SENT', async () => {
    const { session, transport } = connected();
    session.state.upsertContact(repeater());
    const states: Array<[string, string]> = [];
    session.events.on('messageState', (id, state) => states.push([id, state]));

    await session.sendDmText(`c:${PK}`, 'hi', 'm1');
    const p = session.sendBinaryRequest(`c:${PK}`, Buffer.from([0x03]));
    await flush();
    deliver(transport, respSent('aaaa0001')); // DM's
    deliver(transport, respSent('bbbb0002')); // binary request's
    expect(states).toContainEqual(['m1', 'sent']);
    deliver(transport, binaryResponse('bbbb0002', Buffer.from([0x07])));
    await expect(p.then((b) => b.toString('hex'))).resolves.toBe('07');
  });

  it('a RESP_ERR goes to the oldest waiting command, not the newest ack waiter', async () => {
    const { session, transport } = connected();
    session.state.upsertContact(repeater());
    const states: Array<[string, string]> = [];
    session.events.on('messageState', (id, state) => states.push([id, state]));

    await session.sendDmText(`c:${PK}`, 'hi', 'm1');
    const setVar = session.setCustomVar('gps', '1');
    await flush();
    deliver(transport, respErr(0x03)); // the DM's (TABLE_FULL)
    deliver(transport, RESP_OK); // the custom var's
    await expect(setVar).resolves.toBe(true);
    expect(states).toContainEqual(['m1', 'failed']);
  });
});

describe('repeaterLogin', () => {
  it('rejects at once when the radio answers RESP_ERR', async () => {
    const { session, transport } = connected();
    session.state.upsertContact(repeater());
    const p = session.repeaterLogin(`c:${PK}`, 'pw');
    await flush();
    deliver(transport, respErr(0x02));
    await expect(p).rejects.toBeInstanceOf(Errors.ProtocolError);
  });
});

describe('SELF_INFO telemetry policy read-back', () => {
  it('folds byte 46 + byte 44 into telemetryPolicy and emits it', async () => {
    const { session, transport } = connected();
    const seen: Models.TelemetryPolicy[] = [];
    session.events.on('telemetryPolicy', (p) => seen.push(p));
    const frame = frameBuf('selfInfo');
    frame[46] = (2 << 4) | (0 << 2) | 1; // env allow-all, loc deny, base per-contact
    frame[44] = 2;
    deliver(transport, frame);
    expect(seen.at(-1)).toEqual({ base: 1, loc: 0, env: 2, multiAcks: 2 });
    expect(session.state.getTelemetryPolicy()).toEqual({ base: 1, loc: 0, env: 2, multiAcks: 2 });
  });

  it('emits even when the radio reports the library default', async () => {
    const { session, transport } = connected();
    const seen: Models.TelemetryPolicy[] = [];
    session.events.on('telemetryPolicy', (p) => seen.push(p));
    const frame = frameBuf('selfInfo');
    frame[46] = (1 << 4) | (1 << 2) | 1;
    frame[44] = 1;
    deliver(transport, frame);
    expect(seen).toEqual([{ base: 1, loc: 1, env: 1, multiAcks: 1 }]);
  });
});

describe('contact flags survive full-record rewrites', () => {
  const FLAGS = 0x0b; // favourite | base | env

  it('setContactPath carries the flags byte, name, advert time and position', async () => {
    const { session, transport } = connected();
    seedRadioContact(session, { flags: FLAGS });
    const p = session.setContactPath(`c:${PK}`, 'aabb');
    await flush();
    const frame = lastOp(transport, 0x09);
    expect(frame[0]).toBe(0x09);
    expect(frame[34]).toBe(FLAGS);
    expect(frame.readUInt32LE(132)).toBe(1_700_000_000); // last_advert_timestamp
    expect(frame.readInt32LE(136)).toBe(30_250_000);
    expect(frame.readInt32LE(140)).toBe(-97_750_000);
    deliver(transport, RESP_OK);
    await p;
    // The row now holds the new path, so a later rewrite doesn't restore the old one.
    expect(session.state.discovered.get(PK)?.out_path_hex).toBe('aabb');
  });

  it('setContactPath rejects when the radio refuses', async () => {
    const { session, transport } = connected();
    seedRadioContact(session, { flags: FLAGS });
    const p = session.setContactPath(`c:${PK}`, 'aabb');
    await flush();
    deliver(transport, respErr(0x03));
    await expect(p).rejects.toBeInstanceOf(Errors.ProtocolError);
  });

  it('the anon-request zero-hop shim carries the flags byte', async () => {
    const { session, transport } = connected();
    seedRadioContact(session, { flags: FLAGS });
    const p = session.repeaterRequestClock(`c:${PK}`);
    p.catch(() => {});
    await flush();
    const shim = lastOp(transport, 0x09);
    expect(shim[0]).toBe(0x09);
    expect(shim[34]).toBe(FLAGS);
    expect(shim[35]).toBe(0x00); // zero-hop
  });

  it('setContactFavourite keeps telemetry bits and a flood path', async () => {
    const { session, transport } = connected();
    seedRadioContact(session, { flags: 0x06 }); // base | loc, flood
    const p = session.setContactFavourite(PK, true);
    await flush();
    const frame = lastOp(transport, 0x09);
    expect(frame[34]).toBe(0x07);
    expect(frame[35]).toBe(0xff); // still flood, not zero-hop
    deliver(transport, RESP_OK);
    await p;
  });
});

describe('setContactTelemetryPerms', () => {
  it('writes bits 1-3, keeps favourite, and updates state on RESP_OK', async () => {
    const { session, transport } = connected();
    seedRadioContact(session, { flags: 0x01 }); // favourite only
    const upserts: Models.Contact[] = [];
    session.events.on('contactUpserted', (c) => upserts.push(c));

    const p = session.setContactTelemetryPerms(`c:${PK}`, { base: true, loc: true, env: false });
    await flush();
    const frame = lastOp(transport, 0x09);
    expect(frame[0]).toBe(0x09);
    expect(frame[34]).toBe(0x07);
    expect(frame[35]).toBe(0xff);
    deliver(transport, RESP_OK);
    await expect(p).resolves.toBe(true);

    expect(session.state.discovered.get(PK)?.flags).toBe(0x07);
    expect(session.state.getContact(`c:${PK}`)?.telemetryPerms).toEqual({ base: true, loc: true, env: false });
    expect(session.state.getContact(`c:${PK}`)?.favourite).toBe(true);
    expect(upserts.at(-1)?.telemetryPerms).toEqual({ base: true, loc: true, env: false });
    const disc = session.state.discovered.list().find((d) => d.publicKeyHex === PK);
    expect(disc?.telemetryPerms).toEqual({ base: true, loc: true, env: false });
    expect(disc?.favourite).toBe(true);
  });

  it('resolves false and leaves state alone on RESP_ERR', async () => {
    const { session, transport } = connected();
    seedRadioContact(session, { flags: 0x01 });
    const p = session.setContactTelemetryPerms(PK, { base: true, loc: false, env: false });
    await flush();
    deliver(transport, respErr(0x02));
    await expect(p).resolves.toBe(false);
    expect(session.state.discovered.get(PK)?.flags).toBe(0x01);
  });

  it('updates a discovered-only contact locally without writing', async () => {
    const { session, transport } = connected();
    seedRadioContact(session, { flags: 0x00, onRadio: false });
    await expect(session.setContactTelemetryPerms(PK, { base: false, loc: false, env: true })).resolves.toBe(true);
    expect(transport.sent.some((f) => f[0] === 0x09)).toBe(false);
    expect(session.state.discovered.get(PK)?.flags).toBe(0x08);
  });

  it('decodes telemetryPerms from a synced RESP_CONTACT', async () => {
    const { session, transport } = connected();
    const frame = Buffer.alloc(148);
    frame[0] = 0x03; // RESP_CONTACT
    Buffer.from(PK, 'hex').copy(frame, 1);
    frame[33] = 2;
    frame[34] = 0x0d; // favourite | loc | env
    frame[35] = 0xff;
    Buffer.from('Rpt').copy(frame, 100);
    deliver(transport, frame);
    await flush();
    expect(session.state.getContact(`c:${PK}`)?.telemetryPerms).toEqual({ base: false, loc: true, env: true });
  });
});

describe('custom vars', () => {
  it('emits {} for an empty unsolicited reply', () => {
    const { session, transport } = connected();
    const seen: Array<Record<string, string>> = [];
    session.events.on('customVars', (v) => seen.push(v));
    deliver(transport, Buffer.from([0x15]));
    expect(seen).toEqual([{}]);
  });

  it('requestCustomVars resolves the decoded map and emits it', async () => {
    const { session, transport } = connected();
    const seen: Array<Record<string, string>> = [];
    session.events.on('customVars', (v) => seen.push(v));
    const p = session.requestCustomVars();
    await flush();
    expect(lastOp(transport, 0x28).toString('hex')).toBe('28');
    deliver(transport, Buffer.concat([Buffer.from([0x15]), Buffer.from('gps:1,foo:bar')]));
    await expect(p).resolves.toEqual({ gps: '1', foo: 'bar' });
    expect(seen).toEqual([{ gps: '1', foo: 'bar' }]);
    expect(session.state.getGpsConfig().enabled).toBe(true);
  });

  it('requestCustomVars resolves {} on an empty reply', async () => {
    const { session, transport } = connected();
    const p = session.requestCustomVars();
    await flush();
    deliver(transport, Buffer.from([0x15]));
    await expect(p).resolves.toEqual({});
  });

  it('setCustomVar writes key:value and resolves on the ack', async () => {
    const { session, transport } = connected();
    const ok = session.setCustomVar('gps_interval', '300');
    await flush();
    expect(lastOp(transport, 0x29).subarray(1).toString()).toBe('gps_interval:300');
    deliver(transport, RESP_OK);
    await expect(ok).resolves.toBe(true);
    expect(session.state.getGpsConfig().intervalSec).toBe(300);

    const rejected = session.setCustomVar('gps_interval', '300');
    await flush();
    deliver(transport, respErr(0x06));
    await expect(rejected).resolves.toBe(false);
  });

  it('setCustomVar refuses a key containing ":"', async () => {
    const { session } = connected();
    await expect(session.setCustomVar('a:b', '1')).rejects.toThrow(':');
  });
});

describe('parseTelemetryLpp', () => {
  it('reads voltage as signed', () => {
    expect(Protocol.parseTelemetryLpp(Buffer.from('0174ff9c', 'hex'))[0].value).toBe(-1);
  });

  it('stops at trailing zero padding', () => {
    const fields = Protocol.parseTelemetryLpp(Buffer.from('0174019a000000000000000000000000', 'hex'));
    expect(fields).toHaveLength(1);
    expect(fields[0].name).toBe('Voltage');
  });

  it('keeps the undecoded tail of a truncated record', () => {
    const fields = Protocol.parseTelemetryLpp(Buffer.from('0174019a026701', 'hex'));
    expect(fields).toHaveLength(2);
    expect(fields[1]).toMatchObject({ channel: 2, typeHex: '0x67', name: 'Unknown', value: '01' });
  });
});

describe('buildTelemetryReqData', () => {
  it('encodes an inverse permission mask and a random tail', () => {
    const out = Protocol.buildTelemetryReqData({ base: true, loc: false, env: true }, Buffer.from('deadbeef', 'hex'));
    expect(out.toString('hex')).toBe('03fa000000deadbeef');
    expect(Protocol.buildTelemetryReqData(undefined, Buffer.alloc(4))[1]).toBe(0xf8);
  });
});

describe('reply correlation: every RESP_OK / RESP_ERR has an owner', () => {
  it('a self advert written first keeps its RESP_OK away from self telemetry', async () => {
    const { session, transport } = connected();
    deliver(transport, frameBuf('selfInfo'));
    await session.sendSelfAdvert(false);
    const p = session.requestSelfTelemetry();
    await flush();
    deliver(transport, RESP_OK); // the advert's
    deliver(transport, telemetryPush(OWNER_PK, Buffer.from('0174019a', 'hex')));
    await expect(p.then((b) => b.toString('hex'))).resolves.toBe('0174019a');
  });

  it('a stray RESP_OK never settles a typed request', async () => {
    const { session, transport } = connected();
    const p = session.requestCustomVars();
    await flush();
    deliver(transport, RESP_OK); // nobody's
    deliver(transport, Buffer.concat([Buffer.from([0x15]), Buffer.from('gps:0')]));
    await expect(p).resolves.toEqual({ gps: '0' });
  });

  it("a GET_CHANNEL NOT_FOUND written first doesn't fail a later binary request", async () => {
    // Not connected: no handshake holding the sync lock that getChannel takes.
    const { session, transport } = makeSession();
    session.state.upsertContact(repeater());
    const ch = session.getChannel(39);
    await flush();
    const p = session.sendBinaryRequest(`c:${PK}`, Buffer.from([0x03]));
    await flush();
    deliver(transport, respErr(0x02)); // GET_CHANNEL's
    await expect(ch).resolves.toBeNull();
    deliver(transport, respSent('0c0c0c0c'));
    deliver(transport, binaryResponse('0c0c0c0c', Buffer.from([0x09])));
    await expect(p.then((b) => b.toString('hex'))).resolves.toBe('09');
  });

  it('a typed request rejects on RESP_ERR instead of timing out', async () => {
    const { session, transport } = connected();
    const p = session.getDeviceTime();
    await flush();
    deliver(transport, respErr(0x01));
    await expect(p).rejects.toBeInstanceOf(Errors.ProtocolError);
  });

  it('a newer mesh request supersedes the older one the radio stopped tracking', async () => {
    const { session, transport } = connected();
    session.state.upsertContact(repeater());
    const first = session.sendBinaryRequest(`c:${PK}`, Buffer.from([0x03]));
    first.catch(() => {});
    await flush();
    deliver(transport, respSent('a0a0a0a0'));
    const second = session.sendBinaryRequest(`c:${PK}`, Buffer.from([0x05, 0, 0]));
    await flush();
    deliver(transport, respSent('b0b0b0b0'));
    await expect(first).rejects.toThrow(/superseded/);
    deliver(transport, binaryResponse('b0b0b0b0', Buffer.from([0x01])));
    await expect(second.then((b) => b.toString('hex'))).resolves.toBe('01');
  });

  it('a login RESP_ERR during a slow write is not an unhandled rejection', async () => {
    const { session, transport } = connected();
    session.state.upsertContact(repeater());
    const send = transport.send.bind(transport);
    transport.send = async (bytes) => {
      await send(bytes);
      await new Promise((r) => setTimeout(r, 10));
    };
    const p = session.repeaterLogin(`c:${PK}`, 'pw');
    await flush();
    deliver(transport, respErr(0x02)); // arrives while the write is still pending
    await expect(p).rejects.toBeInstanceOf(Errors.ProtocolError);
  });

  it('a getContactByKey pending at disconnect resolves null and frees its slot', async () => {
    const { session, transport } = connected();
    const p = session.getContactByKey(PK);
    await flush();
    transport.setState('idle');
    await expect(p).resolves.toBeNull();
  });
});

describe('anon request shim and zero-hop contacts', () => {
  it('carries the row last-advert time and restores flood after a refused shim', async () => {
    const { session, transport } = connected();
    seedRadioContact(session, { flags: 0x01 });
    const p = session.repeaterRequestClock(`c:${PK}`);
    await flush();
    const shim = lastOp(transport, 0x09);
    expect(shim.readUInt32LE(132)).toBe(1_700_000_000);
    expect(shim.length).toBe(144); // no lastmod: the radio stamps its own
    deliver(transport, respErr(0x03));
    await flush();
    expect(transport.sent.some((f) => f[0] === 0x0d)).toBe(true); // CMD_RESET_PATH
    deliver(transport, RESP_OK); // the reset's
    await expect(p).rejects.toBeInstanceOf(Errors.ProtocolError);
  });

  it('sends a zero-hop contact direct with no shim and no reset', async () => {
    const { session, transport } = connected();
    seedRadioContact(session, { flags: 0x00, outPathLen: 0x00 });
    const p = session.repeaterRequestClock(`c:${PK}`);
    p.catch(() => {});
    await flush();
    expect(transport.sent.some((f) => f[0] === 0x09)).toBe(false);
    expect(lastOp(transport, 0x39).subarray(33).toString('hex')).toBe('0300');
    deliver(transport, respSent('d0d0d0d0'));
    const body = Buffer.alloc(4);
    body.writeUInt32LE(1_700_000_123, 0);
    deliver(transport, binaryResponse('d0d0d0d0', body));
    await expect(p).resolves.toBe(1_700_000_123);
    expect(transport.sent.some((f) => f[0] === 0x0d)).toBe(false);
  });

  it('setContactPath with an empty path records a zero-hop route', async () => {
    const { session, transport } = connected();
    seedRadioContact(session, { flags: 0x00 });
    const p = session.setContactPath(`c:${PK}`, '');
    await flush();
    deliver(transport, RESP_OK);
    await p;
    expect(session.state.getContact(`c:${PK}`)?.hops).toBe(0);
    expect(session.state.discovered.get(PK)?.out_path_len).toBe(0);
  });

  it('resetContactPath leaves state alone when the radio refuses', async () => {
    const { session, transport } = connected();
    seedRadioContact(session, { flags: 0x00, outPathLen: 0x01, outPathHex: 'aa' });
    const p = session.resetContactPath(`c:${PK}`);
    await flush();
    deliver(transport, respErr(0x02));
    await expect(p).rejects.toBeInstanceOf(Errors.ProtocolError);
    expect(session.state.discovered.get(PK)?.out_path_len).toBe(0x01);
  });
});

describe('discovered flags merge', () => {
  it("takes the radio's flags byte from a synced record, favourite included", async () => {
    const { session, transport } = connected();
    seedRadioContact(session, { flags: 0x00 });
    const frame = Buffer.alloc(148);
    frame[0] = 0x03; // RESP_CONTACT
    Buffer.from(PK, 'hex').copy(frame, 1);
    frame[33] = 2;
    frame[34] = 0x01; // favourited on the radio (e.g. by another client)
    frame[35] = 0xff;
    Buffer.from('Rpt').copy(frame, 100);
    deliver(transport, frame);
    expect(session.state.discovered.get(PK)?.flags).toBe(0x01);
    const p = session.setContactTelemetryPerms(PK, { base: true, loc: false, env: false });
    await flush();
    expect(lastOp(transport, 0x09)[34]).toBe(0x03);
    deliver(transport, RESP_OK);
    await expect(p).resolves.toBe(true);
  });

  it('keeps a discovered-only row’s flags across a re-advert', async () => {
    const { session } = connected();
    seedRadioContact(session, { flags: 0x00, onRadio: false });
    await session.setContactTelemetryPerms(PK, { base: true, loc: true, env: false });
    session.state.discovered.upsert(
      {
        publicKeyHex: PK,
        type: 2,
        flags: 0, // adverts carry zeroed flags
        outPathLen: 0xff,
        outPathHex: '',
        name: 'Rpt',
        lastAdvertUnix: 1_700_000_500,
        gpsLat: 0,
        gpsLon: 0,
        lastmod: 0,
      },
      { onRadio: false, nowMs: 1_700_000_500_000, heardLive: true },
    );
    expect(session.state.discovered.get(PK)?.flags).toBe(0x06);
  });
});

describe('GPS settings', () => {
  it('setGpsConfig reports the toggle even when the radio refuses gps_interval', async () => {
    const { session, transport } = connected();
    const seen: Models.GpsConfig[] = [];
    session.events.on('gpsConfig', (c) => seen.push(c));
    const before = session.state.getGpsConfig().intervalSec;
    const p = session.setGpsConfig({ enabled: true, intervalSec: 300 });
    await flush();
    deliver(transport, RESP_OK); // gps:1 applied
    await new Promise((r) => setTimeout(r, 70)); // past the write gap
    deliver(transport, respErr(0x06)); // T1000: gps_interval unsupported
    await expect(p).resolves.toBe(true);
    expect(session.state.getGpsConfig()).toEqual({ enabled: true, intervalSec: before });
    expect(seen.at(-1)?.enabled).toBe(true);
  });

  it("setCustomVar sends a gps value the firmware persists ('1' / '0')", async () => {
    const { session, transport } = connected();
    const p = session.setCustomVar('gps', 'on');
    await flush();
    expect(lastOp(transport, 0x29).subarray(1).toString()).toBe('gps:1');
    deliver(transport, RESP_OK);
    await p;
    expect(session.state.getGpsConfig().enabled).toBe(true);
  });
});

describe('second-pass correlation fixes', () => {
  const loginSuccess = (prefixHex: string): Buffer => {
    const f = Buffer.alloc(8);
    f[0] = 0x85;
    f[1] = 1;
    Buffer.from(prefixHex, 'hex').copy(f, 2);
    return f;
  };

  it('a second login to the same repeater is not superseded by the first', async () => {
    const { session, transport } = connected();
    session.state.upsertContact(repeater());
    const first = session.repeaterLogin(`c:${PK}`, 'pw');
    await flush();
    deliver(transport, respSent(PK.slice(0, 8)));
    deliver(transport, loginSuccess(PK.slice(0, 12)));
    await first;

    const second = session.repeaterLogin(`c:${PK}`, 'pw');
    await flush();
    deliver(transport, respSent(PK.slice(0, 8)));
    deliver(transport, loginSuccess(PK.slice(0, 12)));
    await expect(second).resolves.toMatchObject({ mode: 'remote' });
  });

  it('an aborted request still supersedes the one before it', async () => {
    const { session, transport } = connected();
    session.state.upsertContact(repeater());
    const first = session.sendBinaryRequest(`c:${PK}`, Buffer.from([0x03]));
    first.catch(() => {});
    await flush();
    deliver(transport, respSent('a1a1a1a1'));
    const ac = new AbortController();
    const second = session.sendBinaryRequest(`c:${PK}`, Buffer.from([0x05, 0, 0]), { signal: ac.signal });
    second.catch(() => {});
    await flush();
    ac.abort();
    deliver(transport, respSent('b1b1b1b1'));
    await expect(first).rejects.toThrow(/superseded/);
  });

  it('a GET_CONTACTS BAD_STATE is not credited to an in-flight DM', async () => {
    const { session, transport } = makeSession();
    session.state.upsertContact(repeater());
    const states: Array<[string, string]> = [];
    session.events.on('messageState', (id, state) => states.push([id, state]));
    const contacts = session.getContacts();
    contacts.catch(() => {});
    await flush();
    await session.sendDmText(`c:${PK}`, 'hi', 'm1');
    deliver(transport, respErr(0x04)); // GET_CONTACTS: BAD_STATE
    deliver(transport, respSent('aaaa0009')); // the DM's
    expect(states).toContainEqual(['m1', 'sent']);
    expect(states).not.toContainEqual(['m1', 'failed']);
  });

  it('importPrivateKey on a build without import rejects FeatureDisabledError, and a later RESP_OK is not its', async () => {
    const { session, transport } = connected();
    const imp = session.importPrivateKey('ab'.repeat(64));
    await flush();
    const ch = session.setChannel(1, 'x', '00112233445566778899aabbccddeeff');
    await flush();
    deliver(transport, Buffer.from([0x0f])); // RESP_DISABLED: the import's
    await expect(imp).rejects.toBeInstanceOf(Errors.FeatureDisabledError);
    deliver(transport, RESP_OK); // setChannel's
    await expect(ch).resolves.toBe(true);
  });

  it('GET_STATS on firmware without it rejects instead of timing out', async () => {
    const { session, transport } = makeSession();
    const p = session.repeaterGetLocalStats('CORE');
    await flush();
    deliver(transport, respErr(0x01));
    await expect(p).rejects.toBeInstanceOf(Errors.ProtocolError);
  });
});

describe('third-pass correlation fixes', () => {
  it("a failed earlier login doesn't fail a newer login to the same repeater", async () => {
    const { session, transport } = connected();
    session.state.upsertContact(repeater());
    const a = session.repeaterLogin(`c:${PK}`, 'old');
    a.catch(() => {});
    await flush();
    const b = session.repeaterLogin(`c:${PK}`, 'new');
    await flush();
    deliver(transport, respErr(0x03)); // A refused (TABLE_FULL)
    deliver(transport, respSent(PK.slice(0, 8))); // B sent
    const ok = Buffer.alloc(8);
    ok[0] = 0x85;
    ok[1] = 1;
    Buffer.from(PK.slice(0, 12), 'hex').copy(ok, 2);
    deliver(transport, ok);
    await expect(b).resolves.toMatchObject({ mode: 'remote' });
  });

  it('an export written before an import keeps its own RESP_DISABLED', async () => {
    const { session, transport } = connected();
    const exp = session.exportPrivateKey();
    exp.catch(() => {});
    await flush();
    const imp = session.importPrivateKey('ab'.repeat(64));
    imp.catch(() => {});
    await flush();
    deliver(transport, Buffer.from([0x0f])); // the export's
    await expect(exp).rejects.toBeInstanceOf(Errors.FeatureDisabledError);
    deliver(transport, Buffer.from([0x0f])); // the import's
    await expect(imp).rejects.toBeInstanceOf(Errors.FeatureDisabledError);
  });

  it("a superseded GET_STATS reply doesn't resolve the newer request with the wrong kind", async () => {
    const { session, transport } = makeSession();
    const core = session.repeaterGetLocalStats('CORE');
    core.catch(() => {});
    await flush();
    const radio = session.repeaterGetLocalStats('RADIO');
    await flush();
    const coreFrame = Buffer.alloc(12);
    coreFrame[0] = 0x18;
    coreFrame[1] = 0x00;
    deliver(transport, coreFrame); // late reply to the superseded CORE request
    const radioFrame = Buffer.alloc(14);
    radioFrame[0] = 0x18;
    radioFrame[1] = 0x01;
    deliver(transport, radioFrame);
    await expect(radio).resolves.toMatchObject({ kind: 'radio' });
  });
});
