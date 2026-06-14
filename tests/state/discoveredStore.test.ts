import { describe, expect, it } from 'vitest';
import { DiscoveredStore } from '../../src/state/discoveredStore';

function record(over: Partial<Parameters<DiscoveredStore['upsert']>[0]> = {}) {
  return {
    publicKeyHex: 'aa'.repeat(32),
    type: 1,
    flags: 0,
    outPathLen: 2,
    outPathHex: 'abcd',
    name: 'Alice',
    lastAdvertUnix: 1000,
    gpsLat: 0,
    gpsLon: 0,
    lastmod: 1000,
    ...over,
  };
}

describe('DiscoveredStore.upsert', () => {
  it('inserts a new row keyed by publicKeyHex with snake_case fields', () => {
    const store = new DiscoveredStore();
    store.upsert(record(), { onRadio: false, nowMs: 5000, heardLive: true });
    const row = store.get('aa'.repeat(32));
    expect(row).not.toBeNull();
    expect(row?.pubkey).toBe('aa'.repeat(32));
    expect(row?.name).toBe('Alice');
    expect(row?.out_path_len).toBe(2);
    expect(row?.out_path_hex).toBe('abcd');
    expect(row?.last_advert_unix).toBe(1000);
    expect(row?.on_radio).toBe(0);
    expect(row?.favourite).toBe(0);
  });

  it('stamps first_heard_ms on first sighting and preserves it across later upserts', () => {
    const store = new DiscoveredStore();
    store.upsert(record(), { onRadio: false, nowMs: 5000, heardLive: true });
    expect(store.get('aa'.repeat(32))?.first_heard_ms).toBe(5000);
    store.upsert(record({ name: 'Alice2' }), { onRadio: true, nowMs: 9000, heardLive: true });
    const row = store.get('aa'.repeat(32));
    expect(row?.first_heard_ms).toBe(5000);
    expect(row?.name).toBe('Alice2');
    expect(row?.on_radio).toBe(1);
  });

  it('advances last_heard_ms only on a live advert (heardLive); a resync (heardLive=false) leaves it', () => {
    const store = new DiscoveredStore();
    store.upsert(record(), { onRadio: true, nowMs: 5000, heardLive: true });
    expect(store.get('aa'.repeat(32))?.last_heard_ms).toBe(5000);
    // resync at a later time but heardLive=false → must NOT bump last_heard_ms
    store.upsert(record(), { onRadio: true, nowMs: 9000, heardLive: false });
    expect(store.get('aa'.repeat(32))?.last_heard_ms).toBe(5000);
    // a real later live advert advances it
    store.upsert(record(), { onRadio: true, nowMs: 12000, heardLive: true });
    expect(store.get('aa'.repeat(32))?.last_heard_ms).toBe(12000);
  });

  it('keeps the favourite flag consistent: a re-advert cannot drop a favourite', () => {
    const store = new DiscoveredStore();
    store.upsert(record({ flags: 0x01 }), { onRadio: false, nowMs: 5000, heardLive: true });
    expect(store.get('aa'.repeat(32))?.favourite).toBe(1);
    // re-advert with flags=0 (favourite bit cleared) must preserve favourite
    store.upsert(record({ flags: 0 }), { onRadio: false, nowMs: 6000, heardLive: true });
    const row = store.get('aa'.repeat(32));
    expect(row).not.toBeNull();
    expect(row?.favourite).toBe(1);
    // flags bit 0 should reflect the preserved favourite
    expect((row?.flags ?? 0) & 1).toBe(1);
  });
});

describe('DiscoveredStore.list', () => {
  it('returns DiscoveredContact projections ordered by last_advert_unix desc', () => {
    const store = new DiscoveredStore();
    store.upsert(record({ publicKeyHex: 'aa'.repeat(32), lastAdvertUnix: 1000 }), {
      onRadio: false,
      nowMs: 1,
      heardLive: true,
    });
    store.upsert(record({ publicKeyHex: 'bb'.repeat(32), lastAdvertUnix: 3000 }), {
      onRadio: false,
      nowMs: 2,
      heardLive: true,
    });
    store.upsert(record({ publicKeyHex: 'cc'.repeat(32), lastAdvertUnix: 2000 }), {
      onRadio: false,
      nowMs: 3,
      heardLive: true,
    });
    const list = store.list(2);
    expect(list.map((c) => c.publicKeyHex)).toEqual(['bb'.repeat(32), 'cc'.repeat(32), 'aa'.repeat(32)]);
  });

  it('projects path / gps / kind fields and never carries a blocked field', () => {
    const store = new DiscoveredStore();
    store.upsert(record({ type: 2, outPathLen: 2, outPathHex: 'abcd', gpsLat: 1.5, gpsLon: 2.5 }), {
      onRadio: true,
      nowMs: 5000,
      heardLive: true,
    });
    const [c] = store.list(2);
    expect(c.key).toBe(`c:${'aa'.repeat(32)}`);
    expect(c.kind).toBe('repeater');
    expect(c.hops).toBe(2);
    expect(c.outPathHex).toBe('abcd');
    expect(c.outPathHashSize).toBe(2);
    expect(c.gpsLat).toBe(1.5);
    expect(c.gpsLon).toBe(2.5);
    expect(c.onRadio).toBe(true);
    expect(c.lastAdvertMs).toBe(1_000_000);
    expect('blocked' in c).toBe(false);
  });

  it('treats out_path_len 0xff as no path (undefined hops/outPath) and 0/0 gps as no fix', () => {
    const store = new DiscoveredStore();
    store.upsert(record({ outPathLen: 0xff, outPathHex: '', gpsLat: 0, gpsLon: 0 }), {
      onRadio: false,
      nowMs: 5000,
      heardLive: true,
    });
    const [c] = store.list(2);
    expect(c.hops).toBeUndefined();
    expect(c.outPathHex).toBeUndefined();
    expect(c.outPathHashSize).toBeUndefined();
    expect(c.gpsLat).toBeUndefined();
    expect(c.gpsLon).toBeUndefined();
  });
});

describe('DiscoveredStore.setOnRadio / setFavourite / reconcileOnRadio', () => {
  it('setOnRadio mutates the row flag', () => {
    const store = new DiscoveredStore();
    store.upsert(record(), { onRadio: false, nowMs: 5000, heardLive: true });
    store.setOnRadio('aa'.repeat(32), true);
    expect(store.get('aa'.repeat(32))?.on_radio).toBe(1);
    store.setOnRadio('aa'.repeat(32), false);
    expect(store.get('aa'.repeat(32))?.on_radio).toBe(0);
  });

  it('setFavourite mutates favourite + flags bit 0', () => {
    const store = new DiscoveredStore();
    store.upsert(record(), { onRadio: false, nowMs: 5000, heardLive: true });
    store.setFavourite('aa'.repeat(32), true);
    let row = store.get('aa'.repeat(32));
    expect(row?.favourite).toBe(1);
    expect((row?.flags ?? 0) & 1).toBe(1);
    store.setFavourite('aa'.repeat(32), false);
    row = store.get('aa'.repeat(32));
    expect(row?.favourite).toBe(0);
    expect((row?.flags ?? 1) & 1).toBe(0);
  });

  it('reconcileOnRadio sets the given set to on_radio=1 and everything else to 0', () => {
    const store = new DiscoveredStore();
    store.upsert(record({ publicKeyHex: 'aa'.repeat(32) }), { onRadio: true, nowMs: 1, heardLive: true });
    store.upsert(record({ publicKeyHex: 'bb'.repeat(32) }), { onRadio: true, nowMs: 2, heardLive: true });
    store.upsert(record({ publicKeyHex: 'cc'.repeat(32) }), { onRadio: true, nowMs: 3, heardLive: true });
    store.reconcileOnRadio(['bb'.repeat(32)]);
    expect(store.get('aa'.repeat(32))?.on_radio).toBe(0);
    expect(store.get('bb'.repeat(32))?.on_radio).toBe(1);
    expect(store.get('cc'.repeat(32))?.on_radio).toBe(0);
  });
});

describe('DiscoveredStore.remove / clearDiscoveredOnly', () => {
  it('remove deletes a row', () => {
    const store = new DiscoveredStore();
    store.upsert(record(), { onRadio: false, nowMs: 5000, heardLive: true });
    store.remove('aa'.repeat(32));
    expect(store.get('aa'.repeat(32))).toBeNull();
  });

  it('clearDiscoveredOnly drops discovered-only rows but keeps on_radio rows', () => {
    const store = new DiscoveredStore();
    store.upsert(record({ publicKeyHex: 'aa'.repeat(32) }), { onRadio: true, nowMs: 1, heardLive: true });
    store.upsert(record({ publicKeyHex: 'bb'.repeat(32) }), { onRadio: false, nowMs: 2, heardLive: true });
    store.clearDiscoveredOnly();
    expect(store.get('aa'.repeat(32))).not.toBeNull();
    expect(store.get('bb'.repeat(32))).toBeNull();
  });
});
