// MeshCore companion-protocol command and response codes.
//
// Authoritative sources:
//   - src/main/transport/companionFrame.ts (RESP_* / PUSH_* names + meanings)
//   - src/main/bridge/drain.ts (CMD_* derived from in-flight bridge work)
//   - src/main/bridge/identity.ts (APP_START / SELF_INFO layouts)
//
// Phase 6b uses a deliberately small subset: APP_START handshake, channel
// enumeration, channel send/receive, and the inbox-pump (GET_NEXT_MSG / NO_MORE
// / PUSH_MSG_WAITING). DM, repeater admin, telemetry, etc. land in later phases.

export const CMD = {
  APP_START: 0x01,
  SEND_TXT_MSG: 0x02,
  GET_DEVICE_TIME: 0x05,
  SET_DEVICE_TIME: 0x06,
  SEND_CHAN_TXT_MSG: 0x03,
  GET_CONTACTS: 0x04,
  SEND_SELF_ADVERT: 0x07,
  // CMD_ADD_UPDATE_CONTACT: [0x09][32B pubkey][type u8][flags u8][path_len u8]
  //   [path 64B fixed][name 32B fixed][timestamp u32 LE][lat? i32 LE][lon? i32 LE]
  //   [last_advert? u32 LE]. Min 136 bytes; the trailing 12 bytes (gps + last
  //   advert) are optional and must be all-present or all-absent — sending only
  //   GPS will make the firmware mis-parse the next field as last_advert (see
  //   issue #427 in zjs81/meshcore-open). Replies RESP_OK / RESP_ERR.
  ADD_UPDATE_CONTACT: 0x09,
  GET_NEXT_MSG: 0x0a,
  // CMD_RESET_PATH: [0x0d][32B pubkey]. Clears the contact's out_path on the
  //   radio (equivalent to ADD_UPDATE_CONTACT with path_len=0). Replies RESP_OK.
  RESET_PATH: 0x0d,
  // CMD_REMOVE_CONTACT: [0x0f][32B pubkey]. Deletes the contact from the
  //   radio's on-device store (firmware companion_radio CMD_REMOVE_CONTACT=15).
  //   Replies RESP_OK, or RESP_ERR (ERR_CODE_NOT_FOUND) if absent.
  REMOVE_CONTACT: 0x0f,
  // CMD_DEVICE_QUERY (firmware misspells it CMD_DEVICE_QEURY) carries the app's
  // *protocol* version, which the firmware reads as app_target_ver. Sending
  // version ≥ 3 here makes the radio emit V3 frames (with SNR prefix). Note:
  // CMD_APP_START does NOT set this field — bytes 1..7 of APP_START are
  // reserved on the firmware side, so DEVICE_QUERY is how we negotiate.
  DEVICE_QUERY: 0x16,
  // Repeater admin login. Payload is [32B dest pubkey][ASCII password]. Radio
  // replies RESP_SENT immediately; the real outcome arrives later as
  // PUSH_LOGIN_SUCCESS / PUSH_LOGIN_FAIL after the remote repeater answers.
  SEND_LOGIN: 0x1a,
  SEND_STATUS_REQ: 0x1b,
  // CMD_LOGOUT just calls stopConnection() locally — no graceful "bye" packet
  // is sent. Replies RESP_OK.
  LOGOUT: 0x1d,
  GET_CHANNEL: 0x1f,
  SET_CHANNEL: 0x20,
  // CMD_SEND_TRACE_PATH: [0x24][tag u32 LE][auth u32 LE][flags u8][path bytes]
  // — min total length 11. flags bits 0..1 encode the per-hop hash size.
  SEND_TRACE_PATH: 0x24,
  SEND_TELEMETRY_REQ: 0x27,
  // CMD_SEND_BINARY_REQ: [0x32][32B dest pubkey][req_data]. Used for generic
  // mesh requests where the first req_data byte is a REQ_TYPE (e.g. ACL list,
  // neighbours, owner info). Reply lands in PUSH_BINARY_RESPONSE.
  SEND_BINARY_REQ: 0x32,
  // CMD_GET_STATS: [0x38][subtype u8] (CORE/RADIO/PACKETS). Reply is
  // RESP_CODE_STATS (24) with [subtype][fields...].
  GET_STATS: 0x38,
  // CMD_SEND_ANON_REQ: [0x39][32B dest pubkey][N data bytes]. Data byte 0 is
  // the sub-type — 0 or ≥0x20 (ASCII) means a password login; 0x01/0x02/0x03
  // are anonymous regions/owner/clock queries.
  SEND_ANON_REQ: 0x39,
  // CMD_SET_PATH_HASH_MODE: [0x3d][mode u8]. Global radio setting (not per
  //   contact). Values: 0=legacy/1-byte, 1=standard/2-byte, 2=strict/4-byte.
  //   Replies RESP_OK.
  SET_PATH_HASH_MODE: 0x3d,

  // ---- Settings-parity commands (sourced from meshcore-open
  //       lib/connector/meshcore_protocol.dart and meshcore_connector.dart). ----

  // CMD_SET_ADVERT_NAME: [0x08][utf8 name, ≤31B, no null term]. Replies RESP_OK.
  SET_ADVERT_NAME: 0x08,
  // CMD_SET_RADIO_PARAMS: [0x0b][freq_hz u32 LE][bw_hz u32 LE][sf u8][cr u8]
  //   (+[client_repeat u8] when firmware ver_code ≥ 9). Replies RESP_OK/ERR.
  SET_RADIO_PARAMS: 0x0b,
  // CMD_SET_RADIO_TX_POWER: [0x0c][dBm u8]. Replies RESP_OK/ERR.
  SET_RADIO_TX_POWER: 0x0c,
  // CMD_SET_ADVERT_LATLON: [0x0e][lat*1e6 i32 LE][lon*1e6 i32 LE]. Replies RESP_OK.
  SET_ADVERT_LATLON: 0x0e,
  // CMD_EXPORT_CONTACT: [0x11][32B pubkey] — also used to export the device's
  //   own identity (when pubkey == self). Replies RESP_EXPORT_CONTACT.
  EXPORT_CONTACT: 0x11,
  // CMD_IMPORT_CONTACT: [0x12][serialized contact blob]. Replies RESP_OK/ERR.
  IMPORT_CONTACT: 0x12,
  // CMD_REBOOT: [0x13]"reboot" (literal 6 ASCII bytes). No reply — link drops.
  REBOOT: 0x13,
  // CMD_GET_BATT_AND_STORAGE: [0x14]. Replies RESP_BATT_AND_STORAGE.
  GET_BATT_AND_STORAGE: 0x14,
  // CMD_SET_OTHER_PARAMS: [0x26][reserved u8][telemetry_flags u8]
  //   [advert_loc_policy u8][multi_acks u8]. Replies RESP_OK.
  //   telemetry_flags = (env_mode << 4) | (loc_mode << 2) | base_mode (each 0..2)
  SET_OTHER_PARAMS: 0x26,
  // CMD_GET_CUSTOM_VAR: [0x28][key utf8]. Replies RESP_CUSTOM_VARS with the
  //   key:value text the firmware tracks (gps, gps_interval, etc.).
  GET_CUSTOM_VAR: 0x28,
  // CMD_SET_CUSTOM_VAR: [0x29]"key:value" UTF-8. Replies RESP_OK/ERR.
  SET_CUSTOM_VAR: 0x29,
  // CMD_SET_AUTO_ADD_CONFIG: [0x3a][flags u8]. Replies RESP_OK.
  //   flags: 0x01 overwrite_oldest | 0x02 chat | 0x04 repeater | 0x08 room | 0x10 sensor
  SET_AUTO_ADD_CONFIG: 0x3a,
  // CMD_GET_AUTO_ADD_CONFIG: [0x3b]. Replies RESP_AUTOADD_CONFIG.
  GET_AUTO_ADD_CONFIG: 0x3b,

  // ---- Phase 3 (firmware v1.16.0 parity) additions ----

  // CMD_SET_TUNING_PARAMS: [0x15][rx_delay_base×1000 u32 LE][airtime_factor×1000
  //   u32 LE] (9B). Firmware divides each by 1000 back into a float and
  //   constrains rx_delay_base 0..20, airtime_factor 0..9. Replies RESP_OK.
  SET_TUNING_PARAMS: 0x15,
  // CMD_GET_TUNING_PARAMS: [0x2b]. Replies RESP_TUNING_PARAMS.
  GET_TUNING_PARAMS: 0x2b,

  // CMD_SET_FLOOD_SCOPE_KEY: override the send-scope key for outgoing floods.
  //   [0x36][0x00][key 16B] set the override key; [0x36][0x00] (no key) zero it;
  //   [0x36][0x01] send unscoped (firmware MyMesh.cpp:1909-1919). Replies RESP_OK.
  SET_FLOOD_SCOPE_KEY: 0x36,
  // CMD_SET_DEFAULT_FLOOD_SCOPE: [0x3f][name 31B null-padded][key 16B] (48B,
  //   name 1-30 chars) persists the default scope; a short [0x3f] clears it.
  //   Replies RESP_OK / RESP_ERR (ILLEGAL_ARG on a bad name length).
  SET_DEFAULT_FLOOD_SCOPE: 0x3f,
  // CMD_GET_DEFAULT_FLOOD_SCOPE: [0x40]. Replies RESP_DEFAULT_FLOOD_SCOPE.
  GET_DEFAULT_FLOOD_SCOPE: 0x40,
  // CMD_HAS_CONNECTION: [0x1c][pubkey 32B]. Replies RESP_OK (an active
  //   connection to that node exists) or RESP_ERR (NOT_FOUND).
  HAS_CONNECTION: 0x1c,
  // CMD_GET_ALLOWED_REPEAT_FREQ: [0x3c]. Replies RESP_ALLOWED_REPEAT_FREQ.
  GET_ALLOWED_REPEAT_FREQ: 0x3c,

  // ---- Device admin (group C) — build-gated key import/export, PIN, reset ----

  // CMD_EXPORT_PRIVATE_KEY: [0x17] (bare). On a build with
  //   ENABLE_PRIVATE_KEY_EXPORT replies RESP_PRIVATE_KEY ([0x0e][64B prv_key]);
  //   otherwise RESP_DISABLED ([0x0f]). The 64-byte blob is the ed25519
  //   expanded private key (firmware PRV_KEY_SIZE=64; writeTo emits prv only).
  EXPORT_PRIVATE_KEY: 0x17,
  // CMD_IMPORT_PRIVATE_KEY: [0x18][64B prv_key] (65B; firmware requires len>=65).
  //   Replies RESP_OK on save, RESP_ERR (ILLEGAL_ARG invalid key / FILE_IO_ERROR)
  //   on failure, or RESP_DISABLED on a build without ENABLE_PRIVATE_KEY_IMPORT.
  IMPORT_PRIVATE_KEY: 0x18,
  // CMD_SET_DEVICE_PIN: [0x25][pin u32 LE] (5B). pin must be 0 (disable) or a
  //   6-digit number (100000..999999); otherwise RESP_ERR (ILLEGAL_ARG). Sets
  //   the BLE pairing PIN. Replies RESP_OK.
  SET_DEVICE_PIN: 0x25,
  // CMD_FACTORY_RESET: [0x33]"reset" (the literal 5 ASCII bytes; 6B total). The
  //   firmware disables its serial interface BEFORE formatting the filesystem,
  //   so no RESP reaches us — the link drops (like CMD_REBOOT). Fire-and-forget.
  FACTORY_RESET: 0x33,

  // ---- Message signing (group E) — START → DATA× → FINISH state machine ----

  // CMD_SIGN_START: [0x21] (bare). Allocates the device's 8K sign buffer and
  //   replies RESP_SIGN_START with the max signable length. Resets any prior
  //   in-progress signing session.
  SIGN_START: 0x21,
  // CMD_SIGN_DATA: [0x22][chunk] (≥1 data byte). Appends to the device's sign
  //   buffer. Replies RESP_OK, or RESP_ERR (BAD_STATE if no START first /
  //   TABLE_FULL if the running total would exceed the max length).
  SIGN_DATA: 0x22,
  // CMD_SIGN_FINISH: [0x23] (bare). Signs the accumulated bytes and replies
  //   RESP_SIGNATURE; frees the buffer. RESP_ERR (BAD_STATE) if no START.
  SIGN_FINISH: 0x23,

  // ---- Path diagnostics (group G) ----------------------------------------

  // CMD_GET_ADVERT_PATH: [0x2a][reserved u8][32B pubkey] (34B). Looks up the
  //   device's cached advert path for a contact (matched by 6-byte prefix).
  //   Replies RESP_ADVERT_PATH if cached, else RESP_ERR (NOT_FOUND).
  GET_ADVERT_PATH: 0x2a,
  // CMD_SEND_PATH_DISCOVERY_REQ: [0x34][0x00 reserved][32B pubkey] (34B; byte 1
  //   MUST be 0). Floods a special telemetry request to discover the round-trip
  //   path. Replies RESP_SENT (carrying a tag the firmware tracks internally) on
  //   dispatch, or RESP_ERR (NOT_FOUND / TABLE_FULL). The discovered paths
  //   arrive later as PUSH_PATH_DISCOVERY_RESPONSE.
  SEND_PATH_DISCOVERY_REQ: 0x34,

  // ---- Raw / control / channel data (group H) ----------------------------

  // CMD_SEND_RAW_DATA: [0x19][path_len u8 (0..127, raw byte count)][path bytes]
  //   [payload ≥4B] (≥6B). Sends raw bytes DIRECT along the given path (flood,
  //   i.e. path_len ≥ 0x80, is not supported → RESP_ERR). Replies RESP_OK / RESP_ERR.
  SEND_RAW_DATA: 0x19,
  // CMD_SEND_CONTROL_DATA: [0x37][control_data...] (≥2B; the first data byte's
  //   high bit MUST be set). Sends a zero-hop control datagram. Replies RESP_OK / ERR.
  SEND_CONTROL_DATA: 0x37,
  // CMD_SEND_CHANNEL_DATA: [0x3e][channel_idx u8][path_len u8][path bytes?]
  //   [data_type u16 LE][payload ≤167B]. path_len 0xFF = flood (no path bytes),
  //   else a compound mesh path. data_type 0 is reserved. Replies RESP_OK / RESP_ERR.
  SEND_CHANNEL_DATA: 0x3e,
  // CMD_SEND_RAW_PACKET: [0x41][priority u8][raw packet bytes ≥2] (≥4B). Parses
  //   and transmits a fully-formed mesh packet. Replies RESP_OK / RESP_ERR.
  SEND_RAW_PACKET: 0x41,

  // ---- Contact interop (group B) -----------------------------------------

  // CMD_SHARE_CONTACT: [0x10][32B pubkey]. Re-broadcasts a known contact's
  //   advert zero-hop so neighbours learn it. Replies RESP_OK / RESP_ERR.
  SHARE_CONTACT: 0x10,
  // CMD_GET_CONTACT_BY_KEY: [0x1e][32B pubkey]. Replies RESP_CONTACT (the full
  //   148B contact frame) if the radio has it, else RESP_ERR (NOT_FOUND). NOTE:
  //   RESP_CONTACT is the same opcode the bulk GET_CONTACTS stream uses, so the
  //   reply MUST be correlated inside contactsFeature, not via pendingTyped.
  GET_CONTACT_BY_KEY: 0x1e,
} as const;

// Protocol version we negotiate with the firmware. 4 matches the official
// MeshCore mobile clients and unlocks V3 receive frames (RESP_*_MSG_RECV_V3).
export const APP_PROTOCOL_VERSION = 4;

// Text-message types per firmware (companion_radio/MyMesh.cpp):
// plain text, CLI/data (repeater commands etc.), and signed plain.
export const TXT_TYPE = {
  PLAIN: 0,
  CLI_DATA: 1,
  SIGNED_PLAIN: 2,
} as const;

export const RESP = {
  OK: 0x00,
  ERR: 0x01,
  CONTACTS_START: 0x02,
  CONTACT: 0x03,
  END_OF_CONTACTS: 0x04,
  SELF_INFO: 0x05,
  SENT: 0x06,
  CONTACT_MSG_RECV: 0x07,
  CHANNEL_MSG_RECV: 0x08,
  // RESP_CURR_TIME [0x09][epoch u32 LE] — reply to CMD_GET_DEVICE_TIME.
  CURR_TIME: 0x09,
  NO_MORE_MESSAGES: 0x0a,
  // RESP_EXPORT_CONTACT [0x0b][serialized contact blob]
  EXPORT_CONTACT: 0x0b,
  // RESP_BATT_AND_STORAGE [0x0c][batt_mv u16 LE][storage_used_kb u32 LE][storage_total_kb u32 LE]
  BATT_AND_STORAGE: 0x0c,
  // RESP_DEVICE_INFO [0x0d][firmware_ver_code u8][max_contacts u8 (count/2)]
  //   [max_channels u8][...firmware/radio metadata...]
  //   v9+ adds client_repeat byte (~offset 80); v10+ adds path_hash_mode (~81).
  DEVICE_INFO: 0x0d,
  // RESP_PRIVATE_KEY [0x0e][64B prv_key] — reply to CMD_EXPORT_PRIVATE_KEY on a
  //   build with ENABLE_PRIVATE_KEY_EXPORT. The 64-byte blob is the ed25519
  //   expanded private key (firmware PRV_KEY_SIZE=64).
  PRIVATE_KEY: 0x0e,
  // RESP_DISABLED [0x0f] (bare) — a build-gated command (private-key
  //   export/import) is compiled out on this firmware build.
  DISABLED: 0x0f,
  CONTACT_MSG_RECV_V3: 0x10,
  CHANNEL_MSG_RECV_V3: 0x11,
  CHANNEL_INFO: 0x12,
  // RESP_CUSTOM_VARS [0x15] newline-separated "key:value" UTF-8 pairs.
  CUSTOM_VARS: 0x15,
  // RESP_CODE_STATS reply to CMD_GET_STATS — second byte echoes the requested
  // STATS_TYPE so the caller can route the rest of the payload.
  STATS: 0x18,
  // RESP_AUTOADD_CONFIG [0x19][flags u8] — mirrors SET_AUTO_ADD_CONFIG flags.
  AUTOADD_CONFIG: 0x19,

  // ---- Phase 3 (firmware v1.16.0 parity) additions ----

  // RESP_TUNING_PARAMS [0x17][rx_delay_base×1000 u32 LE][airtime_factor×1000
  //   u32 LE] (9B) — reply to CMD_GET_TUNING_PARAMS.
  TUNING_PARAMS: 0x17,
  // RESP_DEFAULT_FLOOD_SCOPE [0x1c][name 31B][key 16B] (48B) when a default
  //   scope is set, else [0x1c] (1B) when null — reply to CMD_GET_DEFAULT_FLOOD_SCOPE.
  DEFAULT_FLOOD_SCOPE: 0x1c,
  // RESP_ALLOWED_REPEAT_FREQ [0x1a] then N×[lower_freq u32 LE][upper_freq u32 LE]
  //   (8B per range, to the frame limit) — reply to CMD_GET_ALLOWED_REPEAT_FREQ.
  ALLOWED_REPEAT_FREQ: 0x1a,
  // RESP_SIGN_START [0x13][reserved u8][max_len u32 LE] (6B) — reply to
  //   CMD_SIGN_START. max_len is the device's MAX_SIGN_DATA_LEN (8192).
  SIGN_START: 0x13,
  // RESP_SIGNATURE [0x14][64B signature] (65B) — reply to CMD_SIGN_FINISH.
  SIGNATURE: 0x14,
  // RESP_ADVERT_PATH [0x16][recv_timestamp u32 LE][path_len u8][path bytes] —
  //   reply to CMD_GET_ADVERT_PATH. path_len is the compound mesh path byte
  //   (low 6 bits = hop count, top 2 bits + 1 = bytes-per-hop).
  ADVERT_PATH: 0x16,
  // RESP_CHANNEL_DATA_RECV [0x1b][snr×4 i8][rsv u8][rsv u8][channel_idx u8]
  //   [path_len u8][data_type u16 LE][data_len u8][data bytes] — an inbound
  //   group-channel datagram. Queued offline + tickled via PUSH_MSG_WAITING.
  CHANNEL_DATA_RECV: 0x1b,
} as const;

// Firmware error codes carried in a RESP_ERR frame as the byte after the code:
//   [RESP_ERR=0x01][err_code]. Only TABLE_FULL is acted on today — the radio
//   rejects CMD_ADD_UPDATE_CONTACT with 0x03 when its on-device contact store
//   is full (overwrite-oldest off, or every slot is a favourite).
export const ERR_CODE = {
  UNSUPPORTED_CMD: 0x01,
  NOT_FOUND: 0x02,
  TABLE_FULL: 0x03,
  BAD_STATE: 0x04,
  FILE_IO_ERROR: 0x05,
  ILLEGAL_ARG: 0x06,
} as const;

// ADV_TYPE values from src/helpers/AdvertDataHelpers.h, used in RESP_CONTACT
// frames to identify what kind of node the contact is.
export const ADV_TYPE = {
  CHAT: 1,
  REPEATER: 2,
  ROOM: 3,
  SENSOR: 4,
} as const;

export const PUSH = {
  // PUSH_ADVERT [0x80][pubkey 32B] (33B) — a KNOWN contact re-advertised. The
  //   firmware sends this (not the 148B PUSH_NEW_ADVERT) when the advertising
  //   node is already in the contact store; we touch the contact's last-seen.
  ADVERT: 0x80,
  // PUSH_PATH_UPDATED [0x81][pubkey 32B] (33B) — the radio updated its routing
  //   path for a contact (no path bytes inline). We touch the contact's last-seen.
  PATH_UPDATED: 0x81,
  SEND_CONFIRMED: 0x82,
  MSG_WAITING: 0x83,
  // PUSH_RAW_DATA wraps any raw-bytes payload received over the mesh, with a
  // [snr*4][rssi][0xff] header in front of the raw bytes.
  RAW_DATA: 0x84,
  LOGIN_SUCCESS: 0x85,
  LOGIN_FAIL: 0x86,
  STATUS_RESPONSE: 0x87,
  TRACE_DATA: 0x89,
  NEW_ADVERT: 0x8a,
  TELEMETRY_RESPONSE: 0x8b,
  // PUSH_BINARY_RESPONSE delivers a tag-matched binary reply to a prior
  // SEND_ANON_REQ / SEND_BINARY_REQ. Layout: [0x8c][0][tag u32 LE][bytes...].
  BINARY_RESPONSE: 0x8c,
  // PUSH_CONTROL_DATA [0x8e][snr×4 i8][rssi i8][path_len u8][payload bytes] — a
  //   live inbound zero-hop control datagram (sent immediately, not queued).
  CONTROL_DATA: 0x8e,
  // PUSH_PATH_DISCOVERY_RESPONSE [0x8d][reserved u8][6B pubkey_prefix]
  //   [out_path_len u8][out_path bytes][in_path_len u8][in_path bytes] — the
  //   round-trip path discovered by CMD_SEND_PATH_DISCOVERY_REQ. Carries NO tag;
  //   the device tracks a single pending discovery and we correlate by prefix.
  PATH_DISCOVERY_RESPONSE: 0x8d,
  CONTACT_DELETED: 0x8f,
  // PUSH_CODE_CONTACTS_FULL: emitted when the contact store is full and a new
  //   advert could not be auto-added (overwrite-oldest off / all favourites).
  CONTACTS_FULL: 0x90,
} as const;

// Mesh-level admin request sub-types carried inside PAYLOAD_TYPE_REQ. We send
// these via SEND_STATUS_REQ / SEND_TELEMETRY_REQ / SEND_BINARY_REQ; the
// repeater answers via PAYLOAD_TYPE_RESPONSE, which the connected radio
// surfaces back to us as PUSH_STATUS_RESPONSE / TELEMETRY_RESPONSE /
// BINARY_RESPONSE depending on which pending_* tag matched.
export const REQ_TYPE = {
  GET_STATUS: 0x01,
  KEEP_ALIVE: 0x02,
  GET_TELEMETRY_DATA: 0x03,
  GET_AVG_MIN_MAX: 0x04,
  GET_ACCESS_LIST: 0x05,
  GET_NEIGHBOURS: 0x06,
  GET_OWNER_INFO: 0x07,
} as const;

// Sub-type byte for CMD_SEND_ANON_REQ data. A leading 0 or ASCII byte (>= 0x20)
// is treated as a password login; everything else is one of these queries.
export const ANON_REQ_TYPE = {
  REGIONS: 0x01,
  OWNER: 0x02,
  BASIC: 0x03,
} as const;

const REQ_TYPE_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(REQ_TYPE).map(([name, value]) => [value, name]),
);

const ANON_REQ_TYPE_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(ANON_REQ_TYPE).map(([name, value]) => [value, name]),
);

// The REQ_TYPE byte lives in the encrypted body of a PAYLOAD_TYPE_REQ packet, so
// these helpers can only name a byte the caller already holds (e.g. an outbound
// SEND_BINARY_REQ) — not one recovered from a passively-observed on-air packet.

/** Map a REQ_TYPE byte to its enum key name (e.g. 0x05 → 'GET_ACCESS_LIST'),
 *  or 'UNKNOWN' if unmapped. */
export function getRequestTypeName(reqType: number): string {
  return REQ_TYPE_NAMES[reqType] ?? 'UNKNOWN';
}

/** Map an ANON_REQ_TYPE byte to its enum key name (e.g. 0x01 → 'REGIONS'), or
 *  'UNKNOWN' if unmapped. Note a leading 0 or ASCII byte (>= 0x20) is a password
 *  login rather than one of these query sub-types. */
export function getAnonReqTypeName(anonReqType: number): string {
  return ANON_REQ_TYPE_NAMES[anonReqType] ?? 'UNKNOWN';
}

export const STATS_TYPE = {
  CORE: 0x00,
  RADIO: 0x01,
  PACKETS: 0x02,
} as const;

// ACL role, encoded in the low 2 bits of the permissions byte (PUSH_LOGIN_SUCCESS
// byte 12 / ACL list entries). Values mirror firmware helpers/ClientACL.h, where
// `isAdmin() == ((permissions & ACL_ROLE_MASK) == ACL_ADMIN)`.
export const PERM_BITS = {
  ACL_GUEST: 0x00,
  ACL_READ_ONLY: 0x01,
  ACL_READ_WRITE: 0x02,
  ACL_ADMIN: 0x03,
  ACL_ROLE_MASK: 0x03,
} as const;
