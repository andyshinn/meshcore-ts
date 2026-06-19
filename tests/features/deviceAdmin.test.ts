import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import type { FeatureContext } from '../../src/feature';
import {
  createDeviceAdminRuntime,
  type DeviceAdminRuntime,
  decodeExportedPrivateKey,
  deviceAdminFeature,
  encodeExportPrivateKey,
  encodeFactoryReset,
  encodeImportPrivateKey,
  encodeSetDevicePin,
  exportPrivateKey,
  resetDeviceAdmin,
} from '../../src/features/deviceAdmin';
import { FeatureDisabledError } from '../../src/model/errors';

const hex = (b: Buffer) => b.toString('hex');
const KEY = 'ab'.repeat(64); // 64-byte ed25519 expanded private key

// Per-session ctx/rt harness (the template later stateful-feature tasks reuse).
// FeatureContext is wide; the FIFO/dual-reply tests only touch `writeFrame` and
// `rt.deviceAdmin`, so we build a minimal fake carrying just those fields plus a
// record of written frames, then cast to FeatureContext. A full rt is impractical
// here — the localized `as unknown as FeatureContext` keeps the cast contained.
function makeCtx(): { ctx: FeatureContext; rt: DeviceAdminRuntime; writes: Buffer[] } {
  const rt: DeviceAdminRuntime = createDeviceAdminRuntime();
  const writes: Buffer[] = [];
  const ctx = {
    writeFrame: async (frame: Buffer) => {
      writes.push(frame);
    },
    rt: { deviceAdmin: rt },
  } as unknown as FeatureContext;
  return { ctx, rt, writes };
}

describe('deviceAdmin: encodeExportPrivateKey', () => {
  it('is the bare opcode', () => {
    expect(hex(encodeExportPrivateKey())).toBe('17');
  });
});

describe('deviceAdmin: encodeImportPrivateKey', () => {
  it('is [0x18][64B prv_key]', () => {
    expect(hex(encodeImportPrivateKey(KEY))).toBe(`18${KEY}`);
  });

  it('rejects a key that is not exactly 64 bytes', () => {
    expect(() => encodeImportPrivateKey('aabb')).toThrow(/64/);
    expect(() => encodeImportPrivateKey('ab'.repeat(32))).toThrow(/64/);
  });
});

describe('deviceAdmin: decodeExportedPrivateKey', () => {
  it('reads the 64-byte private key, or null when short', () => {
    const frame = Buffer.concat([Buffer.from([0x0e]), Buffer.from(KEY, 'hex')]);
    expect(decodeExportedPrivateKey(frame)).toBe(KEY);
    expect(decodeExportedPrivateKey(Buffer.from([0x0e]))).toBeNull();
    // 1 + 63 bytes is one short of a full key.
    expect(decodeExportedPrivateKey(Buffer.alloc(64))).toBeNull();
  });
});

describe('deviceAdmin: encodeSetDevicePin', () => {
  it('is [0x25][pin u32 LE]', () => {
    expect(hex(encodeSetDevicePin(123456))).toBe('2540e20100');
  });

  it('accepts 0 to disable the PIN', () => {
    expect(hex(encodeSetDevicePin(0))).toBe('2500000000');
  });

  it('rejects a non-zero PIN outside the 6-digit range', () => {
    expect(() => encodeSetDevicePin(99999)).toThrow(/6-digit/);
    expect(() => encodeSetDevicePin(1000000)).toThrow(/6-digit/);
  });
});

describe('deviceAdmin: encodeFactoryReset', () => {
  it('is [0x33] followed by the literal "reset" bytes', () => {
    expect(hex(encodeFactoryReset())).toBe('337265736574'); // 0x33 + "reset"
  });

  it('encodes exactly 6 bytes ending in "reset"', () => {
    const out = encodeFactoryReset();
    expect(out.length).toBe(6);
    expect(out[0]).toBe(0x33);
    expect(out.subarray(1).toString('ascii')).toBe('reset');
  });
});

describe('deviceAdmin: export FIFO + dual-reply correlation (rt-relocated)', () => {
  it('queues exportPrivateKey on ctx.rt.deviceAdmin and writes the bare opcode', async () => {
    const { ctx, rt, writes } = makeCtx();
    const p = exportPrivateKey(ctx);
    // The awaiter is queued on the per-session rt FIFO, and the CMD frame is sent.
    expect(rt.pendingExports).toHaveLength(1);
    expect(writes).toHaveLength(1);
    expect(hex(writes[0])).toBe('17');
    // Drain so the pending promise doesn't dangle.
    resetDeviceAdmin(ctx, 'cleanup');
    await expect(p).rejects.toThrow('cleanup');
  });

  it('resolves the oldest pending export from RESP_PRIVATE_KEY', async () => {
    const { ctx, rt } = makeCtx();
    const p = exportPrivateKey(ctx);
    const frame = Buffer.concat([Buffer.from([0x0e]), Buffer.from(KEY, 'hex')]);
    deviceAdminFeature.handle(0x0e, frame, ctx);
    await expect(p).resolves.toBe(KEY);
    expect(rt.pendingExports).toHaveLength(0); // shifted off the FIFO
  });

  it('rejects FeatureDisabledError on RESP_DISABLED', async () => {
    const { ctx, rt } = makeCtx();
    const p = exportPrivateKey(ctx);
    deviceAdminFeature.handle(0x0f, Buffer.from([0x0f]), ctx);
    await expect(p).rejects.toBeInstanceOf(FeatureDisabledError);
    expect(rt.pendingExports).toHaveLength(0);
  });

  it('correlates FIFO order across two in-flight exports', async () => {
    const { ctx, rt } = makeCtx();
    const first = exportPrivateKey(ctx);
    const second = exportPrivateKey(ctx);
    expect(rt.pendingExports).toHaveLength(2);
    // First reply (PRIVATE_KEY) resolves the oldest; second reply (DISABLED) the next.
    const keyFrame = Buffer.concat([Buffer.from([0x0e]), Buffer.from(KEY, 'hex')]);
    deviceAdminFeature.handle(0x0e, keyFrame, ctx);
    deviceAdminFeature.handle(0x0f, Buffer.from([0x0f]), ctx);
    await expect(first).resolves.toBe(KEY);
    await expect(second).rejects.toBeInstanceOf(FeatureDisabledError);
    expect(rt.pendingExports).toHaveLength(0);
  });

  it('handle is a harmless no-op when no export is queued', () => {
    const { ctx, rt } = makeCtx();
    // RESP_DISABLED for a build-gated import (not queued here) must not throw.
    expect(() => deviceAdminFeature.handle(0x0f, Buffer.from([0x0f]), ctx)).not.toThrow();
    expect(rt.pendingExports).toHaveLength(0);
  });

  it('rejects a malformed RESP_PRIVATE_KEY frame', async () => {
    const { ctx } = makeCtx();
    const p = exportPrivateKey(ctx);
    deviceAdminFeature.handle(0x0e, Buffer.from([0x0e]), ctx); // missing the 64B key
    await expect(p).rejects.toThrow(/malformed/);
  });

  it('resetDeviceAdmin drains all pending exports with the given reason', async () => {
    const { ctx, rt } = makeCtx();
    const a = exportPrivateKey(ctx);
    const b = exportPrivateKey(ctx);
    expect(rt.pendingExports).toHaveLength(2);
    resetDeviceAdmin(ctx, 'disconnected');
    await expect(a).rejects.toThrow('disconnected');
    await expect(b).rejects.toThrow('disconnected');
    expect(rt.pendingExports).toHaveLength(0);
  });
});
