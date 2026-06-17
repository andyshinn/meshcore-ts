---
title: Decoding on-air packets
description: Receive raw LoRa mesh packets via the rawPacket event and structurally decode them with decodeOnAirPacket.
---

Beyond the parsed companion-protocol events, the session can hand you the **raw
on-air bytes** it receives over the air, and a standalone decoder turns those
bytes into a structured, inspectable shape — the basis for a packet inspector.

## The `rawPacket` event

When the radio reports a received LoRa packet (`PUSH_RAW_DATA` /
`PUSH_LOG_RX_DATA`), the session emits `rawPacket`:

```ts
session.events.on('rawPacket', (pkt) => {
  // pkt: { hex: string; source: 'raw' | 'log_rx'; snr: number; rssi: number }
  console.log(pkt.source, pkt.snr, pkt.rssi, pkt.hex);
});
```

- `hex` — the inner on-air mesh-packet bytes (the companion framing and the
  SNR/RSSI prefix are already stripped).
- `source` — `'log_rx'` for `PUSH_LOG_RX_DATA` (0x88) or `'raw'` for
  `PUSH_RAW_DATA` (0x84).
- `snr` / `rssi` — link metrics for that reception.

## `decodeOnAirPacket(hex)`

`decodeOnAirPacket` structurally decodes those bytes into a tagged union. It
performs **no decryption** (cipher bodies are reported only as a length) and
**never throws** — unparseable or unsupported input yields the `raw` fallback
variant.

```ts
import { decodeOnAirPacket } from '@andyshinn/meshcore-ts';

session.events.on('rawPacket', (pkt) => {
  const packet = decodeOnAirPacket(pkt.hex); // also accepts a Uint8Array
  console.log(packet.payloadTypeName); // e.g. 'GRP_TXT'

  switch (packet.payload.kind) {
    case 'advert':
      console.log(packet.payload.advert.appData.name);
      break;
    case 'grpTxt':
      console.log(packet.payload.channelHash, packet.payload.cipherLen);
      break;
    case 'trace':
      console.log(packet.payload.tag, packet.payload.hopCount, packet.payload.snr);
      break;
    // …txtMsg, req, response, anonReq, ack, path, control*, raw
  }
});
```

`decodeOnAirPacket` returns `{ header, payloadTypeName, payload }`:

- `header` — the mesh-packet header (route type, payload type/version, path), or
  `null` if the bytes don't parse as a mesh packet.
- `payloadTypeName` — the on-air payload type name for display (e.g. `TXT_MSG`,
  `TRACE`).
- `payload` — a discriminated union on `payload.kind`, covering `advert`,
  `txtMsg`, `grpTxt`, `req`, `response`, `anonReq`, `ack`, `path`, `trace`,
  `controlDiscoverReq`, `controlDiscoverResp`, `controlOther`, and a `raw`
  fallback.

See `OnAirPacket` and `OnAirPayload` in the [API reference](../../api/readme/)
for every field of every variant.

## A note on the two sources

Only `log_rx` (0x88) packets follow the on-air wire format byte-for-byte. `raw`
(0x84) packets carry a firmware reserved-byte sentinel where the path length
would be, so `decodeOnAirPacket` will usually return the `raw` fallback for them
— the `source` field lets you caveat the display accordingly.

## No hardware needed

`decodeOnAirPacket` is a pure function: you can decode a pasted or captured hex
string with no live session at all. See `examples/decode-on-air-packet.ts` for a
runnable, hardware-free demonstration across several payload types.
