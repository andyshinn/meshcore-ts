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

  it('decodeAutoAddConfig returns flagsByte and radioMaxHops, null on short frame', () => {
    expect(decodeAutoAddConfig(Buffer.from([0x19, 0x1f]))).toEqual({ flagsByte: 0x1f, radioMaxHops: 0 });
    expect(decodeAutoAddConfig(Buffer.from([0x19]))).toBeNull();
  });

  it('decodeAutoAddConfig reads radioMaxHops from 3-byte frame', () => {
    expect(decodeAutoAddConfig(Buffer.from([0x19, 0x12, 0x05]))).toEqual({ flagsByte: 0x12, radioMaxHops: 5 });
  });

  it('encodeSetAutoAddConfig without radioMaxHops emits 2-byte payload', () => {
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

  it('encodeSetAutoAddConfig with radioMaxHops emits 3-byte payload', () => {
    expect(
      encodeSetAutoAddConfig({
        chat: true,
        repeater: true,
        room: true,
        sensor: true,
        overwriteOldest: true,
        radioMaxHops: 3,
      }).toString('hex'),
    ).toBe('3a1f03');
  });

  it('encodeSetAutoAddConfig with radioMaxHops 0 emits 3-byte payload', () => {
    expect(
      encodeSetAutoAddConfig({
        chat: false,
        repeater: false,
        room: false,
        sensor: false,
        overwriteOldest: false,
        radioMaxHops: 0,
      }).toString('hex'),
    ).toBe('3a0000');
  });
});
