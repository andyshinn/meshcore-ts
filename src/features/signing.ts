import { Buffer } from 'node:buffer';
import { CMD, RESP } from '../protocol/codes';
import type { FeatureContext } from './feature';

// Message signing (firmware: companion_radio/MyMesh.cpp:1712-1743). The device
// signs arbitrary bytes with its ed25519 identity via a three-step state
// machine — the accumulation buffer lives on the *device*, so this module just
// sequences the steps; there is no client-side state and no registry Feature:
//
//   CMD_SIGN_START  → RESP_SIGN_START (max signable length; allocates the buffer)
//   CMD_SIGN_DATA × → RESP_OK         (append a chunk; repeated until exhausted)
//   CMD_SIGN_FINISH → RESP_SIGNATURE  (64-byte signature; frees the buffer)

// The firmware's command/reply buffer is MAX_FRAME_SIZE=176 (with ~4 bytes of
// transport framing overhead). Keep each CMD_SIGN_DATA frame comfortably under
// that: [0x22] + up to SIGN_CHUNK_SIZE data bytes.
const SIGN_CHUNK_SIZE = 128;
const SIGN_DATA_MAX_CHUNK = 171; // 176 frame − 4 transport − 1 opcode

// ---- Encoders ----------------------------------------------------------

// CMD_SIGN_START: [0x21]. Replies RESP_SIGN_START.
export function encodeSignStart(): Buffer {
  return Buffer.from([CMD.SIGN_START]);
}

// CMD_SIGN_DATA: [0x22][chunk]. The firmware requires at least one data byte
// (its handler is guarded by `len > 1`) and reads into a MAX_FRAME_SIZE buffer.
export function encodeSignData(chunk: Buffer): Buffer {
  if (chunk.length < 1) throw new Error('sign data chunk must not be empty');
  if (chunk.length > SIGN_DATA_MAX_CHUNK) {
    throw new Error(`sign data chunk is ${chunk.length}B, exceeds the ${SIGN_DATA_MAX_CHUNK}B frame limit`);
  }
  return Buffer.concat([Buffer.from([CMD.SIGN_DATA]), chunk]);
}

// CMD_SIGN_FINISH: [0x23]. Replies RESP_SIGNATURE.
export function encodeSignFinish(): Buffer {
  return Buffer.from([CMD.SIGN_FINISH]);
}

// ---- Decoders ----------------------------------------------------------

/** The max signable length advertised by the device. */
export interface SignStart {
  maxLen: number;
}

// RESP_SIGN_START: [0x13][reserved u8][max_len u32 LE] (6B).
export function decodeSignStart(frame: Buffer): SignStart | null {
  if (frame.length < 6) return null;
  return { maxLen: frame.readUInt32LE(2) };
}

// RESP_SIGNATURE: [0x14][64B signature]. Returns the lowercase hex, or null
// when the frame is short.
export function decodeSignature(frame: Buffer): string | null {
  if (frame.length < 1 + 64) return null;
  return frame.subarray(1, 65).toString('hex');
}

// ---- Session-facing function -------------------------------------------

/** Sign `data` with the device's identity. Drives CMD_SIGN_START →
 *  CMD_SIGN_DATA× → CMD_SIGN_FINISH and returns the 64-byte signature (hex).
 *  Rejects if `data` exceeds the device's advertised max length, or with a
 *  ProtocolError if any step is rejected (e.g. RESP_ERR BAD_STATE). */
export async function signData(ctx: FeatureContext, data: Buffer): Promise<string> {
  const startFrame = await ctx.request(encodeSignStart(), { expect: RESP.SIGN_START });
  const start = decodeSignStart(startFrame);
  if (!start) throw new Error('malformed RESP_SIGN_START frame');
  if (data.length > start.maxLen) {
    throw new Error(`data is ${data.length}B, exceeds the device max of ${start.maxLen}B`);
  }
  // Append in frame-sized chunks; each ack gates the next write (no need for a
  // write-gap since ctx.request awaits RESP_OK before returning). Empty `data`
  // sends no chunks and signs the empty message — a valid ed25519 operation.
  for (let offset = 0; offset < data.length; offset += SIGN_CHUNK_SIZE) {
    const chunk = data.subarray(offset, offset + SIGN_CHUNK_SIZE);
    await ctx.request(encodeSignData(chunk)); // RESP_OK; ProtocolError on RESP_ERR
  }
  const sigFrame = await ctx.request(encodeSignFinish(), { expect: RESP.SIGNATURE });
  const signature = decodeSignature(sigFrame);
  if (!signature) throw new Error('malformed RESP_SIGNATURE frame');
  return signature;
}
