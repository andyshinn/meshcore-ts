import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it } from 'vitest';
import type { Logger } from '../../../src/index.js';
import { deliver, makeSession } from '../../support/harness';

// PORT NOTE: the donor app surfaced PUSH_CONTACTS_FULL as a user-facing toast
// via an `errorMessage` bus event. That toast channel was DROPPED during
// extraction — this library has no `error`/`errorMessage` event and instead
// logs a warning (see src/features/contactsFull.ts). This test therefore
// asserts the warn was logged via a capturing logger, plus that contacts state
// is left untouched, rather than asserting an emitted error event.
describe('PUSH_CONTACTS_FULL handled via the feature registry', () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  it('logs a warning when the radio reports its contact store full', async () => {
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

    const before = session.state.getContacts();

    expect(() => deliver(transport, Buffer.from([0x90]))).not.toThrow(); // PUSH_CODE_CONTACTS_FULL
    await Promise.resolve();

    expect(warnings.some((m) => /contact store is full/i.test(m))).toBe(true);
    // The frame is informational only — it must not mutate contacts state.
    expect(session.state.getContacts()).toEqual(before);
  });
});
