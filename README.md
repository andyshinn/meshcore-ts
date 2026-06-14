# meshcore-ts

An application-agnostic [MeshCore](https://meshcore.co.uk/) companion-protocol library for Node.js, in TypeScript.

`meshcore-ts` speaks the MeshCore **companion-radio** wire protocol (the framing a phone/desktop app uses to talk to a MeshCore device over BLE or serial). It owns the protocol logic, frame parsing, the connect handshake, the DM/channel messaging state machines, and repeater administration — and keeps an in-memory model of contacts, channels, messages, and device state. It does **zero** persistence and ships with **zero runtime dependencies** (only `node:buffer` / `node:crypto`).

You bring a **Transport** (the bytes in/out of your radio); the library does everything above that line and emits typed events. You subscribe and persist however you like.

```
npm install @andyshinn/meshcore-ts
```

> **Node-only.** Uses `node:buffer` and `node:crypto`. Not a browser build.

## Design in one breath

- **Stateful session, injected ports.** You construct a `MeshCoreSession` with an injected `Transport` (and optional `Logger`). The session owns a typed event emitter and an in-memory `SessionState`; it never writes to disk.
- **You own persistence.** Subscribe to events (`contacts`, `messages`, `owner`, …) and store them however you want. On reconnect the session re-syncs from the radio.
- **Multi-instance safe.** No module-level singletons — every session keeps its own state, so you can run several concurrently in one process.

## The ports you supply

### `Transport` (required)

The only thing you must implement. It moves raw companion frames to/from your radio. **Each `onData` chunk must be exactly one complete companion frame** (which is what a BLE GATT notification delivers).

```ts
interface Transport {
  send(bytes: Uint8Array): Promise<void>;        // write one companion frame
  onData(cb: (chunk: Uint8Array) => void): void; // one complete frame per call
  onStateChange(cb: (s: TransportState) => void): void;
  getState(): TransportState; // 'idle' | 'scanning' | 'connecting' | 'connected' | 'error'
}
```

The library does the companion-frame parsing (`0x84`/`0x88` mesh vs. companion classification) internally — your transport only deals in raw frame bytes. BLE/serial drivers, scanning, and native deps stay **your** responsibility (they're intentionally not in this library).

A ready-made `LoopbackTransport` is exported for tests and examples (`send` captures to `.sent`, `.receive(bytes)` / `.receiveHex(hex)` deliver inbound frames, `.setState(s)` drives connection state).

### `Logger` (optional)

```ts
interface Logger { trace; debug; info; warn; error: (...args: unknown[]) => void; }
```

Defaults to a no-op. Pass your own (`pino`, `console`, etc.) to see protocol-level logging.

### Events & State (owned by the session, exposed to you)

You don't inject these — the session creates them and exposes them:

- `session.events` — a typed emitter. Subscribe with `session.events.on('contacts', cb)`.
- `session.state` — the in-memory model. Read with `session.state.getContacts()`, `getChannels()`, `getOwner()`, `getMessagesForKey(key)`, etc.

## Quick start

```ts
import { MeshCoreSession, LoopbackTransport } from '@andyshinn/meshcore-ts';

const transport = new LoopbackTransport(); // swap for your BLE/serial adapter
const session = new MeshCoreSession({ transport /*, logger, appName, appVersion */ });

// Subscribe BEFORE connecting so you don't miss the handshake.
session.events.on('owner', (owner) => console.log('this device:', owner?.name));
session.events.on('contacts', (contacts) => persistContacts(contacts));
session.events.on('channels', (channels) => persistChannels(channels));
session.events.on('messages', (key, messages) => persistMessages(key, messages));
session.events.on('messageState', (id, state) => updateBubble(id, state));
session.events.on('syncProgress', (p) => console.log(p.phase, p.contacts));

session.start();

// When your transport connects, the session runs the handshake automatically:
//   DEVICE_QUERY → APP_START → GET_CONTACTS → channel enumeration → drain.
transport.setState('connected');

// Send a direct message (you supply the message id; track state via events):
await session.sendDmText('c:<pubkeyhex>', 'hello', 'msg-1');
// 'sending' → 'sent' (RESP_SENT) → 'ack' (PUSH_SEND_CONFIRMED), surfaced via 'messageState'.

// Send to a channel:
const { ok, channelHash } = await session.sendChannelText('ch:General', 'hi all');
// Optional: attribute heard repeater relays back to your message (emits 'messagePathHeard'):
if (ok && channelHash != null) session.registerChannelSend({ messageId: 'msg-2', channelHash });
```

### Implementing a real transport (sketch)

```ts
class BleTransport implements Transport {
  #dataCb?: (c: Uint8Array) => void;
  #stateCb?: (s: TransportState) => void;
  #state: TransportState = 'idle';

  // your BLE library calls this once per GATT notification (= one frame):
  #onNotification = (buf: Uint8Array) => this.#dataCb?.(buf);

  async send(bytes: Uint8Array) { await this.#char.writeValue(bytes); }
  onData(cb) { this.#dataCb = cb; }
  onStateChange(cb) { this.#stateCb = cb; }
  getState() { return this.#state; }
  // call this.#setState('connected') from your connect flow, etc.
}
```

## Events

`transportState`, `channels`, `channelPresence`, `syncProgress`, `contacts`, `discovered`, `contactEvicted`, `contactDiscovered`, `messages`, `messageState`, `messagePathHeard`, `owner`, `radioSettings`, `repeaterStatus`, `repeaterTelemetry`, `pathLearned`, `deviceIdentity`, `autoAddConfig`, `telemetryPolicy`, `gpsConfig`, `deviceInfo`, `deviceCapabilities`.

All payloads are exported types (see `MeshCoreEventMap`).

## What the session can do

Messaging (`sendChannelText`, `sendDmText`, `sendDmTextWithRetry`), contacts & paths (`getContactByKey`, `setContactPath`, `resetContactPath`, `addContactToRadio`, `removeContactFromRadio`, `setContactFavourite`, `setPathHashMode`), channels (`setChannel`, `pickFreeSlot`, `deriveSecret`, …), radio/device settings (`setRadioParams`, `setAdvertName`, `setAdvertLatLon`, `setOtherParams`, `setAutoAddConfig`, `setGpsConfig`, `reboot`, …), time (`getDeviceTime`/`setDeviceTime`/`syncDeviceTime`), device admin & signing (`exportPrivateKey`, `importPrivateKey`, `setDevicePin`, `factoryReset`, `signData`), path diagnostics & raw frames (`sendPathDiscoveryReq`, `getAdvertPath`, `sendRawData`, …), and repeater administration (`repeaterLogin`, `repeaterSendCli`, `repeaterRequestAcl`, `repeaterRequestNeighbours`, `repeaterRequestOwnerInfo`, `repeaterTracePath`, `repeaterGetLocalStats`, `sendStatusReq`, `sendTelemetryReq`).

## Extending the protocol

The session dispatches inbound frames through a `FeatureRegistry` of `Feature` modules (each owns the wire codes it reacts to and reads its dependencies from an injected `FeatureContext`). This is the library's extension model — see `src/feature.ts`.

## Scripts

```
npm run build      # tsup → ESM + CJS + .d.ts
npm test           # vitest
npm run typecheck  # tsc --noEmit
npm run lint       # biome
```

## License

MIT
