import { Buffer } from 'node:buffer';
import { onTestFinished } from 'vitest';
import { MeshCoreSession, type MeshCoreSessionOptions, Transports } from '../../src/index.js';

/**
 * A started session on a loopback transport, torn down for you.
 *
 * The session registers its own `onTestFinished(() => session.stop())`, so
 * callers never need a `let stop` / `afterEach` pair or a try/finally. Safe to
 * call from inside `beforeEach` as well as from a test body; multiple sessions
 * per test each register their own teardown and unwind in reverse order.
 *
 * Note that `onTestFinished` callbacks run AFTER a file's own `afterEach`
 * hooks, so an `afterEach` that also restores timers (`vi.useRealTimers()`)
 * now runs before the stop rather than after it. `stop()` is synchronous
 * bookkeeping only, so the order is immaterial.
 */
export function makeSession(opts?: Partial<MeshCoreSessionOptions>): {
  session: MeshCoreSession;
  transport: Transports.Loopback;
} {
  const transport = new Transports.Loopback();
  const session = new MeshCoreSession({ transport, ...opts });
  session.start();
  onTestFinished(() => session.stop());
  return { session, transport };
}

/** Deliver one inbound companion frame to the session. */
export function deliver(transport: Transports.Loopback, frame: Buffer | Uint8Array | string): void {
  if (typeof frame === 'string') transport.receiveHex(frame);
  else transport.receive(frame instanceof Uint8Array ? frame : Uint8Array.from(frame));
}

/** The most recent frame written to the transport, or undefined if none. */
export function lastSent(transport: Transports.Loopback): Buffer | undefined {
  const last = transport.sent.at(-1);
  return last ? Buffer.from(last) : undefined;
}

/** The most recent frame written to the transport as hex, or undefined if none. */
export function lastSentHex(transport: Transports.Loopback): string | undefined {
  return lastSent(transport)?.toString('hex');
}

/**
 * Yield to the event loop so a pending writeFrame lands in `transport.sent`
 * before the next reply is injected. setTimeout(0) drains the full microtask
 * chain that ctx.request → writeFrame → send schedules.
 */
export const flush = (): Promise<unknown> => new Promise((r) => setTimeout(r, 0));
