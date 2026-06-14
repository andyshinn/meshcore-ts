import type { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { encodeSetPathHashMode, pathHashModeToSize, pathHashSizeToMode } from '../../src/features/pathHash';

const hex = (b: Buffer) => b.toString('hex');

describe('pathHash encode + size/mode conversions', () => {
  it('encodeSetPathHashMode emits [0x3d][0x00][mode]', () => {
    expect(hex(encodeSetPathHashMode(1))).toBe('3d0001');
  });

  it('round-trips per-hop byte size ↔ mode', () => {
    for (const size of [1, 2, 3] as const) {
      expect(pathHashModeToSize(pathHashSizeToMode(size))).toBe(size);
    }
    expect(pathHashSizeToMode(1)).toBe(0);
    expect(pathHashSizeToMode(3)).toBe(2);
  });
});
