import { describe, expect, it } from 'vitest';
import { decodeOnAirPacket } from '../src/onAirPackets';

// Full advert packet (header 0x11 → FLOOD/ADVERT, empty path) from
// meshcore-decoder's packet-structure fixtures.
const ADVERT_HEX =
  '11007e7662676f7f0850a8a355baafbfc1eb7b4174c340442d7d7161c9474a2c94006ce7cf682e58408dd8fcc51906eca98ebf94a037886bdade7ecd09fd92b839491df3809c9454f5286d1d3370ac31a34593d569e9a042a3b41fd331dffb7e18599ce1e60992a076d50238c5b8f85757375354522f50756765744d65736820436f75676172';

describe('decodeOnAirPacket — advert', () => {
  it('wraps parseAdvert as the advert variant', () => {
    const pkt = decodeOnAirPacket(ADVERT_HEX);
    expect(pkt.payloadTypeName).toBe('ADVERT');
    if (pkt.payload.kind !== 'advert') throw new Error('expected advert');
    const a = pkt.payload.advert;
    expect(a.publicKeyHex).toBe('7e7662676f7f0850a8a355baafbfc1eb7b4174c340442d7d7161c9474a2c9400');
    expect(a.timestampUnix).toBe(1758455660);
    expect(a.appData.type).toBe(2); // repeater
    expect(a.appData.name).toBe('WW7STR/PugetMesh Cougar');
    expect(a.appData.latlon?.lat).toBeCloseTo(47.543968, 5);
    expect(a.appData.latlon?.lon).toBeCloseTo(-122.108616, 5);
  });
});
