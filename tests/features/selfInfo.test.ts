import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { decodeSelfInfo, encodeAppStart } from '../../src/features/selfInfo';
import type { DeviceIdentity, RadioSettings } from '../../src/model/types';
import { deliver, makeSession } from '../support/harness';

// De-framed RESP_SELF_INFO captured from a connected Heltec/egrmesh "Hand" node
// (donor fixture connect-session.json → "selfInfo"). Full 71-byte frame:
//   [0]=0x05, [1]=advType=1, [2]=txPower=20dBm, [3]=maxTxPower=22
//   [4..35]=pubkey, [36..39]=lat≈30.211336°, [40..43]=lon≈−97.761527°
//   [44]=multiAcks=0, [45]=advertLocPolicy=1, [46]=telemetryByte=0x2a (env=2,loc=2,base=2)
//   [47]=manualAddContacts=0, [48..51]=freqKhz=910525, [52..55]=bwHz=62500
//   [56]=sf=7, [57]=cr=5, [58..]=name="egrme.sh Hand"
const SELF_INFO_HEX =
  '050114161a3d3c6a09f057457bcf0ae5403e5c60072919d193ed8caff58501b7590dd5d508fdcc0109472cfa00012a00bde40d0024f4000007056567726d652e73682048616e64';

// Builds a minimal synthetic ≥58-byte RESP_SELF_INFO frame from explicit field values.
function buildFrame({
  advType = 0,
  txPowerDbm = 0,
  maxTxPowerDbm = 0,
  pubKey = Buffer.alloc(32),
  latRaw = 0,
  lonRaw = 0,
  multiAcks = 0,
  advertLocPolicy = 0,
  telemetryByte = 0,
  manualAddContacts = 0,
  freqKhz = 0,
  bwHz = 0,
  sf = 0,
  cr = 0,
  name = '',
}: {
  advType?: number;
  txPowerDbm?: number;
  maxTxPowerDbm?: number;
  pubKey?: Buffer;
  latRaw?: number;
  lonRaw?: number;
  multiAcks?: number;
  advertLocPolicy?: number;
  telemetryByte?: number;
  manualAddContacts?: number;
  freqKhz?: number;
  bwHz?: number;
  sf?: number;
  cr?: number;
  name?: string;
} = {}): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  const frame = Buffer.alloc(58 + nameBuf.length);
  frame[0] = 0x05;
  frame[1] = advType;
  frame.writeInt8(txPowerDbm, 2);
  frame[3] = maxTxPowerDbm;
  pubKey.copy(frame, 4);
  frame.writeInt32LE(latRaw, 36);
  frame.writeInt32LE(lonRaw, 40);
  frame[44] = multiAcks;
  frame[45] = advertLocPolicy;
  frame[46] = telemetryByte;
  frame[47] = manualAddContacts;
  frame.writeUInt32LE(freqKhz, 48);
  frame.writeUInt32LE(bwHz, 52);
  frame[56] = sf;
  frame[57] = cr;
  nameBuf.copy(frame, 58);
  return frame;
}

describe('selfInfo encode/decode', () => {
  it('encodeAppStart matches the logged handshake frame', () => {
    // coresense.log: BLE_TX 24B cmd=0x01 hex=01010000000000006d657368636f72652d666c7574746572
    expect(encodeAppStart('meshcore-flutter', 1).toString('hex')).toBe('01010000000000006d657368636f72652d666c7574746572');
  });

  it('encodeAppStart lays out [cmd][version][6 reserved zero bytes][name]', () => {
    const out = encodeAppStart('mc', 1);
    expect(out[0]).toBe(0x01);
    expect(out[1]).toBe(0x01);
    expect([...out.subarray(2, 8)]).toEqual([0, 0, 0, 0, 0, 0]);
    expect(out.subarray(8).toString('utf8')).toBe('mc');
  });

  it('decodeSelfInfo extracts the 32-byte public key at offset 4 (fixture)', () => {
    const self = decodeSelfInfo(Buffer.from(SELF_INFO_HEX, 'hex'));
    expect(self).not.toBeNull();
    expect(self?.publicKeyHex).toBe('1a3d3c6a09f057457bcf0ae5403e5c60072919d193ed8caff58501b7590dd5d5');
  });

  it('decodeSelfInfo reads name at fixed offset 58, not trailing ASCII scan (fixture)', () => {
    const self = decodeSelfInfo(Buffer.from(SELF_INFO_HEX, 'hex'));
    expect(self?.name).toBe('egrme.sh Hand');
  });

  it('decodeSelfInfo returns null when the code byte is not 0x05', () => {
    const bad = Buffer.alloc(60);
    bad[0] = 0x06;
    expect(decodeSelfInfo(bad)).toBeNull();
  });

  it('decodeSelfInfo returns null when frame.length < 58', () => {
    // 57-byte frame — one byte short of the fixed header
    const short = Buffer.alloc(57);
    short[0] = 0x05;
    expect(decodeSelfInfo(short)).toBeNull();
  });

  it('decodeSelfInfo returns null on legacy 35-byte frame (old guard was 36)', () => {
    expect(decodeSelfInfo(Buffer.alloc(35))).toBeNull();
  });

  it('decodeSelfInfo accepts exactly 58-byte frame (empty name)', () => {
    const frame = buildFrame({ name: '' });
    expect(frame.length).toBe(58);
    const self = decodeSelfInfo(frame);
    expect(self).not.toBeNull();
    expect(self?.name).toBe('');
  });

  describe('all new fields — synthetic frame', () => {
    const pubKey = Buffer.from('aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899', 'hex');
    // lat = 37.774929° N, lon = -122.419418° W (San Francisco)
    const latRaw = Math.round(37.774929 * 1_000_000); // 37774929
    const lonRaw = Math.round(-122.419418 * 1_000_000); // -122419418
    // telemetryByte = (env=1 << 4) | (loc=2 << 2) | base=3 = 0x1b
    const telemetryByte = (1 << 4) | (2 << 2) | 3; // 0x1b = 27

    const frame = buildFrame({
      advType: 2,
      txPowerDbm: -5, // signed negative
      maxTxPowerDbm: 30,
      pubKey,
      latRaw,
      lonRaw,
      multiAcks: 3,
      advertLocPolicy: 1,
      telemetryByte,
      manualAddContacts: 1,
      freqKhz: 915000,
      bwHz: 250000,
      sf: 10,
      cr: 5,
      name: 'Café Node', // UTF-8 multi-byte character
    });

    it('advType', () => {
      expect(decodeSelfInfo(frame)?.advType).toBe(2);
    });

    it('txPowerDbm is signed (negative value)', () => {
      expect(decodeSelfInfo(frame)?.txPowerDbm).toBe(-5);
    });

    it('maxTxPowerDbm', () => {
      expect(decodeSelfInfo(frame)?.maxTxPowerDbm).toBe(30);
    });

    it('publicKeyHex', () => {
      expect(decodeSelfInfo(frame)?.publicKeyHex).toBe('aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899');
    });

    it('latDeg in decimal degrees', () => {
      expect(decodeSelfInfo(frame)?.latDeg).toBeCloseTo(37.774929, 6);
    });

    it('lonDeg in decimal degrees (negative)', () => {
      expect(decodeSelfInfo(frame)?.lonDeg).toBeCloseTo(-122.419418, 6);
    });

    it('multiAcks', () => {
      expect(decodeSelfInfo(frame)?.multiAcks).toBe(3);
    });

    it('advertLocPolicy', () => {
      expect(decodeSelfInfo(frame)?.advertLocPolicy).toBe(1);
    });

    it('telemetryModeEnv from bits [5:4]', () => {
      expect(decodeSelfInfo(frame)?.telemetryModeEnv).toBe(1);
    });

    it('telemetryModeLoc from bits [3:2]', () => {
      expect(decodeSelfInfo(frame)?.telemetryModeLoc).toBe(2);
    });

    it('telemetryModeBase from bits [1:0]', () => {
      expect(decodeSelfInfo(frame)?.telemetryModeBase).toBe(3);
    });

    it('manualAddContacts', () => {
      expect(decodeSelfInfo(frame)?.manualAddContacts).toBe(1);
    });

    it('freqKhz — wire value is already kHz (915000 = 915 MHz)', () => {
      expect(decodeSelfInfo(frame)?.freqKhz).toBe(915000);
    });

    it('bwHz — wire value is already Hz (250000 = 250 kHz)', () => {
      expect(decodeSelfInfo(frame)?.bwHz).toBe(250000);
    });

    it('sf (spreading factor)', () => {
      expect(decodeSelfInfo(frame)?.sf).toBe(10);
    });

    it('cr (coding rate)', () => {
      expect(decodeSelfInfo(frame)?.cr).toBe(5);
    });

    it('name read at fixed offset 58, supports UTF-8 multi-byte chars', () => {
      expect(decodeSelfInfo(frame)?.name).toBe('Café Node');
    });
  });

  describe('fixture field values', () => {
    const self = decodeSelfInfo(Buffer.from(SELF_INFO_HEX, 'hex'));

    it('advType', () => expect(self?.advType).toBe(1));
    it('txPowerDbm', () => expect(self?.txPowerDbm).toBe(20));
    it('maxTxPowerDbm', () => expect(self?.maxTxPowerDbm).toBe(22));
    it('latDeg ≈ 30.211336', () => expect(self?.latDeg).toBeCloseTo(30.211336, 6));
    it('lonDeg ≈ −97.761527', () => expect(self?.lonDeg).toBeCloseTo(-97.761527, 6));
    it('multiAcks', () => expect(self?.multiAcks).toBe(0));
    it('advertLocPolicy', () => expect(self?.advertLocPolicy).toBe(1));
    // telemetryByte=0x2a=42 => env=(42>>4)&3=2, loc=(42>>2)&3=2, base=42&3=2
    it('telemetryModeEnv', () => expect(self?.telemetryModeEnv).toBe(2));
    it('telemetryModeLoc', () => expect(self?.telemetryModeLoc).toBe(2));
    it('telemetryModeBase', () => expect(self?.telemetryModeBase).toBe(2));
    it('manualAddContacts', () => expect(self?.manualAddContacts).toBe(0));
    it('freqKhz', () => expect(self?.freqKhz).toBe(910525));
    it('bwHz', () => expect(self?.bwHz).toBe(62500));
    it('sf', () => expect(self?.sf).toBe(7));
    it('cr', () => expect(self?.cr).toBe(5));
  });
});

describe('applySelfInfo state fold (via session handler)', () => {
  const pubKey = Buffer.from('aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899', 'hex');
  const frame = buildFrame({
    pubKey,
    txPowerDbm: -5,
    latRaw: Math.round(37.774929 * 1_000_000),
    lonRaw: Math.round(-122.419418 * 1_000_000),
    advertLocPolicy: 1,
    freqKhz: 915000,
    bwHz: 250000,
    sf: 10,
    cr: 5,
    name: 'Café Node',
  });

  it('folds radio params into RadioSettings and emits radioSettings (freq kHz→Hz)', () => {
    const { session, transport } = makeSession();
    const settings: RadioSettings[] = [];
    session.events.on('radioSettings', (s) => settings.push(s));
    deliver(transport, frame);
    expect(settings.length).toBe(1);
    expect(settings[0]).toMatchObject({
      frequencyHz: 915_000_000, // 915000 kHz → Hz
      bandwidthHz: 250_000,
      spreadingFactor: 10,
      codingRate: 5,
      txPowerDbm: -5,
    });
    // SELF_INFO doesn't carry these — defaults must be preserved, not clobbered.
    expect(settings[0]?.repeatMode).toBe(false);
    expect(settings[0]?.pathHashMode).toBe(2);
    session.stop();
  });

  it('folds advertised identity into DeviceIdentity and emits deviceIdentity', () => {
    const { session, transport } = makeSession();
    const ids: DeviceIdentity[] = [];
    session.events.on('deviceIdentity', (d) => ids.push(d));
    deliver(transport, frame);
    expect(ids.length).toBe(1);
    expect(ids[0]?.name).toBe('Café Node');
    expect(ids[0]?.publicKeyHex).toBe(pubKey.toString('hex'));
    expect(ids[0]?.lat).toBeCloseTo(37.774929, 6);
    expect(ids[0]?.lon).toBeCloseTo(-122.419418, 6);
    expect(ids[0]?.sharePositionInAdvert).toBe(true); // advert_loc_policy = 1
    session.stop();
  });

  it('maps the 0/0 "no GPS" sentinel to null lat/lon', () => {
    const { session, transport } = makeSession();
    const ids: DeviceIdentity[] = [];
    session.events.on('deviceIdentity', (d) => ids.push(d));
    deliver(transport, buildFrame({ name: 'No GPS', latRaw: 0, lonRaw: 0 }));
    expect(ids.at(-1)?.lat).toBeNull();
    expect(ids.at(-1)?.lon).toBeNull();
    session.stop();
  });
});
