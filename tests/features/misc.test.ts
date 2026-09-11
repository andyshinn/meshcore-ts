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

  it('decodes the firmware default three-range table', () => {
    const frame = Buffer.alloc(1 + 24);
    frame[0] = 0x1a;
    for (const [i, [lower, upper]] of [
      [433_000, 433_000],
      [869_495, 869_495],
      [918_000, 918_000],
    ].entries()) {
      frame.writeUInt32LE(lower, 1 + i * 8);
      frame.writeUInt32LE(upper, 5 + i * 8);
    }
    expect(decodeAllowedRepeatFreq(frame)).toEqual([
      { lowerKhz: 433_000, upperKhz: 433_000 },
      { lowerKhz: 869_495, upperKhz: 869_495 },
      { lowerKhz: 918_000, upperKhz: 918_000 },
    ]);
  });

  it('stops at a zero entry rather than reporting padding as ranges', () => {
    const frame = Buffer.alloc(1 + 24); // two real ranges + an all-zero pair
    frame[0] = 0x1a;
    frame.writeUInt32LE(902_000, 1);
    frame.writeUInt32LE(928_000, 5);
    frame.writeUInt32LE(868_000, 9);
    frame.writeUInt32LE(870_000, 13);
    expect(decodeAllowedRepeatFreq(frame)).toEqual([
      { lowerKhz: 902_000, upperKhz: 928_000 },
      { lowerKhz: 868_000, upperKhz: 870_000 },
    ]);
  });

  it('treats either bound being zero as end-of-list and drops anything after it', () => {
    const frame = Buffer.alloc(1 + 24);
    frame[0] = 0x1a;
    frame.writeUInt32LE(433_000, 1);
    frame.writeUInt32LE(433_000, 5);
    frame.writeUInt32LE(869_495, 9); // lower set, upper zero -> sentinel
    frame.writeUInt32LE(0, 13);
    frame.writeUInt32LE(918_000, 17); // never reached
    frame.writeUInt32LE(918_000, 21);
    expect(decodeAllowedRepeatFreq(frame)).toEqual([{ lowerKhz: 433_000, upperKhz: 433_000 }]);
  });

  it('keeps complete ranges when the frame ends in a partial chunk', () => {
    const frame = Buffer.alloc(1 + 8 + 3);
    frame[0] = 0x1a;
    frame.writeUInt32LE(902_000, 1);
    frame.writeUInt32LE(928_000, 5);
    frame.writeUInt8(0xff, 9); // 3 leftover bytes, not a whole pair
    frame.writeUInt8(0xff, 10);
    frame.writeUInt8(0xff, 11);
    expect(decodeAllowedRepeatFreq(frame)).toEqual([{ lowerKhz: 902_000, upperKhz: 928_000 }]);
  });
});
