import type { Buffer } from 'node:buffer';
import { invertCodes } from './codeNames';
import { PUSH, RESP } from './codes';

// Parses MeshCore "companion radio" frames received over the Nordic UART TX
// characteristic. Each BLE notification = one frame. The first byte is a
// type code; pushes (0x80+) are unsolicited events, lower codes are responses
// to commands sent by the client.
//
// Only two pushes carry a literal mesh packet:
//   PUSH_CODE_RAW_DATA    (0x84)  [code][snr*4 i8][rssi i8][0xFF][mesh…]
//   PUSH_CODE_LOG_RX_DATA (0x88)  [code][snr*4 i8][rssi i8][mesh…]
// Everything else is a companion-radio event with its own structure.

// Derived from the code tables in codes.ts rather than hand-mirrored, so a new
// PUSH_*/RESP_* constant is named here automatically instead of drifting.
const PUSH_NAMES: Record<number, string> = invertCodes(PUSH, 'PUSH_');
const RESP_NAMES: Record<number, string> = invertCodes(RESP, 'RESP_');

/** Which push delivered a mesh packet. Only `'log_rx'` (0x88) is safe to feed
 *  into the mesh-packet parser — 0x84 (`'raw'`) writes a 0xFF reserved byte
 *  where path_len would be, so its bytes don't follow the Packet wire format. */
export type MeshSource = 'raw' | 'log_rx';

export type ParsedFrame =
  | {
      kind: 'mesh';
      /** See {@link MeshSource}. */
      source: MeshSource;
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

  if (code === PUSH.RAW_DATA && frame.length >= 4) {
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

  if (code === PUSH.LOG_RX_DATA && frame.length >= 3) {
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
