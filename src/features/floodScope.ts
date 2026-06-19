import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { FeatureContext } from '../feature';
import { CMD, RESP } from '../protocol/codes';

const SCOPE_KEY_LEN = 16;
const SCOPE_NAME_LEN = 31;
const DEFAULT_SCOPE_FRAME_LEN = 1 + SCOPE_NAME_LEN + SCOPE_KEY_LEN; // 48

export interface DefaultFloodScope {
  name: string;
  keyHex: string;
}

// CMD_SET_FLOOD_SCOPE_KEY (firmware: MyMesh.cpp:1909-1919) overrides the
// send-scope key for outgoing flood packets. Three behaviors:
//   { keyHex }   → [0x36][0x00][16B key]  set the override key (stays scoped)
//   { clear }    → [0x36][0x00]           zero the override key (stays scoped)
//   { unscoped } → [0x36][0x01]           send unscoped (no flood scope)
export type FloodScopeInput = { keyHex: string } | { clear: true } | { unscoped: true };

export function encodeSetFloodScopeKey(input: FloodScopeInput): Buffer {
  if ('unscoped' in input) return Buffer.from([CMD.SET_FLOOD_SCOPE_KEY, 0x01]);
  if ('clear' in input) return Buffer.from([CMD.SET_FLOOD_SCOPE_KEY, 0x00]);
  const key = Buffer.from(input.keyHex, 'hex');
  if (key.length !== SCOPE_KEY_LEN) {
    throw new Error(`flood scope key must be ${SCOPE_KEY_LEN} bytes, got ${key.length}`);
  }
  const out = Buffer.alloc(2 + SCOPE_KEY_LEN);
  out[0] = CMD.SET_FLOOD_SCOPE_KEY;
  out[1] = 0x00;
  key.copy(out, 2);
  return out;
}

// CMD_SET_DEFAULT_FLOOD_SCOPE (0x3f): [0x3f][name 31B null-padded][key 16B]
// (48B). Firmware requires the name to be 1-30 chars (else ERR_ILLEGAL_ARG).
export function encodeSetDefaultFloodScope(name: string, keyHex: string): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  if (nameBuf.length < 1 || nameBuf.length > SCOPE_NAME_LEN - 1) {
    throw new Error(`flood scope name must be 1-${SCOPE_NAME_LEN - 1} bytes, got ${nameBuf.length}`);
  }
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== SCOPE_KEY_LEN) {
    throw new Error(`flood scope key must be ${SCOPE_KEY_LEN} bytes, got ${key.length}`);
  }
  const out = Buffer.alloc(DEFAULT_SCOPE_FRAME_LEN);
  out[0] = CMD.SET_DEFAULT_FLOOD_SCOPE;
  nameBuf.copy(out, 1); // remainder of the 31B name field stays null-padded
  key.copy(out, 1 + SCOPE_NAME_LEN);
  return out;
}

// A short CMD_SET_DEFAULT_FLOOD_SCOPE frame clears the persisted default scope.
export function encodeClearDefaultFloodScope(): Buffer {
  return Buffer.from([CMD.SET_DEFAULT_FLOOD_SCOPE]);
}

// CMD_GET_DEFAULT_FLOOD_SCOPE: [0x40]. Replies RESP_DEFAULT_FLOOD_SCOPE.
export function encodeGetDefaultFloodScope(): Buffer {
  return Buffer.from([CMD.GET_DEFAULT_FLOOD_SCOPE]);
}

// RESP_DEFAULT_FLOOD_SCOPE: [0x1c][name 31B][key 16B] (48B) when a default scope
// is set, else [0x1c] (1B) when null. Returns null for the no-scope case.
export function decodeDefaultFloodScope(frame: Buffer): DefaultFloodScope | null {
  if (frame.length < DEFAULT_SCOPE_FRAME_LEN) return null;
  const nameRegion = frame.subarray(1, 1 + SCOPE_NAME_LEN);
  const firstNull = nameRegion.indexOf(0);
  const name = (firstNull === -1 ? nameRegion : nameRegion.subarray(0, firstNull)).toString('utf8');
  const keyHex = frame.subarray(1 + SCOPE_NAME_LEN, DEFAULT_SCOPE_FRAME_LEN).toString('hex');
  return { name, keyHex };
}

export async function setFloodScopeKey(ctx: FeatureContext, input: FloodScopeInput): Promise<void> {
  await ctx.request(encodeSetFloodScopeKey(input));
}

export async function setDefaultFloodScope(ctx: FeatureContext, name: string, keyHex: string): Promise<void> {
  await ctx.request(encodeSetDefaultFloodScope(name, keyHex));
}

export async function clearDefaultFloodScope(ctx: FeatureContext): Promise<void> {
  await ctx.request(encodeClearDefaultFloodScope());
}

export async function getDefaultFloodScope(ctx: FeatureContext): Promise<DefaultFloodScope | null> {
  const frame = await ctx.request(encodeGetDefaultFloodScope(), {
    expect: RESP.DEFAULT_FLOOD_SCOPE,
  });
  return decodeDefaultFloodScope(frame);
}

// Derive the 16-byte flood-scope key for a public hashtag region, matching the
// reference's TransportKeyUtil.getHashtagRegionKey: normalize to "#name",
// SHA-256 the UTF-8 bytes, and take the first 16 bytes (the firmware uses the
// first half of the 32-byte hash as the scope key). Returns 32 hex chars.
export function deriveFloodScopeKey(region: string): string {
  const normalized = region.startsWith('#') ? region : `#${region}`;
  return createHash('sha256')
    .update(normalized, 'utf8')
    .digest('hex')
    .slice(0, SCOPE_KEY_LEN * 2);
}

// Convenience: derive the key for a region name and apply it as the send-scope
// override (CMD_SET_FLOOD_SCOPE_KEY).
export async function setFloodScopeRegion(ctx: FeatureContext, region: string): Promise<void> {
  await setFloodScopeKey(ctx, { keyHex: deriveFloodScopeKey(region) });
}
