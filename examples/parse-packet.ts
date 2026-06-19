import { Buffer } from 'node:buffer';
import { Protocol } from '@andyshinn/meshcore-ts';

// Raw mesh-packet bytes (from meshcore.js examples/parse_packet.js).
const bytes = Buffer.from('0200B401DF6528CC9778A56F36FE9399A5CF6B0C7EDE', 'hex');

const header = Protocol.parseMeshPacket(bytes);
if (!header) {
  console.error('Failed to parse mesh packet');
  process.exit(1);
}
console.dir(header, { depth: null });
