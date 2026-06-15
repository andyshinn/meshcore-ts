---
title: Transports
description: Implement the Transport port that moves companion frames to and from your radio.
---

A **Transport** is the only thing you must implement. It moves raw companion
frames to and from your radio. The library handles companion-frame parsing
(`0x84`/`0x88` mesh vs. companion classification) internally — your transport
only deals in raw frame bytes. BLE/serial drivers, scanning, and native deps
stay **your** responsibility; they are intentionally not in this library.

## The interface

```ts
interface Transport {
  send(bytes: Uint8Array): Promise<void>;        // write one companion frame
  onData(cb: (chunk: Uint8Array) => void): void; // one complete frame per call
  onStateChange(cb: (s: TransportState) => void): void;
  getState(): TransportState; // 'idle' | 'scanning' | 'connecting' | 'connected' | 'error'
}
```

> **Framing rule:** Each `onData` chunk must be **exactly one complete companion
> frame** — which is what a single BLE GATT notification delivers.

## LoopbackTransport (tests & examples)

A ready-made `LoopbackTransport` is exported for tests and examples:

- `send` captures outbound frames to `.sent`
- `.receive(bytes)` / `.receiveHex(hex)` deliver inbound frames
- `.setState(s)` drives connection state

```ts
import { LoopbackTransport } from '@andyshinn/meshcore-ts';

const transport = new LoopbackTransport();
transport.setState('connected');     // drive the session's connect handshake
transport.receiveHex('84...');       // feed an inbound companion frame
console.log(transport.sent);         // inspect what the session wrote
```

## Implementing a real transport (sketch)

```ts
class BleTransport implements Transport {
  #dataCb?: (c: Uint8Array) => void;
  #stateCb?: (s: TransportState) => void;
  #state: TransportState = 'idle';

  // your BLE library calls this once per GATT notification (= one frame):
  #onNotification = (buf: Uint8Array) => this.#dataCb?.(buf);

  async send(bytes: Uint8Array) { await this.#char.writeValue(bytes); }
  onData(cb: (c: Uint8Array) => void) { this.#dataCb = cb; }
  onStateChange(cb: (s: TransportState) => void) { this.#stateCb = cb; }
  getState() { return this.#state; }

  // call #setState('connected') from your connect flow:
  #setState(s: TransportState) { this.#state = s; this.#stateCb?.(s); }
}
```

## Logger (optional)

```ts
interface Logger { trace; debug; info; warn; error: (...args: unknown[]) => void; }
```

Defaults to a no-op. Pass your own (`pino`, `console`, etc.) to see
protocol-level logging:

```ts
const session = new MeshCoreSession({ transport, logger: console });
```

See the [events and state model](../events-and-state/) next, or the
[full API reference](../../api/readme/).
