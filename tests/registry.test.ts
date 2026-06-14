import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import type { Feature, FeatureContext } from '../src/feature';
import { FeatureRegistry } from '../src/registry';

function fakeFeature(handles: number[], handle = vi.fn()): Feature {
  return { handles, handle };
}

describe('FeatureRegistry', () => {
  it('maps each handled code to its feature', () => {
    const a = fakeFeature([0x80]);
    const b = fakeFeature([0x90, 0x91]);
    const reg = new FeatureRegistry([a, b]);
    expect(reg.get(0x80)).toBe(a);
    expect(reg.get(0x91)).toBe(b);
    expect(reg.get(0x07)).toBeUndefined();
  });

  it('throws when two features claim the same code', () => {
    expect(() => new FeatureRegistry([fakeFeature([0x80]), fakeFeature([0x80])])).toThrow(/duplicate/i);
  });

  it('dispatches a frame to the right handler', () => {
    const handle = vi.fn();
    const reg = new FeatureRegistry([fakeFeature([0x90], handle)]);
    // The handler is a no-op and never reads ctx; a minimal stub is enough to
    // exercise dispatch routing.
    const ctx = { writeFrame: vi.fn(), request: vi.fn(), requestOrNull: vi.fn() } as unknown as FeatureContext;
    reg.get(0x90)?.handle(0x90, Buffer.from([0x90, 0x01]), ctx);
    expect(handle).toHaveBeenCalledWith(0x90, Buffer.from([0x90, 0x01]), ctx);
  });
});
