// MeshCore companion serial/TCP framing. Each frame on the wire is:
//   [ type: 1 byte ][ length: uint16 LE ][ payload: <length> bytes ]
// type is 0x3c '<' (host→device) or 0x3e '>' (device→host); payload is one
// complete companion frame. Verified against meshcore-dev/meshcore.js
// (src/connection/serial_connection.js, src/constants.js).

const FRAME_TYPE_OUTGOING = 0x3c; // '<' host → device
const FRAME_TYPE_INCOMING = 0x3e; // '>' device → host
const HEADER_LENGTH = 3;
// Firmware MAX_FRAME_SIZE is 176 (BaseSerialInterface.h); 256 leaves headroom.
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

/**
 * Resync-tolerant de-framer for the MeshCore serial byte stream. Feed it raw
 * bytes as they arrive; it returns zero or more complete companion-frame
 * payloads, buffering any partial tail. Never throws on malformed input — it
 * drops a byte and resyncs.
 */
export class SerialDeframer {
  private buffer = new Uint8Array(0);
  private readonly maxFrameBytes: number;

  constructor(opts?: { maxFrameBytes?: number }) {
    this.maxFrameBytes = opts?.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  }

  /** Discard any buffered partial frame. */
  reset(): void {
    this.buffer = new Uint8Array(0);
  }

  /** Append bytes and return every complete companion-frame payload now available. */
  push(bytes: Uint8Array): Uint8Array[] {
    const merged = new Uint8Array(this.buffer.length + bytes.length);
    merged.set(this.buffer, 0);
    merged.set(bytes, this.buffer.length);
    this.buffer = merged;

    const frames: Uint8Array[] = [];
    while (this.buffer.length >= HEADER_LENGTH) {
      const type = this.buffer[0];
      if (type !== FRAME_TYPE_OUTGOING && type !== FRAME_TYPE_INCOMING) {
        this.buffer = this.buffer.subarray(1); // spurious byte → resync
        continue;
      }
      const length = this.buffer[1] | (this.buffer[2] << 8); // uint16 LE
      if (length === 0 || length > this.maxFrameBytes) {
        this.buffer = this.buffer.subarray(1); // bad length → resync, never over-buffer
        continue;
      }
      const required = HEADER_LENGTH + length;
      if (this.buffer.length < required) break; // wait for more bytes
      frames.push(this.buffer.slice(HEADER_LENGTH, required)); // slice() copies → caller owns it
      this.buffer = this.buffer.subarray(required);
    }
    return frames;
  }
}
