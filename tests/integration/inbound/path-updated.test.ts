import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it } from 'vitest';
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
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  it('touches a known contact last-seen and re-emits contacts', () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
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
    stop = () => session.stop();
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
