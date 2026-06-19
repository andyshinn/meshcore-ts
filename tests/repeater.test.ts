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
  parseAvgMinMax,
  parseLoginSuccess,
  parseStatusResponse,
  parseTelemetryResponse,
  parseTraceData,
} from '../src/protocol/repeater';

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

  it('rejects overlong pubkeys instead of silently truncating to 32 bytes', () => {
    const overlong = `${pk}ff`; // 33 bytes
    expect(() => buildLogout(overlong)).toThrow(/32B/);
    expect(() => buildSendStatusReq(overlong)).toThrow(/32B/);
    expect(() => buildSendTelemetryReq(overlong)).toThrow(/32B/);
  });

  it('rejects malformed hex (trailing garbage) instead of aliasing to the truncated key', () => {
    const trailingGarbage = `${pk}zz`; // Buffer.from yields 32B and would alias to `pk`
    expect(() => buildSendLogin(trailingGarbage, 'pw')).toThrow(/32B/);
    expect(() => buildSendBinaryReq(trailingGarbage, Buffer.from([0x01]))).toThrow(/32B/);
    expect(() => buildSendAnonReq(trailingGarbage, Buffer.from([0x01]))).toThrow(/32B/);
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

describe('parseAvgMinMax', () => {
  it('parses now + a signed Temperature series (size 2, /10)', () => {
    const body = Buffer.alloc(4 + 2 + 6);
    body.writeUInt32LE(1000, 0); // now
    body[4] = 1; // channel
    body[5] = 0x67; // LPP_TEMPERATURE
    body.writeInt16BE(200, 6); // min 20.0
    body.writeInt16BE(255, 8); // max 25.5
    body.writeInt16BE(225, 10); // avg 22.5
    const res = parseAvgMinMax(body);
    expect(res).not.toBeNull();
    expect(res?.nowUnix).toBe(1000);
    expect(res?.series).toEqual([
      { channel: 1, lppType: 0x67, typeHex: '0x67', name: 'Temperature', unit: '°C', min: 20, max: 25.5, avg: 22.5 },
    ]);
  });

  it('treats Current (0x75) as UNSIGNED per the firmware series table', () => {
    const body = Buffer.alloc(4 + 2 + 6);
    body.writeUInt32LE(0, 0);
    body[4] = 2;
    body[5] = 0x75; // LPP_CURRENT, size 2, /1000, UNSIGNED here
    body.writeUInt16BE(0xffff, 6); // min
    body.writeUInt16BE(0xffff, 8); // max
    body.writeUInt16BE(0xffff, 10); // avg
    const res = parseAvgMinMax(body);
    expect(res).not.toBeNull();
    // 65535 / 1000 = 65.535 (NOT negative)
    expect(res?.series[0]).toMatchObject({ lppType: 0x75, name: 'Current', unit: 'A', min: 65.535 });
  });

  it('returns null on a body too short for "now"', () => {
    expect(parseAvgMinMax(Buffer.from([0x00, 0x01]))).toBeNull();
  });

  it('stops cleanly on a truncated final entry', () => {
    const body = Buffer.alloc(4 + 2 + 2); // declares a temp entry but only 2 of 6 value bytes
    body.writeUInt32LE(5, 0);
    body[4] = 1;
    body[5] = 0x67;
    const res = parseAvgMinMax(body);
    expect(res).not.toBeNull();
    expect(res?.nowUnix).toBe(5);
    expect(res?.series).toEqual([]);
  });

  it('falls back to size 1 + name "Unknown" for an unrecognised lpp type', () => {
    const body = Buffer.alloc(4 + 2 + 3); // now + [channel][type] + 3×(size-1)
    body.writeUInt32LE(99, 0);
    body[4] = 0; // channel
    body[5] = 0xff; // unknown type
    body[6] = 10;
    body[7] = 20;
    body[8] = 15; // min/max/avg raw (size 1, mult 1)
    const res = parseAvgMinMax(body);
    expect(res?.series[0]).toMatchObject({ name: 'Unknown', min: 10, max: 20, avg: 15 });
  });

  it('parses two consecutive entries (Temperature then Humidity)', () => {
    // Temperature (0x67): size 2, /10, signed
    // Humidity (0x68): size 2, /10, unsigned  ← per avgMinMaxSize/avgMinMaxMultiplier tables
    const body = Buffer.alloc(4 + (2 + 2 * 3) + (2 + 2 * 3)); // now + entryA(8) + entryB(8)
    body.writeUInt32LE(500, 0);
    // Entry A: Temperature, channel 1
    body[4] = 1;
    body[5] = 0x67; // Temperature
    body.writeInt16BE(200, 6); // min = 20.0°C
    body.writeInt16BE(300, 8); // max = 30.0°C
    body.writeInt16BE(250, 10); // avg = 25.0°C
    // Entry B: Humidity, channel 2
    body[12] = 2;
    body[13] = 0x68; // Humidity
    body.writeUInt16BE(400, 14); // min = 40.0%
    body.writeUInt16BE(600, 16); // max = 60.0%
    body.writeUInt16BE(500, 18); // avg = 50.0%
    const res = parseAvgMinMax(body);
    expect(res).not.toBeNull();
    expect(res?.nowUnix).toBe(500);
    expect(res?.series[0]).toMatchObject({ channel: 1, name: 'Temperature', unit: '°C', min: 20, max: 30, avg: 25 });
    expect(res?.series[1]).toMatchObject({ channel: 2, name: 'Humidity', unit: '%', min: 40, max: 60, avg: 50 });
  });
});

// ---- FIX A: parseTraceData (PUSH 0x89) --------------------------------
// Wire layout (no pubkey-prefix field):
//   [0]    0x89
//   [1]    reserved
//   [2]    path_len (u8)
//   [3]    flags (u8) — bits 0..1 = log2(bytesPerHash)
//   [4..7] tag (u32 LE)
//   [8..11] auth_code (u32 LE)
//   [12..12+path_len-1]       path_hashes
//   [12+path_len..+hopCount-1] per-hop SNRs (i8, × 4)
//   [12+path_len+hopCount]    final SNR (i8, × 4)

describe('parseTraceData (FIX A — correct wire layout)', () => {
  // Helper: build a well-formed TRACE_DATA frame from first principles.
  function buildTraceFrame(opts: {
    tag: number;
    authCode: number;
    flags: number;
    hashes: Buffer[]; // one Buffer per hop; all must be pathHashSize bytes
    snrs: number[]; // per-hop SNR in dB (will be multiplied by 4 and stored as i8)
    finalSnr: number; // final SNR in dB
  }): Buffer {
    const bytesPerHash = 1 << (opts.flags & 0x03);
    const hopCount = opts.hashes.length;
    const pathLen = hopCount * bytesPerHash;
    // header(12) + hashes(pathLen) + per-hop SNRs(hopCount) + final SNR(1)
    const frame = Buffer.alloc(12 + pathLen + hopCount + 1);
    frame[0] = 0x89;
    frame[1] = 0x00; // reserved
    frame[2] = pathLen;
    frame[3] = opts.flags;
    frame.writeUInt32LE(opts.tag >>> 0, 4);
    frame.writeUInt32LE(opts.authCode >>> 0, 8);
    let off = 12;
    for (const h of opts.hashes) {
      h.copy(frame, off);
      off += bytesPerHash;
    }
    for (let i = 0; i < hopCount; i += 1) {
      frame.writeInt8(Math.round(opts.snrs[i] * 4), off + i);
    }
    frame.writeInt8(Math.round(opts.finalSnr * 4), off + hopCount);
    return frame;
  }

  it('parses a 2-hop trace with 1-byte hashes (flags=0x00)', () => {
    const tag = 0xdeadbeef;
    const authCode = 0xcafe1234;
    const frame = buildTraceFrame({
      tag,
      authCode,
      flags: 0x00, // bytesPerHash = 1
      hashes: [Buffer.from([0xaa]), Buffer.from([0xbb])],
      snrs: [5.5, -2.25],
      finalSnr: 7.0,
    });

    const res = parseTraceData(frame);
    expect(res).not.toBeNull();

    // tagHex must equal the LE encoding used by resolveTag
    const expectedTagHex = Buffer.alloc(4);
    expectedTagHex.writeUInt32LE(tag >>> 0, 0);
    expect(res?.tagHex).toBe(expectedTagHex.toString('hex'));

    const expectedAuthHex = Buffer.alloc(4);
    expectedAuthHex.writeUInt32LE(authCode >>> 0, 0);
    expect(res?.authHex).toBe(expectedAuthHex.toString('hex'));

    expect(res?.flags).toBe(0x00);
    expect(res?.pathHashSize).toBe(1);
    expect(res?.hops).toHaveLength(2);
    expect(res?.hops[0]).toEqual({ hashHex: 'aa', snrDb: 5.5 });
    expect(res?.hops[1]).toEqual({ hashHex: 'bb', snrDb: -2.25 });
    expect(res?.finalSnrDb).toBe(7.0);

    // Confirm NO pubKeyPrefixHex field exists on the parsed result
    expect(res).not.toHaveProperty('pubKeyPrefixHex');
  });

  it('parses a 3-hop trace with 2-byte hashes (flags=0x01)', () => {
    const frame = buildTraceFrame({
      tag: 0x00000042,
      authCode: 0x00000001,
      flags: 0x01, // bytesPerHash = 2
      hashes: [Buffer.from([0x11, 0x22]), Buffer.from([0x33, 0x44]), Buffer.from([0x55, 0x66])],
      snrs: [10.0, 6.25, -1.0],
      finalSnr: 4.5,
    });
    const res = parseTraceData(frame);
    expect(res).not.toBeNull();
    expect(res?.pathHashSize).toBe(2);
    expect(res?.hops).toHaveLength(3);
    expect(res?.hops[0]).toEqual({ hashHex: '1122', snrDb: 10 });
    expect(res?.hops[1]).toEqual({ hashHex: '3344', snrDb: 6.25 });
    expect(res?.hops[2]).toEqual({ hashHex: '5566', snrDb: -1.0 });
    expect(res?.finalSnrDb).toBe(4.5);
  });

  it('parses a 0-hop trace (path_len=0) — just the final SNR remains', () => {
    // flags=0x00 → bytesPerHash=1; path_len=0 → hopCount=0
    const frame = buildTraceFrame({
      tag: 0x00000001,
      authCode: 0x00000002,
      flags: 0x00,
      hashes: [],
      snrs: [],
      finalSnr: -3.25,
    });
    const res = parseTraceData(frame);
    expect(res).not.toBeNull();
    expect(res?.hops).toHaveLength(0);
    expect(res?.finalSnrDb).toBe(-3.25);
  });

  it('returns null when frame is too short for the header', () => {
    expect(parseTraceData(Buffer.alloc(12))).toBeNull();
  });

  it('returns null when frame is truncated (missing SNR bytes)', () => {
    // Build a valid 2-hop frame then chop the last byte off
    const frame = buildTraceFrame({
      tag: 1,
      authCode: 2,
      flags: 0x00,
      hashes: [Buffer.from([0xaa]), Buffer.from([0xbb])],
      snrs: [1.0, 2.0],
      finalSnr: 3.0,
    });
    expect(parseTraceData(frame.subarray(0, frame.length - 1))).toBeNull();
  });

  it('tagHex matches the key that repeaterTracePath registers with resolveTag', () => {
    // repeaterTracePath does: Buffer.alloc(4).writeUInt32LE(tag>>>0, 0).toString('hex')
    // parseTraceData does:   frame.subarray(4,8).toString('hex')
    // Both must produce the same string for the awaiter to fire.
    const tag = 0x12345678;
    const frame = buildTraceFrame({ tag, authCode: 0, flags: 0x00, hashes: [], snrs: [], finalSnr: 0 });
    const res = parseTraceData(frame);
    const tagBuf = Buffer.alloc(4);
    tagBuf.writeUInt32LE(tag >>> 0, 0);
    expect(res?.tagHex).toBe(tagBuf.toString('hex'));
  });
});

// ---- FIX B: parseLoginSuccess (PUSH 0x85) 14-byte new form ------------
describe('parseLoginSuccess (FIX B — 14-byte new form)', () => {
  function buildLoginSuccessFrame(opts: {
    permissions: number;
    pubKeyPrefix: string; // 12 hex chars = 6 bytes
    tag: number;
    aclPermissions: number;
    firmwareVerLevel: number;
  }): Buffer {
    // New form: [0x85][perms][6B prefix][tag u32 LE][acl][fw_ver] = 14 bytes
    const frame = Buffer.alloc(14);
    frame[0] = 0x85;
    frame[1] = opts.permissions;
    Buffer.from(opts.pubKeyPrefix, 'hex').copy(frame, 2);
    frame.writeUInt32LE(opts.tag >>> 0, 8);
    frame[12] = opts.aclPermissions;
    frame[13] = opts.firmwareVerLevel;
    return frame;
  }

  it('parses the 14-byte new form and populates tag/acl/firmwareVerLevel', () => {
    const frame = buildLoginSuccessFrame({
      permissions: 0x00,
      pubKeyPrefix: 'aabbccddeeff',
      tag: 0xdeadbeef,
      aclPermissions: 0x03, // PERM_ACL_ADMIN
      firmwareVerLevel: 6,
    });
    const res = parseLoginSuccess(frame);
    expect(res).not.toBeNull();
    expect(res?.pubKeyPrefixHex).toBe('aabbccddeeff');
    expect(res?.serverTagHex).toBe(Buffer.from([0xef, 0xbe, 0xad, 0xde]).toString('hex')); // LE stored
    expect(res?.aclPermissions).toBe(0x03);
    expect(res?.firmwareVerLevel).toBe(6);
  });

  it('correctly identifies admin when aclPermissions=0x03 (PERM_ACL_ADMIN)', () => {
    const frame = buildLoginSuccessFrame({
      permissions: 0x00,
      pubKeyPrefix: 'aabbccddeeff',
      tag: 1,
      aclPermissions: 0x03, // admin = both bits set
      firmwareVerLevel: 6,
    });
    const res = parseLoginSuccess(frame);
    expect(res?.isAdmin).toBe(true);
  });

  it('does NOT treat read-only (aclPermissions=0x01) as admin', () => {
    const frame = buildLoginSuccessFrame({
      permissions: 0x00,
      pubKeyPrefix: 'aabbccddeeff',
      tag: 1,
      aclPermissions: 0x01, // PERM_ACL_READ_ONLY — must NOT be admin
      firmwareVerLevel: 6,
    });
    const res = parseLoginSuccess(frame);
    expect(res?.isAdmin).toBe(false);
  });

  it('treats permissions byte != 0 as admin in new form (legacy admin path)', () => {
    const frame = buildLoginSuccessFrame({
      permissions: 0x01, // permissions byte set
      pubKeyPrefix: 'aabbccddeeff',
      tag: 1,
      aclPermissions: 0x00, // no ACL admin
      firmwareVerLevel: 6,
    });
    const res = parseLoginSuccess(frame);
    expect(res?.isAdmin).toBe(true);
  });

  it('parses the 8-byte legacy form (no tag/acl/firmwareVerLevel)', () => {
    // Legacy: [0x85][0 is_admin=0][6B prefix]
    const frame = Buffer.concat([Buffer.from([0x85, 0x00]), Buffer.from('aabbccddeeff', 'hex')]);
    expect(frame.length).toBe(8);
    const res = parseLoginSuccess(frame);
    expect(res).not.toBeNull();
    expect(res?.pubKeyPrefixHex).toBe('aabbccddeeff');
    expect(res?.serverTagHex).toBeNull();
    expect(res?.aclPermissions).toBeNull();
    expect(res?.firmwareVerLevel).toBeNull();
    expect(res?.isAdmin).toBe(false);
  });

  it('legacy form with non-zero permissions byte is admin', () => {
    const frame = Buffer.concat([Buffer.from([0x85, 0x01]), Buffer.from('aabbccddeeff', 'hex')]);
    const res = parseLoginSuccess(frame);
    expect(res?.isAdmin).toBe(true);
  });

  it('returns null for frames shorter than 8 bytes', () => {
    expect(parseLoginSuccess(Buffer.alloc(7))).toBeNull();
  });
});
