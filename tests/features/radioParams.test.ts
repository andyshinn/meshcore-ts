import type { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { encodeSetRadioParams, encodeSetRadioTxPower } from '../../src/features/radioParams';

const hex = (b: Buffer) => b.toString('hex');

describe('radioParams encode', () => {
  it('encodeSetRadioTxPower appends dBm', () => {
    expect(hex(encodeSetRadioTxPower(20))).toBe('0c14');
  });

  it('encodeSetRadioParams lays out freq/bw/sf/cr, repeat byte only when set', () => {
    const base = encodeSetRadioParams({
      frequencyHz: 915_000_000,
      bandwidthHz: 250_000,
      spreadingFactor: 11,
      codingRate: 5,
    });
    expect(base.length).toBe(11);
    expect(base[0]).toBe(0x0b);
    expect(base.readUInt32LE(1)).toBe(915_000_000);
    expect(base.readUInt32LE(5)).toBe(250_000);
    expect(base[9]).toBe(11);
    expect(base[10]).toBe(5);

    const withRepeat = encodeSetRadioParams({
      frequencyHz: 915_000_000,
      bandwidthHz: 250_000,
      spreadingFactor: 11,
      codingRate: 5,
      clientRepeat: true,
    });
    expect(withRepeat.length).toBe(12);
    expect(withRepeat[11]).toBe(1);
  });
});
