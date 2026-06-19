import { Buffer } from 'node:buffer';
import type { Feature, FeatureContext } from '../feature';
import { CMD, RESP } from '../protocol/codes';
import type { Owner } from '../types';

// RESP_SELF_INFO frame layout (MyMesh.cpp:1038-1070):
//   [0]      code 0x05
//   [1]      adv_type (u8)
//   [2]      tx_power_dbm (i8, signed)
//   [3]      max_lora_tx_power (u8)
//   [4..35]  pub_key (32 bytes)
//   [36..39] lat (i32 LE, degrees × 1_000_000)
//   [40..43] lon (i32 LE, degrees × 1_000_000)
//   [44]     multi_acks (u8)
//   [45]     advert_loc_policy (u8)
//   [46]     telemetry_mode (u8) = (env<<4)|(loc<<2)|base  (each 2 bits, 0..3)
//   [47]     manual_add_contacts (u8)
//   [48..51] freq (u32 LE) — wire value is kHz (e.g. 915000 = 915 MHz)
//   [52..55] bw   (u32 LE) — wire value is Hz  (e.g. 250000 = 250 kHz)
//   [56]     sf (u8)
//   [57]     cr (u8)
//   [58..]   node_name (UTF-8, no null terminator, runs to end of frame)
export interface SelfInfo {
  name: string;
  publicKeyHex: string;
  /** Advertisement type byte (frame[1]). */
  advType: number;
  /** TX power in dBm, signed (frame[2]). */
  txPowerDbm: number;
  /** Maximum LoRa TX power in dBm (frame[3]). */
  maxTxPowerDbm: number;
  /** Latitude in decimal degrees (readInt32LE(36) / 1_000_000). */
  latDeg: number;
  /** Longitude in decimal degrees (readInt32LE(40) / 1_000_000). */
  lonDeg: number;
  /** Multi-ACK setting (frame[44]). */
  multiAcks: number;
  /** Advertise location policy (frame[45]). */
  advertLocPolicy: number;
  /** Telemetry mode — environment component, bits [5:4] of frame[46], 0..3. */
  telemetryModeEnv: number;
  /** Telemetry mode — location component, bits [3:2] of frame[46], 0..3. */
  telemetryModeLoc: number;
  /** Telemetry mode — base component, bits [1:0] of frame[46], 0..3. */
  telemetryModeBase: number;
  /** Manual add contacts flag (frame[47]). */
  manualAddContacts: number;
  /**
   * Radio frequency in kHz (readUInt32LE(48)).
   * The firmware sends prefs.freq * 1000 so the wire value is already kHz
   * (e.g. 915000 = 915 MHz).
   */
  freqKhz: number;
  /**
   * Radio bandwidth in Hz (readUInt32LE(52)).
   * The firmware sends prefs.bw * 1000 so the wire value is already Hz
   * (e.g. 250000 = 250 kHz).
   */
  bwHz: number;
  /** LoRa spreading factor (frame[56]). */
  sf: number;
  /** LoRa coding rate (frame[57]). */
  cr: number;
}

// CMD_APP_START payload (per src/main/bridge/identity.ts):
//   [0x01][version u8][6 reserved bytes][app name UTF-8]. Reply is RESP_SELF_INFO.
export function encodeAppStart(appName: string, version = 1): Buffer {
  const name = Buffer.from(appName, 'utf8');
  const out = Buffer.alloc(8 + name.length);
  out[0] = CMD.APP_START;
  out[1] = version;
  // bytes 2..7 stay zero
  name.copy(out, 8);
  return out;
}

export function decodeSelfInfo(frame: Buffer): SelfInfo | null {
  // Fixed header is 58 bytes; name may be empty but the header must be present.
  if (frame.length < 58 || frame[0] !== 0x05) return null;

  const publicKeyHex = frame.subarray(4, 36).toString('hex');

  const latDeg = frame.readInt32LE(36) / 1_000_000;
  const lonDeg = frame.readInt32LE(40) / 1_000_000;

  const telemetryByte = frame[46];
  const telemetryModeEnv = (telemetryByte >> 4) & 0x03;
  const telemetryModeLoc = (telemetryByte >> 2) & 0x03;
  const telemetryModeBase = telemetryByte & 0x03;

  const name = frame.subarray(58).toString('utf8');

  return {
    name,
    publicKeyHex,
    advType: frame[1],
    txPowerDbm: frame.readInt8(2),
    maxTxPowerDbm: frame[3],
    latDeg,
    lonDeg,
    multiAcks: frame[44],
    advertLocPolicy: frame[45],
    telemetryModeEnv,
    telemetryModeLoc,
    telemetryModeBase,
    manualAddContacts: frame[47],
    freqKhz: frame.readUInt32LE(48),
    bwHz: frame.readUInt32LE(52),
    sf: frame[56],
    cr: frame[57],
  };
}

/** Decode RESP_SELF_INFO, publish the radio identity as the app Owner, and
 *  return the parsed SelfInfo. Shared by the feature handler and the on-demand
 *  getSelfInfo() getter (which consumes the frame via the typed-reply path, so
 *  it must invoke this explicitly). */
export function applySelfInfo(ctx: FeatureContext, frame: Buffer): SelfInfo | null {
  const parsed = decodeSelfInfo(frame);
  if (!parsed) return null;
  const owner: Owner = {
    name: parsed.name,
    publicKeyHex: parsed.publicKeyHex,
    // Codebase convention for pubkey prefixes is the first 12 hex chars
    // (6 bytes); the identity card shows fewer but stores the full key.
    publicKeyShort: parsed.publicKeyHex.slice(0, 12),
  };
  ctx.state.setOwner(owner);
  ctx.events.emit('owner', owner);

  // Fold the radio's live LoRa config into RadioSettings. SELF_INFO carries
  // freq (kHz on the wire → Hz here) / bw (already Hz) / sf / cr / tx power, but
  // NOT repeatMode or pathHashMode, so preserve those. Emit only on change so
  // repeated getSelfInfo() calls don't spam identical events.
  const prevRadio = ctx.state.getRadioSettings();
  const nextRadio = {
    ...prevRadio,
    frequencyHz: parsed.freqKhz * 1000,
    bandwidthHz: parsed.bwHz,
    spreadingFactor: parsed.sf,
    codingRate: parsed.cr,
    txPowerDbm: parsed.txPowerDbm,
  };
  if (
    nextRadio.frequencyHz !== prevRadio.frequencyHz ||
    nextRadio.bandwidthHz !== prevRadio.bandwidthHz ||
    nextRadio.spreadingFactor !== prevRadio.spreadingFactor ||
    nextRadio.codingRate !== prevRadio.codingRate ||
    nextRadio.txPowerDbm !== prevRadio.txPowerDbm
  ) {
    ctx.state.setRadioSettings(nextRadio);
    ctx.events.emit('radioSettings', nextRadio);
  }

  // Fold the radio's advertised identity into DeviceIdentity (otherwise only
  // populated by the local advert setters). 0/0 lat/lon is the firmware "no GPS"
  // sentinel → null; advert_loc_policy != 0 means it shares position in adverts.
  const hasFix = parsed.latDeg !== 0 || parsed.lonDeg !== 0;
  const prevIdentity = ctx.state.getDeviceIdentity();
  const nextIdentity = {
    ...prevIdentity,
    name: parsed.name,
    publicKeyHex: parsed.publicKeyHex,
    lat: hasFix ? parsed.latDeg : null,
    lon: hasFix ? parsed.lonDeg : null,
    sharePositionInAdvert: parsed.advertLocPolicy !== 0,
  };
  if (
    nextIdentity.name !== prevIdentity.name ||
    nextIdentity.publicKeyHex !== prevIdentity.publicKeyHex ||
    nextIdentity.lat !== prevIdentity.lat ||
    nextIdentity.lon !== prevIdentity.lon ||
    nextIdentity.sharePositionInAdvert !== prevIdentity.sharePositionInAdvert
  ) {
    ctx.state.setDeviceIdentity(nextIdentity);
    ctx.events.emit('deviceIdentity', nextIdentity);
  }

  ctx.log.debug(`self-info: "${owner.name}" (${owner.publicKeyShort})`);
  return parsed;
}

// RESP handler: surface the radio's identity as the app Owner, radio config,
// and advertised device identity.
export const selfInfoFeature: Feature = {
  handles: [RESP.SELF_INFO],
  handle: (_code, frame, ctx) => {
    applySelfInfo(ctx, frame);
  },
};
