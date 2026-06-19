import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type MeshObservation, MeshObservations } from '../src/model/meshObservations';

// Anchor all timestamps to a fixed wall clock so consumeMatching's internal
// Date.now()-based eviction doesn't sweep the (otherwise fresh) observations.
const NOW = 1_700_000_000_000;

function obs(over: Partial<MeshObservation> = {}): MeshObservation {
  return {
    recordedAt: NOW,
    channelHash: 0x42,
    hashSize: 1,
    hashCount: 2,
    pathHex: 'aabb',
    finalSnr: -5,
    payloadFingerprint: 'fp-a',
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MeshObservations.record / consumeMatching', () => {
  it('returns and removes observations matching channelHash + hashCount', () => {
    const store = new MeshObservations();
    store.record(obs({ channelHash: 0x42, hashCount: 2 }));
    store.record(obs({ channelHash: 0x42, hashCount: 2, pathHex: 'ccdd' }));
    expect(store.size()).toBe(2);

    const taken = store.consumeMatching(0x42, 2);
    expect(taken).toHaveLength(2);
    expect(taken.map((o) => o.pathHex).sort()).toEqual(['aabb', 'ccdd']);
    // Consumed → removed from the buffer.
    expect(store.size()).toBe(0);
    expect(store.consumeMatching(0x42, 2)).toEqual([]);
  });

  it('does not return non-matching observations and keeps them buffered', () => {
    const store = new MeshObservations();
    store.record(obs({ channelHash: 0x42, hashCount: 2 }));
    store.record(obs({ channelHash: 0x99, hashCount: 2 })); // wrong channel
    store.record(obs({ channelHash: 0x42, hashCount: 7 })); // wrong hop count

    const taken = store.consumeMatching(0x42, 2);
    expect(taken).toHaveLength(1);
    expect(taken[0].channelHash).toBe(0x42);
    expect(taken[0].hashCount).toBe(2);
    // The two non-matching observations stay.
    expect(store.size()).toBe(2);
  });

  it('returns [] when nothing matches', () => {
    const store = new MeshObservations();
    store.record(obs({ channelHash: 0x01 }));
    expect(store.consumeMatching(0x42, 2)).toEqual([]);
    expect(store.size()).toBe(1);
  });

  it('only returns the freshest fingerprint cluster, keeping the older one', () => {
    const store = new MeshObservations();
    // Older message (fp-old) and a fresher message (fp-new) on the same
    // channel + hop count, all within the TTL window.
    store.record(obs({ recordedAt: NOW - 2000, payloadFingerprint: 'fp-old', pathHex: 'old1' }));
    store.record(obs({ recordedAt: NOW - 1000, payloadFingerprint: 'fp-new', pathHex: 'new1' }));
    store.record(obs({ recordedAt: NOW, payloadFingerprint: 'fp-new', pathHex: 'new2' }));

    const taken = store.consumeMatching(0x42, 2);
    expect(taken.every((o) => o.payloadFingerprint === 'fp-new')).toBe(true);
    expect(taken.map((o) => o.pathHex).sort()).toEqual(['new1', 'new2']);
    // The older cluster is kept for a future consume.
    expect(store.size()).toBe(1);
    const leftover = store.consumeMatching(0x42, 2);
    expect(leftover.map((o) => o.payloadFingerprint)).toEqual(['fp-old']);
  });

  it('evicts observations older than the 60s TTL on record', () => {
    const store = new MeshObservations();
    store.record(obs({ recordedAt: NOW }));
    // 61s later — the first observation is past TTL and evicted on the next record.
    store.record(obs({ recordedAt: NOW + 61_000, pathHex: 'fresh' }));
    expect(store.size()).toBe(1);
  });

  it('caps the buffer at CAP+1 since eviction runs before each push', () => {
    const store = new MeshObservations();
    // The donor evicts to CAP *before* appending, so after a burst of records
    // with no intervening eviction the buffer settles at CAP + 1.
    for (let i = 0; i < 300; i++) {
      store.record(obs({ recordedAt: NOW + i }));
    }
    expect(store.size()).toBe(257);
  });

  it('clear empties the buffer', () => {
    const store = new MeshObservations();
    store.record(obs());
    store.clear();
    expect(store.size()).toBe(0);
  });

  it('evicts stale entries before matching in consumeMatching', () => {
    const store = new MeshObservations();
    store.record(obs({ recordedAt: NOW, channelHash: 0x42, hashCount: 2 }));
    // Advance wall clock past the TTL so consumeMatching evicts before matching.
    vi.setSystemTime(NOW + 61_000);
    expect(store.consumeMatching(0x42, 2)).toEqual([]);
    expect(store.size()).toBe(0);
  });
});
