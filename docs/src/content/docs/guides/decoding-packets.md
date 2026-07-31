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
variant. To read the body of a channel packet you hold the key for, see
[Decrypting a channel payload](#decrypting-a-channel-payload) below.

```ts
import { Protocol } from '@andyshinn/meshcore-ts';

session.events.on('rawPacket', (pkt) => {
  const packet = Protocol.decodeOnAirPacket(pkt.hex); // also accepts a Uint8Array
  console.log(packet.payloadTypeName); // e.g. 'GRP_TXT'

  switch (packet.payload.kind) {
    case Protocol.PayloadKind.ADVERT:
      console.log(packet.payload.advert.appData.name);
      break;
    case Protocol.PayloadKind.GRP_TXT:
      console.log(packet.payload.channelHash, packet.payload.cipherLen);
      break;
    case Protocol.PayloadKind.TRACE:
      console.log(packet.payload.tag, packet.payload.hopCount, packet.payload.snr);
      break;
    // …txtMsg, req, response, anonReq, ack, path, control*, raw
  }
});
```

> `Protocol.PayloadKind` is optional sugar — the raw discriminant strings
> (`case 'grpTxt':`) work equally well in the switch.

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

## Decrypting a channel payload

`decodeOnAirPacket` deliberately stops at the cipher boundary, so a `grpTxt`
payload gives you `channelHash`, `macHex`, and `cipherLen` — not the body. When
you hold the channel's secret you can go the rest of the way with
`Protocol.decryptGrpTxt`, which verifies the packet's 2-byte MAC and decrypts
the body:

```ts
import { Buffer } from 'node:buffer';
import { Protocol } from '@andyshinn/meshcore-ts';

const mesh = Protocol.parseMeshPacket(Buffer.from(pkt.hex, 'hex'));
if (mesh?.payloadType === Protocol.PAYLOAD_TYPE.GRP_TXT) {
  // GRP_TXT payload is [channel_hash 1B][MAC 2B][ciphertext] — skip the hash
  // byte and hand over the rest.
  const plain = Protocol.decryptGrpTxt(channel.secretHex, mesh.payload.subarray(1));
  if (plain) {
    console.log(plain.timestampUnix, plain.body); // body keeps its "name: " prefix
  }
}
```

`parseMeshPacket` rather than `decodeOnAirPacket` here, because only the former
hands back the payload bytes the decrypt needs.

A `null` return means "not this channel": either the payload is malformed, or
the MAC did not verify under that secret. The channel hash is a single byte, so
roughly one packet in 256 from a channel you cannot read will still carry your
channel's hash — the MAC is what tells the two apart. Try each secret you hold
and let the MAC pick:

```ts
const match = channels
  .map((c) => c.secretHex && Protocol.decryptGrpTxt(c.secretHex, mesh.payload.subarray(1)))
  .find(Boolean);
```

Note that two bytes of MAC is a weak authenticator — about a 1-in-65536 false
accept on random data. It is ample for telling channels apart, but do not treat
a successful decrypt as proof of authorship.

`decryptGrpTxt` returns `{ timestampUnix, flags, body }`. The timestamp is the
one the *originating* node stamped into the packet, which is what makes it a
reliable identity for a message: it is also how the session decides which of
your own sends a heard repeater relay belongs to (see
[Messaging](../messaging/#channel-messages)).

## A note on the two sources

Only `log_rx` (0x88) packets follow the on-air wire format byte-for-byte. `raw`
(0x84) packets carry a firmware reserved-byte sentinel where the path length
would be, so `decodeOnAirPacket` will usually return the `raw` fallback for them
— the `source` field lets you caveat the display accordingly.

## No hardware needed

`decodeOnAirPacket` is a pure function: you can decode a pasted or captured hex
string with no live session at all. See `examples/decode-on-air-packet.ts` for a
runnable, hardware-free demonstration across several payload types.
