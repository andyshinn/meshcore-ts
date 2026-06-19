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
// The one contract you implement — exposed as `Ports.Transport`.
// (`TransportState` is `Models.TransportState`.)
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

A ready-made `Transports.Loopback` is exported for tests and examples:

- `send` captures outbound frames to `.sent`
- `.receive(bytes)` / `.receiveHex(hex)` deliver inbound frames
- `.setState(s)` drives connection state

```ts
import { Transports } from '@andyshinn/meshcore-ts';

const transport = new Transports.Loopback();
transport.setState('connected');     // drive the session's connect handshake
transport.receiveHex('84...');       // feed an inbound companion frame
console.log(transport.sent);         // inspect what the session wrote
```

## Implementing a real transport (sketch)

```ts
import { Models, Ports } from '@andyshinn/meshcore-ts';

class BleTransport implements Ports.Transport {
  #dataCb?: (c: Uint8Array) => void;
  #stateCb?: (s: Models.TransportState) => void;
  #state: Models.TransportState = 'idle';

  // your BLE library calls this once per GATT notification (= one frame):
  #onNotification = (buf: Uint8Array) => this.#dataCb?.(buf);

  async send(bytes: Uint8Array) { await this.#char.writeValue(bytes); }
  onData(cb: (c: Uint8Array) => void) { this.#dataCb = cb; }
  onStateChange(cb: (s: Models.TransportState) => void) { this.#stateCb = cb; }
  getState() { return this.#state; }

  // call #setState('connected') from your connect flow:
  #setState(s: Models.TransportState) { this.#state = s; this.#stateCb?.(s); }
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

## Built-in transport adapters

The `Transports` namespace ships ready-made adapters so you don't have to write
the boilerplate above for the two most common hardware transports.

## Serial (node-serialport)

```ts
import { SerialPort } from 'serialport';
import { MeshCoreSession, Transports } from '@andyshinn/meshcore-ts';

const port = new SerialPort({ path: '/dev/ttyUSB0', baudRate: 115200 });
const session = new MeshCoreSession({ transport: new Transports.Serial(port) });
session.start(); // Transports.Serial observes open/close/error; it does not open the port
```

`Transports.Serial` frames the MeshCore serial protocol for you. You own opening
and closing the port.

## BLE (noble)

```ts
import noble from '@abandonware/noble';
import { MeshCoreSession, Transports } from '@andyshinn/meshcore-ts';

// After you have connected `peripheral` and discovered `rxChar`/`txChar`
// for Transports.NORDIC_UART.rxWrite / Transports.NORDIC_UART.txNotify:
const transport = Transports.createBle({
  write: (bytes) => rxChar.writeAsync(Buffer.from(bytes), true),
  subscribe: (onBytes) => {
    txChar.on('data', (data: Buffer) => onBytes(new Uint8Array(data)));
    txChar.subscribe(() => {});
  },
  watchState: (onState) => peripheral.on('disconnect', () => onState('idle')),
});
const session = new MeshCoreSession({ transport });
session.start();
```

## BLE (React Native — react-native-ble-plx)

`react-native-ble-plx` deals in base64 strings, so decode/encode in your hooks:

```ts
import { Buffer } from 'buffer';
import { MeshCoreSession, Transports } from '@andyshinn/meshcore-ts';

const transport = Transports.createBle({
  write: (bytes) =>
    device.writeCharacteristicWithResponseForService(
      service, rxUuid, Buffer.from(bytes).toString('base64'),
    ).then(() => {}),
  subscribe: (onBytes) =>
    device.monitorCharacteristicForService(service, txUuid, (_err, ch) => {
      if (ch?.value) onBytes(new Uint8Array(Buffer.from(ch.value, 'base64')));
    }),
  watchState: (onState) =>
    device.onDisconnected(() => onState('idle')),
});
const session = new MeshCoreSession({ transport });
session.start();
```
