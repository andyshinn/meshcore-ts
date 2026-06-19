import { Buffer } from 'node:buffer';
import type { FeatureContext } from '../feature';
import { CMD, RESP } from '../protocol/codes';
import { parsePublicKey } from '../protocol/pubkey';

// Contact interop (firmware: companion_radio/MyMesh.cpp:1298-1353). Share, export
// and import contacts as serialized advert blobs. The blob is opaque here — the
// firmware produces and consumes it; parsing/rendering an advert is Phase 4
// (the borrowed Advert parser). getContactByKey lives in contacts.ts because its
// RESP_CONTACT reply shares the bulk-sync opcode and must correlate there.

// Minimum import blob: firmware requires the frame length > 2 + 32 + 64, i.e.
// the advert blob (pubkey + signature + timestamp + appdata) is ≥98 bytes.
const MIN_IMPORT_BLOB = 98;

// ---- Encoders ----------------------------------------------------------

// CMD_SHARE_CONTACT: [0x10][32B pubkey].
export function encodeShareContact(destPublicKeyHex: string): Buffer {
  const pubkey = parsePublicKey(destPublicKeyHex, 'share contact');
  return Buffer.concat([Buffer.from([CMD.SHARE_CONTACT]), pubkey]);
}

// CMD_EXPORT_CONTACT: [0x11] exports the device's own identity; [0x11][32B pubkey]
// exports a known contact. Replies RESP_EXPORT_CONTACT.
export function encodeExportContact(destPublicKeyHex?: string): Buffer {
  if (destPublicKeyHex === undefined) return Buffer.from([CMD.EXPORT_CONTACT]);
  const pubkey = parsePublicKey(destPublicKeyHex, 'export contact');
  return Buffer.concat([Buffer.from([CMD.EXPORT_CONTACT]), pubkey]);
}

// CMD_IMPORT_CONTACT: [0x12][serialized advert blob].
export function encodeImportContact(blobHex: string): Buffer {
  const blob = Buffer.from(blobHex, 'hex');
  if (blob.length < MIN_IMPORT_BLOB) {
    throw new Error(`import contact blob is ${blob.length}B, need ≥${MIN_IMPORT_BLOB}`);
  }
  return Buffer.concat([Buffer.from([CMD.IMPORT_CONTACT]), blob]);
}

// ---- Decoder -----------------------------------------------------------

// RESP_EXPORT_CONTACT: [0x0b][serialized advert blob]. Returns the blob hex, or
// null when no blob follows the code.
export function decodeExportedContact(frame: Buffer): string | null {
  if (frame.length < 2) return null;
  return frame.subarray(1).toString('hex');
}

// ---- Session-facing functions ------------------------------------------

/** Re-broadcast a known contact's advert zero-hop (CMD_SHARE_CONTACT). */
export async function shareContact(ctx: FeatureContext, destPublicKeyHex: string): Promise<void> {
  await ctx.request(encodeShareContact(destPublicKeyHex));
}

/** Export an advert blob for the device itself (no arg) or a known contact.
 *  Returns the blob hex, or null when the contact isn't found (RESP_ERR). */
export async function exportContact(ctx: FeatureContext, destPublicKeyHex?: string): Promise<string | null> {
  // RESP_EXPORT_CONTACT (0x0b) is unshared, so requestOrNull is safe: it resolves
  // the blob frame, or null on RESP_ERR (consumed via the ack FIFO).
  const frame = await ctx.requestOrNull(encodeExportContact(destPublicKeyHex), RESP.EXPORT_CONTACT);
  return frame ? decodeExportedContact(frame) : null;
}

/** Import a contact from a serialized advert blob (CMD_IMPORT_CONTACT). Rejects
 *  ProtocolError (ILLEGAL_ARG) on a malformed blob. */
export async function importContact(ctx: FeatureContext, blobHex: string): Promise<void> {
  await ctx.request(encodeImportContact(blobHex));
}
