import { Buffer } from 'node:buffer';
import { CMD, type STATS_TYPE } from './codes';

// PUSH_LOGIN_SUCCESS (firmware: companion_radio/MyMesh.cpp:669-685). Two
// shapes exist on the wire:
//   - Legacy: [0x85][0 is_admin][6B pubkey prefix]                       (8B)
//   - v6+:    [0x85][perms u8][6B prefix][tag u32 LE][acl_perms u8][fw_ver u8] (15B)
// The longer form is the one current firmware sends; we tolerate the short
// form so older repeaters still parse.
export interface LoginSuccess {
  permissions: number;
  pubKeyPrefixHex: string;
  serverTagHex: string | null;
  aclPermissions: number | null;
  firmwareVerLevel: number | null;
  isAdmin: boolean;
}

export function parseLoginSuccess(frame: Buffer): LoginSuccess | null {
  if (frame.length < 8) return null;
  const permissions = frame[1];
  const pubKeyPrefixHex = frame.subarray(2, 8).toString('hex');
  if (frame.length >= 15) {
    return {
      permissions,
      pubKeyPrefixHex,
      serverTagHex: frame.subarray(8, 12).toString('hex'),
      aclPermissions: frame[12],
      firmwareVerLevel: frame[13],
      // Firmware sets permissions == data[6] from the remote response; the
      // ACL_ADMIN bit lives in aclPermissions (data[7]). Treat either being
      // set as admin so legacy + new shapes both work.
      isAdmin: (permissions & 0x01) !== 0 || (frame[12] & 0x01) !== 0,
    };
  }
  return {
    permissions,
    pubKeyPrefixHex,
    serverTagHex: null,
    aclPermissions: null,
    firmwareVerLevel: null,
    isAdmin: permissions !== 0,
  };
}

// PUSH_LOGIN_FAIL: [0x86][0 reserved][6B pubkey prefix].
export interface LoginFail {
  pubKeyPrefixHex: string;
}

export function parseLoginFail(frame: Buffer): LoginFail | null {
  if (frame.length < 8) return null;
  return { pubKeyPrefixHex: frame.subarray(2, 8).toString('hex') };
}

// PUSH_RAW_DATA: [0x84][snr*4 i8][rssi i8][0xff reserved][raw bytes].
export interface RawData {
  snrDb: number;
  rssi: number;
  payloadHex: string;
}

export function parseRawData(frame: Buffer): RawData | null {
  if (frame.length < 4) return null;
  return {
    snrDb: frame.readInt8(1) / 4,
    rssi: frame.readInt8(2),
    payloadHex: frame.subarray(4).toString('hex'),
  };
}

// PUSH_BINARY_RESPONSE: [0x8c][0 reserved][tag u32 LE][response bytes...].
// The `tag` matches the u32 the firmware echoed in RESP_SENT for the
// originating CMD_SEND_ANON_REQ / CMD_SEND_BINARY_REQ — use it to route the
// response back to the awaiter.
export interface BinaryResponse {
  tagHex: string;
  payloadHex: string;
  payload: Buffer;
}

export function parseBinaryResponse(frame: Buffer): BinaryResponse | null {
  if (frame.length < 6) return null;
  const payload = frame.subarray(6);
  return {
    tagHex: frame.subarray(2, 6).toString('hex'),
    payloadHex: payload.toString('hex'),
    payload,
  };
}

// PUSH_TRACE_DATA frame layout, firmware MyMesh.cpp:812-825. The path-hash
// size is encoded in flags bits 0..1; per-hop SNR bytes follow the hashes,
// then a trailing "final SNR" byte for the last leg.
export interface TraceData {
  pubKeyPrefixHex: string;
  tagHex: string;
  authHex: string;
  flags: number;
  pathHashSize: number;
  hops: Array<{ hashHex: string; snrDb: number }>;
  finalSnrDb: number;
}

export function parseTraceData(frame: Buffer): TraceData | null {
  if (frame.length < 12) return null;
  const pubKeyPrefixHex = frame.subarray(2, 8).toString('hex');
  const pathLen = frame[8];
  const flags = frame[9];
  const pathHashSize = 1 << (flags & 0x03);
  const tagHex = frame.subarray(10, 14).toString('hex');
  if (frame.length < 18) return null;
  const authHex = frame.subarray(14, 18).toString('hex');
  const hashesStart = 18;
  if (frame.length < hashesStart + pathLen) return null;
  const hopCount = pathHashSize > 0 ? Math.floor(pathLen / pathHashSize) : 0;
  const snrsStart = hashesStart + pathLen;
  if (frame.length < snrsStart + hopCount + 1) return null;
  const hops: Array<{ hashHex: string; snrDb: number }> = [];
  for (let i = 0; i < hopCount; i += 1) {
    const hash = frame.subarray(hashesStart + i * pathHashSize, hashesStart + (i + 1) * pathHashSize);
    hops.push({ hashHex: hash.toString('hex'), snrDb: frame.readInt8(snrsStart + i) / 4 });
  }
  const finalSnrDb = frame.readInt8(snrsStart + hopCount) / 4;
  return { pubKeyPrefixHex, tagHex, authHex, flags, pathHashSize, hops, finalSnrDb };
}

// ACL list response body (inside PUSH_BINARY_RESPONSE payload, after the 4B
// tag we already stripped in parseBinaryResponse). Repeating 7-byte entries:
//   [6B pubkey prefix][1B perms]
// Firmware: MyMeshRepeater.cpp:265-277.
export interface AclEntry {
  pubKeyPrefixHex: string;
  permissions: number;
  isAdmin: boolean;
  isGuest: boolean;
}

export function parseAclList(payload: Buffer): AclEntry[] {
  const out: AclEntry[] = [];
  for (let i = 0; i + 7 <= payload.length; i += 7) {
    const perms = payload[i + 6];
    out.push({
      pubKeyPrefixHex: payload.subarray(i, i + 6).toString('hex'),
      permissions: perms,
      isAdmin: (perms & 0x01) !== 0,
      isGuest: (perms & 0x02) !== 0,
    });
  }
  return out;
}

// Neighbours response body (inside PUSH_BINARY_RESPONSE payload, after the
// tag). Firmware: MyMeshRepeater.cpp:279-374. Layout:
//   [total u16 LE][returned u16 LE]
//   then per-entry: [prefix (prefixLen bytes)][heard_secs_ago u32 LE][snr i8]
// The prefix length is whatever we asked for in the request; we re-use it
// here so the caller doesn't have to thread it through.
export interface Neighbour {
  pubKeyPrefixHex: string;
  heardSecsAgo: number;
  snrDb: number;
}

export interface NeighboursPage {
  total: number;
  neighbours: Neighbour[];
}

export function parseNeighbours(payload: Buffer, prefixLen: number): NeighboursPage | null {
  if (payload.length < 4) return null;
  const total = payload.readUInt16LE(0);
  const returned = payload.readUInt16LE(2);
  const entrySize = prefixLen + 4 + 1;
  const neighbours: Neighbour[] = [];
  let off = 4;
  for (let i = 0; i < returned; i += 1) {
    if (off + entrySize > payload.length) break;
    neighbours.push({
      pubKeyPrefixHex: payload.subarray(off, off + prefixLen).toString('hex'),
      heardSecsAgo: payload.readUInt32LE(off + prefixLen),
      snrDb: payload.readInt8(off + prefixLen + 4) / 4,
    });
    off += entrySize;
  }
  return { total, neighbours };
}

// Owner info response body: ASCII text — firmware version, node name, owner
// info — separated by newlines, optionally null-terminated. Firmware:
// MyMeshRepeater.cpp:375-377.
export interface OwnerInfo {
  firmwareVersion: string;
  nodeName: string;
  ownerInfo: string;
}

export function parseOwnerInfo(payload: Buffer): OwnerInfo {
  const nullIdx = payload.indexOf(0);
  const text = (nullIdx === -1 ? payload : payload.subarray(0, nullIdx)).toString('utf8');
  const lines = text.split(/\r?\n/);
  return {
    firmwareVersion: lines[0] ?? '',
    nodeName: lines[1] ?? '',
    ownerInfo: lines.slice(2).join('\n'),
  };
}

// RESP_CODE_STATS reply to CMD_GET_STATS. Second byte is the subtype echo;
// remaining bytes depend on subtype. Firmware: MyMesh.cpp:1822-1872.
export type LocalStats =
  | {
      kind: 'core';
      battMv: number;
      uptimeSecs: number;
      errFlags: number;
      queueLen: number;
    }
  | {
      kind: 'radio';
      noiseFloor: number;
      lastRssi: number;
      lastSnrDb: number;
      txAirSecs: number;
      rxAirSecs: number;
    }
  | {
      kind: 'packets';
      recv: number;
      sent: number;
      nSentFlood: number;
      nSentDirect: number;
      nRecvFlood: number;
      nRecvDirect: number;
      nRecvErrors: number;
    };

export function parseLocalStats(frame: Buffer): LocalStats | null {
  if (frame.length < 2) return null;
  const subtype = frame[1];
  const b = frame.subarray(2);
  if (subtype === 0x00 && b.length >= 9) {
    return {
      kind: 'core',
      battMv: b.readUInt16LE(0),
      uptimeSecs: b.readUInt32LE(2),
      errFlags: b.readUInt16LE(6),
      queueLen: b.readUInt8(8),
    };
  }
  if (subtype === 0x01 && b.length >= 12) {
    return {
      kind: 'radio',
      noiseFloor: b.readInt16LE(0),
      lastRssi: b.readInt8(2),
      lastSnrDb: b.readInt8(3) / 4,
      txAirSecs: b.readUInt32LE(4),
      rxAirSecs: b.readUInt32LE(8),
    };
  }
  if (subtype === 0x02 && b.length >= 28) {
    return {
      kind: 'packets',
      recv: b.readUInt32LE(0),
      sent: b.readUInt32LE(4),
      nSentFlood: b.readUInt32LE(8),
      nSentDirect: b.readUInt32LE(12),
      nRecvFlood: b.readUInt32LE(16),
      nRecvDirect: b.readUInt32LE(20),
      nRecvErrors: b.readUInt32LE(24),
    };
  }
  return null;
}

// ---- Encoders (admin command framing) ----------------------------------

// CMD_SEND_STATUS_REQ (firmware: companion_radio/MyMesh.cpp):
//   [0x1b][32B recipient pub_key]
// Radio replies with RESP_SENT (tag + est_timeout). The actual status payload
// arrives later as PUSH_STATUS_RESPONSE.
export function buildSendStatusReq(destPublicKeyHex: string): Buffer {
  const pubkey = Buffer.from(destPublicKeyHex, 'hex');
  if (pubkey.length < 32) {
    throw new Error(`status req needs full 32B public key, got ${pubkey.length}`);
  }
  const out = Buffer.alloc(1 + 32);
  out[0] = CMD.SEND_STATUS_REQ;
  pubkey.copy(out, 1, 0, 32);
  return out;
}

// CMD_SEND_TELEMETRY_REQ (firmware: companion_radio/MyMesh.cpp).
//   [0x27][3B reserved/filter][32B recipient pub_key]
// The 3 reserved bytes after the opcode are placeholder filter flags in the
// firmware path that takes len >= 4 + PUB_KEY_SIZE; we zero them.
export function buildSendTelemetryReq(destPublicKeyHex: string): Buffer {
  const pubkey = Buffer.from(destPublicKeyHex, 'hex');
  if (pubkey.length < 32) {
    throw new Error(`telemetry req needs full 32B public key, got ${pubkey.length}`);
  }
  const out = Buffer.alloc(4 + 32);
  out[0] = CMD.SEND_TELEMETRY_REQ;
  // bytes 1..3 stay zero
  pubkey.copy(out, 4, 0, 32);
  return out;
}

// CMD_SEND_LOGIN: [0x1a][32B dest pubkey][ASCII password...] (firmware:
// MyMesh.cpp:1500-1521). Firmware appends a null terminator beyond `len`, so we
// pass the password as-is — no need to send a trailing 0.
export function buildSendLogin(destPublicKeyHex: string, password: string): Buffer {
  const pubkey = Buffer.from(destPublicKeyHex, 'hex');
  if (pubkey.length < 32) {
    throw new Error(`login needs full 32B public key, got ${pubkey.length}`);
  }
  const pw = Buffer.from(password, 'utf8');
  const out = Buffer.alloc(1 + 32 + pw.length);
  out[0] = CMD.SEND_LOGIN;
  pubkey.copy(out, 1, 0, 32);
  pw.copy(out, 1 + 32);
  return out;
}

// CMD_LOGOUT: [0x1d][32B dest pubkey]. Firmware MyMesh.cpp:1656-1659.
export function buildLogout(destPublicKeyHex: string): Buffer {
  const pubkey = Buffer.from(destPublicKeyHex, 'hex');
  if (pubkey.length < 32) {
    throw new Error(`logout needs full 32B public key, got ${pubkey.length}`);
  }
  const out = Buffer.alloc(1 + 32);
  out[0] = CMD.LOGOUT;
  pubkey.copy(out, 1, 0, 32);
  return out;
}

// CMD_SEND_ANON_REQ: [0x39][32B dest pubkey][N data bytes]. Firmware requires
// `len > 1 + PUB_KEY_SIZE` (so data must be ≥1 byte). The data sub-type is
// either a password (sub-type byte starts with ASCII), or one of the ANON_REQ
// query types (0x01..0x03). Firmware: MyMesh.cpp:1522-1542.
export function buildSendAnonReq(destPublicKeyHex: string, data: Buffer): Buffer {
  const pubkey = Buffer.from(destPublicKeyHex, 'hex');
  if (pubkey.length < 32) {
    throw new Error(`anon_req needs full 32B public key, got ${pubkey.length}`);
  }
  if (data.length === 0) throw new Error('anon_req data must be ≥1 byte');
  const out = Buffer.alloc(1 + 32 + data.length);
  out[0] = CMD.SEND_ANON_REQ;
  pubkey.copy(out, 1, 0, 32);
  data.copy(out, 1 + 32);
  return out;
}

// Convenience: send an anonymous *password login* to a remote repeater we have
// not yet been admitted to. Body is just the ASCII password (sub-type byte
// happens to be the first password char or 0). Firmware reads data[0] and
// branches on `>= 0x20` (ASCII) for handleLoginReq.
export function buildAnonLogin(destPublicKeyHex: string, password: string): Buffer {
  const body = Buffer.from(password, 'utf8');
  if (body.length === 0) throw new Error('password must not be empty');
  return buildSendAnonReq(destPublicKeyHex, body);
}

// CMD_SEND_TRACE_PATH: [0x24][tag u32 LE][auth u32 LE][flags u8][path bytes...]
// Firmware checks `len > 10`, so we always emit ≥1 path byte. flags bits 0..1
// encode the per-hop hash size (path length must be multiple of 1<<size).
// Firmware: MyMesh.cpp:1721-1746.
export function buildSendTracePath(opts: { tag: number; authCode: number; flags?: number; path: Buffer }): Buffer {
  if (opts.path.length === 0) throw new Error('trace path must contain ≥1 byte');
  const flags = (opts.flags ?? 0) & 0xff;
  const out = Buffer.alloc(10 + opts.path.length);
  out[0] = CMD.SEND_TRACE_PATH;
  out.writeUInt32LE(opts.tag >>> 0, 1);
  out.writeUInt32LE(opts.authCode >>> 0, 5);
  out[9] = flags;
  opts.path.copy(out, 10);
  return out;
}

// CMD_GET_STATS: [0x38][subtype]. Subtype is one of STATS_TYPE.{CORE,RADIO,
// PACKETS}. Firmware: MyMesh.cpp:1822-1872.
export function buildGetStats(subtype: (typeof STATS_TYPE)[keyof typeof STATS_TYPE]): Buffer {
  return Buffer.from([CMD.GET_STATS, subtype & 0xff]);
}

// Mesh-level admin request encoder. The connected radio wraps this for us via
// CMD_SEND_BINARY_REQ (0x32) — `[0x32][32B pubkey][req_type byte + req_data]`.
// The reply comes back as PUSH_BINARY_RESPONSE tagged with the same u32 the
// firmware echoes in RESP_SENT. Used for REQ_TYPE_GET_ACCESS_LIST,
// REQ_TYPE_GET_NEIGHBOURS, REQ_TYPE_GET_OWNER_INFO — anything other than
// STATUS/TELEMETRY which have dedicated CMD opcodes already.
export function buildSendBinaryReq(destPublicKeyHex: string, reqData: Buffer): Buffer {
  const pubkey = Buffer.from(destPublicKeyHex, 'hex');
  if (pubkey.length < 32) {
    throw new Error(`binary_req needs full 32B public key, got ${pubkey.length}`);
  }
  if (reqData.length === 0) throw new Error('binary_req data must be ≥1 byte');
  const out = Buffer.alloc(1 + 32 + reqData.length);
  out[0] = CMD.SEND_BINARY_REQ;
  pubkey.copy(out, 1, 0, 32);
  reqData.copy(out, 1 + 32);
  return out;
}

// ---- Status & telemetry response decoders ------------------------------

// PUSH_STATUS_RESPONSE (firmware: companion_radio/MyMesh.cpp):
//   [0x87][1B reserved][6B sender pub_key_prefix][status bytes...]
// "status bytes" is the raw status blob the repeater returned. The firmware
// doesn't pin a layout in MyMesh.cpp — meshcore-py treats it as a sequence of
// fields keyed by a magic byte (uptime, batt mV, airtime, queue len, etc.).
// For now we surface (a) the sender prefix, (b) the raw hex payload — the
// renderer renders whatever fields it recognises and falls back to hex for
// unknown firmware versions.
export interface StatusResponse {
  senderPubKeyPrefixHex: string;
  payloadHex: string;
  fields: StatusField[];
}

// Best-effort decode of the meshcore "repeater status" blob. The well-known
// layout used by Heltec/RAK repeaters is:
//   [0..3]  bat_millivolts  uint32 LE
//   [4..7]  curr_tx_queue   uint32 LE (packets currently queued for TX)
//   [8..11] curr_free_queue uint32 LE (free slots in the TX queue)
//   [12..13] last_rssi      int16 LE (dBm × 1)
//   [14..17] n_packets_rx   uint32 LE
//   [18..21] n_packets_tx   uint32 LE (since boot)
//   [22..25] total_air_secs uint32 LE
//   [26..29] uptime_secs    uint32 LE
//   [30..33] sent_flood     uint32 LE
//   [34..37] sent_direct    uint32 LE
//   [38..41] recv_flood     uint32 LE
//   [42..45] recv_direct    uint32 LE
//   [46..47] full_evts      uint16 LE
//   [48..49] last_snr_x4    int16 LE (SNR × 4 → dB / 4)
//   [50]    n_direct_dups   uint8
//   [51]    n_flood_dups    uint8
// Older firmwares may truncate; we tolerate by stopping at the byte boundary.
export interface StatusField {
  name: string;
  value: number | string;
  unit?: string;
}

export function parseStatusResponse(frame: Buffer): StatusResponse | null {
  if (frame.length < 8) return null;
  const senderPubKeyPrefixHex = frame.subarray(2, 8).toString('hex');
  const payload = frame.subarray(8);
  return {
    senderPubKeyPrefixHex,
    payloadHex: payload.toString('hex'),
    fields: decodeStatusFields(payload),
  };
}

function decodeStatusFields(b: Buffer): StatusField[] {
  const fields: StatusField[] = [];
  const push = (name: string, value: number | string, unit?: string) => fields.push({ name, value, unit });

  if (b.length >= 4) push('Battery', b.readUInt32LE(0) / 1000, 'V');
  if (b.length >= 8) push('TX queue', b.readUInt32LE(4));
  if (b.length >= 12) push('Free queue', b.readUInt32LE(8));
  if (b.length >= 14) push('Last RSSI', b.readInt16LE(12), 'dBm');
  if (b.length >= 18) push('RX packets', b.readUInt32LE(14));
  if (b.length >= 22) push('TX packets', b.readUInt32LE(18));
  if (b.length >= 26) push('Airtime', b.readUInt32LE(22), 's');
  if (b.length >= 30) push('Uptime', formatUptime(b.readUInt32LE(26)));
  if (b.length >= 34) push('Flood sent', b.readUInt32LE(30));
  if (b.length >= 38) push('Direct sent', b.readUInt32LE(34));
  if (b.length >= 42) push('Flood rx', b.readUInt32LE(38));
  if (b.length >= 46) push('Direct rx', b.readUInt32LE(42));
  if (b.length >= 48) push('Queue-full evts', b.readUInt16LE(46));
  if (b.length >= 50) push('Last SNR', b.readInt16LE(48) / 4, 'dB');
  if (b.length >= 51) push('Direct dups', b.readUInt8(50));
  if (b.length >= 52) push('Flood dups', b.readUInt8(51));
  return fields;
}

function formatUptime(secs: number): string {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// PUSH_TELEMETRY_RESPONSE (firmware: companion_radio/MyMesh.cpp):
//   [0x8b][1B reserved][6B sender pub_key_prefix][CayenneLPP-encoded fields...]
// CayenneLPP encoding: each field is [channel u8][type u8][data...]. We decode
// the full standard type table (CAYENNE_TYPES below) plus a fallback hex view
// for unknown types so new firmware additions surface without code changes.
export interface TelemetryResponse {
  senderPubKeyPrefixHex: string;
  payloadHex: string;
  fields: TelemetryField[];
}

export interface TelemetryField {
  channel: number;
  typeHex: string;
  name: string;
  value: number | string;
  unit?: string;
}

export function parseTelemetryResponse(frame: Buffer): TelemetryResponse | null {
  if (frame.length < 8) return null;
  const senderPubKeyPrefixHex = frame.subarray(2, 8).toString('hex');
  const payload = frame.subarray(8);
  return {
    senderPubKeyPrefixHex,
    payloadHex: payload.toString('hex'),
    fields: decodeCayenneLPP(payload),
  };
}

interface CayenneDescriptor {
  name: string;
  size: number;
  decode: (b: Buffer) => number | string;
  unit?: string;
}

// CayenneLPP type id → { name, payload size in bytes, decoder, unit }.
// Keys are decimal because biome's useSimpleNumberKeys disallows hex literals
// as object keys; the trailing comment preserves the spec id. Multi-axis types
// (GPS, accelerometer, gyrometer, colour) decode to a comma-separated string so
// `value` stays number|string. POLYLINE (240) is variable-length and omitted —
// it surfaces via the abort-on-unknown fallback. Sizes/scaling match the
// MeshCore reference (meshcore.js/src/cayenne_lpp.js).
const CAYENNE_TYPES: Record<number, CayenneDescriptor> = {
  0: { name: 'Digital input', size: 1, decode: (b) => b.readUInt8(0) }, // 0x00
  1: { name: 'Digital output', size: 1, decode: (b) => b.readUInt8(0) }, // 0x01
  2: { name: 'Analog input', size: 2, decode: (b) => b.readInt16BE(0) / 100 }, // 0x02
  3: { name: 'Analog output', size: 2, decode: (b) => b.readInt16BE(0) / 100 }, // 0x03
  100: { name: 'Generic sensor', size: 4, decode: (b) => b.readUInt32BE(0) }, // 0x64
  101: { name: 'Illuminance', size: 2, decode: (b) => b.readUInt16BE(0), unit: 'lx' }, // 0x65
  102: { name: 'Presence', size: 1, decode: (b) => b.readUInt8(0) }, // 0x66
  103: { name: 'Temperature', size: 2, decode: (b) => b.readInt16BE(0) / 10, unit: '°C' }, // 0x67
  104: { name: 'Humidity', size: 1, decode: (b) => b.readUInt8(0) / 2, unit: '%' }, // 0x68
  113: {
    name: 'Accelerometer',
    size: 6,
    decode: (b) => `${b.readInt16BE(0) / 1000},${b.readInt16BE(2) / 1000},${b.readInt16BE(4) / 1000}`,
    unit: 'G',
  }, // 0x71
  115: { name: 'Barometer', size: 2, decode: (b) => b.readUInt16BE(0) / 10, unit: 'hPa' }, // 0x73
  116: { name: 'Voltage', size: 2, decode: (b) => b.readUInt16BE(0) / 100, unit: 'V' }, // 0x74
  117: { name: 'Current', size: 2, decode: (b) => b.readInt16BE(0) / 1000, unit: 'A' }, // 0x75 (signed)
  118: { name: 'Frequency', size: 4, decode: (b) => b.readUInt32BE(0), unit: 'Hz' }, // 0x76
  120: { name: 'Percentage', size: 1, decode: (b) => b.readUInt8(0), unit: '%' }, // 0x78
  121: { name: 'Altitude', size: 2, decode: (b) => b.readInt16BE(0), unit: 'm' }, // 0x79
  125: { name: 'Concentration', size: 2, decode: (b) => b.readUInt16BE(0), unit: 'ppm' }, // 0x7d
  128: { name: 'Power', size: 2, decode: (b) => b.readUInt16BE(0), unit: 'W' }, // 0x80
  130: { name: 'Distance', size: 4, decode: (b) => b.readUInt32BE(0) / 1000, unit: 'm' }, // 0x82
  131: { name: 'Energy', size: 4, decode: (b) => b.readUInt32BE(0) / 1000, unit: 'kWh' }, // 0x83
  132: { name: 'Direction', size: 2, decode: (b) => b.readUInt16BE(0), unit: '°' }, // 0x84
  133: { name: 'Unixtime', size: 4, decode: (b) => b.readUInt32BE(0), unit: 's' }, // 0x85
  134: {
    name: 'Gyrometer',
    size: 6,
    decode: (b) => `${b.readInt16BE(0) / 100},${b.readInt16BE(2) / 100},${b.readInt16BE(4) / 100}`,
    unit: '°/s',
  }, // 0x86
  135: {
    name: 'Colour',
    size: 3,
    decode: (b) => `${b.readUInt8(0)},${b.readUInt8(1)},${b.readUInt8(2)}`,
  }, // 0x87
  136: {
    name: 'GPS',
    size: 9,
    decode: (b) => `${b.readIntBE(0, 3) / 10000},${b.readIntBE(3, 3) / 10000},${b.readIntBE(6, 3) / 100}`,
  }, // 0x88
  142: { name: 'Switch', size: 1, decode: (b) => b.readUInt8(0) }, // 0x8e
};

function decodeCayenneLPP(b: Buffer): TelemetryField[] {
  const out: TelemetryField[] = [];
  let i = 0;
  while (i + 2 <= b.length) {
    const channel = b[i];
    const type = b[i + 1];
    const desc = CAYENNE_TYPES[type];
    if (!desc) {
      // Unknown type — abort rather than mis-frame the rest.
      out.push({
        channel,
        typeHex: `0x${type.toString(16).padStart(2, '0')}`,
        name: 'Unknown',
        value: b.subarray(i + 2).toString('hex'),
      });
      break;
    }
    if (i + 2 + desc.size > b.length) break;
    const data = b.subarray(i + 2, i + 2 + desc.size);
    out.push({
      channel,
      typeHex: `0x${type.toString(16).padStart(2, '0')}`,
      name: desc.name,
      value: desc.decode(data),
      unit: desc.unit,
    });
    i += 2 + desc.size;
  }
  return out;
}

// ---- Avg/Min/Max series (REQ_TYPE_GET_AVG_MIN_MAX) ---------------------
// The series response packs each min/max/avg with size/scale/sign drawn from
// the firmware's getDataSize/getMultiplier/isSigned (NOT the standard CayenneLPP
// decode path — notably Current is UNSIGNED here). Mirrors
// MeshCore/examples/simple_sensor/SensorMesh.cpp:76-148.

function avgMinMaxSize(type: number): number {
  switch (type) {
    case 136:
      return 9; // GPS
    case 240:
      return 8; // POLYLINE
    case 134:
    case 113:
      return 6; // GYROMETER, ACCELEROMETER
    case 100:
    case 118:
    case 130:
    case 131:
    case 133:
      return 4; // GENERIC, FREQ, DIST, ENERGY, UNIXTIME
    case 135:
      return 3; // COLOUR
    case 2:
    case 3:
    case 101:
    case 103:
    case 125:
    case 115:
    case 104:
    case 121:
    case 116:
    case 117:
    case 132:
    case 128:
      return 2;
    default:
      return 1;
  }
}

function avgMinMaxMultiplier(type: number): number {
  switch (type) {
    case 117:
    case 130:
    case 131:
      return 1000; // CURRENT, DISTANCE, ENERGY
    case 116:
    case 2:
    case 3:
      return 100; // VOLTAGE, ANALOG_IN/OUT
    case 103:
    case 115:
    case 104:
      return 10; // TEMPERATURE, BAROMETRIC, HUMIDITY
    default:
      return 1;
  }
}

function avgMinMaxSigned(type: number): boolean {
  // ALTITUDE, TEMPERATURE, GYROMETER, ANALOG_IN/OUT, GPS, ACCELEROMETER
  return type === 121 || type === 103 || type === 134 || type === 2 || type === 3 || type === 136 || type === 113;
}

// Big-endian integer / multiplier, two's-complement when signed. Number math
// (not bitwise) so signedness is correct for multi-byte sizes.
function decodeSeriesFloat(buf: Buffer, size: number, multiplier: number, signed: boolean): number {
  let value = 0;
  for (let i = 0; i < size; i += 1) value = value * 256 + buf[i];
  if (signed) {
    const boundary = 2 ** (size * 8);
    if (value >= boundary / 2) value -= boundary;
  }
  return value / multiplier;
}

export interface AvgMinMaxSeries {
  channel: number;
  lppType: number;
  typeHex: string;
  name: string;
  unit?: string;
  min: number;
  max: number;
  avg: number;
}

export interface AvgMinMaxResult {
  /** Repeater's RTC time (unix seconds) at the moment it built the response. */
  nowUnix: number;
  series: AvgMinMaxSeries[];
}

// `body` is the PUSH_BINARY_RESPONSE payload (tag already stripped):
//   [now u32 LE] then N × [channel u8][lpp_type u8][min][max][avg].
export function parseAvgMinMax(body: Buffer): AvgMinMaxResult | null {
  if (body.length < 4) return null;
  const nowUnix = body.readUInt32LE(0);
  const series: AvgMinMaxSeries[] = [];
  let i = 4;
  while (i + 2 <= body.length) {
    const channel = body[i];
    const lppType = body[i + 1];
    const size = avgMinMaxSize(lppType); // unknown types default to 1 (firmware fallback)
    const entryLen = 2 + size * 3;
    if (i + entryLen > body.length) break; // truncated final entry — stop in frame
    const mult = avgMinMaxMultiplier(lppType);
    const signed = avgMinMaxSigned(lppType);
    const base = i + 2;
    const min = decodeSeriesFloat(body.subarray(base, base + size), size, mult, signed);
    const max = decodeSeriesFloat(body.subarray(base + size, base + 2 * size), size, mult, signed);
    const avg = decodeSeriesFloat(body.subarray(base + 2 * size, base + 3 * size), size, mult, signed);
    const desc = CAYENNE_TYPES[lppType];
    series.push({
      channel,
      lppType,
      typeHex: `0x${lppType.toString(16).padStart(2, '0')}`,
      name: desc?.name ?? 'Unknown',
      unit: desc?.unit,
      min,
      max,
      avg,
    });
    i += entryLen;
  }
  return { nowUnix, series };
}
