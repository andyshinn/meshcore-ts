import { describe, expect, it } from 'vitest';
import { decodeOnAirPacket } from '../src/onAirPackets';

describe('decodeOnAirPacket — request / response / anon', () => {
  it('decodes a REQ into dest/src hash + mac + cipher length', () => {
    // header 0x02 → DIRECT/REQ; path_len 0x00.
    const pkt = decodeOnAirPacket('0200d1deb01b2f8b72dd363aa4ef07e0bda2266a8979');
    expect(pkt.payloadTypeName).toBe('REQ');
    expect(pkt.payload).toEqual({
      kind: 'req',
      destHash: 'd1',
      srcHash: 'de',
      macHex: 'b01b',
      cipherLen: 16,
    });
  });

  it('decodes a RESPONSE into dest/src hash + mac + cipher length', () => {
    // header 0x06 → DIRECT/RESPONSE; path_len 0x00.
    const pkt = decodeOnAirPacket('0600de1fdfcad56e6c38b756fee81c24199c6043ac5b');
    expect(pkt.payloadTypeName).toBe('RESPONSE');
    expect(pkt.payload).toEqual({
      kind: 'response',
      destHash: 'de',
      srcHash: '1f',
      macHex: 'dfca',
      cipherLen: 16,
    });
  });

  it('decodes an ANON_REQ into dest hash + sender pubkey + mac + cipher length', () => {
    // header 0x1e → DIRECT/ANON_REQ; path_len 0x01 (path 5f).
    const pkt = decodeOnAirPacket(
      '1e015f5754af4e36fb37d58be06a87aa8f97c23d0a1f42ec66eced68875175540404a496141b071d2809885de13090a8f813b9151927',
    );
    expect(pkt.payloadTypeName).toBe('ANON_REQ');
    expect(pkt.payload).toEqual({
      kind: 'anonReq',
      destHash: '57',
      senderPubKeyHex: '54af4e36fb37d58be06a87aa8f97c23d0a1f42ec66eced68875175540404a496',
      macHex: '141b',
      cipherLen: 16,
    });
  });
});
