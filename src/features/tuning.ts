import { Buffer } from 'node:buffer';
import type { FeatureContext } from '../feature';
import { CMD, RESP } from '../protocol/codes';

// Radio airtime/backoff tuning (firmware: companion_radio/MyMesh.cpp:1411-1428).
// Both params are floats on the device; the wire carries them as `×1000` u32 LE
// (the firmware multiplies on GET and divides on SET). The firmware constrains
// rxDelayBase to 0..20 and airtimeFactor to 0..9.
export interface TuningParams {
  /** Base of the rx-delay backoff curve. 0 disables the delay. */
  rxDelayBase: number;
  /** Airtime budget multiplier applied to flood forwarding. */
  airtimeFactor: number;
}

// CMD_SET_TUNING_PARAMS: [0x15][rx_delay_base×1000 u32 LE][airtime_factor×1000
// u32 LE] (9B). Replies RESP_OK.
export function encodeSetTuningParams(p: TuningParams): Buffer {
  const out = Buffer.alloc(9);
  out[0] = CMD.SET_TUNING_PARAMS;
  out.writeUInt32LE(Math.round(p.rxDelayBase * 1000) >>> 0, 1);
  out.writeUInt32LE(Math.round(p.airtimeFactor * 1000) >>> 0, 5);
  return out;
}

// CMD_GET_TUNING_PARAMS: [0x2b]. Replies RESP_TUNING_PARAMS.
export function encodeGetTuningParams(): Buffer {
  return Buffer.from([CMD.GET_TUNING_PARAMS]);
}

// RESP_TUNING_PARAMS: [0x17][rx×1000 u32 LE][airtime×1000 u32 LE] (9B).
export function decodeTuningParams(frame: Buffer): TuningParams | null {
  if (frame.length < 9) return null;
  return {
    rxDelayBase: frame.readUInt32LE(1) / 1000,
    airtimeFactor: frame.readUInt32LE(5) / 1000,
  };
}

export async function getTuningParams(ctx: FeatureContext): Promise<TuningParams> {
  const frame = await ctx.request(encodeGetTuningParams(), { expect: RESP.TUNING_PARAMS });
  const parsed = decodeTuningParams(frame);
  if (!parsed) throw new Error('malformed RESP_TUNING_PARAMS frame');
  return parsed;
}

export async function setTuningParams(ctx: FeatureContext, p: TuningParams): Promise<void> {
  // RESP_OK on success; ctx.request rejects with ProtocolError on RESP_ERR.
  await ctx.request(encodeSetTuningParams(p));
}
