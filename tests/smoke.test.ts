import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/index.js';

describe('meshcore-ts', () => {
  it('exposes a VERSION', () => {
    expect(VERSION).toBe('0.1.0');
  });
});
