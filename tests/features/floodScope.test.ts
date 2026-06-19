import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  decodeDefaultFloodScope,
  deriveFloodScopeKey,
  encodeClearDefaultFloodScope,
  encodeGetDefaultFloodScope,
  encodeSetDefaultFloodScope,
  encodeSetFloodScopeKey,
} from '../../src/features/floodScope';
import { CMD } from '../../src/protocol/codes';
import { makeSession } from '../support/harness';

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

describe('floodScope: deriveFloodScopeKey', () => {
  const sha16 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 32);

  it('returns the first 16 bytes of SHA-256("#region") as hex', () => {
    expect(deriveFloodScopeKey('#MyRegion')).toBe(sha16('#MyRegion'));
    expect(deriveFloodScopeKey('#MyRegion')).toHaveLength(32);
    // golden vector: SHA-256('#MyRegion')[:16]
    expect(deriveFloodScopeKey('#MyRegion')).toBe('03dce792b80979a6e2c600a19f16e766');
  });

  it('prepends "#" when absent (so "Region" and "#Region" match)', () => {
    expect(deriveFloodScopeKey('Region')).toBe(sha16('#Region'));
    expect(deriveFloodScopeKey('Region')).toBe(deriveFloodScopeKey('#Region'));
  });
});

describe('floodScope: setFloodScopeRegion (session)', () => {
  it('writes CMD_SET_FLOOD_SCOPE_KEY with the derived 16-byte key', async () => {
    const { session, transport } = makeSession();
    // setFloodScopeRegion awaits the shared RESP_OK/ERR ack; feed the ack after
    // the frame lands, mirroring the setChannel test pattern.
    const promise = session.setFloodScopeRegion('#TestRegion');
    await vi.waitFor(() => expect(transport.sent).toHaveLength(1));
    transport.receive(Uint8Array.from([0x00])); // RESP_OK
    await promise;
    const sent = Buffer.from(transport.sent[0]);
    expect(sent[0]).toBe(CMD.SET_FLOOD_SCOPE_KEY);
    expect(sent[1]).toBe(0x00);
    expect(sent.subarray(2).toString('hex')).toBe(deriveFloodScopeKey('#TestRegion'));
    expect(sent.subarray(2)).toHaveLength(16);
  });
});
