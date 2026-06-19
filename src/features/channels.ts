import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { Feature, FeatureContext } from '../feature';
import type { Channel } from '../model/types';
import { CMD, RESP } from '../protocol/codes';

// How long to wait for RESP_OK / RESP_ERR after a SET_CHANNEL write before
// giving up. The radio normally responds within ~50ms; 2s leaves slack for a
// busy BLE link without leaving the UI hanging on a dead device.
const SET_CHANNEL_TIMEOUT_MS = 2000;

// ---- Wire layer --------------------------------------------------------

// CMD_GET_CHANNEL: enumerate per-slot.
//   [0x1f][idx]
// We don't yet know if the firmware accepts a bare opcode for "all channels",
// so we iterate by index 0..N-1. Empty slots come back as RESP_ERR (or a
// RESP_CHANNEL_INFO with an all-zero key, which decodeChannelInfo filters).
export function encodeGetChannel(idx: number): Buffer {
  return Buffer.from([CMD.GET_CHANNEL, idx & 0xff]);
}

// CMD_SET_CHANNEL writes a channel slot. Mirror of RESP_CHANNEL_INFO:
//   [0x20][idx][name 32B null-padded][secret 16B]
// Firmware replies RESP_OK on success, RESP_ERR on rejection. The firmware
// stores whatever bytes we give it — no special-case for empty name / zero
// key — so "delete" is implemented by writing zeros and letting our enumerator
// filter it back out via the all-zero-key empty check in decodeChannelInfo.
export function encodeSetChannel(idx: number, name: string, secretHex: string): Buffer {
  const out = Buffer.alloc(2 + 32 + 16);
  out[0] = CMD.SET_CHANNEL;
  out[1] = idx & 0xff;
  const nameBuf = Buffer.from(name, 'utf8');
  nameBuf.copy(out, 2, 0, Math.min(nameBuf.length, 32));
  const secret = Buffer.from(secretHex, 'hex');
  if (secret.length !== 16) {
    throw new Error(`channel secret must be 16 bytes, got ${secret.length}`);
  }
  secret.copy(out, 2 + 32);
  return out;
}

// Hashtag and well-known channels derive their shared key as SHA-256(name)[:16].
// Matches meshcore_py and the official mobile app behavior.
export function deriveChannelSecret(name: string): string {
  return createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 32);
}

// RESP_CHANNEL_INFO frame layout (firmware: companion_radio/MyMesh.cpp):
//   [0]: 0x12
//   [1]: idx
//   [2..33]: name 32B null-padded
//   [34..49]: shared key 16B
export interface ChannelInfo {
  idx: number;
  name: string;
  secretHex: string;
  /** Channels with an all-zero key are unconfigured slots — skip them. */
  empty: boolean;
}

const CHANNEL_INFO_FRAME_LEN = 50;

export function decodeChannelInfo(frame: Buffer): ChannelInfo | null {
  if (frame.length < CHANNEL_INFO_FRAME_LEN) return null;
  const idx = frame[1];
  // The 32B region after idx holds a null-terminated channel name; firmware
  // packs a second field (looks like a topic/owner) into the remaining bytes
  // of the same 32B, so we must stop at the FIRST null — not strip trailing
  // nulls.
  const nameRegion = frame.subarray(2, 34);
  const firstNull = nameRegion.indexOf(0);
  const nameBytes = firstNull === -1 ? nameRegion : nameRegion.subarray(0, firstNull);
  const name = nameBytes.toString('utf8');
  const key = frame.subarray(34, 50);
  const empty = key.every((b) => b === 0);
  return {
    idx,
    name,
    secretHex: key.toString('hex'),
    empty,
  };
}

// ---- State: the idx→Channel dispatch map + on-radio presence -----------

/** Per-session channel state (was the module-level channelByIdx / devicePresence).
 *  `channelByIdx`: channel keys we've seen the radio publish, indexed by slot
 *  index. The device tags incoming RESP_CHANNEL_MSG_RECV(_V3) frames with the
 *  channel index, not a hash, so this is the dispatch map.
 *  `devicePresence`: channel keys the *currently connected* radio reports
 *  owning. Cleared on disconnect. Renderer uses this to gray out channels that
 *  exist only in app storage. */
export interface ChannelsRuntime {
  channelByIdx: Map<number, Channel>;
  devicePresence: Set<string>;
}

export function createChannelsRuntime(): ChannelsRuntime {
  return { channelByIdx: new Map(), devicePresence: new Set() };
}

/** The Channel mapped to a radio slot index, if any. Used by channel-message
 *  dispatch and the channel send path. */
export function getChannelByIdx(ctx: FeatureContext, idx: number): Channel | undefined {
  return ctx.rt.channels.channelByIdx.get(idx);
}

/** Slot index currently mapped to `key`, or null. */
export function findIdxByKey(ctx: FeatureContext, key: string): number | null {
  for (const [idx, channel] of ctx.rt.channels.channelByIdx) {
    if (channel.key === key) return idx;
  }
  return null;
}

/** Snapshot of channel keys currently present on the radio. */
export function getDevicePresence(ctx: FeatureContext): string[] {
  return [...ctx.rt.channels.devicePresence];
}

/** Mark a channel as present on the device. Call after a successful
 *  SET_CHANNEL ack — the firmware doesn't echo CHANNEL_INFO back, so without
 *  this the new channel would stay grayed-out in the UI until the next
 *  full re-enumeration. */
export function markChannelPresent(ctx: FeatureContext, channel: Channel): void {
  if (typeof channel.idx !== 'number') return;
  ctx.rt.channels.channelByIdx.set(channel.idx, channel);
  ctx.rt.channels.devicePresence.add(channel.key);
  ctx.events.emit('channelPresence', [...ctx.rt.channels.devicePresence]);
}

/** Mark a slot as no longer on the device (paired with a zero-key write).
 *  Frees the slot for pickFreeSlot and clears the presence flag. */
export function markChannelAbsent(ctx: FeatureContext, idx: number): void {
  const existing = ctx.rt.channels.channelByIdx.get(idx);
  if (!existing) return;
  ctx.rt.channels.channelByIdx.delete(idx);
  ctx.rt.channels.devicePresence.delete(existing.key);
  ctx.events.emit('channelPresence', [...ctx.rt.channels.devicePresence]);
}

/** Lowest unused slot index in 0..15, or null if all 16 are taken. The
 *  device-presence set is the authority; persisted `idx` on a Channel only
 *  counts when the radio confirmed it this session. */
export function pickFreeSlot(ctx: FeatureContext): number | null {
  for (let i = 0; i < 16; i += 1) {
    if (!ctx.rt.channels.channelByIdx.has(i)) return i;
  }
  return null;
}

/** Clear presence (on connect, before re-enumeration, and on disconnect). */
export function clearPresence(ctx: FeatureContext): void {
  ctx.rt.channels.devicePresence.clear();
  ctx.events.emit('channelPresence', [...ctx.rt.channels.devicePresence]);
}

/** Recompute channel indexes from persisted channels so we can send before
 *  enumeration finishes (handshake takes ~1s). */
export function rebuildIndexes(ctx: FeatureContext): void {
  for (const ch of ctx.state.getChannels()) {
    if (typeof ch.idx === 'number') ctx.rt.channels.channelByIdx.set(ch.idx, ch);
  }
}

/** Write a channel slot (add / edit / delete). Delete = empty name + zero
 *  key, which our enumerator filters as `empty`. Returns true if the radio
 *  acked, false on RESP_ERR / timeout / disconnect. */
export async function setChannel(ctx: FeatureContext, idx: number, name: string, secretHex: string): Promise<boolean> {
  if (ctx.getTransportState() !== 'connected') return false;
  try {
    // ctx.request (no `expect`) wraps the session's RESP_OK/ERR ack FIFO with
    // the same timeout the old awaitAck(SET_CHANNEL_TIMEOUT_MS) used; it throws
    // ProtocolError on RESP_ERR/timeout, which the catch maps to false.
    await ctx.request(encodeSetChannel(idx, name, secretHex), {
      timeoutMs: SET_CHANNEL_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

// ---- Inbound feature ---------------------------------------------------

/** Decode RESP_CHANNEL_INFO, update the idx→Channel map, device-presence set,
 *  and persisted channel state, emitting the relevant events. Returns the
 *  decoded Channel, or null for an empty/unparseable slot. Shared by the feature
 *  handler and the on-demand getChannel() getter (typed-reply path bypasses the
 *  handler, so the getter calls this explicitly). */
export function applyChannelInfo(ctx: FeatureContext, frame: Buffer): Channel | null {
  const info = decodeChannelInfo(frame);
  if (!info) return null;
  if (info.empty) {
    // Slot was previously populated but is now empty (e.g. just deleted).
    // Drop it from devicePresence and from the channelByIdx dispatch map so
    // a future re-enumeration starts clean.
    const existing = ctx.rt.channels.channelByIdx.get(info.idx);
    if (existing) {
      ctx.rt.channels.channelByIdx.delete(info.idx);
      ctx.rt.channels.devicePresence.delete(existing.key);
      ctx.events.emit('channelPresence', [...ctx.rt.channels.devicePresence]);
    }
    return null;
  }

  const key = `ch:${info.name}`;
  const channel: Channel = {
    key,
    name: info.name,
    kind: info.name.startsWith('#') ? 'hashtag' : info.name === 'Public' ? 'public' : 'private',
    secretHex: info.secretHex,
    idx: info.idx,
  };

  ctx.rt.channels.channelByIdx.set(info.idx, channel);
  ctx.rt.channels.devicePresence.add(key);
  ctx.events.emit('channelPresence', [...ctx.rt.channels.devicePresence]);

  ctx.state.upsertChannel(channel);
  ctx.events.emit('channels', ctx.state.getChannels());
  ctx.log.debug(`channel idx=${info.idx} "${info.name}"`);
  return channel;
}

/** Actively re-query a single channel slot (CMD_GET_CHANNEL) and apply the
 *  reply. Resolves the decoded Channel, or null for a missing/empty slot.
 *  Uses requestOrNull so that a RESP_ERR ("not found") is consumed via the
 *  shared ack FIFO and cannot be mistaken for a rejected DM send. */
export async function getChannel(ctx: FeatureContext, idx: number): Promise<Channel | null> {
  const frame = await ctx.requestOrNull(encodeGetChannel(idx), RESP.CHANNEL_INFO);
  if (!frame) return null;
  return applyChannelInfo(ctx, frame);
}

export const channelsFeature: Feature = {
  handles: [RESP.CHANNEL_INFO],
  handle: (_code, frame, ctx) => {
    applyChannelInfo(ctx, frame);
  },
};
