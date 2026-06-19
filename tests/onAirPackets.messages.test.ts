import { describe, expect, it } from 'vitest';
import { decodeOnAirPacket } from '../src/protocol/onAirPackets';

describe('decodeOnAirPacket — text + group messages', () => {
  it('decodes a TXT_MSG into dest/src hash + mac + cipher length', () => {
    // header 0x09 → FLOOD/TXT_MSG; path_len 0x04 (path 6f17c47e); payload follows.
    const pkt = decodeOnAirPacket('09046f17c47ed00a13e16ab5b94b1cc2d1a5059c6e5a6253c60d');
    expect(pkt.payloadTypeName).toBe('TXT_MSG');
    expect(pkt.payload).toEqual({
      kind: 'txtMsg',
      destHash: 'd0',
      srcHash: '0a',
      macHex: '13e1',
      cipherLen: 16,
    });
  });

  it('decodes a GRP_TXT into channel hash + mac + cipher length', () => {
    // header 0x15 → FLOOD/GRP_TXT; path_len 0x00; payload follows.
    const pkt = decodeOnAirPacket('150011c3c1354d619bae9590e4d177db7eeaf982f5bdcf78005d75157d9535fa90178f785d');
    expect(pkt.payloadTypeName).toBe('GRP_TXT');
    expect(pkt.payload).toEqual({
      kind: 'grpTxt',
      channelHash: '11',
      macHex: 'c3c1',
      cipherLen: 32,
    });
  });
});
