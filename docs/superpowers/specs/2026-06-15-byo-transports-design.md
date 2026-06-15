# Bring-Your-Own Transports (Serial + BLE) — Design

**Date:** 2026-06-15
**Status:** Approved
**Scope:** Provide optional `SerialTransport` and `BleTransport` glue plus a pure
serial framing codec so users can wire their own `serialport` / `noble` /
React Native BLE handle to a `MeshCoreSession` — **without** `meshcore-ts` taking
a runtime dependency on any serial or BLE package.

## Background

`meshcore-ts` deliberately ships **zero runtime dependencies**. The radio link is
modeled as a narrow port, `Transport` (`src/ports/transport.ts`):

```ts
export interface Transport {
  send(bytes: Uint8Array): Promise<void>;     // write ONE complete companion frame
  onData(cb: (chunk: Uint8Array) => void): void; // each chunk = ONE complete companion frame
  onStateChange(cb: (s: TransportState) => void): void;
  getState(): TransportState;
}
```

`MeshCoreSession.start()` subscribes `this.transport.onData((chunk) => this.ingest(chunk))`
(`src/session/session.ts:216`) and `writeFrame` calls `this.transport.send(frame)`
(`src/session/session.ts:261`). `TransportState` is
`'idle' | 'scanning' | 'connecting' | 'connected' | 'error'` (`src/types.ts:4`).
The existing `LoopbackTransport` (`src/ports/transport.ts:18`) is the in-memory
test double and stays unchanged.

Today there is no shipped adapter, so every user re-implements the wiring — and,
for serial, the byte-stream framing — by hand. This design adds opt-in adapters
that keep the zero-dependency guarantee by **duck-typing** the user's already-open
handle rather than importing the device library.

### The load-bearing fact: serial needs framing, BLE does not

Verified against the reference implementation
[`meshcore-dev/meshcore.js`](https://github.com/meshcore-dev/meshcore.js)
(`src/connection/serial_connection.js`, `src/constants.js`):

**Serial / TCP** wraps every companion frame in a 3-byte header:

```
[ type : 1 byte ][ length : uint16 LE ][ payload : <length> bytes ]
  0x3c '<' = host→device  (SerialFrameTypes.Outgoing)
  0x3e '>' = device→host  (SerialFrameTypes.Incoming)
```

`payload` is exactly the one-complete-companion-frame that `onData`/`ingest`
already expects. A byte stream therefore needs a **de-framer** to reassemble
whole `payload`s, and outgoing frames need a 3-byte **encoder**.

**BLE** (Nordic UART) has **no** wrapping — each notification is already one
complete companion frame, matching the `onData` contract verbatim:

- Service `6E400001-B5A3-F393-E0A9-E50E24DCCA9E`
- RX / write (host→device) `6E400002-…`
- TX / notify (device→host) `6E400003-…`

This asymmetry drives the whole design: serial gets a codec + adapter; BLE is
near-pure plumbing.

## Decisions (settled during brainstorming)

- **Targets:** Node `serialport`, Node `noble`, React Native BLE. Browser
  Web Serial / Web Bluetooth are **out of scope** (but see "Free extensions").
- **Serial ergonomic:** duck-typed **constructor** — `serialport` satisfies the
  structural interface directly, so no subclassing.
- **BLE ergonomic:** **ship both** — a hooks factory as the core, plus a thin
  abstract base class wrapper over it.
- **Connection ownership:** the transport **observes and frames; the user opens
  and connects** the handle — keeping `meshcore-ts` out of connection management
  and free of device-library dependencies. It does **not** assume the handle is
  already open: Node `serialport` opens asynchronously after construction, so the
  transport tracks state from `port.isOpen` plus the `'open'`/`'close'`/`'error'`
  events (unlike browser WebSerial, where the port is opened before the
  connection object exists).

## Architecture & packaging

New directory `src/transports/`, exposed as a **subpath export**
`meshcore-ts/transports` (its own `tsup` entry plus a `package.json` `exports`
map). Rationale: keeps the core import surface clean and signals that these are
opt-in glue. The subpath carries **zero runtime deps and zero type deps** —
the user's handle is described by minimal **structural interfaces defined locally**,
never imported from `serialport`/`noble`.

```
src/transports/
  serialFraming.ts   // pure codec: encodeSerialFrame + SerialDeframer
  serialTransport.ts // SerialTransport(port) — duck-typed ctor
  bleTransport.ts    // createBleTransport(hooks) + abstract BleTransport + UUID constants
  index.ts           // barrel for the subpath export
```

## Component 1 — `serialFraming.ts` (pure codec, the valuable core)

No I/O, no deps, exhaustively unit-testable.

```ts
// Wrap one companion frame as a host→device serial frame: [0x3c][len LE][payload].
export function encodeSerialFrame(payload: Uint8Array): Uint8Array;

// Resync-tolerant stream de-framer. Feed it raw bytes as they arrive; it returns
// zero or more complete companion-frame payloads, buffering any partial tail.
export class SerialDeframer {
  // maxFrameBytes default 256 (firmware MAX_FRAME_SIZE is currently 176 — see BaseSerialInterface.h).
  constructor(opts?: { maxFrameBytes?: number });
  push(bytes: Uint8Array): Uint8Array[];
  reset(): void;
}
```

`SerialDeframer.push` mirrors the reference loop (`onDataReceived`):

1. Append `bytes` to an internal buffer.
2. While buffer length ≥ 3 (header size):
   - Read `type` (byte 0). If it is neither `0x3c` nor `0x3e`, **drop one byte**
     and retry (resync past garbage).
   - Read `length` (bytes 1–2, uint16 LE). If `length === 0` **or
     `length > maxFrameBytes`**, **drop one byte** and retry — a length larger
     than any real companion frame means the type byte was spurious, so resync
     rather than wait for bytes that will never come.
   - If buffer has fewer than `3 + length` bytes, **break** (wait for more).
   - Otherwise slice `payload = buffer[3 .. 3+length]`, push it to the output
     list, and advance the buffer past the whole frame.
3. Return the collected payloads.

It accepts both `0x3e` (the real device→host marker) and `0x3c` as valid type
bytes, matching the reference's tolerance. It **never throws** on a malformed
stream — it resyncs.

**Why the buffer stays tiny:** this is a *reassembly* buffer, not a
fill-before-flush batch buffer. Bytes accumulate only until one complete frame is
decoded, then that frame's bytes are removed immediately. In normal operation it
holds at most one partial frame — and companion frames are small (firmware
`MAX_FRAME_SIZE = 176`, `MAX_CHANNEL_DATA_LENGTH = 163`). The only way it could
grow is a *corrupt* header that declares a huge `length`; the
`length > maxFrameBytes` resync above caps that, bounding the buffer to
`3 + maxFrameBytes` (~259 bytes by default) without ever throwing. There is no
raw byte-count cap and no overflow callback — the semantic frame-length check is
the guard.

## Component 2 — `SerialTransport` (duck-typed constructor)

Implements `Transport`. Constructed from an already-open, `serialport`-shaped
handle described by a local structural type:

```ts
export interface SerialPortLike {
  write(bytes: Uint8Array): unknown;                 // node-serialport returns boolean; ignored
  readonly isOpen?: boolean;                         // node-serialport exposes this
  on(event: 'data', cb: (chunk: Uint8Array) => void): unknown;
  on(event: 'open' | 'close', cb: () => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
}

export class SerialTransport implements Transport {
  constructor(port: SerialPortLike, opts?: { maxFrameBytes?: number });
}
```

Wiring:

- `port.on('data', chunk → deframer.push(chunk))`; each returned payload is
  delivered to the registered `onData` callback (one whole companion frame each).
- `send(frame)` → `port.write(encodeSerialFrame(frame))`; a thrown/rejected write
  rejects the returned promise (the session already handles write rejection in
  `request`, `src/session/session.ts`).
- **State, no open-assumption:** unlike WebSerial — where the browser opens the
  port *before* you construct the connection — Node `serialport` opens
  asynchronously, after construction. So the transport derives state from the
  handle rather than assuming. Initial state is `'connected'` when `port.isOpen`
  is already truthy (caller opened it first), else `'connecting'`. Then events
  drive transitions via `onStateChange`: `'open'` → `'connected'`, `'close'` →
  `'idle'`, `'error'` → `'error'`. (When the initial state is already
  `'connected'`, emit it on the next microtask so `session.start()`'s
  `getState() === 'connected'` check still kicks the handshake.) The transport
  never opens the port itself — the user owns that.

Because the codec is exported, a Node TCP socket or browser Web Serial source can
reuse `SerialDeframer`/`encodeSerialFrame` with a few lines — no extra adapter
needed now.

## Component 3 — BLE (`createBleTransport` + `BleTransport`)

BLE maps 1:1 to `onData`, but `noble` (Buffers via `'data'`) and
`react-native-ble-plx` (base64 strings via monitor callbacks, promise-based)
differ enough that one concrete class cannot fit both. So the core is a hooks
factory operating purely in **bytes**; library-specific encoding (e.g. RN base64)
lives in the user's closures.

```ts
export interface BleHooks {
  write(bytes: Uint8Array): Promise<void> | void;      // → RX characteristic
  subscribe(onBytes: (frame: Uint8Array) => void): void; // ← TX notifications (each = 1 frame)
  watchState?(onState: (s: TransportState) => void): void; // connect/disconnect
}

export function createBleTransport(hooks: BleHooks): Transport;
```

Thin abstract wrapper for users who prefer inheritance:

```ts
export abstract class BleTransport implements Transport {
  protected abstract writeChunk(bytes: Uint8Array): Promise<void> | void;
  protected deliver(frame: Uint8Array): void;   // call from your notification handler
  protected setState(s: TransportState): void;  // call from your connect/disconnect handler
  // implements send/onData/onStateChange/getState by delegating to createBleTransport
}
```

Nordic UART UUIDs exported so nobody copy-pastes them:

```ts
export const NORDIC_UART = {
  service: '6E400001-B5A3-F393-E0A9-E50E24DCCA9E',
  rxWrite: '6E400002-B5A3-F393-E0A9-E50E24DCCA9E',
  txNotify: '6E400003-B5A3-F393-E0A9-E50E24DCCA9E',
} as const;
```

## Data flow

- **Inbound serial:** `port 'data'` → `SerialDeframer.push` → whole payload(s) →
  `onData` → `session.ingest` (existing).
- **Inbound BLE:** notification (already whole) → `deliver`/`onBytes` → `onData` →
  `ingest`.
- **Outbound serial:** `session.send(frame)` → `encodeSerialFrame` → `port.write`.
- **Outbound BLE:** `session.send(frame)` → `write` to RX characteristic (no framing).

## Error handling

- De-framer resyncs (drops a byte) rather than throwing on a bad type byte, a
  zero length, or a length exceeding `maxFrameBytes`; partial frames wait for
  more bytes. This bounds the reassembly buffer to one real frame.
- Write failures reject `send()`; the session surfaces them through its existing
  request/ack paths.
- The transport does not auto-reconnect; reconnection is the user's concern (they
  own the handle). A disconnect maps to `'idle'`/`'error'` via state mapping.

## Testing (vitest)

- **`serialFraming` (pure):** encode→deframe round-trips; byte-by-byte feeding;
  multiple frames coalesced in one chunk; leading/interleaved garbage; `0x3c` vs
  `0x3e` type bytes; zero-length header; truncated tail then completion;
  oversized-`length` header (> `maxFrameBytes`) triggers resync, not unbounded
  buffering; a real 176-byte max frame still decodes.
- **`SerialTransport`:** drive a fake `SerialPortLike` (emit `data`/`open`/`close`/
  `error`); assert whole frames reach `onData`, `send` writes the encoded bytes,
  and state transitions fire. No hardware.
- **BLE:** drive `createBleTransport` / a `BleTransport` subclass with fake hooks;
  assert `onData`, `send`→`write`, and state. No hardware.

## Docs

Add to the Starlight site + README: two ~15-line copy-paste recipes
(`serialport`, `noble`) and one React Native BLE snippet showing base64 bridging
in the `write`/`subscribe` closures.

## Free extensions (not built now)

Because the framing codec and the BLE hooks factory are exported and
device-agnostic, these become small follow-ups with no new dependencies:

- **Web Serial** / **TCP** serial sources — reuse `SerialDeframer` + `encodeSerialFrame`.
- **Web Bluetooth** — another `BleHooks` closure set.

## Out of scope

- Connection lifecycle management (scanning, pairing, auto-reconnect).
- Any runtime or type dependency on `serialport`, `noble`, `react-native-ble-plx`,
  or browser Web API typings.
- Changes to the core `Transport` interface, `MeshCoreSession`, or
  `LoopbackTransport`.
