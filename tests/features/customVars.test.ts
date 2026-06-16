import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { decodeCustomVars, encodeGetCustomVar, encodeSetCustomVar } from '../../src/features/customVars';

const hex = (b: Buffer) => b.toString('hex');

describe('customVars encode/decode', () => {
  it('encodeGetCustomVar appends the key, or bare opcode for empty key', () => {
    expect(hex(encodeGetCustomVar())).toBe('28');
    expect(hex(encodeGetCustomVar('gps'))).toBe('28677073');
  });

  it('encodeSetCustomVar formats "key:value" with boolean → 1/0', () => {
    expect(hex(encodeSetCustomVar('gps', true))).toBe('296770733a31');
  });

  it('decodeCustomVars parses comma-separated key:value pairs (firmware format)', () => {
    const frame = Buffer.concat([Buffer.from([0x15]), Buffer.from('gps:1,gps_interval:60', 'utf8')]);
    expect(decodeCustomVars(frame)).toEqual({ gps: '1', gps_interval: '60' });
  });

  it('decodeCustomVars parses a single key:value entry', () => {
    const frame = Buffer.concat([Buffer.from([0x15]), Buffer.from('gps:1', 'utf8')]);
    expect(decodeCustomVars(frame)).toEqual({ gps: '1' });
  });

  it('decodeCustomVars preserves colons in values (only first colon is the separator)', () => {
    const frame = Buffer.concat([Buffer.from([0x15]), Buffer.from('url:http://localhost:8080', 'utf8')]);
    expect(decodeCustomVars(frame)).toEqual({ url: 'http://localhost:8080' });
  });

  it('decodeCustomVars tolerates legacy newline-separated entries', () => {
    const frame = Buffer.concat([Buffer.from([0x15]), Buffer.from('gps:1\ngps_interval:30', 'utf8')]);
    expect(decodeCustomVars(frame)).toEqual({ gps: '1', gps_interval: '30' });
  });

  it('decodeCustomVars returns an empty object for a too-short frame', () => {
    expect(decodeCustomVars(Buffer.from([0x15]))).toEqual({});
  });
});
