import { Buffer } from 'node:buffer';
import { CMD } from '../protocol/codes';

// CMD_SET_ADVERT_NAME: [0x08][utf8 name]. Firmware truncates beyond 31B; we
// truncate client-side too so the wire format matches the official client.
export function encodeSetAdvertName(name: string): Buffer {
  const nameBuf = Buffer.from(name, 'utf8').subarray(0, 31);
  const out = Buffer.alloc(1 + nameBuf.length);
  out[0] = CMD.SET_ADVERT_NAME;
  nameBuf.copy(out, 1);
  return out;
}

// CMD_SET_ADVERT_LATLON: lat/lon as signed micro-degrees, with an optional
// altitude (metres, signed i32) appended at bytes 9-12. The firmware reads
// `alt` "for FUTURE support" (MyMesh.cpp:1205-1219) — it validates lat/lon
// today and tolerates the extra 4 bytes. Omitting `alt` emits the 9-byte form
// the firmware has always accepted.
export function encodeSetAdvertLatLon(lat: number, lon: number, alt?: number): Buffer {
  const hasAlt = alt !== undefined;
  const out = Buffer.alloc(hasAlt ? 1 + 4 + 4 + 4 : 1 + 4 + 4);
  out[0] = CMD.SET_ADVERT_LATLON;
  out.writeInt32LE(Math.round(lat * 1_000_000) | 0, 1);
  out.writeInt32LE(Math.round(lon * 1_000_000) | 0, 5);
  if (hasAlt) out.writeInt32LE(Math.round(alt) | 0, 9);
  return out;
}

// CMD_SET_OTHER_PARAMS: manual-add flag + telemetry policy + advert-location-policy
// + multi-acks.
// Layout: [0x26][manual_add_contacts u8][telemetry_flags u8][advert_loc_policy u8]
//   [multi_acks u8].
//
// Byte 1 is NOT reserved. `MyMesh::handleCmdFrame` (MyMesh.cpp:1022) assigns it
// at MyMesh.cpp:1444 — the first statement of the CMD_SET_OTHER_PARAMS branch,
// before every length guard:
//   } else if (cmd_frame[0] == CMD_SET_OTHER_PARAMS) {
//       _prefs.manual_add_contacts = cmd_frame[1];
// so every telemetry or share-position save overwrites the radio's auto-add pref.
export interface OtherParamsInput {
  telemetryBase: 0 | 1 | 2;
  telemetryLoc: 0 | 1 | 2;
  telemetryEnv: 0 | 1 | 2;
  /** 1 = share GPS in self-adverts, 0 = withhold. */
  advertLocationPolicy: 0 | 1;
  /** Number of duplicate ACKs to emit per inbound DM (0..2 typical). */
  multiAcks: number;
  /** Firmware `_prefs.manual_add_contacts` (`MyMesh::handleCmdFrame`, the
   *  `CMD_SET_OTHER_PARAMS` branch, MyMesh.cpp:1444). Bit 0 CLEAR = auto-add every advert and
   *  ignore `autoadd_config`; bit 0 SET = honour the per-kind
   *  `CMD_SET_AUTO_ADD_CONFIG` flags. Byte 1 is NOT reserved — every
   *  SET_OTHER_PARAMS write overwrites this pref, so callers must pass the
   *  value they intend to keep rather than letting it default to 0. */
  manualAddContacts: number;
}
export function encodeSetOtherParams(input: OtherParamsInput): Buffer {
  const out = Buffer.alloc(5);
  out[0] = CMD.SET_OTHER_PARAMS;
  out[1] = input.manualAddContacts & 0xff;
  out[2] = ((input.telemetryEnv & 0x03) << 4) | ((input.telemetryLoc & 0x03) << 2) | (input.telemetryBase & 0x03);
  out[3] = input.advertLocationPolicy & 0x01;
  out[4] = input.multiAcks & 0xff;
  return out;
}
