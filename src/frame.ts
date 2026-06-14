import type { Buffer } from 'node:buffer';

// Parses MeshCore "companion radio" frames received over the Nordic UART TX
// characteristic. Each BLE notification = one frame. The first byte is a
// type code; pushes (0x80+) are unsolicited events, lower codes are responses
// to commands sent by the client.
//
// Only two pushes carry a literal mesh packet:
//   PUSH_CODE_RAW_DATA    (0x84)  [code][snr*4 i8][rssi i8][0xFF][mesh…]
//   PUSH_CODE_LOG_RX_DATA (0x88)  [code][snr*4 i8][rssi i8][mesh…]
// Everything else is a companion-radio event with its own structure.

const PUSH_NAMES: Record<number, string> = {
  128: 'PUSH_ADVERT',
  129: 'PUSH_PATH_UPDATED',
  130: 'PUSH_SEND_CONFIRMED',
  131: 'PUSH_MSG_WAITING',
  132: 'PUSH_RAW_DATA',
  133: 'PUSH_LOGIN_SUCCESS',
  134: 'PUSH_LOGIN_FAIL',
  135: 'PUSH_STATUS_RESPONSE',
  136: 'PUSH_LOG_RX_DATA',
  137: 'PUSH_TRACE_DATA',
  138: 'PUSH_NEW_ADVERT',
  139: 'PUSH_TELEMETRY_RESPONSE',
  140: 'PUSH_BINARY_RESPONSE',
  141: 'PUSH_PATH_DISCOVERY_RESPONSE',
  142: 'PUSH_CONTROL_DATA',
  143: 'PUSH_CONTACT_DELETED',
  144: 'PUSH_CONTACTS_FULL',
};

const RESP_NAMES: Record<number, string> = {
  0: 'RESP_OK',
  1: 'RESP_ERR',
  2: 'RESP_CONTACTS_START',
  3: 'RESP_CONTACT',
  4: 'RESP_END_OF_CONTACTS',
  5: 'RESP_SELF_INFO',
  6: 'RESP_SENT',
  7: 'RESP_CONTACT_MSG_RECV',
  8: 'RESP_CHANNEL_MSG_RECV',
  9: 'RESP_CURR_TIME',
  10: 'RESP_NO_MORE_MESSAGES',
  11: 'RESP_EXPORT_CONTACT',
  12: 'RESP_BATT_AND_STORAGE',
  13: 'RESP_DEVICE_INFO',
  14: 'RESP_PRIVATE_KEY',
  15: 'RESP_DISABLED',
  16: 'RESP_CONTACT_MSG_RECV_V3',
  17: 'RESP_CHANNEL_MSG_RECV_V3',
  18: 'RESP_CHANNEL_INFO',
  19: 'RESP_SIGN_START',
  20: 'RESP_SIGNATURE',
  21: 'RESP_CUSTOM_VARS',
  22: 'RESP_ADVERT_PATH',
  23: 'RESP_TUNING_PARAMS',
  24: 'RESP_STATS',
  25: 'RESP_AUTOADD_CONFIG',
  27: 'RESP_CHANNEL_DATA_RECV',
  28: 'RESP_DEFAULT_FLOOD_SCOPE',
};

const PUSH_RAW_DATA = 0x84;
const PUSH_LOG_RX_DATA = 0x88;

export type ParsedFrame =
  | {
      kind: 'mesh';
      /** Which push delivered this mesh packet. Only `'log_rx'` (0x88) is safe
       *  to feed into the mesh-packet parser — 0x84 (`'raw'`) writes a 0xFF
       *  reserved byte where path_len would be, so its bytes don't follow the
       *  Packet wire format. */
      source: 'raw' | 'log_rx';
      meshHex: string;
      meshBytes: Buffer;
      snr: number;
      rssi: number;
    }
  | {
      kind: 'companion';
      code: number;
      codeName: string;
      payloadHex: string;
      payloadBytes: Buffer;
    };

export function parseCompanionFrame(frame: Buffer): ParsedFrame | null {
  if (frame.length < 1) return null;
  const code = frame[0];

  if (code === PUSH_RAW_DATA && frame.length >= 4) {
    // [0x84][snr*4 i8][rssi i8][0xFF reserved][mesh…]
    const snr = frame.readInt8(1) / 4;
    const rssi = frame.readInt8(2);
    const mesh = frame.subarray(4);
    return {
      kind: 'mesh',
      source: 'raw',
      meshHex: mesh.toString('hex'),
      meshBytes: mesh,
      snr,
      rssi,
    };
  }

  if (code === PUSH_LOG_RX_DATA && frame.length >= 3) {
    // [0x88][snr*4 i8][rssi i8][mesh…]
    const snr = frame.readInt8(1) / 4;
    const rssi = frame.readInt8(2);
    const mesh = frame.subarray(3);
    return {
      kind: 'mesh',
      source: 'log_rx',
      meshHex: mesh.toString('hex'),
      meshBytes: mesh,
      snr,
      rssi,
    };
  }

  const codeName = PUSH_NAMES[code] ?? RESP_NAMES[code] ?? `frame 0x${code.toString(16).padStart(2, '0')}`;
  const payload = frame.subarray(1);
  return {
    kind: 'companion',
    code,
    codeName,
    payloadHex: payload.toString('hex'),
    payloadBytes: payload,
  };
}
