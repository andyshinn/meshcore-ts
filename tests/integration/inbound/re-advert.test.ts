import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Models, Transports } from '../../../src/index.js';
import { CMD } from '../../../src/protocol/codes';
import { deliver, makeSession } from '../../support/harness';

const PK = 'aa'.repeat(32);
const UNKNOWN_PK = 'bb'.repeat(32);

// A fixed wall clock, so a clamped-to-the-present last-seen can be pinned to an
// exact number instead of a range.
const NOW = Date.UTC(2026, 0, 1);

// PUSH_ADVERT: [0x80][pubkey 32B] — the advertising node IS in the radio's
// contact store, INCLUDING one the radio auto-added microseconds ago, so the
// pubkey may be one we have never seen.
function advert(pubkeyHex: string): Buffer {
  return Buffer.concat([Buffer.from([0x80]), Buffer.from(pubkeyHex, 'hex')]);
}

// PUSH_PATH_UPDATED: [0x81][pubkey 32B] — a routing change, not an advert.
function pathUpdated(pubkeyHex: string): Buffer {
  return Buffer.concat([Buffer.from([0x81]), Buffer.from(pubkeyHex, 'hex')]);
}

// RESP_CONTACT (0x03) — the 148-byte record the radio answers
// CMD_GET_CONTACT_BY_KEY with. `lastAdvertUnix` is the ADVERTISING node's own
// RTC (frame offset 132), which is only ever a hint.
function contactRecordFrame(pubkeyHex: string, name: string, lastAdvertUnix = 0): Buffer {
  const frame = Buffer.alloc(148);
  frame[0] = 0x03;
  Buffer.from(pubkeyHex, 'hex').copy(frame, 1);
  frame[33] = 1; // type = chat
  frame[35] = 0xff; // out_path_len = direct
  Buffer.from(name, 'utf8').copy(frame, 100);
  frame.writeUInt32LE(lastAdvertUnix >>> 0, 132);
  return frame;
}

const contact = (pk: string, lastSeenMs: number): Models.Contact => ({
  key: `c:${pk}`,
  publicKeyHex: pk,
  name: 'Bob',
  kind: 'chat',
  lastSeenMs,
});

/** Every CMD_GET_CONTACT_BY_KEY sent for this pubkey, in send order. */
function lookupsFor(transport: Transports.Loopback, pubkeyHex: string): Buffer[] {
  return transport.sent
    .map((f) => Buffer.from(f))
    .filter((f) => f[0] === CMD.GET_CONTACT_BY_KEY && f.subarray(1, 33).toString('hex') === pubkeyHex);
}

describe('inbound PUSH_ADVERT (0x80 re-advert)', () => {
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
    stop = undefined;
    vi.useRealTimers();
  });

  it('touches a known contact last-seen and re-emits contacts', () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    session.state.upsertContact(contact(PK, 1_000));

    const emitted: Array<Array<{ key: string }>> = [];
    const onContacts = (c: Array<{ key: string }>) => emitted.push(c);
    session.events.on('contacts', onContacts);
    try {
      deliver(transport, advert(PK));
      const updated = session.state.getContacts().find((c) => c.key === `c:${PK}`);
      expect(updated?.lastSeenMs).toBeGreaterThan(1_000);
      expect(emitted.length).toBeGreaterThan(0);
    } finally {
      session.events.off('contacts', onContacts);
    }
  });

  it('looks up an advertiser it has never seen instead of dropping the advert', async () => {
    vi.useFakeTimers();
    const { session, transport } = makeSession();
    stop = () => session.stop();

    deliver(transport, advert(UNKNOWN_PK));
    expect(lookupsFor(transport, UNKNOWN_PK)).toHaveLength(0); // still inside the 50ms debounce

    await vi.advanceTimersByTimeAsync(100);

    const lookups = lookupsFor(transport, UNKNOWN_PK);
    expect(lookups).toHaveLength(1);
    expect(lookups[0][0]).toBe(CMD.GET_CONTACT_BY_KEY);
    expect(lookups[0].subarray(1, 33).toString('hex')).toBe(UNKNOWN_PK);
  });

  it('adds the fetched record to the contact list when the radio answers the lookup', async () => {
    vi.useFakeTimers();
    const { session, transport } = makeSession();
    stop = () => session.stop();

    const upserted: Models.Contact[] = [];
    const snapshots: Array<Array<{ key: string }>> = [];
    session.events.on('contactUpserted', (c: Models.Contact) => upserted.push(c));
    session.events.on('contacts', (c: Array<{ key: string }>) => snapshots.push(c));

    deliver(transport, advert(UNKNOWN_PK));
    await vi.advanceTimersByTimeAsync(100);
    expect(lookupsFor(transport, UNKNOWN_PK)).toHaveLength(1);

    // The radio answers: it holds this contact, so it belongs in the list.
    deliver(transport, contactRecordFrame(UNKNOWN_PK, 'Newbie'));
    await vi.advanceTimersByTimeAsync(1);

    const added = session.state.getContacts().find((c) => c.key === `c:${UNKNOWN_PK}`);
    expect(added).toBeDefined();
    expect(added?.name).toBe('Newbie');
    expect(upserted.map((c) => c.key)).toContain(`c:${UNKNOWN_PK}`);
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots.at(-1)?.some((c) => c.key === `c:${UNKNOWN_PK}`)).toBe(true);
  });

  it('reports the fetched record as heard live rather than synced', async () => {
    vi.useFakeTimers();
    const { session, transport } = makeSession();
    stop = () => session.stop();

    const observed: Array<{ record: Models.ContactRecord; source: Models.ContactSource }> = [];
    session.events.on('contactObserved', (record: Models.ContactRecord, source: Models.ContactSource) =>
      observed.push({ record, source }),
    );

    deliver(transport, advert(UNKNOWN_PK));
    await vi.advanceTimersByTimeAsync(100);
    deliver(transport, contactRecordFrame(UNKNOWN_PK, 'Newbie'));
    await vi.advanceTimersByTimeAsync(1);

    expect(observed).toHaveLength(1);
    expect(observed[0].source).toBe('advert');
    expect(observed[0].record).toMatchObject({ publicKeyHex: UNKNOWN_PK, name: 'Newbie' });
  });

  it('collapses a burst of adverts for one pubkey into a single lookup', async () => {
    vi.useFakeTimers();
    const { session, transport } = makeSession();
    stop = () => session.stop();

    deliver(transport, advert(UNKNOWN_PK));
    deliver(transport, advert(UNKNOWN_PK));
    deliver(transport, advert(UNKNOWN_PK));
    await vi.advanceTimersByTimeAsync(100);

    expect(lookupsFor(transport, UNKNOWN_PK)).toHaveLength(1);
  });

  it('upgrades a pending path-update refresh to an advert when a 0x80 lands in the same window', async () => {
    vi.useFakeTimers();
    const { session, transport } = makeSession();
    stop = () => session.stop();
    session.state.upsertContact(contact(PK, 1_000));

    const observed: Array<{ record: Models.ContactRecord; source: Models.ContactSource }> = [];
    session.events.on('contactObserved', (record: Models.ContactRecord, source: Models.ContactSource) =>
      observed.push({ record, source }),
    );

    // A path update schedules a 'sync' refresh; the advert arrives before the
    // 50ms debounce expires and must win — the contact WAS heard live.
    deliver(transport, pathUpdated(PK));
    await vi.advanceTimersByTimeAsync(10);
    deliver(transport, advert(PK));
    await vi.advanceTimersByTimeAsync(100);

    expect(lookupsFor(transport, PK)).toHaveLength(1);

    deliver(transport, contactRecordFrame(PK, 'Bob'));
    await vi.advanceTimersByTimeAsync(1);

    expect(observed).toHaveLength(1);
    expect(observed[0].source).toBe('advert');
  });

  it('upgrades a path-update refresh to an advert when a 0x80 lands while the lookup is out', async () => {
    vi.useFakeTimers();
    const { session, transport } = makeSession();
    stop = () => session.stop();
    session.state.upsertContact(contact(PK, 1_000));

    const observed: Array<{ record: Models.ContactRecord; source: Models.ContactSource }> = [];
    session.events.on('contactObserved', (record: Models.ContactRecord, source: Models.ContactSource) =>
      observed.push({ record, source }),
    );

    // Same upgrade as above, but the advert arrives AFTER the debounce has fired
    // and the request is already on the wire. The refresh entry lives until the
    // lookup resolves, so the later flavour still wins — and no second lookup is
    // issued for a contact we are already fetching.
    deliver(transport, pathUpdated(PK));
    await vi.advanceTimersByTimeAsync(100);
    expect(lookupsFor(transport, PK)).toHaveLength(1);

    deliver(transport, advert(PK));
    await vi.advanceTimersByTimeAsync(100);
    expect(lookupsFor(transport, PK)).toHaveLength(1);

    deliver(transport, contactRecordFrame(PK, 'Bob'));
    await vi.advanceTimersByTimeAsync(1);

    expect(observed).toHaveLength(1);
    expect(observed[0].source).toBe('advert');
  });

  it('still ingests the advert when an app lookup races it for the same pubkey', async () => {
    vi.useFakeTimers();
    const { session, transport } = makeSession();
    stop = () => session.stop();

    const observed: Array<{ record: Models.ContactRecord; source: Models.ContactSource }> = [];
    session.events.on('contactObserved', (record: Models.ContactRecord, source: Models.ContactSource) =>
      observed.push({ record, source }),
    );

    // The app asks for this contact first, so its waiter is the OLDEST for the
    // pubkey and takes the single RESP_CONTACT the radio sends. The advert's own
    // refresh must not starve behind it — the record is ingested against the
    // refresh entry rather than against whichever waiter happened to resolve.
    const appLookup = session.getContactByKey(UNKNOWN_PK);
    deliver(transport, advert(UNKNOWN_PK));
    await vi.advanceTimersByTimeAsync(100);

    deliver(transport, contactRecordFrame(UNKNOWN_PK, 'Contested'));
    await vi.advanceTimersByTimeAsync(1);

    // The app's own promise still resolves with the record.
    expect((await appLookup)?.publicKeyHex).toBe(UNKNOWN_PK);
    // ...and the advert was not lost: ingested once, as heard-live.
    expect(observed).toHaveLength(1);
    expect(observed[0].source).toBe('advert');
    expect(session.state.getContacts().map((c) => c.key)).toContain(`c:${UNKNOWN_PK}`);
  });

  it('never moves last-seen backwards when the advertiser clock is behind ours', () => {
    vi.useFakeTimers({ now: NOW });
    const { session, transport } = makeSession();
    stop = () => session.stop();
    session.state.upsertContact(contact(PK, NOW));

    // The record claims an advert timestamp a day old — a skewed remote RTC.
    deliver(transport, contactRecordFrame(PK, 'Bob', Math.floor(NOW / 1000) - 86_400));

    const updated = session.state.getContacts().find((c) => c.key === `c:${PK}`);
    expect(updated?.lastSeenMs).toBe(NOW);
  });

  it('stamps a first-seen contact with our clock, not the advertiser stale one', async () => {
    vi.useFakeTimers({ now: NOW });
    const { session, transport } = makeSession();
    stop = () => session.stop();

    // We hear the advert NOW, but the node's own RTC is a day behind. There is no
    // existing row to preserve, so nothing but our own clock stands between
    // last-seen and the advertiser's unverified claim.
    deliver(transport, advert(UNKNOWN_PK));
    await vi.advanceTimersByTimeAsync(100); // the debounce also moves the fake clock
    deliver(transport, contactRecordFrame(UNKNOWN_PK, 'Drifty', Math.floor(NOW / 1000) - 86_400));
    await vi.advanceTimersByTimeAsync(0);

    // Our clock at the moment of ingest — a day newer than the record's claim.
    const added = session.state.getContacts().find((c) => c.key === `c:${UNKNOWN_PK}`);
    expect(added?.lastSeenMs).toBe(NOW + 100);
  });

  it('keeps a contact the radio answered for mid-sync when the iteration ends', async () => {
    vi.useFakeTimers({ now: NOW });
    const { session, transport } = makeSession();
    stop = () => session.stop();

    // The advert arrives first, so the lookup is already in flight when the
    // enumeration opens.
    deliver(transport, advert(UNKNOWN_PK));
    await vi.advanceTimersByTimeAsync(100);
    expect(lookupsFor(transport, UNKNOWN_PK)).toHaveLength(1);

    // RESP_CONTACTS_START [0x02][total u32]
    const start = Buffer.alloc(5);
    start[0] = 0x02;
    start.writeUInt32LE(1, 1);
    deliver(transport, start);

    // The solicited reply interleaves with the stream — the firmware answers a
    // CMD_GET_CONTACT_BY_KEY at once, even mid-enumeration.
    deliver(transport, contactRecordFrame(UNKNOWN_PK, 'Interleaved'));
    await vi.advanceTimersByTimeAsync(0);
    deliver(transport, contactRecordFrame(PK, 'Enumerated'));
    await vi.advanceTimersByTimeAsync(0);

    // RESP_END_OF_CONTACTS prunes every contact missing from syncSeen.
    deliver(transport, Buffer.from([0x04, 0x00, 0x00, 0x00, 0x00]));
    await vi.advanceTimersByTimeAsync(0);

    const keys = session.state.getContacts().map((c) => c.key);
    expect(keys).toContain(`c:${PK}`);
    expect(keys).toContain(`c:${UNKNOWN_PK}`);
  });

  it('clamps an advertiser clock set in the future to the present', () => {
    vi.useFakeTimers({ now: NOW });
    const { session, transport } = makeSession();
    stop = () => session.stop();

    // 4e9 unix seconds is the year 2096: a node whose RTC is wildly ahead must
    // not pin last-seen to a timestamp that never falls out of "just heard".
    deliver(transport, contactRecordFrame(UNKNOWN_PK, 'Timelord', 4_000_000_000));

    const added = session.state.getContacts().find((c) => c.key === `c:${UNKNOWN_PK}`);
    expect(added?.lastSeenMs).toBe(NOW);
  });
});
