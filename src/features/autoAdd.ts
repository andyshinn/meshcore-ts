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

// CMD_SET_AUTO_ADD_CONFIG: [0x3a][flags u8]. Replies RESP_OK/ERR.
export function encodeSetAutoAddConfig(flags: AutoAddFlagsInput): Buffer {
  return new BufferWriter().writeByte(CMD.SET_AUTO_ADD_CONFIG).writeByte(autoAddFlagsToByte(flags)).toBuffer();
}

// RESP_AUTOADD_CONFIG: [0x19][flags u8].
export function decodeAutoAddConfig(frame: Buffer): number | null {
  const r = new BufferReader(frame);
  r.readByte(); // code
  if (r.remaining < 1) return null;
  return r.readByte();
}

// Handler: merge the radio's reported flags into the app's auto-add config.
export const autoAddFeature: Feature = {
  handles: [RESP.AUTOADD_CONFIG],
  handle: (_code, frame, ctx) => {
    const byte = decodeAutoAddConfig(frame);
    if (byte === null) return;
    const flags = autoAddByteToFlags(byte);
    const current = ctx.state.getAutoAddConfig();
    const next = {
      ...current,
      chat: flags.chat,
      repeater: flags.repeater,
      room: flags.room,
      sensor: flags.sensor,
      overwriteOldest: flags.overwriteOldest,
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
