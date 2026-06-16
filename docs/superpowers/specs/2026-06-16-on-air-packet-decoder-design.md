# On-air packet feed + decoder — design

**Date:** 2026-06-16
**Status:** Approved (pending spec review)
**Package:** `@andyshinn/meshcore-ts`

## Problem

A downstream Electron renderer (the "coresense" app) has a packet inspector
(`decodePacket.ts`) that needs two things meshcore-ts does not currently expose:

1. **A raw on-air packet feed.** Today the renderer taps `PUSH_RAW_DATA` (0x84)
   and `PUSH_LOG_RX_DATA` (0x88) bytes itself in its BLE layer and ships the hex
   to the inspector. `MeshCoreSession` swallows those frames internally — it only
   parses 0x88 for GRP_TXT correlation
   ([`session.ts:401-431`](../../../src/session/session.ts#L401-L431)) — and emits
   no public event. Without one, moving the renderer onto the library makes the
   inspector go dark.

2. **Structural decoders for on-air payloads.** The library's existing
   `decode*` functions parse **companion frames** (host↔radio), a different wire
   format from the **on-air** payloads the inspector shows.
   [`parseMeshPacket()`](../../../src/meshPacket.ts) yields the header + route +
   path + raw payload `Buffer`, and [`parseAdvert()`](../../../src/advert.ts)
   covers ADVERT, but the per-type structural fields (src/dst hash, channel hash,
   checksum, trace tag/hop-count, etc.) for the other on-air payload types are not
   exposed anywhere.

## Goals

- Add a public `rawPacket` event so consumers receive the on-air bytes the
  session currently consumes internally.
- Add a public, standalone `decodeOnAirPacket(hex)` that structurally cracks an
  on-air mesh packet into a tagged union the inspector can format directly.
- Keep the package's **zero runtime dependencies** property.
- Structural extraction only — **no decryption, no encode/serialize.**

## Non-goals

- No decryption of any payload (the inspector shows hashes/lengths, not plaintext).
- No encode/serialize path.
- No changes to companion-frame decoding, the feature registry, or transports.
- No new runtime dependencies.

## Decisions

These were settled during brainstorming:

- **Emission model: thin feed + pure decoder (decoupled).** The event ships raw
  hex; decoding is a separate pure function the consumer calls. The two pieces are
  independent — the decoder is testable and usable on pasted/offline hex with no
  live session, and consumers pay decode cost only when they want it.
- **Decoder scope: the full inspector table in this first pass.** All on-air
  payload types the inspector shows are decoded now; a partial decoder would leave
  the inspector half-dark and force revisiting the same wire layouts twice.
- **flag #1 — event `hex` = inner on-air mesh bytes** (`parsed.meshHex`), not the
  full companion frame. That is exactly what `decodeOnAirPacket` consumes, and
  `snr`/`rssi` are already broken out so the frame prefix is redundant.
- **flag #2 — source names reuse the existing `ParsedFrame` vocabulary**
  `'raw' | 'log_rx'` rather than introducing `'rx' | 'log'`, for one vocabulary
  across the codebase.

## Design

### 1. The `rawPacket` event

Add one entry to [`MeshCoreEventMap`](../../../src/ports/events.ts#L32):

```ts
rawPacket: (pkt: { hex: string; source: 'raw' | 'log_rx'; snr: number; rssi: number }) => void;
```

- `hex` — the inner on-air mesh packet bytes as hex (`parsed.meshHex`).
- `source` — which push delivered it: `'raw'` (0x84) or `'log_rx'` (0x88).
- `snr`, `rssi` — already extracted by `parseCompanionFrame`.

Emitted from [`session.ingest()`](../../../src/session/session.ts#L401-L431)
inside the existing `parsed.kind === 'mesh'` branch, for **both** sources (today
only `log_rx` is inspected). Purely additive: the GRP_TXT observation tee is
unchanged; we add `this.events.emit('rawPacket', …)` before the early `return`.

### 2. The `decodeOnAirPacket` decoder

New standalone primitive file `src/onAirPackets.ts`, in the same layer as
`advert.ts` and `meshPacket.ts` (no registry, no session wiring). Exported from
`index.ts`.

```ts
export function decodeOnAirPacket(input: string | Uint8Array): OnAirPacket;
```

- Accepts a hex string (what the event ships) **or** raw bytes (ergonomic for
  internal callers) — avoids hex-only friction.
- **Total function — never throws.** Internally calls `parseMeshPacket`, then
  switches on `payloadType` to structurally crack `payload`. Any parse failure or
  not-yet-supported type returns the `raw` fallback variant, so the inspector
  always renders something.

```ts
export interface OnAirPacket {
  header: MeshPacketHeader;   // route/payloadType/version, hashSize/Count, pathHex, transportCodesHex
  payloadTypeName: string;    // 'TXT_MSG', 'GRP_TXT', … for display
  payload: OnAirPayload;      // discriminated union (Section 3)
}
```

### 3. The payload tagged union

Discriminated on `kind`. **Structural fields only — no decryption.**

| `kind` | Fields |
|---|---|
| `advert` | reuses `parseAdvert` → `publicKeyHex`, `timestampUnix`, role/`type`, `name?`, `latlon?` |
| `txtMsg` | `srcHash`, `dstHash`, `cipherLen` (+ `macHex?`) |
| `grpTxt` | `channelHash`, `macHex`, `cipherLen` |
| `req` / `response` | `destHash`, `srcHash`, `reqType?` |
| `anonReq` | `destHash`, `senderPubKeyHex`, `cipherLen` |
| `ack` | `checksumHex` |
| `path` | `pathLen`, `extraType`, `extraHex` |
| `trace` | `tag`, `hopCount` (+ per-hop hashes/SNR if cheap) |
| `control` | `subType` (discover req/resp), `nodeType`, `snr` |
| `raw` | fallback: `payloadType`, `payloadHex` — GRP_DATA / MULTIPART / RAW_CUSTOM / parse failure |

**Exact byte offsets per variant are pinned during implementation** against three
authoritative sources: this repo's [`meshPacket.ts`](../../../src/meshPacket.ts)
notes, meshcore-decoder's `src/decoder/payload-decoders/`, and firmware
`Packet.cpp`. Any disagreement among them is treated as a bug to resolve with a
real capture, not guessed.

### 4. The `raw` (0x84) subtlety

The code already documents that `0x84` writes a `0xFF` sentinel where `path_len`
belongs, so `parseMeshPacket` returns `null` for those bytes — which is why the
session only ever parsed `0x88`
([`frame.ts:71-78`](../../../src/frame.ts#L71-L78),
[`meshPacket.ts:67-69`](../../../src/meshPacket.ts#L67-L69)). Consequently
`decodeOnAirPacket` will reliably structurally-decode **`log_rx`/0x88** packets;
for **`raw`/0x84** it will often land in the `raw` fallback. That is acceptable —
the inspector still shows what it can plus the hex, and the `source` field lets it
caveat. The exact 0x84 behavior is the one thing to confirm against a real
captured 0x84 frame during TDD rather than guess.

## Testing

- **TDD with real vectors.** Unit-test `decodeOnAirPacket` per variant using
  captured hex (sourced from meshcore-decoder's test fixtures and/or live
  captures). The pure function is trivially testable with zero transport.
- One session test asserting `rawPacket` fires for **both** `raw` and `log_rx`
  sources with the correct `hex`/`snr`/`rssi`.

## Public API surface added

- `decodeOnAirPacket`, `OnAirPacket`, `OnAirPayload` (+ variant types) via
  `index.ts`.
- `rawPacket` event, added automatically through `MeshCoreEventMap`.

## Risk / impact

- Additive only; no behavior change to existing companion-frame decoding,
  observation correlation, transports, or the feature registry.
- Zero new runtime dependencies — reuses `parseMeshPacket`, `parseAdvert`,
  `node:buffer`.
