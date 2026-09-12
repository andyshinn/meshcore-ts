import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Models } from '../../../src/index.js';
import { deliver, makeSession } from '../../support/harness';

const PK = 'cc'.repeat(32);

// PUSH_PATH_UPDATED [0x81][pubkey 32B].
function pathUpdated(pubkeyHex: string): Buffer {
  return Buffer.concat([Buffer.from([0x81]), Buffer.from(pubkeyHex, 'hex')]);
}

const contact = (pk: string, lastSeenMs: number): Models.Contact => ({
  key: `c:${pk}`,
  publicKeyHex: pk,
  name: 'Repeater',
  kind: 'repeater',
  lastSeenMs,
});

describe('inbound PUSH_PATH_UPDATED', () => {
  it('touches a known contact last-seen and re-emits contacts', () => {
    const { session, transport } = makeSession();
    session.state.upsertContact(contact(PK, 1_000));

    const emitted: unknown[] = [];
    const onContacts = (c: unknown) => emitted.push(c);
    session.events.on('contacts', onContacts);
    try {
      deliver(transport, pathUpdated(PK));
      const updated = session.state.getContacts().find((c) => c.key === `c:${PK}`);
      expect(updated?.lastSeenMs).toBeGreaterThan(1_000);
      expect(emitted.length).toBeGreaterThan(0);
    } finally {
      session.events.off('contacts', onContacts);
    }
  });

  it('ignores PUSH_PATH_UPDATED for an unknown contact', () => {
    const { session, transport } = makeSession();
    const emitted: unknown[] = [];
    const onContacts = (c: unknown) => emitted.push(c);
    session.events.on('contacts', onContacts);
    try {
      expect(() => deliver(transport, pathUpdated('dd'.repeat(32)))).not.toThrow();
      expect(emitted).toHaveLength(0);
    } finally {
      session.events.off('contacts', onContacts);
    }
  });
});

// RESP_CONTACT (0x03): the 148-byte record the radio answers
// CMD_GET_CONTACT_BY_KEY with. lastAdvertUnix (offset 132) is left at 0 so the
// refresh carries no remote-clock claim of its own.
function contactRecordFrame(pubkeyHex: string, name: string): Buffer {
  const frame = Buffer.alloc(148);
  frame[0] = 0x03;
  Buffer.from(pubkeyHex, 'hex').copy(frame, 1);
  frame[33] = 1; // type = chat
  frame[35] = 0xff; // out_path_len = direct
  Buffer.from(name, 'utf8').copy(frame, 100);
  return frame;
}

describe('PUSH_PATH_UPDATED contact refresh', () => {
  afterEach(() => vi.useRealTimers());

  it('ingests the refreshed record as sync, never advert — a path update is not an advert', async () => {
    vi.useFakeTimers();
    const { session, transport } = makeSession();
    session.state.upsertContact(contact(PK, 1_000));

    const observed: Array<{ record: Models.ContactRecord; source: Models.ContactSource }> = [];
    session.events.on('contactObserved', (record: Models.ContactRecord, source: Models.ContactSource) =>
      observed.push({ record, source }),
    );

    deliver(transport, pathUpdated(PK));
    const sentBefore = transport.sent.length;
    await vi.advanceTimersByTimeAsync(100); // past the 50ms debounce

    // The refresh went out as CMD_GET_CONTACT_BY_KEY for this pubkey.
    const refreshFrames = transport.sent.slice(sentBefore).filter((f) => f[0] === 0x1e);
    expect(refreshFrames).toHaveLength(1);
    expect(Buffer.from(refreshFrames[0]).subarray(1, 33).toString('hex')).toBe(PK);

    deliver(transport, contactRecordFrame(PK, 'Repeater-Updated'));
    await vi.runAllTimersAsync();

    expect(observed).toHaveLength(1);
    expect(observed[0].source).toBe('sync');
    expect(observed[0].record.publicKeyHex).toBe(PK);

    // The record still landed on-radio (the radio answered for it), and the
    // refreshed fields are visible in the contact list.
    const updated = session.state.getContacts().find((c) => c.key === `c:${PK}`);
    expect(updated?.name).toBe('Repeater-Updated');
    expect(session.state.discovered.get(PK)?.on_radio).toBe(1);
    // ...but nothing claims we heard it live: last_heard_ms only moves on an advert.
    expect(session.state.discovered.get(PK)?.last_heard_ms).toBe(0);
  });

  it('schedules no refresh for a pubkey we do not already hold', async () => {
    vi.useFakeTimers();
    const { transport } = makeSession();
    const sentBefore = transport.sent.length;
    deliver(transport, pathUpdated('dd'.repeat(32)));
    await vi.advanceTimersByTimeAsync(100);

    // Unlike PUSH_ADVERT, a path update stays gated on a known contact — the
    // radio only recomputes paths for contacts it already stores.
    expect(transport.sent.slice(sentBefore).filter((f) => f[0] === 0x1e)).toHaveLength(0);
  });
});
