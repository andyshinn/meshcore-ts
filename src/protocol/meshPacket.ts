import type { Buffer } from 'node:buffer';

// Decodes the MeshCore on-air mesh packet (firmware src/Packet.cpp `readFrom`).
// We see these bytes inside PUSH_CODE_LOG_RX_DATA (0x88) frames — the firmware
// copies them verbatim from the LoRa receive path before any decryption, so
// they include the per-hop path bytes our UI needs.
//
// Wire format (Packet::writeTo):
//   [header u8]
//   [transport_codes 4B]      ← only when routeType has transport codes
//   [path_len u8]             ← bits 0..5 = hash count, bits 6..7 = hashSize-1
//   [path bytes: hashCount × hashSize]
//   [payload …]
//
// Header byte (Packet.h PH_*):
//   bits 0..1 → routeType (PH_ROUTE_MASK 0x03)
//   bits 2..5 → payloadType (mask 0x0F << 2)
//   bits 6..7 → payloadVer

export const ROUTE_TYPE = {
  TRANSPORT_FLOOD: 0x00,
  FLOOD: 0x01,
  DIRECT: 0x02,
  TRANSPORT_DIRECT: 0x03,
} as const;

export const PAYLOAD_TYPE = {
  REQ: 0x00,
  RESPONSE: 0x01,
  TXT_MSG: 0x02,
  ACK: 0x03,
  ADVERT: 0x04,
  GRP_TXT: 0x05,
  GRP_DATA: 0x06,
  ANON_REQ: 0x07,
  PATH: 0x08,
  TRACE: 0x09,
  MULTIPART: 0x0a,
  CONTROL: 0x0b,
  RAW_CUSTOM: 0x0f,
} as const;

export interface MeshPacketHeader {
  routeType: number;
  payloadType: number;
  payloadVer: number;
  /** Bytes per hop in the path (1, 2, or 3). 4 is reserved by firmware. */
  hashSize: number;
  /** Number of hops in the path. May be 0 (originator emitted with empty path). */
  hashCount: number;
  /** Hex path bytes (hashCount × hashSize). Empty string when hashCount=0. */
  pathHex: string;
  transportCodesHex?: string;
  /** Decrypted-or-not body. For GRP_TXT, format is:
   *    [channel_hash 1B][MAC 2B][encrypted: ts u32 LE + "name: text"] */
  payload: Buffer;
}

function hasTransportCodes(routeType: number): boolean {
  return routeType === ROUTE_TYPE.TRANSPORT_FLOOD || routeType === ROUTE_TYPE.TRANSPORT_DIRECT;
}

export function parseMeshPacket(bytes: Buffer): MeshPacketHeader | null {
  if (bytes.length < 2) return null;
  const header = bytes[0];

  // 0xFF marks a "do not retransmit" or, in PUSH_CODE_RAW_DATA, the reserved
  // path_len placeholder. Either way, not something we decode here.
  if (header === 0xff) return null;

  const routeType = header & 0x03;
  const payloadType = (header >> 2) & 0x0f;
  const payloadVer = (header >> 6) & 0x03;

  let i = 1;
  let transportCodesHex: string | undefined;
  if (hasTransportCodes(routeType)) {
    if (bytes.length < i + 4) return null;
    transportCodesHex = bytes.subarray(i, i + 4).toString('hex');
    i += 4;
  }

  if (bytes.length < i + 1) return null;
  const pathLenByte = bytes[i++];
  const hashCount = pathLenByte & 0x3f;
  const hashSize = ((pathLenByte >> 6) & 0x03) + 1;
  // Firmware reserves hashSize == 4 (encoded as 0x03 in the top bits).
  if (hashSize === 4) return null;
  const pathByteLen = hashCount * hashSize;
  if (bytes.length < i + pathByteLen) return null;
  const pathHex = bytes.subarray(i, i + pathByteLen).toString('hex');
  i += pathByteLen;

  return {
    routeType,
    payloadType,
    payloadVer,
    hashSize,
    hashCount,
    pathHex,
    transportCodesHex,
    payload: bytes.subarray(i),
  };
}
