import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodeAdvert,
  decodeContact,
  decodeContactDeleted,
  decodeContactsStart,
  decodeEndOfContacts,
  encodeAddUpdateContact,
  encodeGetContactByKey,
  encodeGetContacts,
  encodeRemoveContact,
  encodeResetPath,
} from '../../src/features/contacts';
import type { Contact } from '../../src/index';
import { deliver, makeSession } from '../support/harness';

const hex = (b: Buffer) => b.toString('hex');
const pk = 'aa'.repeat(32);

describe('decodeAdvert (PUSH_ADVERT re-advert)', () => {
  it('reads the 32-byte pubkey, or null when short', () => {
    const frame = Buffer.concat([Buffer.from([0x80]), Buffer.from(pk, 'hex')]);
    expect(decodeAdvert(frame)).toBe(pk);
    expect(decodeAdvert(Buffer.from([0x80, 0x01]))).toBeNull();
  });
});

describe('contacts encoders', () => {
  it('encodeGetContacts is a bare opcode with no `since`', () => {
    expect(hex(encodeGetContacts())).toBe('04');
  });

  it('encodeGetContacts appends `since` as u32 LE', () => {
    expect(hex(encodeGetContacts(0x100))).toBe('0400010000');
  });

  it('encodeResetPath is [0x0d][32B pubkey]', () => {
    expect(hex(encodeResetPath(pk))).toBe(`0d${pk}`);
  });

  it('encodeRemoveContact is [0x0f][32B pubkey]', () => {
    expect(hex(encodeRemoveContact(pk))).toBe(`0f${pk}`);
  });

  it('encodeGetContactByKey is [0x1e][32B pubkey]', () => {
    expect(hex(encodeGetContactByKey(pk))).toBe(`1e${pk}`);
  });

  it('encodeGetContactByKey rejects a short pubkey', () => {
    expect(() => encodeGetContactByKey('aabb')).toThrow(/32B/);
  });

  it('encodeResetPath / encodeRemoveContact reject short pubkeys', () => {
    expect(() => encodeResetPath('aabb')).toThrow(/32B/);
    expect(() => encodeRemoveContact('aabb')).toThrow(/32B/);
  });

  it('rejects overlong pubkeys instead of silently truncating to 32 bytes', () => {
    const overlong = `${pk}ff`; // 66 hex chars / 33 bytes — must not truncate to `pk`
    expect(() => encodeGetContactByKey(overlong)).toThrow(/32B/);
    expect(() => encodeRemoveContact(overlong)).toThrow(/32B/);
    expect(() => encodeResetPath(overlong)).toThrow(/32B/);
  });

  it('rejects malformed hex (trailing garbage / odd length / non-hex) instead of aliasing', () => {
    expect(() => encodeGetContactByKey(`${pk}zz`)).toThrow(/32B/); // valid key + non-hex tail aliases to `pk`
    expect(() => encodeGetContactByKey('a'.repeat(63))).toThrow(/32B/); // odd hex length
    expect(() => encodeGetContactByKey('gg'.repeat(32))).toThrow(/32B/); // 64 chars but not hex
  });

  it('encodeAddUpdateContact rejects an overlong publicKeyHex', () => {
    expect(() =>
      encodeAddUpdateContact({
        publicKeyHex: `${pk}ff`,
        advType: 1,
        flags: 0,
        outPathHex: '',
        name: 'Bob',
        timestampUnix: 5,
      }),
    ).toThrow(/32B/);
  });

  it('encodeAddUpdateContact omits the GPS tail when not provided (136 bytes)', () => {
    const out = encodeAddUpdateContact({
      publicKeyHex: pk,
      advType: 1,
      flags: 0,
      outPathHex: '',
      name: 'Bob',
      timestampUnix: 5,
    });
    expect(out.length).toBe(136);
    expect(out[0]).toBe(0x09);
    expect(out.subarray(1, 33).toString('hex')).toBe(pk);
    expect(out[33]).toBe(1); // advType
    expect(out[34]).toBe(0); // flags
    expect(out[35]).toBe(0); // out_path_len
    const nameRegion = out.subarray(100, 132);
    expect(nameRegion.subarray(0, nameRegion.indexOf(0)).toString('utf8')).toBe('Bob');
    expect(out.readUInt32LE(132)).toBe(5);
  });

  it('encodeAddUpdateContact includes the GPS tail when provided (148 bytes)', () => {
    const out = encodeAddUpdateContact({
      publicKeyHex: pk,
      advType: 1,
      flags: 0,
      outPathHex: '',
      name: 'Bob',
      timestampUnix: 5,
      gpsLat: 1,
      gpsLon: 2,
      lastAdvertUnix: 10,
    });
    expect(out.length).toBe(148);
    expect(out.readInt32LE(136)).toBe(1_000_000);
    expect(out.readInt32LE(140)).toBe(2_000_000);
    expect(out.readUInt32LE(144)).toBe(10);
  });
});

describe('contacts decoders', () => {
  it('decodeContact reads pubkey, type/flags, out_path, name, gps, timestamps', () => {
    const frame = Buffer.alloc(148);
    frame[0] = 0x03;
    Buffer.alloc(32, 0x11).copy(frame, 1); // pubkey
    frame[33] = 2; // type (repeater)
    frame[34] = 0x05; // flags
    frame[35] = 2; // out_path_len
    Buffer.from([0xa1, 0xb2]).copy(frame, 36); // out_path
    Buffer.from('Repeater-1', 'utf8').copy(frame, 100); // name
    frame.writeUInt32LE(1000, 132); // last_advert
    frame.writeInt32LE(37_123456, 136); // gps_lat → 37.123456
    frame.writeInt32LE(-122_654321, 140); // gps_lon → -122.654321
    frame.writeUInt32LE(2000, 144); // lastmod
    const c = decodeContact(frame);
    expect(c?.publicKeyHex).toBe('11'.repeat(32));
    expect(c?.type).toBe(2);
    expect(c?.flags).toBe(0x05);
    expect(c?.outPathLen).toBe(2);
    expect(c?.outPathHex).toBe('a1b2');
    expect(c?.name).toBe('Repeater-1');
    expect(c?.lastAdvertUnix).toBe(1000);
    expect(c?.gpsLat).toBeCloseTo(37.123456, 5);
    expect(c?.gpsLon).toBeCloseTo(-122.654321, 5);
    expect(c?.lastmod).toBe(2000);
  });

  it('decodeContact returns null below 148 bytes', () => {
    expect(decodeContact(Buffer.alloc(147))).toBeNull();
  });

  it('decodeContactsStart / decodeEndOfContacts read a u32 LE at offset 1', () => {
    const start = Buffer.from([0x02, 0x05, 0x00, 0x00, 0x00]);
    const end = Buffer.from([0x04, 0x10, 0x00, 0x00, 0x00]);
    expect(decodeContactsStart(start)).toBe(5);
    expect(decodeEndOfContacts(end)).toBe(16);
    expect(decodeContactsStart(Buffer.alloc(4))).toBeNull();
  });

  it('decodeContactDeleted returns the 32B pubkey hex, or null if short', () => {
    const frame = Buffer.concat([Buffer.from([0x8f]), Buffer.alloc(32, 0x22)]);
    expect(decodeContactDeleted(frame)).toBe('22'.repeat(32));
    expect(decodeContactDeleted(Buffer.alloc(32))).toBeNull();
  });

  it('decodeContact with outPathLen=0xFF returns outPathHex="" (flood/unknown)', () => {
    const frame = Buffer.alloc(148);
    frame[0] = 0x03;
    Buffer.alloc(32, 0x33).copy(frame, 1);
    frame[33] = 1; // type chat
    frame[34] = 0;
    frame[35] = 0xff; // flood sentinel
    // Fill the path region with non-zero garbage to prove it is not read.
    frame.fill(0xab, 36, 100);
    Buffer.from('Flood', 'utf8').copy(frame, 100);
    const c = decodeContact(frame);
    expect(c?.outPathLen).toBe(0xff);
    expect(c?.outPathHex).toBe('');
  });

  it('decodeContact clamps a corrupt outPathLen (>64) to 64 bytes, not beyond', () => {
    const frame = Buffer.alloc(148);
    frame[0] = 0x03;
    Buffer.alloc(32, 0x44).copy(frame, 1);
    frame[33] = 1;
    frame[34] = 0;
    frame[35] = 100; // corrupt: claims 100 bytes but the region is only 64 (frame[36..99])
    // Fill path region with a known pattern so we can verify the slice length.
    frame.fill(0xcc, 36, 100); // 64 bytes of 0xcc
    const c = decodeContact(frame);
    expect(c?.outPathHex).toBe('cc'.repeat(64)); // clamped to 64, not 100
  });

  it('decodeContact with a normal outPathLen still decodes correctly', () => {
    const frame = Buffer.alloc(148);
    frame[0] = 0x03;
    Buffer.alloc(32, 0x55).copy(frame, 1);
    frame[33] = 1;
    frame[34] = 0;
    frame[35] = 3; // normal 3-byte path
    Buffer.from([0x01, 0x02, 0x03]).copy(frame, 36);
    const c = decodeContact(frame);
    expect(c?.outPathLen).toBe(3);
    expect(c?.outPathHex).toBe('010203');
  });
});

// Helper: build a full 148-byte RESP_CONTACT frame for a known pubkey.
function contactFrame(pubkeyHex: string, name: string, outPathLen = 0xff): Buffer {
  const frame = Buffer.alloc(148);
  frame[0] = 0x03; // RESP_CONTACT
  Buffer.from(pubkeyHex, 'hex').copy(frame, 1);
  frame[33] = 1; // type = chat
  frame[35] = outPathLen;
  Buffer.from(name, 'utf8').copy(frame, 100);
  return frame;
}

describe('PUSH_ADVERT schedules a single-contact refresh (Fix B)', () => {
  afterEach(() => vi.useRealTimers());

  it('sends CMD_GET_CONTACT_BY_KEY after the debounce when a known contact re-advertises', async () => {
    vi.useFakeTimers();
    const { session, transport } = makeSession();
    try {
      // Seed a known contact so the PUSH_ADVERT handler finds it.
      const contact: Contact = { key: `c:${pk}`, publicKeyHex: pk, name: 'Alice', kind: 'chat' };
      session.state.upsertContact(contact);

      // Deliver PUSH_ADVERT [0x80][pubkey].
      const advertFrame = Buffer.concat([Buffer.from([0x80]), Buffer.from(pk, 'hex')]);
      deliver(transport, advertFrame);

      // Before the debounce fires, no refresh command should have been sent.
      const sentBeforeDebounce = transport.sent.length;

      // Advance past the 50ms debounce.
      await vi.advanceTimersByTimeAsync(100);

      // CMD_GET_CONTACT_BY_KEY (0x1e) must have been sent for this pubkey.
      const refreshFrames = transport.sent.slice(sentBeforeDebounce);
      expect(refreshFrames.length).toBeGreaterThan(0);
      const lastSent = refreshFrames.at(-1);
      expect(lastSent).toBeDefined();
      const lastFrame = Buffer.from(lastSent ?? []);
      expect(lastFrame[0]).toBe(0x1e); // CMD_GET_CONTACT_BY_KEY
      expect(lastFrame.subarray(1, 33).toString('hex')).toBe(pk);
    } finally {
      session.stop();
    }
  });

  it('de-duplicates: a burst of PUSH_ADVERTs for the same contact fires only one refresh', async () => {
    vi.useFakeTimers();
    const { session, transport } = makeSession();
    try {
      const contact: Contact = { key: `c:${pk}`, publicKeyHex: pk, name: 'Alice', kind: 'chat' };
      session.state.upsertContact(contact);

      const advertFrame = Buffer.concat([Buffer.from([0x80]), Buffer.from(pk, 'hex')]);
      const sentBefore = transport.sent.length;

      // Deliver three adverts in rapid succession (within the debounce window).
      deliver(transport, advertFrame);
      deliver(transport, advertFrame);
      deliver(transport, advertFrame);

      await vi.advanceTimersByTimeAsync(100);

      // Exactly one CMD_GET_CONTACT_BY_KEY should have been enqueued.
      const refreshFrames = transport.sent.slice(sentBefore).filter((f) => f[0] === 0x1e);
      expect(refreshFrames).toHaveLength(1);
    } finally {
      session.stop();
    }
  });

  it('PUSH_ADVERT refresh: ingests the updated contact record when the radio replies', async () => {
    vi.useFakeTimers();
    const { session, transport } = makeSession();
    try {
      const contact: Contact = { key: `c:${pk}`, publicKeyHex: pk, name: 'Alice', kind: 'chat' };
      session.state.upsertContact(contact);

      const advertFrame = Buffer.concat([Buffer.from([0x80]), Buffer.from(pk, 'hex')]);
      deliver(transport, advertFrame);

      const sentBefore = transport.sent.length;
      await vi.advanceTimersByTimeAsync(100); // fire the refresh timer

      // The GET_CONTACT_BY_KEY was sent; reply with an updated name.
      const reply = contactFrame(pk, 'Alice-Updated');
      deliver(transport, reply);
      await vi.runAllTimersAsync();

      // The updated name should now be reflected in local state.
      const updated = session.state.getContacts().find((c) => c.key === `c:${pk}`);
      expect(updated?.name).toBe('Alice-Updated');
      void sentBefore; // silence unused-var lint
    } finally {
      session.stop();
    }
  });
});
