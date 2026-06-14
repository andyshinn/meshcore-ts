import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  decodeDefaultFloodScope,
  encodeClearDefaultFloodScope,
  encodeGetDefaultFloodScope,
  encodeSetDefaultFloodScope,
  encodeSetFloodScopeKey,
} from '../../src/features/floodScope';

const hex = (b: Buffer) => b.toString('hex');
const KEY = 'aa'.repeat(16);

describe('floodScope: encodeSetFloodScopeKey', () => {
  it('sets the override key: [0x36][0x00][16B key]', () => {
    expect(hex(encodeSetFloodScopeKey({ keyHex: KEY }))).toBe(`3600${KEY}`);
  });

  it('clears the override key: [0x36][0x00]', () => {
    expect(hex(encodeSetFloodScopeKey({ clear: true }))).toBe('3600');
  });

  it('goes unscoped: [0x36][0x01]', () => {
    expect(hex(encodeSetFloodScopeKey({ unscoped: true }))).toBe('3601');
  });

  it('rejects a key that is not 16 bytes', () => {
    expect(() => encodeSetFloodScopeKey({ keyHex: 'aabb' })).toThrow(/16 bytes/);
  });
});

describe('floodScope: encodeSetDefaultFloodScope', () => {
  it('lays out [0x3f][name 31B null-padded][key 16B]', () => {
    const out = encodeSetDefaultFloodScope('Public', 'bb'.repeat(16));
    expect(out.length).toBe(48);
    expect(out[0]).toBe(0x3f);
    const nameRegion = out.subarray(1, 32);
    expect(nameRegion.subarray(0, nameRegion.indexOf(0)).toString('utf8')).toBe('Public');
    expect(out.subarray(32, 48).toString('hex')).toBe('bb'.repeat(16));
  });

  it('rejects an empty name, an over-long name, and a bad key', () => {
    expect(() => encodeSetDefaultFloodScope('', 'bb'.repeat(16))).toThrow(/1-30/);
    expect(() => encodeSetDefaultFloodScope('x'.repeat(31), 'bb'.repeat(16))).toThrow(/1-30/);
    expect(() => encodeSetDefaultFloodScope('ok', 'bb')).toThrow(/16 bytes/);
  });
});

describe('floodScope: bare opcodes', () => {
  it('clear is [0x3f], get is [0x40]', () => {
    expect(hex(encodeClearDefaultFloodScope())).toBe('3f');
    expect(hex(encodeGetDefaultFloodScope())).toBe('40');
  });
});

describe('floodScope: decodeDefaultFloodScope', () => {
  it('reads name + key from the 48-byte set form', () => {
    const frame = Buffer.alloc(48);
    frame[0] = 0x1c;
    Buffer.from('General', 'utf8').copy(frame, 1);
    Buffer.alloc(16, 0xcd).copy(frame, 32);
    expect(decodeDefaultFloodScope(frame)).toEqual({ name: 'General', keyHex: 'cd'.repeat(16) });
  });

  it('returns null for the 1-byte no-scope form', () => {
    expect(decodeDefaultFloodScope(Buffer.from([0x1c]))).toBeNull();
  });
});
