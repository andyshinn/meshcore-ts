import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  buildGetStats,
  buildLogout,
  buildSendAnonReq,
  buildSendBinaryReq,
  buildSendLogin,
  buildSendStatusReq,
  buildSendTelemetryReq,
  buildSendTracePath,
  decodeAclRole,
  parseAclList,
  parseAnonOwnerInfo,
  parseAvgMinMax,
  parseLoginSuccess,
  parseStatusResponse,
  parseTelemetryLpp,
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

  it('buildSendLogin with an empty (guest) password is [0x1a][32B pubkey] with no password bytes', () => {
    expect(hex(buildSendLogin(pk, ''))).toBe(`1a${pk}`);
  });

  it('buildSendAnonReq is [0x39][32B pubkey][data]; rejects empty data', () => {
    expect(hex(buildSendAnonReq(pk, Buffer.from([0x01])))).toBe(`39${pk}01`);
    expect(() => buildSendAnonReq(pk, Buffer.alloc(0))).toThrow(/≥1 byte/);
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
  // Ground truth: the firmware memcpy's `struct RepeaterStats` straight onto the
  // wire (MeshCore/examples/simple_repeater/MyMesh.h:44). Packed, naturally
  // aligned, no padding — 56 bytes on firmware ≥ v1.12.0:
  //   u16 batt_milli_volts, u16 curr_tx_queue_len, i16 noise_floor, i16 last_rssi,
  //   u32 n_packets_recv, u32 n_packets_sent, u32 total_air_time_secs,
  //   u32 total_up_time_secs, u32 n_sent_flood, u32 n_sent_direct,
  //   u32 n_recv_flood, u32 n_recv_direct, u16 err_events, i16 last_snr (×4),
  //   u16 n_direct_dups, u16 n_flood_dups, u32 total_rx_air_time_secs,
  //   u32 n_recv_errors.
  interface RepeaterStats {
    battMilliVolts: number;
    currTxQueueLen: number;
    noiseFloor: number;
    lastRssi: number;
    nPacketsRecv: number;
    nPacketsSent: number;
    totalAirTimeSecs: number;
    totalUpTimeSecs: number;
    nSentFlood: number;
    nSentDirect: number;
    nRecvFlood: number;
    nRecvDirect: number;
    errEvents: number;
    lastSnrX4: number;
    nDirectDups: number;
    nFloodDups: number;
    totalRxAirTimeSecs: number;
    nRecvErrors?: number; // omitted → 52-byte legacy frame (pre-v1.12.0)
  }

  /** Serialise the firmware struct exactly as the repeater memcpy's it. */
  function statsPayload(s: RepeaterStats): Buffer {
    const b = Buffer.alloc(s.nRecvErrors === undefined ? 52 : 56);
    b.writeUInt16LE(s.battMilliVolts, 0);
    b.writeUInt16LE(s.currTxQueueLen, 2);
    b.writeInt16LE(s.noiseFloor, 4);
    b.writeInt16LE(s.lastRssi, 6);
    b.writeUInt32LE(s.nPacketsRecv, 8);
    b.writeUInt32LE(s.nPacketsSent, 12);
    b.writeUInt32LE(s.totalAirTimeSecs, 16);
    b.writeUInt32LE(s.totalUpTimeSecs, 20);
    b.writeUInt32LE(s.nSentFlood, 24);
    b.writeUInt32LE(s.nSentDirect, 28);
    b.writeUInt32LE(s.nRecvFlood, 32);
    b.writeUInt32LE(s.nRecvDirect, 36);
    b.writeUInt16LE(s.errEvents, 40);
    b.writeInt16LE(s.lastSnrX4, 42);
    b.writeUInt16LE(s.nDirectDups, 44);
    b.writeUInt16LE(s.nFloodDups, 46);
    b.writeUInt32LE(s.totalRxAirTimeSecs, 48);
    if (s.nRecvErrors !== undefined) b.writeUInt32LE(s.nRecvErrors, 52);
    return b;
  }

  const statusFrame = (payload: Buffer): Buffer =>
    Buffer.concat([Buffer.from([0x87, 0x00]), Buffer.from('aabbccddeeff', 'hex'), payload]);

  // Every field distinct so a mis-aligned read can't coincidentally pass. The
  // tx queue is deliberately NON-ZERO: the old (wrong) u32 battery read only
  // looked correct because an idle repeater leaves the high half of that word
  // zero, so a busy queue immediately corrupts the battery reading.
  const busy: RepeaterStats = {
    battMilliVolts: 4020, // 4.02 V
    currTxQueueLen: 7,
    noiseFloor: -122,
    lastRssi: -85,
    nPacketsRecv: 1234,
    nPacketsSent: 567,
    totalAirTimeSecs: 890,
    totalUpTimeSecs: 93_784, // 1d 2h 3m (+4s)
    nSentFlood: 11,
    nSentDirect: 22,
    nRecvFlood: 33,
    nRecvDirect: 44,
    errEvents: 5,
    lastSnrX4: -26, // -6.5 dB
    nDirectDups: 300, // > 255: proves these are u16, not u8
    nFloodDups: 400,
    totalRxAirTimeSecs: 4321,
    nRecvErrors: 9,
  };

  const byName = (res: { fields: Array<{ name: string; value: number | string; unit?: string }> } | null) =>
    new Map((res?.fields ?? []).map((f) => [f.name, f]));

  it('reads the sender prefix', () => {
    expect(parseStatusResponse(statusFrame(statsPayload(busy)))?.senderPubKeyPrefixHex).toBe('aabbccddeeff');
  });

  it('decodes every field of a 56-byte frame against the firmware struct', () => {
    const f = byName(parseStatusResponse(statusFrame(statsPayload(busy))));
    expect(f.get('Battery')).toEqual({ name: 'Battery', value: 4.02, unit: 'V' });
    expect(f.get('TX queue')).toEqual({ name: 'TX queue', value: 7, unit: undefined });
    expect(f.get('Noise floor')).toEqual({ name: 'Noise floor', value: -122, unit: 'dBm' });
    expect(f.get('Last RSSI')).toEqual({ name: 'Last RSSI', value: -85, unit: 'dBm' });
    expect(f.get('RX packets')).toEqual({ name: 'RX packets', value: 1234, unit: undefined });
    expect(f.get('TX packets')).toEqual({ name: 'TX packets', value: 567, unit: undefined });
    expect(f.get('TX airtime')).toEqual({ name: 'TX airtime', value: 890, unit: 's' });
    expect(f.get('Uptime')).toEqual({ name: 'Uptime', value: '1d 2h 3m', unit: undefined });
    expect(f.get('Flood sent')).toEqual({ name: 'Flood sent', value: 11, unit: undefined });
    expect(f.get('Direct sent')).toEqual({ name: 'Direct sent', value: 22, unit: undefined });
    expect(f.get('Flood rx')).toEqual({ name: 'Flood rx', value: 33, unit: undefined });
    expect(f.get('Direct rx')).toEqual({ name: 'Direct rx', value: 44, unit: undefined });
    expect(f.get('Error events')).toEqual({ name: 'Error events', value: 5, unit: undefined });
    expect(f.get('Last SNR')).toEqual({ name: 'Last SNR', value: -6.5, unit: 'dB' });
    expect(f.get('Direct dups')).toEqual({ name: 'Direct dups', value: 300, unit: undefined });
    expect(f.get('Flood dups')).toEqual({ name: 'Flood dups', value: 400, unit: undefined });
    expect(f.get('RX airtime')).toEqual({ name: 'RX airtime', value: 4321, unit: 's' });
    expect(f.get('RX errors')).toEqual({ name: 'RX errors', value: 9, unit: undefined });
    expect(f.size).toBe(18);
  });

  it('keeps the battery correct when the TX queue is non-zero (the old u32 layout did not)', () => {
    const f = byName(parseStatusResponse(statusFrame(statsPayload({ ...busy, currTxQueueLen: 3 }))));
    expect(f.get('Battery')?.value).toBe(4.02);
    expect(f.get('TX queue')?.value).toBe(3);
    // The old layout read battery as a u32 at [0..3] → 3 << 16 | 4020 = 200_628 mV.
    expect(f.get('Battery')?.value).not.toBe(200.628);
  });

  it('still decodes an idle repeater (empty TX queue)', () => {
    const f = byName(parseStatusResponse(statusFrame(statsPayload({ ...busy, currTxQueueLen: 0 }))));
    expect(f.get('Battery')?.value).toBe(4.02);
    expect(f.get('TX queue')?.value).toBe(0);
  });

  it('decodes a legacy 52-byte frame (pre-v1.12.0, no n_recv_errors)', () => {
    const payload = statsPayload({ ...busy, nRecvErrors: undefined });
    expect(payload.length).toBe(52);
    const f = byName(parseStatusResponse(statusFrame(payload)));
    expect(f.get('Battery')?.value).toBe(4.02);
    expect(f.get('RX airtime')).toEqual({ name: 'RX airtime', value: 4321, unit: 's' });
    expect(f.has('RX errors')).toBe(false);
    expect(f.size).toBe(17);
  });

  it('degrades gracefully on a truncated payload instead of throwing', () => {
    const short = statsPayload(busy).subarray(0, 10); // batt/queue/noise/rssi + 2 stray bytes
    const res = parseStatusResponse(statusFrame(short));
    expect(res?.fields.map((f) => f.name)).toEqual(['Battery', 'TX queue', 'Noise floor', 'Last RSSI']);
  });

  it('returns null below 8 bytes', () => {
    expect(parseStatusResponse(Buffer.alloc(7))).toBeNull();
  });

  it('tolerates an empty status payload', () => {
    const res = parseStatusResponse(statusFrame(Buffer.alloc(0)));
    expect(res?.fields).toEqual([]);
    expect(res?.payloadHex).toBe('');
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

describe('parseAnonOwnerInfo (anon OWNER response: [now u32][name\\nowner])', () => {
  // Body layout after parseBinaryResponse strips the 4B tag:
  //   [now u32 LE][node_name "\n" owner_info][\0…]
  function ownerBody(now: number, name: string, owner: string): Buffer {
    const text = Buffer.from(`${name}\n${owner}\0`, 'utf8'); // firmware null-terminates
    const body = Buffer.alloc(4 + text.length);
    body.writeUInt32LE(now >>> 0, 0);
    text.copy(body, 4);
    return body;
  }

  it('strips the leading `now` clock and splits name\\nowner', () => {
    const res = parseAnonOwnerInfo(ownerBody(1_700_000_000, 'Node A', 'owner notes'));
    expect(res).toEqual({ firmwareVersion: '', nodeName: 'Node A', ownerInfo: 'owner notes' });
  });

  it('null-trims the owner field (and anything past the terminator)', () => {
    const body = Buffer.concat([Buffer.alloc(4), Buffer.from('Node B\nowner\0garbage', 'utf8')]);
    body.writeUInt32LE(42, 0);
    const res = parseAnonOwnerInfo(body);
    expect(res?.nodeName).toBe('Node B');
    expect(res?.ownerInfo).toBe('owner');
  });

  it('tolerates a missing owner line (no \\n)', () => {
    const res = parseAnonOwnerInfo(ownerBody(1, 'JustName', ''));
    expect(res).toEqual({ firmwareVersion: '', nodeName: 'JustName', ownerInfo: '' });
  });

  it('returns null when the body is too short for the `now` header', () => {
    expect(parseAnonOwnerInfo(Buffer.alloc(3))).toBeNull();
  });
});

describe('parseTelemetryLpp (binary-req telemetry: raw CayenneLPP, no header)', () => {
  it('decodes LPP fields directly from the tagged binary-response payload', () => {
    // ch0 voltage 4.20 V (type 0x74, u16 BE /100 → 420)
    const fields = parseTelemetryLpp(Buffer.from([0x00, 0x74, 0x01, 0xa4]));
    expect(fields[0]).toMatchObject({ channel: 0, name: 'Voltage', value: 4.2, unit: 'V' });
  });

  it('returns an empty array for an empty payload', () => {
    expect(parseTelemetryLpp(Buffer.alloc(0))).toEqual([]);
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

// ---- parseAclList: 2-bit role value + deleted-entry filtering ----------
describe('parseAclList', () => {
  // One 7-byte ACL entry: [6B pubkey prefix][1B permissions].
  const entry = (prefixHex: string, perms: number) => Buffer.concat([Buffer.from(prefixHex, 'hex'), Buffer.from([perms])]);

  it('decodes PERM_ACL_GUEST (0) — guest, not admin', () => {
    // Role bits 0b00 plus a reserved high bit: a permissions byte of exactly 0
    // means "deleted" and is filtered out, so guest needs another bit set.
    const res = parseAclList(entry('aabbccddeeff', 0x80));
    expect(res).toHaveLength(1);
    expect(res[0].role).toBe('guest');
    expect(res[0].isGuest).toBe(true);
    expect(res[0].isAdmin).toBe(false);
    expect(res[0].permissions).toBe(0x80);
    expect(res[0].pubKeyPrefixHex).toBe('aabbccddeeff');
  });

  it('decodes PERM_ACL_READ_ONLY (1) — neither admin nor guest', () => {
    const res = parseAclList(entry('010203040506', 0x01));
    expect(res).toHaveLength(1);
    expect(res[0].role).toBe('readOnly');
    expect(res[0].isAdmin).toBe(false); // regression: used to report admin
    expect(res[0].isGuest).toBe(false);
  });

  it('decodes PERM_ACL_READ_WRITE (2) — neither admin nor guest', () => {
    const res = parseAclList(entry('010203040506', 0x02));
    expect(res).toHaveLength(1);
    expect(res[0].role).toBe('readWrite');
    expect(res[0].isAdmin).toBe(false);
    expect(res[0].isGuest).toBe(false); // regression: used to report guest
  });

  it('decodes PERM_ACL_ADMIN (3) — admin only, never both', () => {
    const res = parseAclList(entry('010203040506', 0x03));
    expect(res).toHaveLength(1);
    expect(res[0].role).toBe('admin');
    expect(res[0].isAdmin).toBe(true);
    expect(res[0].isGuest).toBe(false); // regression: used to report both
  });

  it('ignores reserved bits above the 2-bit role mask', () => {
    const res = parseAclList(entry('010203040506', 0xf3)); // 0b1111_0011 → admin
    expect(res[0].role).toBe('admin');
    expect(res[0].isAdmin).toBe(true);
    expect(res[0].permissions).toBe(0xf3); // raw byte preserved
  });

  it('skips deleted entries (permissions == 0)', () => {
    const payload = Buffer.concat([
      entry('aaaaaaaaaaaa', 0x03),
      entry('bbbbbbbbbbbb', 0x00), // deleted — firmware skips these too
      entry('cccccccccccc', 0x01),
    ]);
    expect(parseAclList(payload).map((e) => e.pubKeyPrefixHex)).toEqual(['aaaaaaaaaaaa', 'cccccccccccc']);
  });

  it('skips all-zero pubkey prefixes (padding), matching meshcore_py parse_acl', () => {
    const payload = Buffer.concat([entry('000000000000', 0x03), entry('aaaaaaaaaaaa', 0x03)]);
    const res = parseAclList(payload);
    expect(res).toHaveLength(1);
    expect(res[0].pubKeyPrefixHex).toBe('aaaaaaaaaaaa');
  });

  it('returns an empty list for an all-zero (padding-only) payload', () => {
    expect(parseAclList(Buffer.alloc(21))).toEqual([]);
  });

  it('parses multiple entries and ignores a trailing partial entry', () => {
    const payload = Buffer.concat([
      entry('aaaaaaaaaaaa', 0x03),
      entry('bbbbbbbbbbbb', 0x02),
      Buffer.from([0xcc, 0xcc, 0xcc]), // 3 stray bytes — not a whole entry
    ]);
    const res = parseAclList(payload);
    expect(res).toHaveLength(2);
    expect(res[0].role).toBe('admin');
    expect(res[1].role).toBe('readWrite');
  });

  it('decodeAclRole maps all four role values', () => {
    expect(decodeAclRole(0)).toBe('guest');
    expect(decodeAclRole(1)).toBe('readOnly');
    expect(decodeAclRole(2)).toBe('readWrite');
    expect(decodeAclRole(3)).toBe('admin');
  });
});
