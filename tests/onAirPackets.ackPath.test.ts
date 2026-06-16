import { describe, expect, it } from 'vitest';
import { decodeOnAirPacket } from '../src/onAirPackets';

describe('decodeOnAirPacket — ack + path', () => {
  it('decodes an ACK checksum as raw wire-order hex (4 bytes)', () => {
    // header 0x0d → FLOOD/ACK; path_len 0x04 (path b891647e); payload bb40ba70.
    const pkt = decodeOnAirPacket('0d04b891647ebb40ba70');
    expect(pkt.payloadTypeName).toBe('ACK');
    expect(pkt.payload).toEqual({ kind: 'ack', checksumHex: 'bb40ba70' });
  });

  it('decodes a PATH payload into its own path hashes + extra type/data', () => {
    // header 0x21 → FLOOD/PATH; path_len 0x05 (path f464c77e41); payload follows.
    const pkt = decodeOnAirPacket('2105f464c77e411279399efe1942b8a3ffa10f54d9c602ff2c8cf4');
    expect(pkt.payloadTypeName).toBe('PATH');
    expect(pkt.payload).toEqual({
      kind: 'path',
      pathLen: 18,
      hashSize: 1,
      pathHashesHex: '79399efe1942b8a3ffa10f54d9c602ff2c8c',
      extraType: 244,
      extraHex: '',
    });
  });
});
