import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  buildAnonLogin,
  buildGetStats,
  buildLogout,
  buildSendAnonReq,
  buildSendBinaryReq,
  buildSendLogin,
  buildSendStatusReq,
  buildSendTelemetryReq,
  buildSendTracePath,
  parseStatusResponse,
  parseTelemetryResponse,
} from '../src/repeater';

const hex = (b: Buffer) => b.toString('hex');
const pk = 'aa'.repeat(32);

describe('repeater encoders: bare/simple', () => {
  it('buildGetStats appends the subtype', () => {
    expect(hex(buildGetStats(0x00))).toBe('3800');
  });
});

describe('repeater encoders: 32-byte-pubkey commands', () => {
  it('buildLogout is [0x1d][32B pubkey]', () => {
    expect(hex(buildLogout(pk))).toBe(`1d${pk}`);
  });

  it('buildSendStatusReq is [0x1b][32B pubkey]', () => {
    expect(hex(buildSendStatusReq(pk))).toBe(`1b${pk}`);
  });

  it('buildSendTelemetryReq is [0x27][3 reserved zero bytes][32B pubkey]', () => {
    expect(hex(buildSendTelemetryReq(pk))).toBe(`27000000${pk}`);
  });

  it('buildSendLogin is [0x1a][32B pubkey][ascii password]', () => {
    expect(hex(buildSendLogin(pk, 'pw'))).toBe(`1a${pk}7077`);
  });

  it('buildSendAnonReq is [0x39][32B pubkey][data]; rejects empty data', () => {
    expect(hex(buildSendAnonReq(pk, Buffer.from([0x01])))).toBe(`39${pk}01`);
    expect(() => buildSendAnonReq(pk, Buffer.alloc(0))).toThrow(/≥1 byte/);
  });

  it('buildAnonLogin wraps the password as anon-req data; rejects empty', () => {
    expect(hex(buildAnonLogin(pk, 'pw'))).toBe(`39${pk}7077`);
    expect(() => buildAnonLogin(pk, '')).toThrow(/empty/);
  });

  it('buildSendBinaryReq is [0x32][32B pubkey][reqData]; rejects empty', () => {
    expect(hex(buildSendBinaryReq(pk, Buffer.from([0x05])))).toBe(`32${pk}05`);
    expect(() => buildSendBinaryReq(pk, Buffer.alloc(0))).toThrow(/≥1 byte/);
  });

  it('rejects pubkeys shorter than 32 bytes', () => {
    expect(() => buildLogout('aabb')).toThrow(/32B/);
    expect(() => buildSendStatusReq('aabb')).toThrow(/32B/);
  });
});

describe('repeater encoders: structured', () => {
  it('buildSendTracePath lays out [0x24][tag u32 LE][auth u32 LE][flags u8][path]', () => {
    const out = buildSendTracePath({ tag: 1, authCode: 2, flags: 0, path: Buffer.from([0xaa]) });
    expect(hex(out)).toBe('24010000000200000000aa');
  });

  it('buildSendTracePath rejects an empty path', () => {
    expect(() => buildSendTracePath({ tag: 1, authCode: 2, path: Buffer.alloc(0) })).toThrow(/≥1 byte/);
  });
});

describe('repeater decoders: parseStatusResponse', () => {
  it('reads the sender prefix and decodes the leading status fields', () => {
    const payload = Buffer.alloc(8); // battery(4) + tx queue(4)
    payload.writeUInt32LE(4020, 0); // 4.02 V
    payload.writeUInt32LE(2, 4); // TX queue = 2
    const frame = Buffer.concat([Buffer.from([0x87, 0x00]), Buffer.from('aabbccddeeff', 'hex'), payload]);
    const res = parseStatusResponse(frame);
    expect(res?.senderPubKeyPrefixHex).toBe('aabbccddeeff');
    expect(res?.fields[0]).toEqual({ name: 'Battery', value: 4.02, unit: 'V' });
    expect(res?.fields[1]).toEqual({ name: 'TX queue', value: 2, unit: undefined });
  });

  it('returns null below 8 bytes', () => {
    expect(parseStatusResponse(Buffer.alloc(7))).toBeNull();
  });
});

describe('repeater decoders: parseTelemetryResponse (CayenneLPP)', () => {
  const telemetryFrame = (payload: Buffer): Buffer =>
    Buffer.concat([Buffer.from([0x8b, 0x00]), Buffer.from('aabbccddeeff', 'hex'), payload]);

  it('decodes a voltage field', () => {
    // channel 0, type 0x74 (Voltage, u16 BE /100), value 4.20 V → 420 = 0x01a4
    const res = parseTelemetryResponse(telemetryFrame(Buffer.from([0x00, 0x74, 0x01, 0xa4])));
    expect(res?.fields[0]).toMatchObject({ channel: 0, name: 'Voltage', value: 4.2, unit: 'V' });
  });

  it('decodes a negative current (type 117 is signed, per firmware LPPDataHelpers.h)', () => {
    // -0.5 A → -500 = 0xFE0C as int16 BE
    const res = parseTelemetryResponse(telemetryFrame(Buffer.from([0x00, 0x75, 0xfe, 0x0c])));
    expect(res?.fields[0]).toMatchObject({ name: 'Current', value: -0.5, unit: 'A' });
  });

  it('decodes a generic sensor (type 100, u32 BE)', () => {
    const payload = Buffer.from([0x01, 0x64, 0x00, 0x01, 0x86, 0xa0]); // 100000
    const res = parseTelemetryResponse(telemetryFrame(payload));
    expect(res?.fields[0]).toMatchObject({ channel: 1, name: 'Generic sensor', value: 100000 });
  });

  it('decodes a percentage and an altitude across two fields', () => {
    // ch2 type 0x78 (%) = 55; ch3 type 0x79 (altitude i16) = -12
    const payload = Buffer.from([0x02, 0x78, 0x37, 0x03, 0x79, 0xff, 0xf4]);
    const res = parseTelemetryResponse(telemetryFrame(payload));
    expect(res?.fields[0]).toMatchObject({ name: 'Percentage', value: 55, unit: '%' });
    expect(res?.fields[1]).toMatchObject({ name: 'Altitude', value: -12, unit: 'm' });
  });

  it('decodes a GPS field (type 136, int24 lat/lon/alt) as a string', () => {
    // lat 12.3456 → 123456, lon -7.8901 → -78901, alt 100.5 → 10050
    const payload = Buffer.alloc(2 + 9);
    payload[0] = 0x05; // channel
    payload[1] = 0x88; // GPS
    payload.writeIntBE(123456, 2, 3);
    payload.writeIntBE(-78901, 5, 3);
    payload.writeIntBE(10050, 8, 3);
    const res = parseTelemetryResponse(telemetryFrame(payload));
    expect(res?.fields[0]).toMatchObject({
      channel: 5,
      name: 'GPS',
      value: '12.3456,-7.8901,100.5',
    });
  });

  it('decodes a colour field (type 135, 3×u8) as r,g,b', () => {
    const payload = Buffer.from([0x06, 0x87, 0xff, 0x80, 0x00]);
    const res = parseTelemetryResponse(telemetryFrame(payload));
    expect(res?.fields[0]).toMatchObject({ name: 'Colour', value: '255,128,0' });
  });
});
