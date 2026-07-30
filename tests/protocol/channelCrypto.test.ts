import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { decryptGrpTxt } from '../../src/protocol/channelCrypto';
import { channelHashFor, channelSecretFor, encryptGrpTxt } from '../support/grpTxt';

// A real on-air GRP_TXT payload for the well-known `#bachelorette` hashtag
// channel, published in the reverse-engineered MeshCore crypto write-up. This
// is the anchor that proves our decrypt path matches firmware rather than
// merely matching our own test encoder.
//
// Layout: [channel_hash 1B][MAC 2B][ciphertext ...]
const BACHELORETTE_PAYLOAD =
  '5C13C031C6DC206E8B1D8D300C637FCE97204C8763A06B7AC406D39381DC0D07470C019D2047D711D48BAAE988EBBCB0966DC197A7DD99BDF154304B9E3AAA10498686';

describe('decryptGrpTxt — real captured packet', () => {
  const secretHex = channelSecretFor('#bachelorette');
  const payload = Buffer.from(BACHELORETTE_PAYLOAD, 'hex');
  // Everything after the channel_hash byte, matching what session.ts records.
  const macAndCipher = payload.subarray(1);

  it('derives the channel hash byte the packet is tagged with', () => {
    expect(channelHashFor(secretHex)).toBe(payload[0]);
  });

  it('verifies the MAC and recovers the plaintext', () => {
    const plain = decryptGrpTxt(secretHex, macAndCipher);
    expect(plain).not.toBeNull();
    expect(plain?.timestampUnix).toBe(1768616503);
    expect(plain?.flags).toBe(0);
    expect(plain?.body).toBe('A1b2c3: This is a group message in #bachelorette!');
  });

  it('rejects the packet under a different channel secret', () => {
    expect(decryptGrpTxt(channelSecretFor('#someotherroom'), macAndCipher)).toBeNull();
  });

  it('rejects a payload whose ciphertext was tampered with', () => {
    const tampered = Buffer.from(macAndCipher);
    tampered[tampered.length - 1] ^= 0xff;
    expect(decryptGrpTxt(secretHex, tampered)).toBeNull();
  });
});

describe('decryptGrpTxt — round trip and malformed input', () => {
  const secretHex = channelSecretFor('#test');

  it('round-trips a payload built by the test encoder', () => {
    const hex = encryptGrpTxt(secretHex, { timestampUnix: 1_700_000_000, body: 'Me: hello there' });
    const plain = decryptGrpTxt(secretHex, Buffer.from(hex, 'hex'));
    expect(plain).toEqual({ timestampUnix: 1_700_000_000, flags: 0, body: 'Me: hello there' });
  });

  it('preserves a body that fills the final block exactly', () => {
    // 5-byte header + 11-byte body = exactly one 16-byte block, no zero padding
    // to strip — guards against an over-eager trailing-NUL trim.
    const body = 'abcdefghijk';
    const hex = encryptGrpTxt(secretHex, { timestampUnix: 42, body });
    expect(decryptGrpTxt(secretHex, Buffer.from(hex, 'hex'))?.body).toBe(body);
  });

  it('returns null for a secret that is not 16 bytes', () => {
    const hex = encryptGrpTxt(secretHex, { timestampUnix: 1, body: 'x' });
    expect(decryptGrpTxt('abcd', Buffer.from(hex, 'hex'))).toBeNull();
  });

  it('returns null when the ciphertext is not a whole number of blocks', () => {
    const hex = encryptGrpTxt(secretHex, { timestampUnix: 1, body: 'x' });
    expect(decryptGrpTxt(secretHex, Buffer.from(hex, 'hex').subarray(0, 17))).toBeNull();
  });

  it('returns null for a payload too short to hold a MAC and one block', () => {
    expect(decryptGrpTxt(secretHex, Buffer.alloc(8))).toBeNull();
  });
});
