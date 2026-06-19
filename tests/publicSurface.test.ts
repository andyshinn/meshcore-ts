import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as core from '../src/index';

describe('public surface — core barrel', () => {
  it('exports exactly the intended runtime values', () => {
    const expected = [
      'ContactTableFullError',
      'FeatureDisabledError',
      'LoopbackTransport',
      'MeshCoreSession',
      'ProtocolError',
      'ProtocolTimeoutError',
      'UnknownContactError',
      'VERSION',
    ];
    expect(Object.keys(core).sort()).toEqual(expected);
  });
});

describe('public surface — protocol & transports barrels', () => {
  it('protocol barrel exposes the codec primitives', async () => {
    const protocol = await import('../src/protocol');
    expect(protocol.BufferReader).toBeTypeOf('function');
    expect(protocol.BufferWriter).toBeTypeOf('function');
    expect(protocol.CMD).toBeDefined();
    expect(protocol.RESP).toBeDefined();
  });

  it('transports barrel exposes the adapters', async () => {
    const transports = await import('../src/transports');
    expect(transports.createBleTransport).toBeTypeOf('function');
    expect(transports.SerialTransport).toBeTypeOf('function');
    expect((transports as Record<string, unknown>).LoopbackTransport).toBeUndefined(); // stays in core only
  });
});

describe('package exports map blocks deep imports', () => {
  it('declares exactly three entry points and no wildcard', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(Object.keys(pkg.exports).sort()).toEqual(['.', './protocol', './transports']);
    expect(JSON.stringify(pkg.exports)).not.toContain('*');
    expect(pkg.sideEffects).toBe(false);
  });
});
