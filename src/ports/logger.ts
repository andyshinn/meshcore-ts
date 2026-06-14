/** Minimal structured logging port. Replaces the donor's tslog `log.ts`. */
export interface Logger {
  trace(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** Default no-op logger so logging is entirely optional. */
export const noopLogger: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
};
