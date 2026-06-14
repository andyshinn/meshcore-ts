import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  decodeExportedContact,
  encodeExportContact,
  encodeImportContact,
  encodeShareContact,
} from '../../src/features/contactInterop';

const hex = (b: Buffer) => b.toString('hex');
const PK = 'aa'.repeat(32);
const BLOB = 'bb'.repeat(98); // ≥98-byte advert blob

describe('contactInterop: encodeShareContact', () => {
  it('is [0x10][32B pubkey]', () => {
    expect(hex(encodeShareContact(PK))).toBe(`10${PK}`);
  });
  it('rejects a short pubkey', () => {
    expect(() => encodeShareContact('aabb')).toThrow(/32B/);
  });
});

describe('contactInterop: encodeExportContact', () => {
  it('is the bare opcode when exporting self', () => {
    expect(hex(encodeExportContact())).toBe('11');
  });
  it('appends the 32B pubkey when exporting a contact', () => {
    expect(hex(encodeExportContact(PK))).toBe(`11${PK}`);
  });
  it('rejects a short pubkey', () => {
    expect(() => encodeExportContact('aabb')).toThrow(/32B/);
  });
});

describe('contactInterop: encodeImportContact', () => {
  it('is [0x12][blob]', () => {
    expect(hex(encodeImportContact(BLOB))).toBe(`12${BLOB}`);
  });
  it('rejects a blob shorter than 98 bytes', () => {
    expect(() => encodeImportContact('bb'.repeat(97))).toThrow(/98/);
  });
});

describe('contactInterop: decodeExportedContact', () => {
  it('returns the blob hex after the code byte, or null when empty', () => {
    const frame = Buffer.concat([Buffer.from([0x0b]), Buffer.from(BLOB, 'hex')]);
    expect(decodeExportedContact(frame)).toBe(BLOB);
    expect(decodeExportedContact(Buffer.from([0x0b]))).toBeNull();
  });
});
