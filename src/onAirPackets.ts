import { Buffer } from 'node:buffer';
import { type Advert, parseAdvert } from './advert';
import { type MeshPacketHeader, PAYLOAD_TYPE, parseMeshPacket } from './meshPacket';

/** A structurally-decoded MeshCore on-air packet. `header` is null when the
 *  input bytes do not parse as a mesh packet (e.g. a 0x84 sentinel frame or a
 *  truncated buffer); in that case `payload` is the `raw` fallback variant. */
export interface OnAirPacket {
  header: MeshPacketHeader | null;
  /** Enum key for `header.payloadType` (e.g. 'GRP_TXT'); 'UNKNOWN' if absent. */
  payloadTypeName: string;
  payload: OnAirPayload;
}

/** Structural (never decrypted) view of an on-air payload, discriminated on
 *  `kind`. Cipher bodies are reported only as a length (`cipherLen`). */
export type OnAirPayload =
  | { kind: 'advert'; advert: Advert }
  | { kind: 'txtMsg'; destHash: string; srcHash: string; macHex: string; cipherLen: number }
  | { kind: 'grpTxt'; channelHash: string; macHex: string; cipherLen: number }
  | { kind: 'req'; destHash: string; srcHash: string; macHex: string; cipherLen: number }
  | { kind: 'response'; destHash: string; srcHash: string; macHex: string; cipherLen: number }
  | { kind: 'anonReq'; destHash: string; senderPubKeyHex: string; macHex: string; cipherLen: number }
  | { kind: 'ack'; checksumHex: string }
  | { kind: 'path'; pathLen: number; hashSize: number; pathHashesHex: string; extraType: number; extraHex: string }
  | { kind: 'trace'; tag: number; authCode: number; flags: number; hopCount: number; pathHashesHex: string; snr: number[] }
  | { kind: 'controlDiscoverReq'; prefixOnly: boolean; typeFilter: number; tag: number; since: number }
  | { kind: 'controlDiscoverResp'; nodeType: number; snr: number; tag: number; publicKeyHex: string }
  | { kind: 'controlOther'; rawFlags: number; payloadHex: string }
  | { kind: 'raw'; payloadType: number | null; payloadHex: string };

// Reverse lookup: payloadType number → enum key name, for display.
const PAYLOAD_TYPE_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(PAYLOAD_TYPE).map(([name, value]) => [value, name]),
);

/** Decode a full on-air mesh packet (header + path + payload) into a tagged
 *  union. Total — never throws; unparseable or unsupported input yields the
 *  `raw` fallback variant. Accepts a hex string or raw bytes. */
export function decodeOnAirPacket(input: string | Uint8Array): OnAirPacket {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'hex') : Buffer.from(input);
  const header = parseMeshPacket(bytes);
  if (!header) {
    return {
      header: null,
      payloadTypeName: 'UNKNOWN',
      payload: { kind: 'raw', payloadType: null, payloadHex: bytes.toString('hex') },
    };
  }
  return {
    header,
    payloadTypeName: PAYLOAD_TYPE_NAMES[header.payloadType] ?? 'UNKNOWN',
    payload: decodePayload(header),
  };
}

function decodePayload(header: MeshPacketHeader): OnAirPayload {
  const payload = header.payload;
  switch (header.payloadType) {
    case PAYLOAD_TYPE.ADVERT: {
      const advert = parseAdvert(payload);
      if (advert) return { kind: 'advert', advert };
      break;
    }
    case PAYLOAD_TYPE.TXT_MSG: {
      if (payload.length < 4) break;
      return {
        kind: 'txtMsg',
        destHash: payload.subarray(0, 1).toString('hex'),
        srcHash: payload.subarray(1, 2).toString('hex'),
        macHex: payload.subarray(2, 4).toString('hex'),
        cipherLen: payload.length - 4,
      };
    }
    case PAYLOAD_TYPE.GRP_TXT: {
      if (payload.length < 3) break;
      return {
        kind: 'grpTxt',
        channelHash: payload.subarray(0, 1).toString('hex'),
        macHex: payload.subarray(1, 3).toString('hex'),
        cipherLen: payload.length - 3,
      };
    }
    case PAYLOAD_TYPE.REQ:
    case PAYLOAD_TYPE.RESPONSE: {
      if (payload.length < 4) break;
      const fields = {
        destHash: payload.subarray(0, 1).toString('hex'),
        srcHash: payload.subarray(1, 2).toString('hex'),
        macHex: payload.subarray(2, 4).toString('hex'),
        cipherLen: payload.length - 4,
      };
      return header.payloadType === PAYLOAD_TYPE.REQ ? { kind: 'req', ...fields } : { kind: 'response', ...fields };
    }
    case PAYLOAD_TYPE.ANON_REQ: {
      if (payload.length < 35) break;
      return {
        kind: 'anonReq',
        destHash: payload.subarray(0, 1).toString('hex'),
        senderPubKeyHex: payload.subarray(1, 33).toString('hex'),
        macHex: payload.subarray(33, 35).toString('hex'),
        cipherLen: payload.length - 35,
      };
    }
    case PAYLOAD_TYPE.ACK: {
      if (payload.length < 4) break;
      return { kind: 'ack', checksumHex: payload.subarray(0, 4).toString('hex') };
    }
    case PAYLOAD_TYPE.PATH: {
      if (payload.length < 2) break;
      const pathLenByte = payload[0];
      const pathLen = pathLenByte & 0x3f;
      const hashSize = (pathLenByte >> 6) + 1;
      const pathByteLen = pathLen * hashSize;
      // Need the path hashes plus the 1-byte extraType that follows them.
      if (payload.length < 1 + pathByteLen + 1) break;
      return {
        kind: 'path',
        pathLen,
        hashSize,
        pathHashesHex: payload.subarray(1, 1 + pathByteLen).toString('hex'),
        extraType: payload[1 + pathByteLen],
        extraHex: payload.subarray(1 + pathByteLen + 1).toString('hex'),
      };
    }
    case PAYLOAD_TYPE.TRACE: {
      if (payload.length < 9) break;
      const flags = payload[8];
      const hashSize = 1 << (flags & 0x03);
      const hashes = payload.subarray(9);
      return {
        kind: 'trace',
        tag: payload.readUInt32LE(0),
        authCode: payload.readUInt32LE(4),
        flags,
        hopCount: Math.floor(hashes.length / hashSize),
        pathHashesHex: hashes.toString('hex'),
        snr: snrFromPathHex(header.pathHex),
      };
    }
    // Payload-type cases are inserted above this line by later tasks.
    default:
      break;
  }
  return { kind: 'raw', payloadType: header.payloadType, payloadHex: payload.toString('hex') };
}

/** Each on-air path byte in a TRACE packet is a per-hop SNR sample: a signed
 *  int8 scaled by 1/4 (dB). Returns one value per byte of `pathHex`. */
function snrFromPathHex(pathHex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < pathHex.length; i += 2) {
    const byte = Number.parseInt(pathHex.slice(i, i + 2), 16);
    out.push((byte > 127 ? byte - 256 : byte) / 4);
  }
  return out;
}
