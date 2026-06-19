import { describe, expect, it } from 'vitest';
import { buildPath, channelHashOf } from '../src/model/paths';
import type { Channel } from '../src/model/types';

function channel(secretHex?: string): Channel {
  return { key: 'ch:test', name: 'test', kind: 'public', secretHex };
}

describe('channelHashOf', () => {
  it('returns null when there is no secret', () => {
    expect(channelHashOf(channel(undefined))).toBeNull();
    expect(channelHashOf(channel(''))).toBeNull();
  });

  it('returns a single byte (0..255), deterministic for the same secret', () => {
    const h1 = channelHashOf(channel('00112233445566778899aabbccddeeff'));
    const h2 = channelHashOf(channel('00112233445566778899aabbccddeeff'));
    expect(h1).toBe(h2);
    expect(h1).toBeGreaterThanOrEqual(0);
    expect(h1).toBeLessThanOrEqual(255);
    expect(h1).toBe(168); // golden: sha256(secret bytes)[0]
  });
});

describe('buildPath', () => {
  it('builds origin → one hop per (hashSize*2) hex chars → sink', () => {
    const path = buildPath('aabb', 1, -7.5, 'Alice', 'My Node');
    expect(path.hops.map((h) => h.kind)).toEqual(['origin', 'hop', 'hop', 'sink']);
    expect(path.hops[0].name).toBe('Alice');
    expect(path.hops[0].shortId).toBe('al'); // first 2 chars, lowercased
    expect(path.hops[0].unnamed).toBe(false);
    expect(path.hops[1].unnamed).toBe(true);
    expect(path.hops[1].shortId).toBe('aa');
    expect(path.hops[2].shortId).toBe('bb');
    expect(path.hops[3].kind).toBe('sink');
    expect(path.hops[3].name).toBe('My Node');
    expect(path.hashMode).toBe(1);
    expect(path.finalSnr).toBe(-7.5);
    expect(path.id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('marks the origin unnamed when there is no sender name', () => {
    const path = buildPath('', 1, 0, null, undefined);
    expect(path.hops[0].unnamed).toBe(true);
    expect(path.hops[0].shortId).toBe('??');
    // No path bytes → just origin + sink.
    expect(path.hops.map((h) => h.kind)).toEqual(['origin', 'sink']);
    expect(path.hops[1].shortId).toBe('me');
  });

  it('groups hop hex by a 2-byte hash size', () => {
    const path = buildPath('aabbccdd', 2, 0, 'X', 'Y');
    const hops = path.hops.filter((h) => h.kind === 'hop');
    expect(hops.map((h) => h.shortId)).toEqual(['aabb', 'ccdd']);
  });
});
