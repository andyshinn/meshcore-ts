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

  it('decodes N×[lower u32 LE][upper u32 LE] ranges', () => {
    const frame = Buffer.alloc(1 + 16);
    frame[0] = 0x1a;
    frame.writeUInt32LE(902_000_000, 1);
    frame.writeUInt32LE(928_000_000, 5);
    frame.writeUInt32LE(868_000_000, 9);
    frame.writeUInt32LE(870_000_000, 13);
    expect(decodeAllowedRepeatFreq(frame)).toEqual([
      { lowerHz: 902_000_000, upperHz: 928_000_000 },
      { lowerHz: 868_000_000, upperHz: 870_000_000 },
    ]);
  });

  it('returns [] for the bare reply and ignores trailing partial bytes', () => {
    expect(decodeAllowedRepeatFreq(Buffer.from([0x1a]))).toEqual([]);
    expect(decodeAllowedRepeatFreq(Buffer.from([0x1a, 0x01, 0x02, 0x03]))).toEqual([]);
  });
});
