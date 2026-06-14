import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  decodeSignature,
  decodeSignStart,
  encodeSignData,
  encodeSignFinish,
  encodeSignStart,
} from '../../src/features/signing';

const hex = (b: Buffer) => b.toString('hex');
const SIG = 'cd'.repeat(64); // 64-byte ed25519 signature

describe('signing encoders', () => {
  it('encodeSignStart is the bare opcode', () => {
    expect(hex(encodeSignStart())).toBe('21');
  });

  it('encodeSignFinish is the bare opcode', () => {
    expect(hex(encodeSignFinish())).toBe('23');
  });

  it('encodeSignData prefixes the chunk with the opcode', () => {
    expect(hex(encodeSignData(Buffer.from([0xaa, 0xbb, 0xcc])))).toBe('22aabbcc');
  });

  it('encodeSignData rejects an empty chunk (firmware needs ≥1 data byte)', () => {
    expect(() => encodeSignData(Buffer.alloc(0))).toThrow(/empty/i);
  });

  it('encodeSignData rejects a chunk larger than the frame limit', () => {
    expect(() => encodeSignData(Buffer.alloc(200))).toThrow(/too large|frame/i);
  });
});

describe('signing decoders', () => {
  it('decodeSignStart reads the max_len u32 LE at offset 2', () => {
    const frame = Buffer.from([0x13, 0x00, 0x00, 0x20, 0x00, 0x00]); // max_len = 8192
    expect(decodeSignStart(frame)).toEqual({ maxLen: 8192 });
  });

  it('decodeSignStart returns null below 6 bytes', () => {
    expect(decodeSignStart(Buffer.from([0x13, 0x00, 0x00]))).toBeNull();
  });

  it('decodeSignature returns the 64-byte signature hex, or null when short', () => {
    const frame = Buffer.concat([Buffer.from([0x14]), Buffer.from(SIG, 'hex')]);
    expect(decodeSignature(frame)).toBe(SIG);
    expect(decodeSignature(Buffer.from([0x14]))).toBeNull();
    expect(decodeSignature(Buffer.alloc(64))).toBeNull(); // 1 + 63 is one short
  });
});
