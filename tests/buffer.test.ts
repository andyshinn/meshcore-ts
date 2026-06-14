import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { BufferReader, BufferWriter } from '../src/buffer';

describe('BufferWriter', () => {
  it('writes little-endian integers and bytes in order', () => {
    const buf = new BufferWriter()
      .writeByte(0x06)
      .writeUInt32LE(0x01020304)
      .writeUInt16LE(0x0a0b)
      .writeBytes(Buffer.from([0xff, 0xfe]))
      .toBuffer();
    expect(buf.toString('hex')).toBe('06' + '04030201' + '0b0a' + 'fffe');
  });

  it('writeCString pads to maxLen and always null-terminates', () => {
    const buf = new BufferWriter().writeCString('hi', 4).toBuffer();
    expect([...buf]).toEqual([0x68, 0x69, 0x00, 0x00]);
  });

  it('writeCString truncates and keeps a trailing null', () => {
    const buf = new BufferWriter().writeCString('abcd', 3).toBuffer();
    expect(buf.length).toBe(3);
    expect(buf[2]).toBe(0x00);
  });

  it('writeString encodes utf8 text', () => {
    expect(new BufferWriter().writeString('hi').toBuffer().toString('hex')).toBe('6869');
  });
});

describe('BufferReader', () => {
  it('round-trips what BufferWriter produced', () => {
    const r = new BufferReader(new BufferWriter().writeByte(0x09).writeUInt32LE(0x01020304).toBuffer());
    expect(r.readByte()).toBe(0x09);
    expect(r.readUInt32LE()).toBe(0x01020304);
    expect(r.remaining).toBe(0);
  });

  it('reads signed 8/16/32 and 24-bit big-endian', () => {
    const r = new BufferReader(Buffer.from([0xff, 0xff, 0xff, 0x80, 0x00, 0x00]));
    expect(r.readInt8()).toBe(-1);
    expect(r.readInt16LE()).toBe(-1);
    expect(r.readInt24BE()).toBe(-0x800000);
  });

  it('readCString stops at the first null and consumes maxLen', () => {
    const r = new BufferReader(Buffer.from([0x68, 0x69, 0x00, 0x7a, 0x55]));
    expect(r.readCString(4)).toBe('hi');
    expect(r.remaining).toBe(1);
    expect(r.readByte()).toBe(0x55);
  });

  it('readString returns the utf8 text of the remaining bytes', () => {
    const r = new BufferReader(Buffer.from('hello', 'utf8'));
    expect(r.readString()).toBe('hello');
    expect(r.remaining).toBe(0);
  });

  it('readBytes throws a clear error on underrun', () => {
    const r = new BufferReader(Buffer.from([0x01, 0x02]));
    expect(() => r.readBytes(3)).toThrow(/only 2 remain/);
  });
});
