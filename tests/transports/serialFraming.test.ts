import { describe, expect, it } from 'vitest';
import { encodeSerialFrame, SerialDeframer } from '../../src/transports/serialFraming';

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

// Build a device→host wire frame: [0x3e][len LE][payload].
function wire(payload: number[]): number[] {
  const len = payload.length;
  return [0x3e, len & 0xff, (len >> 8) & 0xff, ...payload];
}

describe('SerialDeframer', () => {
  it('decodes one complete frame in a single chunk', () => {
    const d = new SerialDeframer();
    const frames = d.push(Uint8Array.from(wire([1, 2, 3])));
    expect(frames.map((f) => [...f])).toEqual([[1, 2, 3]]);
  });

  it('decodes multiple frames coalesced in one chunk', () => {
    const d = new SerialDeframer();
    const frames = d.push(Uint8Array.from([...wire([1, 2]), ...wire([9])]));
    expect(frames.map((f) => [...f])).toEqual([[1, 2], [9]]);
  });

  it('reassembles a frame delivered one byte at a time', () => {
    const d = new SerialDeframer();
    const bytes = wire([7, 8, 9]);
    const collected: number[][] = [];
    for (const b of bytes) collected.push(...d.push(Uint8Array.from([b])).map((f) => [...f]));
    expect(collected).toEqual([[7, 8, 9]]);
  });

  it('holds a partial frame until the rest arrives', () => {
    const d = new SerialDeframer();
    const full = wire([1, 2, 3, 4]);
    expect(d.push(Uint8Array.from(full.slice(0, 4)))).toEqual([]); // header + 1 byte
    const frames = d.push(Uint8Array.from(full.slice(4)));
    expect(frames.map((f) => [...f])).toEqual([[1, 2, 3, 4]]);
  });

  it('resyncs past leading garbage', () => {
    const d = new SerialDeframer();
    const frames = d.push(Uint8Array.from([0x00, 0xff, 0x12, ...wire([5, 6])]));
    expect(frames.map((f) => [...f])).toEqual([[5, 6]]);
  });

  it('accepts the 0x3c type byte too (reference tolerance)', () => {
    const d = new SerialDeframer();
    const frames = d.push(Uint8Array.from([0x3c, 0x01, 0x00, 0x42]));
    expect(frames.map((f) => [...f])).toEqual([[0x42]]);
  });

  it('treats a zero-length header as garbage and resyncs', () => {
    const d = new SerialDeframer();
    // 0x3e,0x00,0x00 is dropped one byte at a time; a real frame follows.
    const frames = d.push(Uint8Array.from([0x3e, 0x00, 0x00, ...wire([1])]));
    expect(frames.map((f) => [...f])).toEqual([[1]]);
  });

  it('rejects an oversized length (> maxFrameBytes) and resyncs instead of buffering', () => {
    const d = new SerialDeframer({ maxFrameBytes: 8 });
    // Declares length 0xffff — must NOT wait for 65k bytes; drop and resync.
    const frames = d.push(Uint8Array.from([0x3e, 0xff, 0xff, ...wire([4, 5])]));
    expect(frames.map((f) => [...f])).toEqual([[4, 5]]);
  });

  it('decodes a max-size 176-byte frame', () => {
    const d = new SerialDeframer();
    const payload = Array.from({ length: 176 }, (_, i) => i & 0xff);
    const frames = d.push(Uint8Array.from(wire(payload)));
    expect(frames.length).toBe(1);
    expect(frames[0].length).toBe(176);
  });

  it('round-trips an encoded frame back through the de-framer', () => {
    const d = new SerialDeframer();
    const encoded = encodeSerialFrame(Uint8Array.from([0xde, 0xad, 0xbe, 0xef]));
    expect(d.push(encoded).map((f) => [...f])).toEqual([[0xde, 0xad, 0xbe, 0xef]]);
  });

  it('reset() drops any buffered partial frame', () => {
    const d = new SerialDeframer();
    d.push(Uint8Array.from([0x3e, 0x04, 0x00, 0x01])); // partial
    d.reset();
    const frames = d.push(Uint8Array.from(wire([2])));
    expect(frames.map((f) => [...f])).toEqual([[2]]);
  });
});
