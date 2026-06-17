import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { CMD, RESP } from '../codes';
import type { Feature, FeatureContext } from '../feature';
import { buildPath, channelHashOf } from '../paths';
import type { Message, MessagePath } from '../types';
import * as channels from './channels';
import * as drain from './drain';

// ---- Encoder -----------------------------------------------------------

// CMD_SEND_CHAN_TXT_MSG payload (per src/main/bridge/drain.ts):
//   [0x03][flags 1B][chan_idx 1B][ts 4B LE][text UTF-8...]
export function encodeSendChannelText(opts: {
  channelIdx: number;
  text: string;
  timestampUnix?: number;
  flags?: number;
}): Buffer {
  const text = Buffer.from(opts.text, 'utf8');
  const ts = opts.timestampUnix ?? Math.floor(Date.now() / 1000);
  const out = Buffer.alloc(7 + text.length);
  out[0] = CMD.SEND_CHAN_TXT_MSG;
  out[1] = opts.flags ?? 0;
  out[2] = opts.channelIdx & 0xff;
  out.writeUInt32LE(ts >>> 0, 3);
  text.copy(out, 7);
  return out;
}

// ---- Decoders ----------------------------------------------------------

// RESP_CHANNEL_MSG_RECV_V3 frame layout (firmware: companion_radio/MyMesh.cpp
// onChannelMessageRecv):
//   [0]: 0x11
//   [1]: snr*4 (signed int8) — divide by 4 for dB
//   [2..3]: 2B reserved
//   [4]: channel index (slot on the radio)
//   [5]: path_len (hop count for flood; 0xFF for direct)
//   [6]: txt_type
//   [7..10]: timestamp uint32 LE (UNIX seconds)
//   [11..]: text body (often prefixed "name: ")
export interface ChannelMsgV3 {
  snrDb: number;
  channelIdx: number;
  pathLen: number;
  txtType: number;
  timestampUnix: number;
  body: string;
  /** Body with the trailing "name: " sender prefix split out, when present. */
  senderName: string | null;
  cleanBody: string;
}

export function decodeChannelMsgV3(frame: Buffer): ChannelMsgV3 | null {
  if (frame.length < 11) return null;
  const snrRaw = frame.readInt8(1);
  const channelIdx = frame[4];
  const pathLen = frame[5];
  const txtType = frame[6];
  const timestampUnix = frame.readUInt32LE(7);
  const body = frame.subarray(11).toString('utf8').replace(/\0+$/, '');
  const { senderName, cleanBody } = splitSenderPrefix(body);
  return {
    snrDb: snrRaw / 4,
    channelIdx,
    pathLen,
    txtType,
    timestampUnix,
    body,
    senderName,
    cleanBody,
  };
}

// Older RESP_CHANNEL_MSG_RECV (0x08) — no SNR/reserved prefix.
//   [0]: 0x08
//   [1]: channel index
//   [2]: path_len
//   [3]: txt_type
//   [4..7]: timestamp uint32 LE
//   [8..]: text body
export function decodeChannelMsgV1(frame: Buffer): ChannelMsgV3 | null {
  if (frame.length < 8) return null;
  const channelIdx = frame[1];
  const pathLen = frame[2];
  const txtType = frame[3];
  const timestampUnix = frame.readUInt32LE(4);
  const body = frame.subarray(8).toString('utf8').replace(/\0+$/, '');
  const { senderName, cleanBody } = splitSenderPrefix(body);
  return {
    snrDb: 0,
    channelIdx,
    pathLen,
    txtType,
    timestampUnix,
    body,
    senderName,
    cleanBody,
  };
}

// Sender names on channel messages are conventionally prefixed "name: " by the
// originating node. Strip them for cleaner rendering; keep the original body
// available too.
function splitSenderPrefix(body: string): { senderName: string | null; cleanBody: string } {
  const colon = body.indexOf(': ');
  if (colon <= 0 || colon > 32) return { senderName: null, cleanBody: body };
  const candidate = body.slice(0, colon);
  // Reject control chars but allow non-ASCII (sender names commonly include emoji).
  for (let i = 0; i < candidate.length; i++) {
    const code = candidate.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return { senderName: null, cleanBody: body };
  }
  return { senderName: candidate, cleanBody: body.slice(colon + 2) };
}

// ---- Send --------------------------------------------------------------

/** Returns ok on transport-level write success. When ok, `channelHash` is
 *  the byte the firmware tags GRP_TXT packets with on this channel — the
 *  caller uses it to register a pending-send entry so subsequent
 *  PUSH_CODE_LOG_RX_DATA observations matching that byte can be attributed
 *  back to the outgoing message (repeater relays we hear over the air). */
export async function sendChannelText(
  ctx: FeatureContext,
  channelKey: string,
  text: string,
): Promise<{ ok: boolean; error?: string; channelHash?: number }> {
  const channel = ctx.state.getChannels().find((c) => c.key === channelKey);
  if (!channel) return { ok: false, error: `unknown channel ${channelKey}` };
  const idx = channel.idx ?? channels.findIdxByKey(ctx, channelKey);
  if (idx === undefined || idx === null) {
    return { ok: false, error: `no slot index known for ${channelKey}` };
  }

  const frame = encodeSendChannelText({ channelIdx: idx, text });
  try {
    await ctx.writeFrame(frame);
    const channelHash = channelHashOf(channel) ?? undefined;
    return { ok: true, channelHash };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ---- Inbound feature ---------------------------------------------------

export const channelMessagesFeature: Feature = {
  handles: [RESP.CHANNEL_MSG_RECV_V3, RESP.CHANNEL_MSG_RECV],
  handle: (code, frame, ctx) => {
    const parsed = code === RESP.CHANNEL_MSG_RECV_V3 ? decodeChannelMsgV3(frame) : decodeChannelMsgV1(frame);
    if (!parsed) return;
    const channel = channels.getChannelByIdx(ctx, parsed.channelIdx);
    if (!channel) {
      ctx.log.warn(`incoming channel msg idx=${parsed.channelIdx} doesn't match any known channel slot`);
      return;
    }

    const owner = ctx.state.getOwner();

    // Pull matching mesh-side observations for this channel + hop count and
    // build the Message's paths from them. parsed.pathLen carries the firmware
    // path_len byte (hashSize in bits 6..7, hashCount in bits 0..5); 0xFF means
    // "direct, no flood" — no per-hop bytes to fetch.
    const paths: MessagePath[] = [];
    let finalSnr = parsed.snrDb;
    if (parsed.pathLen !== 0xff) {
      const hashCount = parsed.pathLen & 0x3f;
      const channelHashByte = channelHashOf(channel);
      if (channelHashByte != null) {
        const observations = ctx.rt.meshObs.consumeMatching(channelHashByte, hashCount);
        for (const obs of observations) {
          paths.push(buildPath(obs.pathHex, obs.hashSize, obs.finalSnr, parsed.senderName, owner?.name));
        }
        // Prefer the SNR our radio measured on the LoRa frame (mesh side) over
        // the one the firmware quoted in 0x11 — they're the same value when the
        // observation arrived from the same hop, and the mesh one is fresher.
        if (observations.length > 0) finalSnr = observations[0].finalSnr;
      }
    }

    // Deterministic id: re-receipts of the same flood message via different
    // paths collide here so upsertMessage merges them into one row.
    const bodyHash = createHash('sha1').update(parsed.cleanBody).digest('hex').slice(0, 12);
    const id = `chmsg-${channel.key}-${parsed.timestampUnix}-${bodyHash}`;

    const message: Message = {
      id,
      key: channel.key,
      ts: parsed.timestampUnix * 1000,
      // No pubkey at the channel-message layer; the sender is identified by the
      // "name: " prefix the originating node tacks onto the body.
      fromPublicKeyHex: parsed.senderName ? `name:${parsed.senderName}` : 'unknown',
      body: parsed.cleanBody,
      state: 'received',
      meta: {
        snr: finalSnr,
        ...(paths.length > 0 ? { paths } : {}),
      },
    };
    ctx.state.upsertMessage(message);
    ctx.events.emit('messageUpserted', message);
    ctx.events.emit('messages', channel.key, ctx.state.getMessagesForKey(channel.key));
    ctx.log.debug(
      `channel msg idx=${parsed.channelIdx} → "${channel.name}" (${channel.key}) ` +
        `from=${parsed.senderName ?? 'unknown'} paths=${paths.length} ` +
        `body=${JSON.stringify(parsed.cleanBody.slice(0, 60))}`,
    );
    if (drain.isDraining(ctx)) drain.pumpAfterRecv(ctx);
  },
};
