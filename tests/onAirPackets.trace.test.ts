import { describe, expect, it } from 'vitest';
import { decodeOnAirPacket } from '../src/protocol/onAirPackets';

describe('decodeOnAirPacket — trace', () => {
  it('decodes a single-hop trace (tag LE u32, flags 0 → 1-byte hashes)', () => {
    // header 0x26 → DIRECT/TRACE; path_len 0x01 (path 30 → snr 12); payload follows.
    const pkt = decodeOnAirPacket('260130a24d89bd0000000000fb');
    expect(pkt.payloadTypeName).toBe('TRACE');
    expect(pkt.payload).toEqual({
      kind: 'trace',
      tag: 3179892130, // 0xbd894da2, little-endian
      authCode: 0,
      flags: 0,
      hopCount: 1,
      pathHashesHex: 'fb',
      snr: [12],
    });
  });

  it('decodes a trace with flags 1 → 2-byte hashes', () => {
    // header 0x26 → DIRECT/TRACE; path_len 0x01 (path 30 → snr 12); payload follows.
    const pkt = decodeOnAirPacket('260130040302010a0b0c0d01aabbccdd');
    expect(pkt.payload).toEqual({
      kind: 'trace',
      tag: 16909060, // 0x01020304
      authCode: 218893066, // 0x0d0c0b0a
      flags: 1,
      hopCount: 2,
      pathHashesHex: 'aabbccdd',
      snr: [12],
    });
  });
});
