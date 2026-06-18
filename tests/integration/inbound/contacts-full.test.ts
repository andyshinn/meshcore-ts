import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it } from 'vitest';
import type { Logger } from '../../../src/index.js';
import { deliver, makeSession } from '../../support/harness';

// PORT NOTE: the donor app surfaced PUSH_CONTACTS_FULL as a user-facing toast
// via an `errorMessage` bus event. This library has no generic `error` event
// (that channel was dropped during extraction); instead it logs a warning AND
// emits a dedicated `contactsFull` event (see src/features/contactsFull.ts) that
// adapters may bridge onto their own error/toast channel. This test asserts both
// the warn and the event, plus that contacts state is left untouched.
describe('PUSH_CONTACTS_FULL handled via the feature registry', () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  it('logs a warning and emits contactsFull when the radio reports its store full', async () => {
    const warnings: string[] = [];
    const logger: Logger = {
      trace() {},
      debug() {},
      info() {},
      warn: (...args: unknown[]) => {
        warnings.push(args.map(String).join(' '));
      },
      error() {},
    };
    const { session, transport } = makeSession({ logger });
    stop = () => session.stop();

    let contactsFull = 0;
    session.events.on('contactsFull', () => {
      contactsFull += 1;
    });

    const before = session.state.getContacts();

    expect(() => deliver(transport, Buffer.from([0x90]))).not.toThrow(); // PUSH_CODE_CONTACTS_FULL
    await Promise.resolve();

    expect(contactsFull).toBe(1);
    expect(warnings.some((m) => /contact store is full/i.test(m))).toBe(true);
    // The frame is informational only — it must not mutate contacts state.
    expect(session.state.getContacts()).toEqual(before);
  });
});
