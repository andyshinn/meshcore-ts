import type { Buffer } from 'node:buffer';
import { BufferReader, BufferWriter } from '../buffer';
import { CMD, RESP } from '../codes';
import type { Feature, FeatureContext } from '../feature';

export interface AutoAddFlagsInput {
  chat: boolean;
  repeater: boolean;
  room: boolean;
  sensor: boolean;
  overwriteOldest: boolean;
  /** Radio-side autoadd_max_hops byte. When provided, a 3-byte SET payload is
   *  emitted so the radio updates its stored value; when omitted the 2-byte
   *  payload is used and the radio preserves its stored value. */
  radioMaxHops?: number;
}

// Auto-add flag bits (firmware companion_radio): overwriteOldest | chat | repeater | room | sensor.
export function autoAddFlagsToByte(flags: AutoAddFlagsInput): number {
  return (
    (flags.overwriteOldest ? 0x01 : 0) |
    (flags.chat ? 0x02 : 0) |
    (flags.repeater ? 0x04 : 0) |
    (flags.room ? 0x08 : 0) |
    (flags.sensor ? 0x10 : 0)
  );
}

export function autoAddByteToFlags(byte: number): AutoAddFlagsInput {
  return {
    overwriteOldest: (byte & 0x01) !== 0,
    chat: (byte & 0x02) !== 0,
    repeater: (byte & 0x04) !== 0,
    room: (byte & 0x08) !== 0,
    sensor: (byte & 0x10) !== 0,
  };
}

// CMD_GET_AUTO_ADD_CONFIG: [0x3b]. Replies RESP_AUTOADD_CONFIG.
export function encodeGetAutoAddConfig(): Buffer {
  return new BufferWriter().writeByte(CMD.GET_AUTO_ADD_CONFIG).toBuffer();
}

// CMD_SET_AUTO_ADD_CONFIG: [0x3a][flags u8] or [0x3a][flags u8][radioMaxHops u8].
// Emit 3 bytes when radioMaxHops is provided so the radio updates its stored
// value; emit 2 bytes when omitted so the radio preserves its stored value
// (matches firmware "reads byte 2 only if len ≥ 3" semantics).
export function encodeSetAutoAddConfig(flags: AutoAddFlagsInput): Buffer {
  const w = new BufferWriter().writeByte(CMD.SET_AUTO_ADD_CONFIG).writeByte(autoAddFlagsToByte(flags));
  if (flags.radioMaxHops !== undefined) {
    w.writeByte(flags.radioMaxHops);
  }
  return w.toBuffer();
}

// RESP_AUTOADD_CONFIG: [0x19][flags u8][autoadd_max_hops u8 — optional].
// Returns { flagsByte, radioMaxHops } or null when the frame is too short.
export function decodeAutoAddConfig(frame: Buffer): { flagsByte: number; radioMaxHops: number } | null {
  const r = new BufferReader(frame);
  r.readByte(); // code
  if (r.remaining < 1) return null;
  const flagsByte = r.readByte();
  const radioMaxHops = r.remaining >= 1 ? r.readByte() : 0;
  return { flagsByte, radioMaxHops };
}

// Handler: merge the radio's reported flags into the app's auto-add config.
export const autoAddFeature: Feature = {
  handles: [RESP.AUTOADD_CONFIG],
  handle: (_code, frame, ctx) => {
    const decoded = decodeAutoAddConfig(frame);
    if (decoded === null) return;
    const flags = autoAddByteToFlags(decoded.flagsByte);
    const current = ctx.state.getAutoAddConfig();
    const next = {
      ...current,
      chat: flags.chat,
      repeater: flags.repeater,
      room: flags.room,
      sensor: flags.sensor,
      overwriteOldest: flags.overwriteOldest,
      radioMaxHops: decoded.radioMaxHops,
    };
    ctx.state.setAutoAddConfig(next);
    ctx.events.emit('autoAddConfig', next);
  },
};

/** Ask the radio for its current auto-add flags (RESP_AUTOADD_CONFIG lands via the handler). */
export async function requestAutoAddConfig(ctx: FeatureContext): Promise<void> {
  await ctx.writeFrame(encodeGetAutoAddConfig());
}

/** Push auto-add flags to the radio. Resolves true on RESP_OK, false on RESP_ERR/timeout. */
export async function setAutoAddConfig(ctx: FeatureContext, flags: AutoAddFlagsInput): Promise<boolean> {
  try {
    await ctx.request(encodeSetAutoAddConfig(flags));
    return true;
  } catch {
    return false;
  }
}
