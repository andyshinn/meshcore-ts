import type { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { encodeGetNextMsg } from '../../src/features/drain';

const hex = (b: Buffer) => b.toString('hex');

describe('drain: encodeGetNextMsg', () => {
  it('is a single opcode', () => {
    expect(hex(encodeGetNextMsg())).toBe('0a');
  });
});
