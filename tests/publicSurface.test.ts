import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as pkg from '../src/index';

describe('public surface — top-level', () => {
  it('exposes only the essentials + namespaces, with no leakage', () => {
    // `Features` is type-only: whether it survives as an empty `{}` runtime
    // binding is bundler-dependent, so allow it but do not require it. Every
    // other namespace has runtime members and must be present.
    const allowed = ['Errors', 'Features', 'MeshCoreSession', 'Models', 'Ports', 'Protocol', 'Transports', 'VERSION'];
    const required = ['Errors', 'MeshCoreSession', 'Models', 'Ports', 'Protocol', 'Transports', 'VERSION'];
    const keys = Object.keys(pkg);
    for (const k of keys) expect(allowed).toContain(k); // no internal leakage
    for (const r of required) expect(keys).toContain(r);
    // Internals stay out of the top level.
    expect(keys).not.toContain('ProtocolError');
    expect(keys).not.toContain('SerialTransport');
    expect(keys).not.toContain('LoopbackTransport');
  });

  it('top-level values are the three essentials', () => {
    expect(pkg.MeshCoreSession).toBeTypeOf('function');
    expect(pkg.VERSION).toBeTypeOf('string');
  });

  it('namespaces expose representative members', () => {
    expect(pkg.Models.DEFAULT_RADIO_SETTINGS).toBeDefined();
    expect(pkg.Errors.ProtocolError).toBeTypeOf('function');
    expect(pkg.Protocol.BufferReader).toBeTypeOf('function');
    expect(pkg.Protocol.CMD).toBeDefined();
    expect(pkg.Protocol.RESP).toBeDefined();
    expect(pkg.Transports.Serial).toBeTypeOf('function');
    expect(pkg.Transports.Loopback).toBeTypeOf('function');
    expect(pkg.Ports.noopLogger).toBeDefined();
    // Named-constant maps reachable via their namespaces.
    expect(pkg.Protocol.PayloadKind.GRP_TXT).toBe('grpTxt');
    expect(pkg.Ports.EventName.RAW_PACKET).toBe('rawPacket');
  });

  it('Features is a type-only namespace (compile-time reachable)', () => {
    const _check: import('../src/index').Features.SelfInfo | undefined = undefined;
    expect(_check).toBeUndefined();
  });
});

describe('package exports map — single entry, no wildcard', () => {
  it('declares exactly the "." entry and keeps sideEffects false', () => {
    const meta = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(Object.keys(meta.exports)).toEqual(['.']);
    expect(JSON.stringify(meta.exports)).not.toContain('*');
    expect(meta.sideEffects).toBe(false);
  });
});
