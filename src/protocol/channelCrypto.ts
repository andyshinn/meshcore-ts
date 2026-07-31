// Channel (GRP_TXT / GRP_DATA) payload decryption.
//
// MeshCore protects group traffic with an encrypt-then-MAC construction keyed
// by the channel's 16-byte shared secret:
//
//   payload    = [channel_hash 1B][MAC 2B][ciphertext N*16B]
//   ciphertext = AES-128-ECB(secret, plaintext zero-padded to 16B blocks)
//   MAC        = first 2 bytes of HMAC-SHA256(secret, ciphertext)
//   plaintext  = [timestamp u32 LE][flags 1B][body UTF-8]
//
// `body` still carries the originating node's "name: " prefix — the firmware
// prepends it before encrypting, so it is part of the ciphertext, not a
// companion-frame decoration.
//
// Notes on the primitives, all of which are easy to get subtly wrong:
//   * ECB, not CBC — there is no IV, and identical plaintext blocks encrypt
//     identically. That is the firmware's choice, not ours.
//   * Zero padding, not PKCS#7. Node's createDecipheriv defaults to PKCS#7 and
//     would throw or truncate, so autoPadding MUST be disabled and the trailing
//     NULs stripped by hand.
//   * The MAC is only 2 bytes: a 1-in-65536 false accept on random data. It is
//     enough to reject a foreign channel whose hash byte collides with ours,
//     but callers should not treat it as strong authentication on its own.
//   * HMAC pads keys shorter than its 64-byte block with zeros, so keying with
//     the bare 16-byte secret and keying with the firmware's zero-padded
//     32-byte GroupChannel::secret produce identical MACs. Either is correct.
//
// Verified against a real captured `#bachelorette` packet — see
// tests/protocol/channelCrypto.test.ts.

import { Buffer } from 'node:buffer';
import { createDecipheriv, createHmac, timingSafeEqual } from 'node:crypto';

const MAC_SIZE = 2;
const BLOCK_SIZE = 16;
const KEY_SIZE = 16;
/** [timestamp u32 LE][flags 1B] ahead of the body. */
const HEADER_SIZE = 5;

export interface GrpTxtPlaintext {
  /** UNIX seconds the *originating* node stamped into the packet. Unique per
   *  send, which makes it the reliable identity for correlating a heard relay
   *  back to one of our own outgoing messages. */
  timestampUnix: number;
  flags: number;
  /** Decrypted body, including the originating node's "name: " prefix. */
  body: string;
}

/** Verify the MAC on a GRP_TXT payload body and decrypt it.
 *
 *  `macAndCipher` is everything after the channel_hash byte — the same slice
 *  the session records as an observation's `encryptedHex`.
 *
 *  Returns null when the payload is malformed or the MAC does not verify. A
 *  null therefore means "this packet is not on the channel that `secretHex`
 *  belongs to", which is exactly the signal needed to reject a colliding
 *  channel-hash byte from a channel we cannot read. */
export function decryptGrpTxt(secretHex: string, macAndCipher: Buffer): GrpTxtPlaintext | null {
  const secret = Buffer.from(secretHex, 'hex');
  if (secret.length !== KEY_SIZE) return null;
  if (macAndCipher.length < MAC_SIZE + BLOCK_SIZE) return null;

  const mac = macAndCipher.subarray(0, MAC_SIZE);
  const ciphertext = macAndCipher.subarray(MAC_SIZE);
  if (ciphertext.length % BLOCK_SIZE !== 0) return null;

  const expected = createHmac('sha256', secret).update(ciphertext).digest().subarray(0, MAC_SIZE);
  if (!timingSafeEqual(mac, expected)) return null;

  const decipher = createDecipheriv('aes-128-ecb', secret, null);
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (plain.length < HEADER_SIZE) return null;

  return {
    timestampUnix: plain.readUInt32LE(0),
    flags: plain[4],
    body: plain.subarray(HEADER_SIZE).toString('utf8').replace(/\0+$/, ''),
  };
}
