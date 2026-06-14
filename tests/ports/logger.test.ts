import { describe, expect, it } from 'vitest';
import type { Logger } from '../../src/index.js';
import { noopLogger } from '../../src/index.js';

describe('noopLogger', () => {
  it('exposes all log-level methods', () => {
    for (const level of ['trace', 'debug', 'info', 'warn', 'error'] as const) {
      expect(typeof noopLogger[level]).toBe('function');
    }
  });

  it('is callable at every level without throwing', () => {
    expect(() => {
      noopLogger.trace('a', 1);
      noopLogger.debug('b', 2);
      noopLogger.info('c', 3);
      noopLogger.warn('d', 4);
      noopLogger.error('e', 5);
    }).not.toThrow();
  });

  it('returns undefined (no-op) from each method', () => {
    expect(noopLogger.info('x')).toBeUndefined();
  });
});

describe('Logger interface', () => {
  it('is satisfied by a custom implementation that captures calls', () => {
    const calls: Array<{ level: string; args: unknown[] }> = [];
    const make =
      (level: string) =>
      (...args: unknown[]) => {
        calls.push({ level, args });
      };
    const fake: Logger = {
      trace: make('trace'),
      debug: make('debug'),
      info: make('info'),
      warn: make('warn'),
      error: make('error'),
    };

    fake.info('hello', 42);
    fake.error('boom');

    expect(calls).toEqual([
      { level: 'info', args: ['hello', 42] },
      { level: 'error', args: ['boom'] },
    ]);
  });
});
