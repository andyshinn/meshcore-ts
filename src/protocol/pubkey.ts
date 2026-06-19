import { Buffer } from 'node:buffer';

// MeshCore public keys are exactly 32 bytes (64 hex chars).
const PUB_KEY_HEX_LEN = 64;
const PUB_KEY_HEX_RE = /^[0-9a-fA-F]{64}$/;

/** Decode a full 32-byte public key from hex, rejecting anything that isn't
 *  exactly 64 valid hex chars. `Buffer.from(hex, 'hex')` silently truncates an
 *  odd trailing nibble, stops at the first non-hex char, and over-allocates for
 *  overlong input — so a bare `length < 32` check lets malformed/overlong keys
 *  alias to the same 32 bytes on the wire. Validating up front keeps distinct
 *  invalid inputs distinct (they throw) instead of being truncated. `label`
 *  names the caller for the error message. */
export function parsePublicKey(publicKeyHex: string, label: string): Buffer {
  if (!PUB_KEY_HEX_RE.test(publicKeyHex)) {
    throw new Error(`${label} needs full 32B public key (${PUB_KEY_HEX_LEN} hex chars), got ${publicKeyHex.length}`);
  }
  return Buffer.from(publicKeyHex, 'hex');
}
