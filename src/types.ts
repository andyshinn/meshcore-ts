// Carved MeshCore companion-protocol types. Self-contained: no imports from
// other modules — this file only references types it defines internally.

export type TransportState = 'idle' | 'scanning' | 'connecting' | 'connected' | 'error';

/** Which physical transport carried a frame. */
export type TransportType = 'ble' | 'serial';

/** Coarse frame classification: a literal mesh packet vs. a companion-radio
 *  event/response. Mirrors the discriminant on the frame parser's ParsedFrame. */
export type FrameKind = 'mesh' | 'companion';

export interface RawPacket {
  timestamp: number;
  transportType: TransportType;
  kind: FrameKind;
  // Verbatim transport frame — what the bridge fans out to TCP/WS proxy clients.
  // Companion: includes the type code byte. Mesh: includes the 0x84/0x88 + SNR/RSSI prefix.
  hex: string;
  bytes: number[];
  // Parsed payload — what consumers display / feed to the decoder.
  // Companion: payload after the type code. Mesh: the mesh packet only.
  payloadHex: string;
  payloadBytes: number[];
  // Mesh-only: link metrics extracted from companion-radio RAW_DATA / LOG_RX_DATA frames.
  snr?: number;
  rssi?: number;
  // Companion-only: the frame-type byte (e.g. 0x84) and human-readable name.
  code?: number;
  codeName?: string;
}

/** Post-connect handshake progress. `phase` is the high-level state surfaced
 *  alongside the transport-level state; the per-bucket counters for channels
 *  and contacts are summed to drive a "Syncing N/M" indicator. `idle` = not
 *  currently syncing (either pre-connect or post-completion); `syncing` =
 *  handshake in flight; `done` = handshake finished this session. */
export type SyncPhase = 'idle' | 'syncing' | 'done';
export interface SyncProgress {
  phase: SyncPhase;
  channels: { done: number; total: number };
  contacts: { done: number; total: number };
}

export const DEFAULT_SYNC_PROGRESS: SyncProgress = {
  phase: 'idle',
  channels: { done: 0, total: 0 },
  contacts: { done: 0, total: 0 },
};

export type ChannelKind = 'public' | 'hashtag' | 'private';

export interface Channel {
  key: string; // 'ch:<name>'
  name: string;
  kind: ChannelKind;
  secretHex?: string;
  /** Slot index on the radio (0..N). Set after the protocol session learns it
   *  via RESP_CHANNEL_INFO. Required for outbound CMD_SEND_CHAN_TXT_MSG and
   *  used to dispatch incoming RESP_CHANNEL_MSG_RECV(_V3) frames to the right
   *  channel. */
  idx?: number;
}

export type ContactKind = 'chat' | 'repeater' | 'sensor' | 'room';

export type PathHashSize = 1 | 2 | 3;

export interface Contact {
  key: string; // 'c:<publicKeyHex>'
  publicKeyHex: string;
  name: string;
  kind: ContactKind;
  lastSeenMs?: number;
  rssi?: number;
  snr?: number;
  hops?: number;
  /** Radio-level favourite — maps to the firmware contact flag bit 0, which
   *  protects the contact from overwrite-oldest eviction. */
  favourite?: boolean;
  /** Hex-encoded out-path bytes (no separators) mirroring the firmware's
   *  advert.out_path. Empty / undefined means "flood" (no source-route). The
   *  byte length must be a multiple of `outPathHashSize`. */
  outPathHex?: string;
  /** Bytes per hop prefix (1, 2 or 4). Snapshot of the radio's `path.hash.mode`
   *  at the time the path was captured / written. Needed to split `outPathHex`
   *  into the per-hop chips. */
  outPathHashSize?: PathHashSize;
  /** When true, mesh routing is skipped entirely and the companion-side direct
   *  flow is used for this contact (CMD_SEND_LOGIN for repeaters; direct DM
   *  otherwise). Takes precedence over `outPathHex`. */
  preferDirect?: boolean;
  /** True iff the current `outPathHex` was set by hand (not learned by the
   *  auto-retry pipeline). Drives the "overwrite manual path?" dialog. */
  pathManual?: boolean;
  /** Wall-clock ms of the most recent auto-learn that wrote `outPathHex`. */
  pathLearnedAt?: number;
  /** Last advertised position in WGS84 degrees. Both present together or both
   *  absent — a partial fix is never written. 0/0 from firmware is treated as
   *  absent (default for radios without a GPS module). */
  gpsLat?: number;
  gpsLon?: number;
}

/** True iff the contact carries a usable WGS84 fix: both coords present, not
 *  the 0/0 "no GPS" sentinel, and within valid lat/lon ranges. Corrupt adverts
 *  can yield out-of-range coords — treat those as no fix. */
export function hasValidFix(c: Contact): c is Contact & { gpsLat: number; gpsLon: number } {
  return (
    typeof c.gpsLat === 'number' &&
    typeof c.gpsLon === 'number' &&
    (c.gpsLat !== 0 || c.gpsLon !== 0) &&
    c.gpsLat >= -90 &&
    c.gpsLat <= 90 &&
    c.gpsLon >= -180 &&
    c.gpsLon <= 180
  );
}

export type MessageState = 'sending' | 'sent' | 'heard' | 'ack' | 'failed' | 'received';

/** One node in a routing path. `kind` distinguishes the message originator
 *  (sender, derived from the "name: " prefix in channel messages), intermediate
 *  repeaters, and the sink (our radio). `shortId` is the per-hop prefix hex
 *  (1, 2, or 3 bytes wide) as encoded by the firmware in the on-air path.
 *  `unnamed: true` means we only know the prefix byte(s) — no advert ever seen
 *  for that prefix. */
export type MessageHopKind = 'origin' | 'hop' | 'sink';
export interface MessageHop {
  kind: MessageHopKind;
  shortId: string;
  name?: string | null;
  pk?: string | null;
  unnamed?: boolean;
}

/** One observed reception of a flood message: the sequence of hops it took
 *  from origin to our radio. A single Message can carry multiple paths when
 *  the same packet arrived via multiple flood routes (merged on receipt by
 *  deterministic id). `hashMode` is the firmware-encoded per-hop hash byte
 *  count (1, 2, or 3 — 4 is reserved). `finalSnr` is the SNR our radio
 *  measured on the LAST hop only; per-hop SNR is never available on flood. */
export interface MessagePath {
  id: string;
  hops: MessageHop[];
  hashMode: number;
  finalSnr: number;
}

export interface MessageMeta {
  hops?: number;
  rssi?: number;
  snr?: number;
  /** Decoded route(s) the message travelled, populated when a matching mesh
   *  observation (PUSH_CODE_LOG_RX_DATA 0x88) preceded the channel-msg push. */
  paths?: MessagePath[];
  /** Number of distinct flood receptions merged into this Message row. Absent
   *  ⇒ treat as 1. Bumped on collision. */
  timesHeard?: number;
  signatureHex?: string;
}

export interface Message {
  id: string;
  key: string; // channel or contact key the message belongs to
  fromPublicKeyHex?: string; // omitted when sent by the owner
  body: string;
  ts: number;
  state: MessageState;
  meta?: MessageMeta;
}

export interface Owner {
  name: string;
  publicKeyHex: string;
  publicKeyShort: string;
}

export interface RadioSettings {
  frequencyHz: number;
  bandwidthHz: number;
  spreadingFactor: number;
  codingRate: number;
  txPowerDbm: number;
  repeatMode: boolean;
  /** Firmware `path.hash.mode` — bytes per hop prefix used when source-routing.
   *  All contacts whose path is captured / learned while this radio is connected
   *  inherit this as their `outPathHashSize` default. */
  pathHashMode: PathHashSize;
}

// US-915 defaults from project/data/meshcore-config.json (the egrmesh Hand export).
export const DEFAULT_RADIO_SETTINGS: RadioSettings = {
  frequencyHz: 910_525_000,
  bandwidthHz: 62_500,
  spreadingFactor: 7,
  codingRate: 5,
  txPowerDbm: 20,
  repeatMode: false,
  pathHashMode: 2,
};

// ---- Device-side settings (cached locally, device is source of truth) ----

/** "Public info" the radio advertises about itself. Synced from RESP_SELF_INFO
 *  and mutated via CMD_SET_ADVERT_NAME / CMD_SET_ADVERT_LATLON /
 *  CMD_SET_OTHER_PARAMS.advertLocationPolicy. */
export interface DeviceIdentity {
  name: string;
  publicKeyHex: string;
  lat: number | null;
  lon: number | null;
  sharePositionInAdvert: boolean;
}
export const DEFAULT_DEVICE_IDENTITY: DeviceIdentity = {
  name: '',
  publicKeyHex: '',
  lat: null,
  lon: null,
  sharePositionInAdvert: true,
};

/** Auto-add behaviour (CMD_SET_AUTO_ADD_CONFIG / GET_AUTO_ADD_CONFIG). `mode`
 *  is an app-side convenience: "all" forces all four kind flags true on save;
 *  "selected" respects the per-kind booleans. The radio flag byte only carries
 *  the kinds + overwrite_oldest. */
export type AutoAddMode = 'all' | 'selected';
export interface AutoAddConfig {
  mode: AutoAddMode;
  chat: boolean;
  repeater: boolean;
  room: boolean;
  sensor: boolean;
  overwriteOldest: boolean;
  /** App-side filter: drop adverts whose path has more hops than this. `null`
   *  = no limit. The radio doesn't apply this; the companion does pre-upsert. */
  maxHops: number | null;
  /** Radio-side firmware autoadd_max_hops; 0 = no limit. Distinct from the app-side `maxHops` advert filter. */
  radioMaxHops: number;
}
export const DEFAULT_AUTO_ADD_CONFIG: AutoAddConfig = {
  mode: 'all',
  chat: true,
  repeater: true,
  room: true,
  sensor: true,
  overwriteOldest: true,
  maxHops: null,
  radioMaxHops: 0,
};

/** Telemetry/messaging knobs from CMD_SET_OTHER_PARAMS. Each telemetry mode is
 *  0=deny, 1=allow-per-contact-flag, 2=allow-all. `multiAcks` is 0..2 typical;
 *  more ACKs increase reliability at the cost of airtime. */
export interface TelemetryPolicy {
  base: 0 | 1 | 2;
  loc: 0 | 1 | 2;
  env: 0 | 1 | 2;
  multiAcks: number;
}
export const DEFAULT_TELEMETRY_POLICY: TelemetryPolicy = {
  base: 1,
  loc: 1,
  env: 1,
  multiAcks: 1,
};

/** GPS module config exchanged via CMD_SET_CUSTOM_VAR("gps:1"/"gps_interval:N"). */
export interface GpsConfig {
  enabled: boolean;
  intervalSec: number;
}
export const DEFAULT_GPS_CONFIG: GpsConfig = {
  enabled: false,
  intervalSec: 300,
};

/** Aggregate read-only device info. firmwareVerCode 0 means "unknown/no
 *  device connected" — consumers use that to gate firmware-version features
 *  (identity key export needs ≥ 1.7.0, repeat mode needs ≥9, etc.). */
export interface DeviceInfo {
  firmwareVerCode: number;
  deviceModel: string;
  /** Human-readable firmware version, e.g. "v1.15.0" (distinct from firmwareVerCode). */
  firmwareVersion: string;
  /** Firmware build date string, e.g. "19 Apr 2026". */
  firmwareBuildDate: string;
  /** Device BLE pairing PIN; 0 = unset / random per session. */
  blePin: number;
  maxContacts: number;
  maxChannels: number;
  channelsUsed: number;
  contactsUsed: number;
  storageUsedKb: number;
  storageTotalKb: number;
  batteryMv: number;
}
export const DEFAULT_DEVICE_INFO: DeviceInfo = {
  firmwareVerCode: 0,
  deviceModel: '',
  firmwareVersion: '',
  firmwareBuildDate: '',
  blePin: 0,
  maxContacts: 0,
  maxChannels: 0,
  channelsUsed: 0,
  contactsUsed: 0,
  storageUsedKb: 0,
  storageTotalKb: 0,
  batteryMv: 0,
};

/** Per-tab "the device firmware doesn't expose this over BLE" capability flags.
 *  Used to disable rows the official open-source protocol doesn't define. */
export interface DeviceCapabilities {
  /** Firmware version ≥ 1.7.0 — required for CLI-based private key export. */
  identityKeyIO: boolean;
  /** Firmware ver_code ≥ 9 — repeat mode and client_repeat byte. */
  repeatMode: boolean;
}
export const DEFAULT_DEVICE_CAPABILITIES: DeviceCapabilities = {
  identityKeyIO: false,
  repeatMode: false,
};

/** Decoded admin-response payload surfaced from a repeater. `payloadHex` is
 *  always populated so raw bytes can be shown when decoding can't make sense of
 *  them; `fields` is the best-effort decode (status: well-known firmware
 *  layout; telemetry: CayenneLPP). */
export interface RepeaterStatusSnapshot {
  contactKey: string;
  receivedAt: number;
  payloadHex: string;
  fields: Array<{ name: string; value: number | string; unit?: string }>;
}

export interface RepeaterTelemetrySnapshot {
  contactKey: string;
  receivedAt: number;
  payloadHex: string;
  fields: Array<{
    channel: number;
    typeHex: string;
    name: string;
    value: number | string;
    unit?: string;
  }>;
}

export interface PathLearnedEvent {
  contactKey: string;
  /** New out-path bytes the radio observed when the send succeeded. May be
   *  empty (e.g. a path-known send fell back to flood and the radio still
   *  hasn't a path it trusts). */
  newOutPathHex: string;
  newOutPathHashSize: PathHashSize;
  /** Path that was on the contact immediately before the learn. */
  previousOutPathHex: string;
  /** True iff the previous path was set manually — used to decide whether to
   *  prompt or apply silently. */
  previousManual: boolean;
  /** Wall-clock ms of the learn event. */
  learnedAt: number;
}
