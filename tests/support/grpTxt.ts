// Test-only encoder for the GRP_TXT payload body, mirroring the firmware's
// `Utils::encryptThenMAC`. Production code only ever decrypts, so this lives
// here rather than in src/.
//
// Trustworthy because its inverse is pinned to a real captured packet: see the
// `#bachelorette` vector in tests/protocol/channelCrypto.test.ts.

import { Buffer } from 'node:buffer';
import { createCipheriv, createHash, createHmac } from 'node:crypto';

/** Hashtag / well-known channel key derivation: sha256(name)[:16]. */
export function channelSecretFor(name: string): string {
  return createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 32);
}

/** The byte the firmware tags GRP_TXT packets with — sha256(secret)[0]. */
export function channelHashFor(secretHex: string): number {
  return createHash('sha256').update(Buffer.from(secretHex, 'hex')).digest()[0];
}

/** Build the GRP_TXT payload body — `[MAC 2B][ciphertext]`, i.e. everything
 *  after the channel_hash byte, which is exactly what session.ts records as
 *  the observation's `encryptedHex`. Plaintext is
 *  `[ts u32 LE][flags 1B][body]`, zero-padded to a 16-byte boundary. */
export function encryptGrpTxt(secretHex: string, opts: { timestampUnix: number; body: string; flags?: number }): string {
  const secret = Buffer.from(secretHex, 'hex');
  const text = Buffer.from(opts.body, 'utf8');
  const padded = Buffer.alloc(Math.ceil((5 + text.length) / 16) * 16);
  padded.writeUInt32LE(opts.timestampUnix >>> 0, 0);
  padded[4] = opts.flags ?? 0;
  text.copy(padded, 5);

  const cipher = createCipheriv('aes-128-ecb', secret, null);
  cipher.setAutoPadding(false);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final()]);
  const mac = createHmac('sha256', secret).update(ciphertext).digest().subarray(0, 2);
  return Buffer.concat([mac, ciphertext]).toString('hex');
}
