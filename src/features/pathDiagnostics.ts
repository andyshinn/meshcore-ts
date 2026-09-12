import { Buffer } from 'node:buffer';
import { ProtocolError } from '../model/errors';
import { CMD, PUSH, RESP } from '../protocol/codes';
import { parsePublicKey } from '../protocol/pubkey';
import { scheduleContactRefresh, upsertContact } from './contacts';
import type { Feature, FeatureContext } from './feature';

// Path diagnostics (firmware: companion_radio/MyMesh.cpp). Two queries plus a
// liveness push:
//   - getAdvertPath: the device's cached advert path for a contact (RESP_ADVERT_PATH
//     or RESP_ERR NOT_FOUND).
//   - sendPathDiscoveryReq: flood a special telemetry request, then await the
//     round-trip path in PUSH_PATH_DISCOVERY_RESPONSE.
//   - PUSH_PATH_UPDATED: the radio updated a contact's routing path.
//
// The discovery push carries NO tag (the firmware tracks a single pending
// discovery internally and identifies the contact by a 6-byte pubkey prefix),
// so we correlate the in-flight request against that prefix in this module.

// Cap on how long sendPathDiscoveryReq waits for the response push after the
// request is dispatched. A multi-hop flood round-trip is the worst case; this
// mirrors the DM retry's per-attempt budget.
const PATH_DISCOVERY_TIMEOUT_MS = 30_000;

// ---- Compound path_len helpers -----------------------------------------
// The mesh path_len byte packs the hop count (low 6 bits) and the bytes-per-hop
// hash size (top 2 bits + 1), so the on-wire path occupies hops × hashSize bytes
// (firmware: Packet::writePath / isValidPathLen).
//
// 0xFF is the one value that is NOT a compound length: it is the flood /
// no-path sentinel (firmware OUT_PATH_UNKNOWN, meshcore_py's path_len -1) and
// no path bytes follow it. Unpacking it would claim 63 hops × 4 bytes = 252
// path bytes and make the decoders below reject the whole frame, so both
// helpers special-case it to zero — matching how decodeContact and the session
// contact rows already collapse a 0xFF out_path_len to an empty path.
//
// Zero is also a legitimate hop count, though, so the decoders additionally
// report the sentinel through a flag (see AdvertPath.flood) rather than leaving
// callers to guess which kind of empty path they were handed.
const PATH_LEN_FLOOD = 0xff;
function isFloodPathLen(pathLenByte: number): boolean {
  return pathLenByte === PATH_LEN_FLOOD;
}
function pathHops(pathLenByte: number): number {
  return isFloodPathLen(pathLenByte) ? 0 : pathLenByte & 0x3f;
}
function pathByteLen(pathLenByte: number): number {
  if (isFloodPathLen(pathLenByte)) return 0;
  const hashSize = (pathLenByte >> 6) + 1;
  return pathHops(pathLenByte) * hashSize;
}

// ---- Wire types --------------------------------------------------------

/** The device's cached advert path for a contact.
 *
 *  `flood` separates the two very different results that both arrive as an
 *  empty path. path_len 0x00 is a real reception with no relays ("heard
 *  direct"); path_len 0xFF is the flood / no-path sentinel, meaning the device
 *  holds no path for this contact at all. The sentinel carries no path bytes,
 *  so both collapse to `hops: 0` / `pathHex: ''` — and unlike a contact row,
 *  which keeps its raw `outPathLen`, a `getAdvertPath` caller only ever sees
 *  this struct, with no way back to the wire byte.
 *
 *  0.8.0 deliberately shipped without the flag, on the grounds that "no path to
 *  walk" was already how the library surfaced a 0xFF path length elsewhere.
 *  That reasoning does not survive contact with a consumer that persists an
 *  inbound-hops column: it recorded "heard direct, 0 hops" for nodes it had no
 *  path information about, and the wrong reading outlived the query. Hence the
 *  flag — added as an optional property that is only ever `true`, so every
 *  existing field keeps its type and existing consumers keep compiling. The
 *  change is additive, not breaking. */
export interface AdvertPath {
  recvTimestampUnix: number;
  hops: number;
  pathHex: string;
  /** Present (always `true`) only when path_len was the 0xFF sentinel: `hops: 0`
   *  then means "no cached path / would flood", not "direct". */
  flood?: true;
}

/** The round-trip path discovered by a path-discovery request.
 *
 *  Each leg has its own path_len byte and so its own flood flag, set on the same
 *  terms as `AdvertPath.flood`. The two are independent: the reply can arrive
 *  over a known path while the outbound leg is still unknown, or vice versa. */
export interface DiscoveredPath {
  pubKeyPrefixHex: string;
  outHops: number;
  outPathHex: string;
  /** Present (always `true`) only when out_path_len was the 0xFF sentinel. */
  outFlood?: true;
  inHops: number;
  inPathHex: string;
  /** Present (always `true`) only when in_path_len was the 0xFF sentinel. */
  inFlood?: true;
}

// ---- Encoders ----------------------------------------------------------

function encodePubKeyCommand(code: number, destPublicKeyHex: string, label: string): Buffer {
  const pubkey = parsePublicKey(destPublicKeyHex, label);
  const out = Buffer.alloc(2 + 32);
  out[0] = code;
  out[1] = 0; // reserved (firmware requires byte 1 == 0 for path discovery)
  pubkey.copy(out, 2, 0, 32);
  return out;
}

// CMD_SEND_PATH_DISCOVERY_REQ: [0x34][0x00][32B pubkey].
export function encodeSendPathDiscoveryReq(destPublicKeyHex: string): Buffer {
  return encodePubKeyCommand(CMD.SEND_PATH_DISCOVERY_REQ, destPublicKeyHex, 'path discovery');
}

// CMD_GET_ADVERT_PATH: [0x2a][0x00][32B pubkey].
export function encodeGetAdvertPath(destPublicKeyHex: string): Buffer {
  return encodePubKeyCommand(CMD.GET_ADVERT_PATH, destPublicKeyHex, 'get advert path');
}

// ---- Decoders ----------------------------------------------------------

// RESP_ADVERT_PATH: [0x16][recv_timestamp u32 LE][path_len u8][path bytes].
// path_len 0xFF (flood / no path) carries no path bytes, so the frame is a
// valid 6-byte response; it decodes to zero hops with an empty path and
// `flood: true` to mark that empty path as "unknown" rather than "direct".
export function decodeAdvertPath(frame: Buffer): AdvertPath | null {
  if (frame.length < 6) return null;
  const pathLenByte = frame[5];
  const byteLen = pathByteLen(pathLenByte);
  if (frame.length < 6 + byteLen) return null;
  return {
    recvTimestampUnix: frame.readUInt32LE(1),
    hops: pathHops(pathLenByte),
    pathHex: frame.subarray(6, 6 + byteLen).toString('hex'),
    ...(isFloodPathLen(pathLenByte) ? ({ flood: true } as const) : {}),
  };
}

// PUSH_PATH_DISCOVERY_RESPONSE:
//   [0x8d][reserved u8][6B prefix][out_path_len u8][out_path][in_path_len u8][in_path]
// Either length byte can be the 0xFF flood sentinel (that leg has no path), in
// which case no bytes follow it and the leg decodes to zero hops / empty path
// plus its own flood flag — the legs are flagged independently.
export function decodePathDiscoveryResponse(frame: Buffer): DiscoveredPath | null {
  if (frame.length < 9) return null; // code + reserved + 6B prefix + out_path_len
  const pubKeyPrefixHex = frame.subarray(2, 8).toString('hex');
  let off = 8;
  const outLenByte = frame[off];
  off += 1;
  const outBytes = pathByteLen(outLenByte);
  if (frame.length < off + outBytes + 1) return null; // need out_path + in_path_len
  const outPathHex = frame.subarray(off, off + outBytes).toString('hex');
  off += outBytes;
  const inLenByte = frame[off];
  off += 1;
  const inBytes = pathByteLen(inLenByte);
  if (frame.length < off + inBytes) return null;
  const inPathHex = frame.subarray(off, off + inBytes).toString('hex');
  return {
    pubKeyPrefixHex,
    outHops: pathHops(outLenByte),
    outPathHex,
    ...(isFloodPathLen(outLenByte) ? ({ outFlood: true } as const) : {}),
    inHops: pathHops(inLenByte),
    inPathHex,
    ...(isFloodPathLen(inLenByte) ? ({ inFlood: true } as const) : {}),
  };
}

// PUSH_PATH_UPDATED: [0x81][32B pubkey]. Returns the lowercase hex, or null if short.
export function decodePathUpdated(frame: Buffer): string | null {
  if (frame.length < 1 + 32) return null;
  return frame.subarray(1, 33).toString('hex');
}

// ---- Discovery correlation ---------------------------------------------

export interface PendingDiscovery {
  prefixHex: string;
  resolve: (p: DiscoveredPath) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Per-session path-diagnostics state (was the module-level pendingDiscovery).
 *  The firmware tracks a single pending discovery, so we mirror that with one
 *  slot. A fresh request supersedes any prior one. */
export interface PathDiagRuntime {
  pendingDiscovery: PendingDiscovery | null;
}

export function createPathDiagRuntime(): PathDiagRuntime {
  return { pendingDiscovery: null };
}

function armDiscovery(
  ctx: FeatureContext,
  prefixHex: string,
): {
  promise: Promise<DiscoveredPath>;
  entry: PendingDiscovery;
} {
  if (ctx.rt.pathDisc.pendingDiscovery) {
    clearTimeout(ctx.rt.pathDisc.pendingDiscovery.timer);
    ctx.rt.pathDisc.pendingDiscovery.reject(new Error('superseded by a new path discovery'));
    ctx.rt.pathDisc.pendingDiscovery = null;
  }
  let entry!: PendingDiscovery;
  const promise = new Promise<DiscoveredPath>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (ctx.rt.pathDisc.pendingDiscovery === entry) ctx.rt.pathDisc.pendingDiscovery = null;
      reject(new Error('path discovery timed out'));
    }, PATH_DISCOVERY_TIMEOUT_MS);
    entry = { prefixHex, resolve, reject, timer };
  });
  ctx.rt.pathDisc.pendingDiscovery = entry;
  return { promise, entry };
}

// Disarm only when `entry` is still the active discovery — a later request for
// the same contact supersedes it (replacing pendingDiscovery), so a failed
// dispatch from the older request must not reject the newer one's promise.
function disarmDiscovery(ctx: FeatureContext, entry: PendingDiscovery, err: Error): void {
  if (ctx.rt.pathDisc.pendingDiscovery === entry) {
    clearTimeout(entry.timer);
    entry.reject(err);
    ctx.rt.pathDisc.pendingDiscovery = null;
  }
}

/** Fail an in-flight discovery (on disconnect/stop). */
export function resetPathDiagnostics(ctx: FeatureContext, reason: string): void {
  if (ctx.rt.pathDisc.pendingDiscovery) {
    clearTimeout(ctx.rt.pathDisc.pendingDiscovery.timer);
    ctx.rt.pathDisc.pendingDiscovery.reject(new Error(reason));
    ctx.rt.pathDisc.pendingDiscovery = null;
  }
}

// ---- Inbound feature ---------------------------------------------------

export const pathDiagnosticsFeature: Feature = {
  handles: [PUSH.PATH_DISCOVERY_RESPONSE, PUSH.PATH_UPDATED],
  handle: (code, frame, ctx) => {
    if (code === PUSH.PATH_UPDATED) {
      // The radio updated a contact's path (no path bytes inline). Touch the
      // known contact's last-seen so the UI reflects liveness. Then schedule a
      // non-blocking re-fetch of the full contact record so the updated out_path
      // becomes visible without waiting for the next full GET_CONTACTS sync.
      //
      // The refresh keeps the 'sync' default deliberately: a path update is not
      // an advert, so it must not mark the contact heard-live. Unlike
      // PUSH_ADVERT, this stays gated on a contact we already hold — the radio
      // only recomputes paths for contacts in its store, so an unknown pubkey
      // here is not the newly-auto-added case that 0x80 carries.
      const pubkeyHex = decodePathUpdated(frame);
      if (pubkeyHex) {
        const existing = ctx.state.getContact(`c:${pubkeyHex}`);
        if (existing) {
          upsertContact(ctx, { ...existing, lastSeenMs: Date.now() });
          ctx.log.trace(`path updated: touched ${pubkeyHex.slice(0, 12)}`);
          scheduleContactRefresh(ctx, pubkeyHex);
        }
      }
      return;
    }
    // PUSH.PATH_DISCOVERY_RESPONSE
    const resp = decodePathDiscoveryResponse(frame);
    if (!resp) return;
    const pending = ctx.rt.pathDisc.pendingDiscovery;
    if (pending && pending.prefixHex === resp.pubKeyPrefixHex) {
      clearTimeout(pending.timer);
      ctx.rt.pathDisc.pendingDiscovery = null;
      pending.resolve(resp);
    } else {
      ctx.log.debug(`unmatched path discovery response prefix=${resp.pubKeyPrefixHex}`);
    }
  },
};

// ---- Session-facing functions ------------------------------------------

function fullPubKey(ctx: FeatureContext, contactKey: string, label: string): string {
  const contact = ctx.state.getContact(contactKey);
  if (!contact?.publicKeyHex || contact.publicKeyHex.length < 64) {
    throw new Error(`${label}: contact ${contactKey} has no full 32B public key`);
  }
  return contact.publicKeyHex;
}

/** Discover the round-trip mesh path to a contact. Dispatches the request
 *  (rejecting ProtocolError if the radio can't send it) and resolves with the
 *  paths from PUSH_PATH_DISCOVERY_RESPONSE (or rejects on timeout/disconnect). */
export function sendPathDiscoveryReq(ctx: FeatureContext, contactKey: string): Promise<DiscoveredPath> {
  const pubkey = fullPubKey(ctx, contactKey, 'path discovery');
  const prefixHex = pubkey.slice(0, 12);
  // Arm the response waiter before dispatch so a fast push can't be missed, then
  // return that single promise: it resolves on PUSH_PATH_DISCOVERY_RESPONSE and
  // rejects on dispatch error / timeout / disconnect. The dispatch runs detached
  // and only feeds the failure path back into the same promise via disarm.
  const { promise, entry } = armDiscovery(ctx, prefixHex);
  void (async () => {
    try {
      // RESP_SENT confirms dispatch (consumed here so it isn't mistaken for a
      // DM); RESP_ERR (NOT_FOUND / TABLE_FULL) comes back as null.
      const sent = await ctx.requestOrNull(encodeSendPathDiscoveryReq(pubkey), RESP.SENT);
      if (sent === null) disarmDiscovery(ctx, entry, new ProtocolError());
    } catch (err) {
      disarmDiscovery(ctx, entry, err as Error);
    }
  })();
  return promise;
}

/** The device's cached advert path for a contact, or null when none is cached
 *  (the firmware answers RESP_ERR NOT_FOUND). */
export async function getAdvertPath(ctx: FeatureContext, contactKey: string): Promise<AdvertPath | null> {
  const pubkey = fullPubKey(ctx, contactKey, 'get advert path');
  const frame = await ctx.requestOrNull(encodeGetAdvertPath(pubkey), RESP.ADVERT_PATH);
  return frame ? decodeAdvertPath(frame) : null;
}
