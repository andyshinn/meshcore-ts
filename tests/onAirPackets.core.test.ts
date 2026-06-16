import { describe, expect, it } from 'vitest';
import { decodeOnAirPacket } from '../src/onAirPackets';

describe('decodeOnAirPacket — core', () => {
  it('returns a null header + raw fallback for bytes that are not a mesh packet', () => {
    // Single byte: parseMeshPacket requires >= 2 bytes.
    const pkt = decodeOnAirPacket('26');
    expect(pkt.header).toBeNull();
    expect(pkt.payloadTypeName).toBe('UNKNOWN');
    expect(pkt.payload).toEqual({ kind: 'raw', payloadType: null, payloadHex: '26' });
  });

  it('decodes the header but raw-falls-back for an unhandled payload type (GRP_DATA)', () => {
    // header 0x19 → route FLOOD(1), payloadType GRP_DATA(6); path_len 0x00; payload aabb
    const pkt = decodeOnAirPacket('1900aabb');
    expect(pkt.header).not.toBeNull();
    expect(pkt.header?.payloadType).toBe(0x06);
    expect(pkt.payloadTypeName).toBe('GRP_DATA');
    expect(pkt.payload).toEqual({ kind: 'raw', payloadType: 0x06, payloadHex: 'aabb' });
  });

  it('accepts raw bytes as well as a hex string', () => {
    const pkt = decodeOnAirPacket(Uint8Array.from([0x19, 0x00, 0xaa, 0xbb]));
    expect(pkt.payloadTypeName).toBe('GRP_DATA');
    expect(pkt.payload).toEqual({ kind: 'raw', payloadType: 0x06, payloadHex: 'aabb' });
  });
});
