import type { Buffer } from 'node:buffer';
import { BufferReader, BufferWriter } from '../buffer';
import { CMD, RESP } from '../codes';
import type { FeatureContext } from '../feature';

// CMD_GET_DEVICE_TIME: [0x05]. Replies RESP_CURR_TIME.
export function encodeGetDeviceTime(): Buffer {
  return new BufferWriter().writeByte(CMD.GET_DEVICE_TIME).toBuffer();
}

// CMD_SET_DEVICE_TIME: [0x06][epoch u32 LE]. Firmware rejects with
// ERR_CODE_ILLEGAL_ARG when epoch < its current clock. Replies RESP_OK/ERR.
export function encodeSetDeviceTime(epochSecs: number): Buffer {
  return new BufferWriter().writeByte(CMD.SET_DEVICE_TIME).writeUInt32LE(epochSecs).toBuffer();
}

// RESP_CURR_TIME: [0x09][epoch u32 LE].
export function decodeCurrTime(frame: Buffer): number | null {
  const r = new BufferReader(frame);
  r.readByte(); // code
  if (r.remaining < 4) return null;
  return r.readUInt32LE();
}

/** Read the radio's RTC clock (unix seconds). */
export async function getDeviceTime(ctx: FeatureContext): Promise<number> {
  const frame = await ctx.request(encodeGetDeviceTime(), { expect: RESP.CURR_TIME });
  const t = decodeCurrTime(frame);
  if (t === null) throw new Error('malformed RESP_CURR_TIME');
  return t;
}

/** Set the radio's RTC clock (unix seconds). Throws ProtocolError on rejection. */
export async function setDeviceTime(ctx: FeatureContext, epochSecs: number): Promise<void> {
  await ctx.request(encodeSetDeviceTime(epochSecs));
}

/** Push the host's current time to the radio. */
export async function syncDeviceTime(ctx: FeatureContext): Promise<void> {
  await setDeviceTime(ctx, Math.floor(Date.now() / 1000));
}
