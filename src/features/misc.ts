import { Buffer } from 'node:buffer';
import type { FeatureContext } from '../feature';
import { CMD, RESP } from '../protocol/codes';
import { parsePublicKey } from '../protocol/pubkey';

/**
 * An inclusive frequency range the radio is permitted to repeat on.
 * Values are in **kHz** (e.g. 433000 = 433 MHz, 869495 = 869.495 MHz, 918000 = 918 MHz).
 */
export interface RepeatFreqRange {
  lowerKhz: number;
  upperKhz: number;
}

// CMD_HAS_CONNECTION: [0x1c][pubkey 32B]. Replies RESP_OK (an active connection
// to that node exists) or RESP_ERR (NOT_FOUND).
export function encodeHasConnection(destPublicKeyHex: string): Buffer {
  const pubkey = parsePublicKey(destPublicKeyHex, 'has_connection');
  const out = Buffer.alloc(1 + 32);
  out[0] = CMD.HAS_CONNECTION;
  pubkey.copy(out, 1, 0, 32);
  return out;
}

// CMD_GET_ALLOWED_REPEAT_FREQ: [0x3c]. Replies RESP_ALLOWED_REPEAT_FREQ.
export function encodeGetAllowedRepeatFreq(): Buffer {
  return Buffer.from([CMD.GET_ALLOWED_REPEAT_FREQ]);
}

// RESP_ALLOWED_REPEAT_FREQ: [0x1a] then N×[lower_freq u32 LE][upper_freq u32 LE]
// (firmware: MyMesh.cpp:1967-1975). Trailing partial bytes are ignored.
export function decodeAllowedRepeatFreq(frame: Buffer): RepeatFreqRange[] {
  const out: RepeatFreqRange[] = [];
  for (let i = 1; i + 8 <= frame.length; i += 8) {
    out.push({ lowerKhz: frame.readUInt32LE(i), upperKhz: frame.readUInt32LE(i + 4) });
  }
  return out;
}

/** True when the radio reports an active connection to the given node. */
export async function hasConnection(ctx: FeatureContext, destPublicKeyHex: string): Promise<boolean> {
  try {
    await ctx.request(encodeHasConnection(destPublicKeyHex)); // RESP_OK → connected
    return true;
  } catch {
    return false; // RESP_ERR (NOT_FOUND) → ProtocolError → not connected
  }
}

/** The frequency ranges the radio is allowed to repeat on (region-dependent). */
export async function getAllowedRepeatFreq(ctx: FeatureContext): Promise<RepeatFreqRange[]> {
  const frame = await ctx.request(encodeGetAllowedRepeatFreq(), {
    expect: RESP.ALLOWED_REPEAT_FREQ,
  });
  return decodeAllowedRepeatFreq(frame);
}
