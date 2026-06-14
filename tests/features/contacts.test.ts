import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
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
});
