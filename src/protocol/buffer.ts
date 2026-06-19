import { Buffer } from 'node:buffer';

/** Cursor-based reader for MeshCore companion frames. Replaces hardcoded
 *  absolute offsets (e.g. `frame.readUInt32LE(132)`) so variable-length frames
 *  decode without off-by-one risk. Ported from meshcore.js's BufferReader. */
export class BufferReader {
  private pos = 0;
  constructor(private readonly buf: Buffer) {}

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  readByte(): number {
    return this.buf.readUInt8(this.pos++);
  }
  readInt8(): number {
    return this.buf.readInt8(this.pos++);
  }
  readUInt16LE(): number {
    const v = this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }
  readInt16LE(): number {
    const v = this.buf.readInt16LE(this.pos);
    this.pos += 2;
    return v;
  }
  readUInt32LE(): number {
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  readInt32LE(): number {
    const v = this.buf.readInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  /** 24-bit big-endian signed — used by CayenneLPP GPS fields. */
  readInt24BE(): number {
    let v = (this.readByte() << 16) | (this.readByte() << 8) | this.readByte();
    if ((v & 0x800000) !== 0) v -= 0x1000000;
    return v;
  }
  readBytes(n: number): Buffer {
    if (n > this.remaining) {
      throw new RangeError(`BufferReader: requested ${n} bytes but only ${this.remaining} remain`);
    }
    const v = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
  readRemaining(): Buffer {
    return this.readBytes(this.remaining);
  }
  readString(): string {
    return this.readRemaining().toString('utf8');
  }
  /** Fixed-width null-padded string: consumes exactly `maxLen` bytes, returns
   *  the text up to the first null. */
  readCString(maxLen: number): string {
    const slice = this.readBytes(maxLen);
    const nul = slice.indexOf(0);
    return slice.subarray(0, nul === -1 ? maxLen : nul).toString('utf8');
  }
}

/** Cursor-based writer producing MeshCore companion frames. Methods chain. */
export class BufferWriter {
  private readonly bytes: number[] = [];

  writeByte(b: number): this {
    this.bytes.push(b & 0xff);
    return this;
  }
  writeInt8(b: number): this {
    return this.writeByte(b);
  }
  writeUInt16LE(n: number): this {
    this.bytes.push(n & 0xff, (n >>> 8) & 0xff);
    return this;
  }
  writeUInt32LE(n: number): this {
    const v = n >>> 0;
    this.bytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
    return this;
  }
  writeInt32LE(n: number): this {
    return this.writeUInt32LE(n >>> 0);
  }
  writeBytes(b: Buffer | readonly number[]): this {
    for (const x of b) this.bytes.push(x & 0xff);
    return this;
  }
  writeString(s: string): this {
    return this.writeBytes(Buffer.from(s, 'utf8'));
  }
  /** Fixed-width null-padded string: writes exactly `maxLen` bytes, always
   *  null-terminated (last byte forced to 0). */
  writeCString(s: string, maxLen: number): this {
    const out = Buffer.alloc(maxLen);
    // Fixed-width truncation at a byte boundary (matches firmware char arrays);
    // may split a multi-byte UTF-8 codepoint, same as the device.
    Buffer.from(s, 'utf8').copy(out, 0, 0, maxLen - 1);
    out[maxLen - 1] = 0;
    return this.writeBytes(out);
  }
  toBuffer(): Buffer {
    return Buffer.from(this.bytes);
  }
}
