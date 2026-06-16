import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { decodeAllowedRepeatFreq, encodeGetAllowedRepeatFreq, encodeHasConnection } from '../../src/features/misc';

const hex = (b: Buffer) => b.toString('hex');
const PK = 'aa'.repeat(32);

describe('misc: encodeHasConnection', () => {
  it('is [0x1c][32B pubkey]', () => {
    expect(hex(encodeHasConnection(PK))).toBe(`1c${PK}`);
  });
  it('rejects a pubkey shorter than 32 bytes', () => {
    expect(() => encodeHasConnection('aabb')).toThrow(/32B/);
  });
});

describe('misc: getAllowedRepeatFreq', () => {
  it('encodeGetAllowedRepeatFreq is the bare opcode', () => {
    expect(hex(encodeGetAllowedRepeatFreq())).toBe('3c');
  });

  it('decodes N×[lower u32 LE][upper u32 LE] ranges, values in kHz', () => {
    // Firmware sends kHz: 433000 = 433 MHz, 869495 = 869.495 MHz, 918000 = 918 MHz.
    const frame = Buffer.alloc(1 + 16);
    frame[0] = 0x1a;
    frame.writeUInt32LE(433_000, 1); // 433 MHz
    frame.writeUInt32LE(433_000, 5); // 433 MHz (single-channel range)
    frame.writeUInt32LE(869_495, 9); // 869.495 MHz
    frame.writeUInt32LE(918_000, 13); // 918 MHz
    expect(decodeAllowedRepeatFreq(frame)).toEqual([
      { lowerKhz: 433_000, upperKhz: 433_000 }, // 433 MHz band
      { lowerKhz: 869_495, upperKhz: 918_000 }, // EU/US range
    ]);
  });

  it('decodes two ranges using real firmware kHz values', () => {
    const frame = Buffer.alloc(1 + 16);
    frame[0] = 0x1a;
    frame.writeUInt32LE(902_000, 1); // 902 MHz
    frame.writeUInt32LE(928_000, 5); // 928 MHz
    frame.writeUInt32LE(868_000, 9); // 868 MHz
    frame.writeUInt32LE(870_000, 13); // 870 MHz
    expect(decodeAllowedRepeatFreq(frame)).toEqual([
      { lowerKhz: 902_000, upperKhz: 928_000 },
      { lowerKhz: 868_000, upperKhz: 870_000 },
    ]);
  });

  it('returns [] for the bare reply and ignores trailing partial bytes', () => {
    expect(decodeAllowedRepeatFreq(Buffer.from([0x1a]))).toEqual([]);
    expect(decodeAllowedRepeatFreq(Buffer.from([0x1a, 0x01, 0x02, 0x03]))).toEqual([]);
  });
});
