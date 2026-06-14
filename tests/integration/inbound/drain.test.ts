import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deliver, makeSession } from '../../support/harness';

// PUSH_MSG_WAITING (0x83) tickles the inbox pump; RESP_NO_MORE_MESSAGES (0x0a)
// ends a drain round. The pump answers each queue event with exactly one
// CMD_GET_NEXT_MSG (0x0a) and chains until the device says no-more.
const MSG_WAITING = Buffer.from([0x83]);
const NO_MORE = Buffer.from([0x0a]);
const GET_NEXT = '0a';
const DRAIN_INTERVAL_MS = 250;

const hex = (f: Uint8Array) => Buffer.from(f).toString('hex');

describe('inbox drain pump', () => {
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
    vi.useRealTimers();
  });

  it('pumps one GET_NEXT_MSG per queue event, coalescing + chaining to NO_MORE', async () => {
    vi.useFakeTimers();
    const { session, transport } = makeSession();
    stop = () => session.stop();

    // One MSG_WAITING → one GET_NEXT after the drain interval.
    deliver(transport, MSG_WAITING);
    await vi.advanceTimersByTimeAsync(DRAIN_INTERVAL_MS + 10);
    expect(transport.sent.map(hex)).toEqual([GET_NEXT]);

    // A MSG_WAITING arriving mid-drain coalesces into a single pending drain —
    // no extra write while the current round is still open.
    deliver(transport, MSG_WAITING);
    await vi.advanceTimersByTimeAsync(DRAIN_INTERVAL_MS + 10);
    expect(transport.sent).toHaveLength(1);

    // NO_MORE clears the busy flag AND fires the pending drain → a second GET_NEXT.
    deliver(transport, NO_MORE);
    await vi.advanceTimersByTimeAsync(DRAIN_INTERVAL_MS + 10);
    expect(transport.sent).toHaveLength(2);
    expect(transport.sent.every((f) => hex(f) === GET_NEXT)).toBe(true);

    // A final NO_MORE with nothing pending issues no further writes.
    deliver(transport, NO_MORE);
    await vi.advanceTimersByTimeAsync(DRAIN_INTERVAL_MS + 10);
    expect(transport.sent).toHaveLength(2);
  });
});
