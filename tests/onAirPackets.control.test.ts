import { describe, expect, it } from 'vitest';
import { decodeOnAirPacket } from '../src/onAirPackets';

describe('decodeOnAirPacket — control', () => {
  it('decodes a NodeDiscoverResp (subType 0x90)', () => {
    // header 0x2e → DIRECT/CONTROL; path_len 0x00; payload starts 0x92.
    const pkt = decodeOnAirPacket('2e0092dc35333e5b4fbb374d26e77a3af0a0e3d34a7174131bbebf2341ee948b6f4b13cf800c928f');
    expect(pkt.payloadTypeName).toBe('CONTROL');
    expect(pkt.payload).toEqual({
      kind: 'controlDiscoverResp',
      nodeType: 2, // repeater (rawFlags 0x92 & 0x0f)
      snr: -9, // 0xdc as int8 = -36, /4
      tag: 1530802997, // 0x5b3e3335
      publicKeyHex: '4fbb374d26e77a3af0a0e3d34a7174131bbebf2341ee948b6f4b13cf800c928f',
    });
  });

  it('decodes a NodeDiscoverReq (subType 0x80) with an absent "since" field', () => {
    // header 0x2e → DIRECT/CONTROL; path_len 0x00; payload starts 0x80.
    const pkt = decodeOnAirPacket('2e0080040102030400000000');
    expect(pkt.payload).toEqual({
      kind: 'controlDiscoverReq',
      prefixOnly: false, // rawFlags 0x80 & 0x01
      typeFilter: 4, // repeater bit
      tag: 67305985, // 0x04030201
      since: 0,
    });
  });

  it('falls back to controlOther for an unrecognised sub-type', () => {
    // header 0x2e → CONTROL; payload 0x00 → subType 0x00 (neither 0x80 nor 0x90).
    const pkt = decodeOnAirPacket('2e0000');
    expect(pkt.payload).toEqual({ kind: 'controlOther', rawFlags: 0, payloadHex: '00' });
  });
});
