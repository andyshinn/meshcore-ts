import { Protocol } from '@andyshinn/meshcore-ts';

// Protocol.decodeOnAirPacket() structurally decodes a MeshCore on-air mesh packet — the
// bytes carried inside PUSH_RAW_DATA (0x84) / PUSH_LOG_RX_DATA (0x88) frames —
// into a tagged union keyed on `payload.kind`. It performs no decryption (cipher
// bodies are reported only as a length) and never throws: unparseable or
// unsupported input yields the `raw` fallback variant. This is exactly what a
// packet inspector formats for display.
//
// In a live session you'd feed it the hex from the rawPacket event:
//
//   session.events.on('rawPacket', (pkt) => {
//     console.dir(Protocol.decodeOnAirPacket(pkt.hex), { depth: null });
//   });
//
// Here we decode a few captured packets so it runs with no hardware.

const samples: Array<{ label: string; hex: string }> = [
  {
    label: 'ADVERT — name, role, location',
    hex: '11007e7662676f7f0850a8a355baafbfc1eb7b4174c340442d7d7161c9474a2c94006ce7cf682e58408dd8fcc51906eca98ebf94a037886bdade7ecd09fd92b839491df3809c9454f5286d1d3370ac31a34593d569e9a042a3b41fd331dffb7e18599ce1e60992a076d50238c5b8f85757375354522f50756765744d65736820436f75676172',
  },
  {
    label: 'GRP_TXT — channel hash + ciphertext length',
    hex: '150011c3c1354d619bae9590e4d177db7eeaf982f5bdcf78005d75157d9535fa90178f785d',
  },
  {
    label: 'TXT_MSG — src/dst hash + ciphertext length',
    hex: '09046f17c47ed00a13e16ab5b94b1cc2d1a5059c6e5a6253c60d',
  },
  {
    label: 'TRACE — tag, hop count, per-hop SNR',
    hex: '260130a24d89bd0000000000fb',
  },
];

for (const { label, hex } of samples) {
  const pkt = Protocol.decodeOnAirPacket(hex);
  console.log(`\n# ${label}  (payloadType=${pkt.payloadTypeName})`);
  console.dir(pkt.payload, { depth: null });
}
