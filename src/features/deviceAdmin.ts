import { Buffer } from 'node:buffer';
import { FeatureDisabledError, ProtocolTimeoutError } from '../errors';
import type { Feature, FeatureContext } from '../feature';
import { CMD, RESP } from '../protocol/codes';

// Device administration (firmware: companion_radio/MyMesh.cpp). Groups the
// build-gated private-key export/import, the BLE-PIN setter, and factory reset.
//
// Private-key export/import are compiled out unless the firmware sets
// ENABLE_PRIVATE_KEY_EXPORT / ENABLE_PRIVATE_KEY_IMPORT, in which case the radio
// answers RESP_DISABLED instead of the normal reply. EXPORT therefore has a
// dual reply — RESP_PRIVATE_KEY *or* RESP_DISABLED — which the bare
// ctx.request({ expect }) FIFO can't express ("either code"). A small registry
// Feature correlates the in-flight export against whichever arrives.

// Cap on how long exportPrivateKey waits for RESP_PRIVATE_KEY / RESP_DISABLED.
const EXPORT_TIMEOUT_MS = 5_000;

// ---- Encoders ----------------------------------------------------------

// CMD_EXPORT_PRIVATE_KEY: [0x17] (bare). Reply is RESP_PRIVATE_KEY or RESP_DISABLED.
export function encodeExportPrivateKey(): Buffer {
  return Buffer.from([CMD.EXPORT_PRIVATE_KEY]);
}

// CMD_IMPORT_PRIVATE_KEY: [0x18][64B prv_key] (65B). The firmware reads exactly
// 64 bytes (PRV_KEY_SIZE) and rejects anything else, so we require a full key.
export function encodeImportPrivateKey(privKeyHex: string): Buffer {
  const key = Buffer.from(privKeyHex, 'hex');
  if (key.length !== 64) {
    throw new Error(`import private key needs a 64-byte key, got ${key.length}`);
  }
  const out = Buffer.alloc(1 + 64);
  out[0] = CMD.IMPORT_PRIVATE_KEY;
  key.copy(out, 1);
  return out;
}

// CMD_SET_DEVICE_PIN: [0x25][pin u32 LE] (5B). The firmware accepts 0 (disable)
// or a 6-digit PIN; we mirror that guard client-side for a clearer error.
export function encodeSetDevicePin(pin: number): Buffer {
  if (!(pin === 0 || (pin >= 100000 && pin <= 999999))) {
    throw new Error(`device PIN must be 0 (disabled) or a 6-digit number, got ${pin}`);
  }
  const out = Buffer.alloc(5);
  out[0] = CMD.SET_DEVICE_PIN;
  out.writeUInt32LE(pin >>> 0, 1);
  return out;
}

// CMD_FACTORY_RESET: [0x33]"reset" (the literal 5 ASCII bytes guard; 6B total).
export function encodeFactoryReset(): Buffer {
  return Buffer.concat([Buffer.from([CMD.FACTORY_RESET]), Buffer.from('reset', 'ascii')]);
}

// ---- Decoders ----------------------------------------------------------

// RESP_PRIVATE_KEY [0x0e][64B prv_key]. Returns the lowercase hex of the
// 64-byte private key, or null when the frame is short.
export function decodeExportedPrivateKey(frame: Buffer): string | null {
  if (frame.length < 1 + 64) return null;
  return frame.subarray(1, 65).toString('hex');
}

// ---- Dual-reply correlation (export) -----------------------------------

export interface PendingExport {
  resolve: (privKeyHex: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** Per-session state for device admin: the FIFO of in-flight exportPrivateKey()
 *  calls awaiting RESP_PRIVATE_KEY / RESP_DISABLED. Admin actions are
 *  user-initiated and serialise in practice, so the oldest entry is always the
 *  one the radio is answering. */
export interface DeviceAdminRuntime {
  pendingExports: PendingExport[];
}

export function createDeviceAdminRuntime(): DeviceAdminRuntime {
  return { pendingExports: [] };
}

function removePendingExport(ctx: FeatureContext, entry: PendingExport): void {
  const pending = ctx.rt.deviceAdmin.pendingExports;
  const i = pending.indexOf(entry);
  if (i !== -1) pending.splice(i, 1);
}

/** Fail every in-flight export awaiter (on disconnect/stop). */
export function resetDeviceAdmin(ctx: FeatureContext, reason: string): void {
  const pending = ctx.rt.deviceAdmin.pendingExports;
  while (pending.length > 0) {
    const entry = pending.shift();
    if (entry) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
  }
}

export const deviceAdminFeature: Feature = {
  handles: [RESP.PRIVATE_KEY, RESP.DISABLED],
  handle: (code, frame, ctx) => {
    // RESP_DISABLED can also arrive for a build-gated *import* (which does NOT
    // queue here — it rides the bare ack channel). With no export queued, the
    // shift is a harmless no-op and the import's ack times out on its own.
    const entry = ctx.rt.deviceAdmin.pendingExports.shift();
    if (!entry) return;
    clearTimeout(entry.timer);
    if (code === RESP.DISABLED) {
      entry.reject(new FeatureDisabledError());
      return;
    }
    const privKeyHex = decodeExportedPrivateKey(frame);
    if (privKeyHex) entry.resolve(privKeyHex);
    else entry.reject(new Error('malformed RESP_PRIVATE_KEY frame'));
  },
};

// ---- Session-facing functions ------------------------------------------

/** Export the device's 64-byte private key (hex). Rejects FeatureDisabledError
 *  when the firmware build has private-key export compiled out. */
export async function exportPrivateKey(ctx: FeatureContext): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const entry: PendingExport = {
      resolve,
      reject,
      timer: setTimeout(() => {
        removePendingExport(ctx, entry);
        reject(new ProtocolTimeoutError(RESP.PRIVATE_KEY));
      }, EXPORT_TIMEOUT_MS),
    };
    ctx.rt.deviceAdmin.pendingExports.push(entry);
    ctx.writeFrame(encodeExportPrivateKey()).catch((err) => {
      removePendingExport(ctx, entry);
      clearTimeout(entry.timer);
      reject(err as Error);
    });
  });
}

/** Import a 64-byte private key (hex). Resolves on RESP_OK; rejects
 *  ProtocolError on RESP_ERR (invalid key / FS error). On a build without
 *  ENABLE_PRIVATE_KEY_IMPORT the radio answers RESP_DISABLED, which the feature
 *  consumes as a no-op (no export queued) and the ack times out → ProtocolError. */
export async function importPrivateKey(ctx: FeatureContext, privKeyHex: string): Promise<void> {
  await ctx.request(encodeImportPrivateKey(privKeyHex));
}

/** Set the BLE pairing PIN (0 disables it; otherwise a 6-digit number). */
export async function setDevicePin(ctx: FeatureContext, pin: number): Promise<void> {
  await ctx.request(encodeSetDevicePin(pin));
}

/** Wipe the device to factory state. The firmware drops the serial link before
 *  the format completes, so there is no reply to await — fire-and-forget. */
export async function factoryReset(ctx: FeatureContext): Promise<void> {
  await ctx.writeFrame(encodeFactoryReset());
}
