import { describe, expect, it } from 'vitest';
import { encodeSerialFrame } from '../../src/transports/serialFraming';

describe('encodeSerialFrame', () => {
  it('wraps a payload as [0x3c][len uint16 LE][payload]', () => {
    const out = encodeSerialFrame(Uint8Array.from([0xaa, 0xbb, 0xcc]));
    expect([...out]).toEqual([0x3c, 0x03, 0x00, 0xaa, 0xbb, 0xcc]);
  });

  it('encodes the length little-endian for a multi-byte length', () => {
    const out = encodeSerialFrame(new Uint8Array(300)); // 300 = 0x012c
    expect([out[0], out[1], out[2]]).toEqual([0x3c, 0x2c, 0x01]);
    expect(out.length).toBe(303);
  });

  it('encodes an empty payload as a bare header', () => {
    expect([...encodeSerialFrame(new Uint8Array(0))]).toEqual([0x3c, 0x00, 0x00]);
  });
});
