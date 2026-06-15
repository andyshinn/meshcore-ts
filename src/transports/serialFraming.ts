// MeshCore companion serial/TCP framing. Each frame on the wire is:
//   [ type: 1 byte ][ length: uint16 LE ][ payload: <length> bytes ]
// type is 0x3c '<' (host→device) or 0x3e '>' (device→host); payload is one
// complete companion frame. Verified against meshcore-dev/meshcore.js
// (src/connection/serial_connection.js, src/constants.js).

const FRAME_TYPE_OUTGOING = 0x3c; // '<' host → device
// biome-ignore lint/correctness/noUnusedVariables: used in Task 2 (de-framer)
const FRAME_TYPE_INCOMING = 0x3e; // '>' device → host
const HEADER_LENGTH = 3;
// Firmware MAX_FRAME_SIZE is 176 (BaseSerialInterface.h); 256 leaves headroom.
// biome-ignore lint/correctness/noUnusedVariables: used in Task 2 (de-framer)
const DEFAULT_MAX_FRAME_BYTES = 256;

/** Wrap one companion frame as a host→device serial frame: [0x3c][len LE][payload]. */
export function encodeSerialFrame(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER_LENGTH + payload.length);
  out[0] = FRAME_TYPE_OUTGOING;
  out[1] = payload.length & 0xff;
  out[2] = (payload.length >> 8) & 0xff;
  out.set(payload, HEADER_LENGTH);
  return out;
}
