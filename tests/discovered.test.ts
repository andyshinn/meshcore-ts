import { describe, expect, it } from 'vitest';
import { advTypeToKind, hashSizeFromOutPathLen, hopsFromOutPathLen } from '../src/model/contacts';

// out_path_len is the packed MeshCore path-length byte: bits 5-0 = hop count,
// bits 7-6 = hashSize-1. The hop count is the low 6 bits, NOT the raw byte.
describe('hopsFromOutPathLen', () => {
  it('treats 0xFF (OUT_PATH_UNKNOWN) as undefined', () => {
    expect(hopsFromOutPathLen(0xff)).toBeUndefined();
  });

  it('returns 0 for a direct (zero-hop) path in 1-byte mode', () => {
    expect(hopsFromOutPathLen(0x00)).toBe(0);
  });

  it('reads the low 6 bits as the hop count in 1-byte mode', () => {
    expect(hopsFromOutPathLen(0x02)).toBe(2); // 2 hops, 1-byte
  });

  it('returns 0 for a direct (zero-hop) 2-byte path (0x40), not 64', () => {
    expect(hopsFromOutPathLen(0x40)).toBe(0);
  });

  it('reads the hop count from a 2-byte path (0x41 → 1, 0x43 → 3)', () => {
    expect(hopsFromOutPathLen(0x41)).toBe(1);
    expect(hopsFromOutPathLen(0x43)).toBe(3);
  });

  it('reads the hop count from a 3-byte path (0x82 → 2)', () => {
    expect(hopsFromOutPathLen(0x82)).toBe(2);
  });
});

// hashSize is (bits 7-6) + 1: 0x00-0x3F → 1B, 0x40-0x7F → 2B, 0x80-0xBF → 3B.
describe('hashSizeFromOutPathLen', () => {
  it('treats 0xFF (OUT_PATH_UNKNOWN) as undefined', () => {
    expect(hashSizeFromOutPathLen(0xff)).toBeUndefined();
  });

  it('returns 1 for a 1-byte path', () => {
    expect(hashSizeFromOutPathLen(0x02)).toBe(1);
  });

  it('returns 2 for a 2-byte path (direct or multi-hop)', () => {
    expect(hashSizeFromOutPathLen(0x40)).toBe(2);
    expect(hashSizeFromOutPathLen(0x41)).toBe(2);
  });

  it('returns 3 for a 3-byte path', () => {
    expect(hashSizeFromOutPathLen(0x82)).toBe(3);
  });
});

describe('advTypeToKind', () => {
  it('maps 2 to repeater', () => {
    expect(advTypeToKind(2)).toBe('repeater');
  });

  it('maps 3 to room', () => {
    expect(advTypeToKind(3)).toBe('room');
  });

  it('maps 4 to sensor', () => {
    expect(advTypeToKind(4)).toBe('sensor');
  });

  it('maps 1 to chat', () => {
    expect(advTypeToKind(1)).toBe('chat');
  });

  it('defaults unknown types to chat', () => {
    expect(advTypeToKind(0)).toBe('chat');
    expect(advTypeToKind(99)).toBe('chat');
  });
});
