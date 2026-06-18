import { describe, expect, it } from 'vitest';
import { version } from '../package.json';
import { VERSION } from '../src/index.js';

describe('meshcore-ts', () => {
  it('exposes the package.json version', () => {
    expect(VERSION).toBe(version);
  });
});
