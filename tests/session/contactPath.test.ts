import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it } from 'vitest';
import type { Models } from '../../src/index';
import { deliver, makeSession } from '../support/harness';

const PK = 'aa'.repeat(32);
const CMD_ADD_UPDATE_CONTACT = 0x09;

/** Build a 148-byte RESP_CONTACT frame with an arbitrary packed out_path_len. */
function respContact(pkHex: string, outPathLen: number, outPathHex: string, name = 'Bob'): Buffer {
  const f = Buffer.alloc(148);
  f[0] = 0x03;
  Buffer.from(pkHex, 'hex').copy(f, 1);
  f[33] = 1; // type: chat
  f[35] = outPathLen;
  Buffer.from(outPathHex, 'hex').copy(f, 36);
  Buffer.from(name, 'utf8').copy(f, 100);
  return f;
}

describe('setContactPath packs the firmware path_len byte', () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  it('encodes a 2-byte-mode path with the packed byte 35, not a raw byte count', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    // Default pathHashMode is 2.
    const contact: Models.Contact = { key: `c:${PK}`, publicKeyHex: PK, name: 'Bob', kind: 'chat' };
    session.state.upsertContact(contact);

    await session.setContactPath(`c:${PK}`, 'aabbccdd'); // 4 bytes = 2 hops × 2-byte hash

    const frame = Buffer.from(transport.sent.at(-1) ?? Buffer.alloc(0));
    expect(frame[0]).toBe(CMD_ADD_UPDATE_CONTACT);
    expect(frame[35]).toBe(0x42); // hashSize-1=1 (bits 7-6), hop count=2 (bits 5-0)
    expect(frame.subarray(36, 40).toString('hex')).toBe('aabbccdd');

    const updated = session.state.getContacts().find((c) => c.key === `c:${PK}`);
    expect(updated?.outPathHex).toBe('aabbccdd');
    expect(updated?.outPathHashSize).toBe(2);
    expect(updated?.hops).toBe(2);
  });
});

describe('addContactToRadio re-encodes a stored path with the packed byte', () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  it('packs byte 35 from the stored 2-byte path (0x42), not the raw byte length', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    session.state.discovered.upsert(
      {
        publicKeyHex: PK,
        type: 1,
        flags: 0,
        outPathLen: 0x42, // hashSize 2, hop count 2 → 4-byte learned path
        outPathHex: 'aabbccdd',
        name: 'Bob',
        lastAdvertUnix: 0,
        gpsLat: 0,
        gpsLon: 0,
        lastmod: 0,
      },
      { onRadio: false, nowMs: 1_700_000_000_000, heardLive: true },
    );

    const p = session.addContactToRadio(PK);
    await Promise.resolve(); // let writeFrame push before we assert / reply

    const frame = Buffer.from(transport.sent.at(-1) ?? Buffer.alloc(0));
    expect(frame[0]).toBe(CMD_ADD_UPDATE_CONTACT);
    expect(frame[35]).toBe(0x42);
    expect(frame.subarray(36, 40).toString('hex')).toBe('aabbccdd');

    deliver(transport, Buffer.from([0x00])); // RESP_OK
    await p;
  });
});

describe('setContactFavourite re-encodes a stored path with the packed byte', () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  it('packs byte 35 from the stored 2-byte path when round-tripping the favourite flag', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    session.state.discovered.upsert(
      {
        publicKeyHex: PK,
        type: 1,
        flags: 0,
        outPathLen: 0x42,
        outPathHex: 'aabbccdd',
        name: 'Bob',
        lastAdvertUnix: 0,
        gpsLat: 0,
        gpsLon: 0,
        lastmod: 0,
      },
      { onRadio: true, nowMs: 1_700_000_000_000, heardLive: true },
    );

    await session.setContactFavourite(PK, true);

    const frame = Buffer.from(transport.sent.at(-1) ?? Buffer.alloc(0));
    expect(frame[0]).toBe(CMD_ADD_UPDATE_CONTACT);
    expect(frame[34] & 0x01).toBe(0x01); // favourite bit set
    expect(frame[35]).toBe(0x42); // path still correctly packed
  });
});

describe('upsertOnRadioContact derives hashSize from the contact byte, not the radio mode', () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  it('a synced 2-byte contact keeps outPathHashSize=2 even when the radio is in 3-byte mode', () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    // Force the radio's current path-hash mode to 3 to prove the contact's own
    // out_path_len (0x42 → 2-byte) wins.
    session.state.setRadioSettings({ ...session.state.getRadioSettings(), pathHashMode: 3 });

    deliver(transport, respContact(PK, 0x42, 'aabbccdd'));

    const c = session.state.getContacts().find((x) => x.key === `c:${PK}`);
    expect(c?.outPathHex).toBe('aabbccdd');
    expect(c?.outPathHashSize).toBe(2);
    expect(c?.hops).toBe(2);
  });
});
