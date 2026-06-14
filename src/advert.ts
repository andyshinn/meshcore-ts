import { Buffer } from 'node:buffer';
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

// Advert parsing + ed25519 signature verification (firmware: Mesh.cpp:241-279,
// 389-423; AdvertDataHelpers.h/.cpp; Packet.h). An advert payload is:
//   [pub_key 32][timestamp u32 LE][signature 64][app_data]
// and the signature covers `pub_key || timestamp || app_data`. The export/import
// blob (RESP_EXPORT_CONTACT / CMD_IMPORT_CONTACT) is this advert wrapped in a
// serialized mesh Packet frame ([header][transport_codes?][path_len][path][payload]).
//
// This is a standalone parsing primitive — no registry feature, no session
// wiring — used to decode and authenticate contact blobs (a Phase 5 / UI concern).

// app_data flag masks (AdvertDataHelpers.h).
const ADV_LATLON_MASK = 0x10;
const ADV_FEAT1_MASK = 0x20;
const ADV_FEAT2_MASK = 0x40;
const ADV_NAME_MASK = 0x80;

// Packet header bit layout (Packet.h): bits 0-1 route type, bits 2-5 payload type.
const PH_ROUTE_MASK = 0x03;
const PH_TYPE_SHIFT = 2;
const PH_TYPE_MASK = 0x0f;
const PAYLOAD_TYPE_ADVERT = 0x04;
// Route types that carry a 4-byte transport-codes block after the header.
const ROUTE_TYPE_TRANSPORT_FLOOD = 0x00;
const ROUTE_TYPE_TRANSPORT_DIRECT = 0x03;

const PUB_KEY_SIZE = 32;
const SIGNATURE_SIZE = 64;
const ADVERT_HEADER_LEN = PUB_KEY_SIZE + 4 + SIGNATURE_SIZE; // pubkey + timestamp + signature = 100
const MAX_ADVERT_DATA_SIZE = 32; // firmware caps app_data (incl. for verification)

// The fixed 12-byte SPKI DER prefix that precedes a raw ed25519 public key.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface AdvertAppData {
  /** ADV_TYPE_* (1=chat, 2=repeater, 3=room, 4=sensor). */
  type: number;
  latlon?: { lat: number; lon: number };
  feat1?: number;
  feat2?: number;
  name?: string;
}

export interface Advert {
  publicKeyHex: string;
  timestampUnix: number;
  signatureHex: string;
  appData: AdvertAppData;
  appDataHex: string;
  /** The exact bytes the signature covers: pub_key || timestamp || app_data. */
  signedMessage: Buffer;
}

// ---- app_data parser ---------------------------------------------------

// [flags u8][lat i32 LE ×1e6][lon i32 LE ×1e6]?[feat1 u16]?[feat2 u16]?[name UTF-8]?
export function parseAdvertAppData(appData: Buffer): AdvertAppData | null {
  if (appData.length < 1) return null;
  const flags = appData[0];
  const out: AdvertAppData = { type: flags & 0x0f };
  let i = 1;
  if (flags & ADV_LATLON_MASK) {
    if (i + 8 > appData.length) return null;
    out.latlon = {
      lat: appData.readInt32LE(i) / 1_000_000,
      lon: appData.readInt32LE(i + 4) / 1_000_000,
    };
    i += 8;
  }
  if (flags & ADV_FEAT1_MASK) {
    if (i + 2 > appData.length) return null;
    out.feat1 = appData.readUInt16LE(i);
    i += 2;
  }
  if (flags & ADV_FEAT2_MASK) {
    if (i + 2 > appData.length) return null;
    out.feat2 = appData.readUInt16LE(i);
    i += 2;
  }
  if (flags & ADV_NAME_MASK) {
    const rest = appData.subarray(i);
    const nul = rest.indexOf(0); // name may be null-terminated or run to the end
    out.name = (nul === -1 ? rest : rest.subarray(0, nul)).toString('utf8');
  }
  return out;
}

// ---- advert payload parser ---------------------------------------------

/** Parse a raw advert payload ([pubkey][timestamp][signature][app_data]). */
export function parseAdvert(payload: Buffer): Advert | null {
  if (payload.length < ADVERT_HEADER_LEN + 1) return null; // need ≥1 app_data byte (flags)
  let appDataBytes = payload.subarray(ADVERT_HEADER_LEN);
  if (appDataBytes.length > MAX_ADVERT_DATA_SIZE) {
    appDataBytes = appDataBytes.subarray(0, MAX_ADVERT_DATA_SIZE);
  }
  const appData = parseAdvertAppData(appDataBytes);
  if (!appData) return null;
  return {
    publicKeyHex: payload.subarray(0, PUB_KEY_SIZE).toString('hex'),
    timestampUnix: payload.readUInt32LE(PUB_KEY_SIZE),
    signatureHex: payload.subarray(PUB_KEY_SIZE + 4, ADVERT_HEADER_LEN).toString('hex'),
    appData,
    appDataHex: appDataBytes.toString('hex'),
    // pub_key(32) || timestamp(4) sit at the front of the payload already.
    signedMessage: Buffer.concat([payload.subarray(0, PUB_KEY_SIZE + 4), appDataBytes]),
  };
}

// ---- export-blob (framed Packet) parser --------------------------------

// path_len is the compound mesh byte (low 6 bits = hops, top 2 bits + 1 = bytes-per-hop).
function pathByteLen(pathLenByte: number): number {
  return (pathLenByte & 0x3f) * ((pathLenByte >> 6) + 1);
}

/** Parse an export/import contact blob — a mesh Packet wrapping an advert —
 *  returning the advert, or null when it isn't a well-formed advert packet. */
export function parseContactBlob(blob: Buffer): Advert | null {
  if (blob.length < 1) return null;
  const header = blob[0];
  if (((header >> PH_TYPE_SHIFT) & PH_TYPE_MASK) !== PAYLOAD_TYPE_ADVERT) return null;
  const routeType = header & PH_ROUTE_MASK;
  let i = 1;
  if (routeType === ROUTE_TYPE_TRANSPORT_FLOOD || routeType === ROUTE_TYPE_TRANSPORT_DIRECT) {
    i += 4; // transport codes
  }
  if (i >= blob.length) return null;
  const pathLen = blob[i];
  i += 1 + pathByteLen(pathLen);
  if (i > blob.length) return null;
  return parseAdvert(blob.subarray(i));
}

// ---- ed25519 verification ----------------------------------------------

/** Verify an advert's ed25519 signature against its own public key. Returns
 *  false (never throws) on a malformed key/signature. */
export function verifyAdvert(advert: Advert): boolean {
  try {
    const rawPub = Buffer.from(advert.publicKeyHex, 'hex');
    const signature = Buffer.from(advert.signatureHex, 'hex');
    if (rawPub.length !== PUB_KEY_SIZE || signature.length !== SIGNATURE_SIZE) return false;
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, rawPub]),
      format: 'der',
      type: 'spki',
    });
    return cryptoVerify(null, advert.signedMessage, key, signature);
  } catch {
    return false;
  }
}
