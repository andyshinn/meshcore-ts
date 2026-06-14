import { describe, expect, it } from 'vitest';
import { SessionState } from '../../src/state/model';
import {
  type Channel,
  type Contact,
  DEFAULT_AUTO_ADD_CONFIG,
  DEFAULT_DEVICE_CAPABILITIES,
  DEFAULT_DEVICE_IDENTITY,
  DEFAULT_DEVICE_INFO,
  DEFAULT_GPS_CONFIG,
  DEFAULT_RADIO_SETTINGS,
  DEFAULT_TELEMETRY_POLICY,
  type Message,
  type MessagePath,
} from '../../src/types';

function path(id: string): MessagePath {
  return { id, hops: [], hashMode: 1, finalSnr: 0 };
}

function msg(over: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    key: 'ch:Public',
    body: 'hello',
    ts: 1000,
    state: 'received',
    ...over,
  };
}

describe('SessionState scalars: defaults before any set', () => {
  it('returns donor defaults for every scalar', () => {
    const s = new SessionState();
    expect(s.getOwner()).toBeNull();
    expect(s.getRadioSettings()).toEqual(DEFAULT_RADIO_SETTINGS);
    expect(s.getDeviceInfo()).toEqual(DEFAULT_DEVICE_INFO);
    expect(s.getDeviceIdentity()).toEqual(DEFAULT_DEVICE_IDENTITY);
    expect(s.getDeviceCapabilities()).toEqual(DEFAULT_DEVICE_CAPABILITIES);
    expect(s.getAutoAddConfig()).toEqual(DEFAULT_AUTO_ADD_CONFIG);
    expect(s.getTelemetryPolicy()).toEqual(DEFAULT_TELEMETRY_POLICY);
    expect(s.getGpsConfig()).toEqual(DEFAULT_GPS_CONFIG);
  });

  it('set/get round-trips each scalar', () => {
    const s = new SessionState();
    s.setOwner({ name: 'me', publicKeyHex: 'ab', publicKeyShort: 'ab' });
    expect(s.getOwner()?.name).toBe('me');
    s.setRadioSettings({ ...DEFAULT_RADIO_SETTINGS, txPowerDbm: 17 });
    expect(s.getRadioSettings().txPowerDbm).toBe(17);
    s.setGpsConfig({ enabled: true, intervalSec: 60 });
    expect(s.getGpsConfig()).toEqual({ enabled: true, intervalSec: 60 });
  });
});

describe('SessionState contacts/channels: upsert replaces by key, remove filters by key', () => {
  const c = (key: string, name = key): Contact => ({ key, publicKeyHex: key.slice(2), name, kind: 'chat' });
  const ch = (key: string, name = key): Channel => ({ key, name, kind: 'public' });

  it('contacts start empty, upsert appends, upsert with same key replaces, remove filters', () => {
    const s = new SessionState();
    expect(s.getContacts()).toEqual([]);
    s.upsertContact(c('c:aa', 'Alice'));
    s.upsertContact(c('c:bb', 'Bob'));
    expect(s.getContacts().map((x) => x.key)).toEqual(['c:aa', 'c:bb']);
    s.upsertContact(c('c:aa', 'Alice2'));
    expect(s.getContacts().length).toBe(2);
    expect(s.getContacts().find((x) => x.key === 'c:aa')?.name).toBe('Alice2');
    s.removeContact('c:aa');
    expect(s.getContacts().map((x) => x.key)).toEqual(['c:bb']);
  });

  it('setContacts replaces the whole array', () => {
    const s = new SessionState();
    s.setContacts([c('c:aa'), c('c:bb')]);
    expect(s.getContacts().length).toBe(2);
  });

  it('channels start empty, upsert appends/replaces, remove filters', () => {
    const s = new SessionState();
    expect(s.getChannels()).toEqual([]);
    s.upsertChannel(ch('ch:Public'));
    s.upsertChannel(ch('ch:Test'));
    expect(s.getChannels().map((x) => x.key)).toEqual(['ch:Public', 'ch:Test']);
    s.upsertChannel(ch('ch:Public', 'Public2'));
    expect(s.getChannels().length).toBe(2);
    expect(s.getChannels().find((x) => x.key === 'ch:Public')?.name).toBe('Public2');
    s.removeChannel('ch:Public');
    expect(s.getChannels().map((x) => x.key)).toEqual(['ch:Test']);
  });
});

describe('SessionState messages: insert / recent / byKey ordering', () => {
  it('insertMessage upserts by id (replace) and getRecentMessages returns ts ascending', () => {
    const s = new SessionState();
    s.insertMessage(msg({ id: 'a', ts: 3000 }));
    s.insertMessage(msg({ id: 'b', ts: 1000 }));
    s.insertMessage(msg({ id: 'c', ts: 2000 }));
    // recent() returns the most-recent `limit` rows, presented ts ascending
    expect(s.getRecentMessages().map((m) => m.id)).toEqual(['b', 'c', 'a']);
    // replace by id
    s.insertMessage(msg({ id: 'a', ts: 3000, body: 'changed' }));
    expect(s.getRecentMessages().filter((m) => m.id === 'a').length).toBe(1);
    expect(s.getRecentMessages().find((m) => m.id === 'a')?.body).toBe('changed');
  });

  it('getRecentMessages limit takes the newest N then presents them ascending', () => {
    const s = new SessionState();
    s.insertMessage(msg({ id: 'a', ts: 1000 }));
    s.insertMessage(msg({ id: 'b', ts: 2000 }));
    s.insertMessage(msg({ id: 'c', ts: 3000 }));
    expect(s.getRecentMessages(2).map((m) => m.id)).toEqual(['b', 'c']);
  });

  it('getMessagesForKey filters by key, orders ascending, honours limit + before', () => {
    const s = new SessionState();
    s.insertMessage(msg({ id: 'a', key: 'ch:Public', ts: 1000 }));
    s.insertMessage(msg({ id: 'b', key: 'ch:Public', ts: 2000 }));
    s.insertMessage(msg({ id: 'c', key: 'ch:Public', ts: 3000 }));
    s.insertMessage(msg({ id: 'x', key: 'ch:Other', ts: 1500 }));
    expect(s.getMessagesForKey('ch:Public').map((m) => m.id)).toEqual(['a', 'b', 'c']);
    // limit takes the newest N for the key, presented ascending
    expect(s.getMessagesForKey('ch:Public', { limit: 2 }).map((m) => m.id)).toEqual(['b', 'c']);
    // before=2000 → strictly older, newest-first window, presented ascending
    expect(s.getMessagesForKey('ch:Public', { before: 2000 }).map((m) => m.id)).toEqual(['a']);
  });

  it('setMessageState mutates the row state', () => {
    const s = new SessionState();
    s.insertMessage(msg({ id: 'a', state: 'sending' }));
    s.setMessageState('a', 'sent');
    expect(s.getRecentMessages().find((m) => m.id === 'a')?.state).toBe('sent');
  });
});

describe('SessionState.upsertMessage — merge precedence (ported from donor holder)', () => {
  it('new insert with non-empty paths and no timesHeard sets timesHeard=1', () => {
    const s = new SessionState();
    s.upsertMessage(msg({ id: 'a', meta: { paths: [path('p1')] } }));
    const m = s.getRecentMessages().find((x) => x.id === 'a');
    expect(m?.meta?.timesHeard).toBe(1);
  });

  it('new insert without paths leaves timesHeard undefined', () => {
    const s = new SessionState();
    s.upsertMessage(msg({ id: 'a' }));
    const m = s.getRecentMessages().find((x) => x.id === 'a');
    expect(m?.meta?.timesHeard).toBeUndefined();
  });

  it('new insert copies meta defensively (mutating source after does not change stored)', () => {
    const s = new SessionState();
    const source = msg({ id: 'a', meta: { paths: [path('p1')] } });
    s.upsertMessage(source);
    (source.meta as { hops?: number }).hops = 99;
    const m = s.getRecentMessages().find((x) => x.id === 'a');
    expect(m?.meta?.hops).toBeUndefined();
  });

  it('second receipt unions paths by id, bumps timesHeard, keeps min ts', () => {
    const s = new SessionState();
    s.upsertMessage(msg({ id: 'a', ts: 2000, meta: { paths: [path('p1')] } }));
    s.upsertMessage(msg({ id: 'a', ts: 1000, meta: { paths: [path('p2'), path('p1')] } }));
    const m = s.getRecentMessages().find((x) => x.id === 'a');
    expect(m?.meta?.paths?.map((p) => p.id)).toEqual(['p1', 'p2']); // existing first, then new
    expect(m?.meta?.timesHeard).toBe(2);
    expect(m?.ts).toBe(1000); // min ts
  });

  it('state precedence: received (rank 1) does NOT override existing sent (rank 1) — keeps existing', () => {
    const s = new SessionState();
    s.upsertMessage(msg({ id: 'a', state: 'sent' }));
    s.upsertMessage(msg({ id: 'a', state: 'received' }));
    expect(s.getRecentMessages().find((x) => x.id === 'a')?.state).toBe('sent');
  });

  it('state precedence: ack (3) beats heard (2) beats sent/received (1) beats sending/failed (0)', () => {
    const s = new SessionState();
    s.upsertMessage(msg({ id: 'a', state: 'sending' }));
    s.upsertMessage(msg({ id: 'a', state: 'received' }));
    expect(s.getRecentMessages().find((x) => x.id === 'a')?.state).toBe('received');
    s.upsertMessage(msg({ id: 'a', state: 'heard' }));
    expect(s.getRecentMessages().find((x) => x.id === 'a')?.state).toBe('heard');
    s.upsertMessage(msg({ id: 'a', state: 'ack' }));
    expect(s.getRecentMessages().find((x) => x.id === 'a')?.state).toBe('ack');
    // a lower-rank incoming never demotes
    s.upsertMessage(msg({ id: 'a', state: 'failed' }));
    expect(s.getRecentMessages().find((x) => x.id === 'a')?.state).toBe('ack');
  });

  it('failed (0) does not override sending (0) — equal rank keeps existing', () => {
    const s = new SessionState();
    s.upsertMessage(msg({ id: 'a', state: 'sending' }));
    s.upsertMessage(msg({ id: 'a', state: 'failed' }));
    expect(s.getRecentMessages().find((x) => x.id === 'a')?.state).toBe('sending');
  });

  it('merge: when existing had timesHeard, bump is existing+1; when absent, defaults to 1 then +1', () => {
    const s = new SessionState();
    // existing inserted without paths → no timesHeard; merge defaults existing to 1 then +1 = 2
    s.upsertMessage(msg({ id: 'a' }));
    s.upsertMessage(msg({ id: 'a' }));
    expect(s.getRecentMessages().find((x) => x.id === 'a')?.meta?.timesHeard).toBe(2);
  });

  it('merged meta overlays incoming meta over existing but paths/timesHeard are recomputed', () => {
    const s = new SessionState();
    s.upsertMessage(msg({ id: 'a', meta: { hops: 1, paths: [path('p1')] } }));
    s.upsertMessage(msg({ id: 'a', meta: { hops: 5, snr: 7, paths: [path('p2')] } }));
    const m = s.getRecentMessages().find((x) => x.id === 'a');
    expect(m?.meta?.hops).toBe(5); // incoming overrides
    expect(m?.meta?.snr).toBe(7); // incoming adds
    expect(m?.meta?.paths?.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(m?.meta?.timesHeard).toBe(2);
  });
});

describe('SessionState.appendMessagePath — ported from donor holder', () => {
  it('returns null for an unknown id', () => {
    const s = new SessionState();
    expect(s.appendMessagePath('nope', path('p1'))).toBeNull();
  });

  it('duplicate path.id → no bump, returns current state unchanged', () => {
    const s = new SessionState();
    s.upsertMessage(msg({ id: 'a', state: 'sent', meta: { paths: [path('p1')], timesHeard: 1 } }));
    const ret = s.appendMessagePath('a', path('p1'));
    expect(ret).toBe('sent');
    const m = s.getRecentMessages().find((x) => x.id === 'a');
    expect(m?.state).toBe('sent');
    expect(m?.meta?.paths?.length).toBe(1);
    expect(m?.meta?.timesHeard).toBe(1); // unchanged
  });

  it('new path on a sent message advances state to heard and bumps timesHeard', () => {
    const s = new SessionState();
    s.upsertMessage(msg({ id: 'a', state: 'sent', meta: { paths: [path('p1')], timesHeard: 1 } }));
    const ret = s.appendMessagePath('a', path('p2'));
    expect(ret).toBe('heard');
    const m = s.getRecentMessages().find((x) => x.id === 'a');
    expect(m?.state).toBe('heard');
    expect(m?.meta?.paths?.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(m?.meta?.timesHeard).toBe(2);
  });

  it('new path on a non-sent message keeps its state but still appends + bumps', () => {
    const s = new SessionState();
    s.upsertMessage(msg({ id: 'a', state: 'ack', meta: { paths: [path('p1')], timesHeard: 3 } }));
    const ret = s.appendMessagePath('a', path('p2'));
    expect(ret).toBe('ack');
    const m = s.getRecentMessages().find((x) => x.id === 'a');
    expect(m?.state).toBe('ack');
    expect(m?.meta?.paths?.length).toBe(2);
    expect(m?.meta?.timesHeard).toBe(4);
  });

  it('appends to a message that had no paths (timesHeard defaults from 0 → 1)', () => {
    const s = new SessionState();
    s.insertMessage(msg({ id: 'a', state: 'sent' }));
    const ret = s.appendMessagePath('a', path('p1'));
    expect(ret).toBe('heard');
    const m = s.getRecentMessages().find((x) => x.id === 'a');
    expect(m?.meta?.paths?.map((p) => p.id)).toEqual(['p1']);
    expect(m?.meta?.timesHeard).toBe(1);
  });
});

describe('SessionState discovered pool delegation', () => {
  const rec = {
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
  };

  it('exposes the store as state.discovered and via delegate methods', () => {
    const s = new SessionState();
    s.upsertDiscovered(rec, { onRadio: false, nowMs: 5000, heardLive: true });
    expect(s.getDiscovered('aa'.repeat(32))?.name).toBe('Alice');
    expect(s.discovered.get('aa'.repeat(32))?.name).toBe('Alice');
    const list = s.listDiscovered(s.getRadioSettings().pathHashMode);
    expect(list.length).toBe(1);
    expect(list[0].publicKeyHex).toBe('aa'.repeat(32));
  });

  it('delegate setOnRadio / setFavourite / reconcileOnRadio mutate the underlying rows', () => {
    const s = new SessionState();
    s.upsertDiscovered(rec, { onRadio: false, nowMs: 5000, heardLive: true });
    s.setDiscoveredOnRadio('aa'.repeat(32), true);
    expect(s.getDiscovered('aa'.repeat(32))?.on_radio).toBe(1);
    s.setDiscoveredFavourite('aa'.repeat(32), true);
    expect(s.getDiscovered('aa'.repeat(32))?.favourite).toBe(1);
    s.reconcileDiscoveredOnRadio([]);
    expect(s.getDiscovered('aa'.repeat(32))?.on_radio).toBe(0);
  });
});
