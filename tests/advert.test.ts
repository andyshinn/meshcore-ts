import { Buffer } from 'node:buffer';
import { sign as cryptoSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type Advert, parseAdvert, parseAdvertAppData, parseContactBlob, verifyAdvert } from '../src/advert';

// Build a real signed advert payload for a fresh ed25519 identity.
function buildSignedAdvert(appData: Buffer, timestampUnix = 1_700_000_000) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPub = rawEd25519PublicKey(publicKey); // 32B
  const ts = Buffer.alloc(4);
  ts.writeUInt32LE(timestampUnix, 0);
  const message = Buffer.concat([rawPub, ts, appData]); // pubkey || ts || app_data
  const signature = cryptoSign(null, message, privateKey); // 64B
  const payload = Buffer.concat([rawPub, ts, signature, appData]);
  return { payload, rawPub, signature, appData };
}

function rawEd25519PublicKey(key: KeyObject): Buffer {
  // SPKI DER for ed25519 is a fixed 12-byte prefix + the raw 32-byte key.
  return key.export({ type: 'spki', format: 'der' }).subarray(-32);
}

describe('parseAdvertAppData', () => {
  it('decodes type from the low nibble', () => {
    expect(parseAdvertAppData(Buffer.from([0x02]))).toEqual({ type: 2 });
  });

  it('decodes lat/lon when the 0x10 flag is set', () => {
    const b = Buffer.alloc(9);
    b[0] = 0x01 | 0x10; // chat + latlon
    b.writeInt32LE(12_345678, 1); // 12.345678
    b.writeInt32LE(-7_890123, 5); // -7.890123
    const parsed = parseAdvertAppData(b);
    expect(parsed?.type).toBe(1);
    expect(parsed?.latlon?.lat).toBeCloseTo(12.345678, 6);
    expect(parsed?.latlon?.lon).toBeCloseTo(-7.890123, 6);
  });

  it('decodes a trailing name when the 0x80 flag is set', () => {
    const b = Buffer.concat([Buffer.from([0x01 | 0x80]), Buffer.from('Repeater-1', 'utf8')]);
    expect(parseAdvertAppData(b)).toMatchObject({ type: 1, name: 'Repeater-1' });
  });

  it('decodes lat/lon followed by a name', () => {
    const b = Buffer.alloc(9);
    b[0] = 0x02 | 0x10 | 0x80;
    b.writeInt32LE(1_000000, 1);
    b.writeInt32LE(2_000000, 5);
    const full = Buffer.concat([b, Buffer.from('Bob', 'utf8')]);
    const parsed = parseAdvertAppData(full);
    expect(parsed?.latlon).toEqual({ lat: 1, lon: 2 });
    expect(parsed?.name).toBe('Bob');
  });

  it('returns null when a flagged field overruns the buffer', () => {
    expect(parseAdvertAppData(Buffer.from([0x10, 0x00]))).toBeNull(); // latlon needs 8 more
    expect(parseAdvertAppData(Buffer.alloc(0))).toBeNull();
  });
});

describe('parseAdvert + verifyAdvert', () => {
  const appData = Buffer.concat([Buffer.from([0x01 | 0x80]), Buffer.from('Alice', 'utf8')]);

  it('parses the payload fields and verifies a genuine signature', () => {
    const { payload, rawPub } = buildSignedAdvert(appData);
    const advert = parseAdvert(payload) as Advert;
    expect(advert.publicKeyHex).toBe(rawPub.toString('hex'));
    expect(advert.timestampUnix).toBe(1_700_000_000);
    expect(advert.appData).toMatchObject({ type: 1, name: 'Alice' });
    expect(verifyAdvert(advert)).toBe(true);
  });

  it('fails verification when the app_data is tampered', () => {
    const { payload } = buildSignedAdvert(appData);
    payload[payload.length - 1] ^= 0xff; // flip a name byte (covered by the signature)
    const advert = parseAdvert(payload) as Advert;
    expect(verifyAdvert(advert)).toBe(false);
  });

  it('fails verification when the signature is tampered', () => {
    const { payload } = buildSignedAdvert(appData);
    payload[36] ^= 0xff; // flip a signature byte
    const advert = parseAdvert(payload) as Advert;
    expect(verifyAdvert(advert)).toBe(false);
  });

  it('returns null below the fixed header + 1 app_data byte', () => {
    expect(parseAdvert(Buffer.alloc(100))).toBeNull();
  });
});

describe('parseContactBlob', () => {
  const appData = Buffer.concat([Buffer.from([0x02 | 0x80]), Buffer.from('Repeater', 'utf8')]);

  it('strips the flood Packet frame and parses + verifies the advert', () => {
    const { payload } = buildSignedAdvert(appData);
    // header = PAYLOAD_TYPE_ADVERT(0x04)<<2 | ROUTE_TYPE_FLOOD(0x01); path_len 0
    const blob = Buffer.concat([Buffer.from([0x11, 0x00]), payload]);
    const advert = parseContactBlob(blob) as Advert;
    expect(advert.appData).toMatchObject({ type: 2, name: 'Repeater' });
    expect(verifyAdvert(advert)).toBe(true);
  });

  it('returns null for a non-advert payload type', () => {
    const { payload } = buildSignedAdvert(appData);
    const blob = Buffer.concat([Buffer.from([0x09, 0x00]), payload]); // type 0x02 != ADVERT
    expect(parseContactBlob(blob)).toBeNull();
  });
});
