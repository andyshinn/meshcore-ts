import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { decodeTuningParams, encodeGetTuningParams, encodeSetTuningParams } from '../../src/features/tuning';

const hex = (b: Buffer) => b.toString('hex');

describe('tuning: encodeSetTuningParams', () => {
  it('lays out [0x15][rx×1000 u32 LE][airtime×1000 u32 LE]', () => {
    // rx 10 → 10000 = 0x2710 → LE 10270000; airtime 1 → 1000 = 0x03e8 → LE e8030000
    expect(hex(encodeSetTuningParams({ rxDelayBase: 10, airtimeFactor: 1 }))).toBe('1510270000e8030000');
  });

  it('rounds fractional params to the nearest milli-unit', () => {
    // rx 12.5 → 12500 = 0x30d4 → LE d4300000; airtime 2.345 → 2345 = 0x0929 → LE 29090000
    expect(hex(encodeSetTuningParams({ rxDelayBase: 12.5, airtimeFactor: 2.345 }))).toBe('15d430000029090000');
  });
});

describe('tuning: encodeGetTuningParams', () => {
  it('is the bare opcode', () => {
    expect(hex(encodeGetTuningParams())).toBe('2b');
  });
});

describe('tuning: decodeTuningParams', () => {
  it('reads rx + airtime and divides by 1000', () => {
    const frame = Buffer.alloc(9);
    frame[0] = 0x17;
    frame.writeUInt32LE(12500, 1);
    frame.writeUInt32LE(2345, 5);
    expect(decodeTuningParams(frame)).toEqual({ rxDelayBase: 12.5, airtimeFactor: 2.345 });
  });

  it('round-trips an encoded SET frame body shape', () => {
    const built = encodeSetTuningParams({ rxDelayBase: 7.25, airtimeFactor: 3 });
    // SET (0x15) and RESP (0x17) share the same body layout; swap the code byte.
    const resp = Buffer.from(built);
    resp[0] = 0x17;
    expect(decodeTuningParams(resp)).toEqual({ rxDelayBase: 7.25, airtimeFactor: 3 });
  });

  it('returns null below 9 bytes', () => {
    expect(decodeTuningParams(Buffer.alloc(8))).toBeNull();
  });
});
