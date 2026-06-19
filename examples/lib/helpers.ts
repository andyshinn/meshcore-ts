import type { MeshCoreSession, Ports } from '@andyshinn/meshcore-ts';

/** Read a required positional CLI arg; print `usage` and exit(1) if absent. */
export function requireArg(argv: string[], index: number, usage: string): string {
  const value = argv[index];
  if (!value) {
    console.error(usage);
    process.exit(1);
  }
  return value;
}

/**
 * Resolve with a typed event's arguments the next time it fires (optionally
 * gated by `predicate`); reject on timeout. Always removes its listener.
 * Used for the event-driven repeater request/response flows.
 */
export function waitForEvent<K extends keyof Ports.EventMap>(
  session: MeshCoreSession,
  event: K,
  opts: {
    predicate?: (...args: Parameters<Ports.EventMap[K]>) => boolean;
    timeoutMs?: number;
  } = {},
): Promise<Parameters<Ports.EventMap[K]>> {
  const { predicate, timeoutMs = 15_000 } = opts;
  return new Promise((resolve, reject) => {
    const listener = ((...args: Parameters<Ports.EventMap[K]>) => {
      if (predicate && !predicate(...args)) return;
      cleanup();
      resolve(args);
    }) as Ports.EventMap[K];

    const cleanup = (): void => {
      clearTimeout(timer);
      session.events.off(event, listener);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for '${String(event)}' after ${timeoutMs}ms`));
    }, timeoutMs);

    session.events.on(event, listener);
  });
}
