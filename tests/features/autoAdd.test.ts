import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  autoAddByteToFlags,
  autoAddFlagsToByte,
  decodeAutoAddConfig,
  encodeGetAutoAddConfig,
  encodeSetAutoAddConfig,
} from '../../src/features/autoAdd';

describe('autoAdd encode/decode', () => {
  it('encodeGetAutoAddConfig is the bare opcode', () => {
    expect(encodeGetAutoAddConfig().toString('hex')).toBe('3b');
  });

  it('encodeSetAutoAddConfig appends the packed flags byte', () => {
    expect(
      encodeSetAutoAddConfig({
        chat: true,
        repeater: true,
        room: true,
        sensor: true,
        overwriteOldest: true,
      }).toString('hex'),
    ).toBe('3a1f');
  });

  it('flag byte ↔ struct round-trips', () => {
    for (const b of [0x00, 0x01, 0x12, 0x1f]) {
      expect(autoAddFlagsToByte(autoAddByteToFlags(b))).toBe(b);
    }
  });

  it('decodeAutoAddConfig returns the flags byte, null on short frame', () => {
    expect(decodeAutoAddConfig(Buffer.from([0x19, 0x1f]))).toBe(0x1f);
    expect(decodeAutoAddConfig(Buffer.from([0x19]))).toBeNull();
  });
});
