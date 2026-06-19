import { Buffer } from 'node:buffer';
import type { Feature, FeatureContext } from '../feature';
import { CMD, PUSH, RESP } from '../protocol/codes';
import * as drain from './drain';

// Raw / control / channel datagrams (firmware: companion_radio/MyMesh.cpp).
// Four low-level send variants plus two inbound handlers. These carry custom
// application bytes (not chat text); like PUSH_RAW_DATA (owned by repeaterAdmin)
// the inbound frames are decoded and logged — there is no app consumer yet, so
// no bus event is emitted (that would be IPC/UI scope).

// MAX_CHANNEL_DATA_LENGTH = MAX_FRAME_SIZE(176) − 9 (the channel-data header).
const MAX_CHANNEL_DATA_LENGTH = 167;
// path_len value meaning "flood" (no explicit path) — firmware OUT_PATH_UNKNOWN.
const PATH_FLOOD = 0xff;
// data_type 0 is reserved (firmware DATA_TYPE_RESERVED).
const DATA_TYPE_RESERVED = 0x0000;

// ---- Encoders ----------------------------------------------------------

// CMD_SEND_RAW_DATA: [0x19][path_len u8][path bytes][payload]. path_len is a raw
// byte count 0..127 (flood is unsupported); payload must be ≥4 bytes.
export function encodeSendRawData(opts: { pathHex: string; payload: Buffer }): Buffer {
  const path = Buffer.from(opts.pathHex, 'hex');
  if (path.length > 127) {
    throw new Error(`raw data path is ${path.length}B, max 127 (flood not supported)`);
  }
  if (opts.payload.length < 4) {
    throw new Error(`raw data payload must be ≥4 bytes, got ${opts.payload.length}`);
  }
  return Buffer.concat([Buffer.from([CMD.SEND_RAW_DATA, path.length]), path, opts.payload]);
}

// CMD_SEND_CONTROL_DATA: [0x37][control_data]. The first data byte's high bit
// must be set (firmware guard).
export function encodeSendControlData(payload: Buffer): Buffer {
  if (payload.length < 1) throw new Error('control data must not be empty');
  if ((payload[0] & 0x80) === 0) {
    throw new Error('control data first byte must have its high bit (0x80) set');
  }
  return Buffer.concat([Buffer.from([CMD.SEND_CONTROL_DATA]), payload]);
}

// CMD_SEND_CHANNEL_DATA: [0x3e][channel_idx][0xff flood][data_type u16 LE][payload].
// Only the flood form is exposed (group-channel datagrams broadcast); a
// path-routed channel send is not surfaced.
export function encodeSendChannelData(opts: { channelIdx: number; dataType: number; payload: Buffer }): Buffer {
  if (opts.dataType === DATA_TYPE_RESERVED) {
    throw new Error('channel data_type 0 is reserved');
  }
  if (opts.payload.length > MAX_CHANNEL_DATA_LENGTH) {
    throw new Error(`channel data payload is ${opts.payload.length}B, max ${MAX_CHANNEL_DATA_LENGTH}`);
  }
  const header = Buffer.alloc(5);
  header[0] = CMD.SEND_CHANNEL_DATA;
  header[1] = opts.channelIdx & 0xff;
  header[2] = PATH_FLOOD;
  header.writeUInt16LE(opts.dataType & 0xffff, 3);
  return Buffer.concat([header, opts.payload]);
}

// CMD_SEND_RAW_PACKET: [0x41][priority u8][raw packet bytes]. The packet must be
// at least 2 bytes (a parseable mesh packet header).
export function encodeSendRawPacket(opts: { priority: number; packetHex: string }): Buffer {
  const packet = Buffer.from(opts.packetHex, 'hex');
  if (packet.length < 2) {
    throw new Error(`raw packet must be ≥2 bytes, got ${packet.length}`);
  }
  return Buffer.concat([Buffer.from([CMD.SEND_RAW_PACKET, opts.priority & 0xff]), packet]);
}

// ---- Decoders ----------------------------------------------------------

/** An inbound group-channel datagram (RESP_CHANNEL_DATA_RECV). */
export interface ChannelDataRecv {
  snrDb: number;
  channelIdx: number;
  /** Sender path length (or 0xff when the packet was not route-flood). */
  pathLen: number;
  dataType: number;
  dataHex: string;
}

// RESP_CHANNEL_DATA_RECV:
//   [0x1b][snr×4 i8][rsv][rsv][channel_idx][path_len][data_type u16 LE][data_len][data]
export function decodeChannelDataRecv(frame: Buffer): ChannelDataRecv | null {
  if (frame.length < 9) return null;
  const dataLen = frame[8];
  if (frame.length < 9 + dataLen) return null;
  return {
    snrDb: frame.readInt8(1) / 4,
    channelIdx: frame[4],
    pathLen: frame[5],
    dataType: frame.readUInt16LE(6),
    dataHex: frame.subarray(9, 9 + dataLen).toString('hex'),
  };
}

/** An inbound zero-hop control datagram (PUSH_CONTROL_DATA). */
export interface ControlData {
  snrDb: number;
  rssi: number;
  pathLen: number;
  payloadHex: string;
}

// PUSH_CONTROL_DATA: [0x8e][snr×4 i8][rssi i8][path_len u8][payload bytes].
export function decodeControlData(frame: Buffer): ControlData | null {
  if (frame.length < 4) return null;
  return {
    snrDb: frame.readInt8(1) / 4,
    rssi: frame.readInt8(2),
    pathLen: frame[3],
    payloadHex: frame.subarray(4).toString('hex'),
  };
}

// ---- Inbound feature ---------------------------------------------------

export const rawDataFeature: Feature = {
  handles: [RESP.CHANNEL_DATA_RECV, PUSH.CONTROL_DATA],
  handle: (code, frame, ctx) => {
    if (code === RESP.CHANNEL_DATA_RECV) {
      const parsed = decodeChannelDataRecv(frame);
      if (parsed) {
        ctx.log.debug(
          `channel_data ch=${parsed.channelIdx} type=0x${parsed.dataType.toString(16)} len=${parsed.dataHex.length / 2}`,
        );
      }
      // Queued offline + tickled via PUSH_MSG_WAITING like chat messages; keep
      // the drain pump going so the rest of the queue is pulled.
      if (drain.isDraining(ctx)) drain.pumpAfterRecv(ctx);
      return;
    }
    // PUSH.CONTROL_DATA — a live datagram, not queued.
    const parsed = decodeControlData(frame);
    if (parsed) {
      ctx.log.trace(`control_data snr=${parsed.snrDb} rssi=${parsed.rssi} len=${parsed.payloadHex.length / 2}`);
    }
  },
};

// ---- Session-facing functions ------------------------------------------

/** Send raw bytes DIRECT along a known path (CMD_SEND_RAW_DATA). */
export async function sendRawData(ctx: FeatureContext, opts: { pathHex: string; payload: Buffer }): Promise<void> {
  await ctx.request(encodeSendRawData(opts));
}

/** Send a zero-hop control datagram (CMD_SEND_CONTROL_DATA). */
export async function sendControlData(ctx: FeatureContext, payload: Buffer): Promise<void> {
  await ctx.request(encodeSendControlData(payload));
}

/** Broadcast a group-channel datagram (CMD_SEND_CHANNEL_DATA, flood). */
export async function sendChannelData(
  ctx: FeatureContext,
  opts: { channelIdx: number; dataType: number; payload: Buffer },
): Promise<void> {
  await ctx.request(encodeSendChannelData(opts));
}

/** Transmit a fully-formed mesh packet (CMD_SEND_RAW_PACKET). */
export async function sendRawPacket(ctx: FeatureContext, opts: { priority: number; packetHex: string }): Promise<void> {
  await ctx.request(encodeSendRawPacket(opts));
}
