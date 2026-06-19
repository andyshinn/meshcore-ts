import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it } from 'vitest';
import type { Models } from '../../../src/index.js';
import { deliver, makeSession } from '../../support/harness';

const PK = 'aa'.repeat(32);

// PUSH_ADVERT: [0x80][pubkey 32B] — a known contact re-advertised.
function advert(pubkeyHex: string): Buffer {
  return Buffer.concat([Buffer.from([0x80]), Buffer.from(pubkeyHex, 'hex')]);
}

const contact = (pk: string, lastSeenMs: number): Models.Contact => ({
  key: `c:${pk}`,
  publicKeyHex: pk,
  name: 'Bob',
  kind: 'chat',
  lastSeenMs,
});

describe('inbound PUSH_ADVERT (known contact re-advert)', () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

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

  it('ignores a re-advert for an unknown contact', () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();

    const emitted: unknown[] = [];
    const onContacts = (c: unknown) => emitted.push(c);
    session.events.on('contacts', onContacts);
    try {
      expect(() => deliver(transport, advert('bb'.repeat(32)))).not.toThrow();
      expect(emitted).toHaveLength(0);
    } finally {
      session.events.off('contacts', onContacts);
    }
  });
});
