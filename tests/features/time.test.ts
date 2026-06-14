import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { decodeCurrTime, encodeGetDeviceTime, encodeSetDeviceTime } from '../../src/features/time';

describe('time feature encode/decode', () => {
  it('encodeGetDeviceTime is the bare opcode', () => {
    expect(encodeGetDeviceTime().toString('hex')).toBe('05');
  });

  it('encodeSetDeviceTime is [0x06][epoch u32 LE]', () => {
    expect(encodeSetDeviceTime(0x01020304).toString('hex')).toBe('06' + '04030201');
  });

  it('decodeCurrTime reads the little-endian epoch after the code byte', () => {
    expect(decodeCurrTime(Buffer.from([0x09, 0x04, 0x03, 0x02, 0x01]))).toBe(0x01020304);
  });

  it('decodeCurrTime returns null for a short frame', () => {
    expect(decodeCurrTime(Buffer.from([0x09, 0x04]))).toBeNull();
  });
});
