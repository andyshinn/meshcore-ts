import { Buffer } from 'node:buffer';
import { parseAdvert, parseMeshPacket } from '@andyshinn/meshcore-ts';

// A meshcore:// advert URL (from meshcore.js examples/parse_advert.js).
const advertUrl =
  'meshcore://1100e04b135959ffac9397b600add84822cb8bf4a050a7f40965dd1ab7aea3ddd3743327e668b5db95bc8fbc3894b115415d6e4cca36f9c9e62e923afd37c3e2a154b27b0c53b6cfddd45bb3faf56fdaf08860d985ca2da44f9dcac1d7d76fc2b86d7b26e004814c69616d20436f74746c6520f09fa4a0';
const advertHex = advertUrl.replace('meshcore://', '');
const bytes = Buffer.from(advertHex, 'hex');

const packet = parseMeshPacket(bytes);
if (!packet) {
  console.error('Failed to parse mesh packet from advert URL');
  process.exit(1);
}

const advert = parseAdvert(packet.payload);
if (!advert) {
  console.error('Failed to parse advert from packet payload');
  process.exit(1);
}
console.dir(advert, { depth: null });
