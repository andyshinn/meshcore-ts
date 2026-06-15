# Runnable Examples — Design

**Date:** 2026-06-15
**Status:** Approved (design); pending spec review
**Topic:** A runnable `examples/` directory for `@andyshinn/meshcore-ts`

## Goal

Ship a set of runnable example scripts for `@andyshinn/meshcore-ts`, ported from
the example set in [`meshcore-dev/meshcore.js`](https://github.com/liamcottle/meshcore.js)
(`examples/*.js`). The examples demonstrate the library's public API against
**real hardware**, using the library's own built-in transport adapters.

Two design facts shape everything:

1. **The library now ships transports.** `@andyshinn/meshcore-ts/transports`
   exports `SerialTransport` (wraps a duck-typed `serialport` handle and frames
   the MeshCore serial protocol internally), `createBleTransport` + `NORDIC_UART`
   (+ an abstract `BleTransport`), and the framing primitives
   `encodeSerialFrame` / `SerialDeframer`. Examples therefore write **no
   transport/framing code** — they construct a port and hand it to the adapter.
2. **The API is now near-1:1 with meshcore.js.** Find helpers
   (`findContactByName`, `findContactByPublicKeyPrefix`, `findChannelByName`,
   `findChannelBySecret`) and active re-fetch getters
   (`await session.getContacts()`, `getChannels()`, `getSelfInfo()`,
   `getChannel(idx)`) mean each ported example is a thin, readable script.

## Decisions (locked during brainstorming)

| Decision | Choice |
| --- | --- |
| What examples connect to | Real hardware via the library's built-in transports |
| Transports showcased | Serial (all 12 meshcore.js examples) **+ one BLE example** (`@stoprocent/noble`). No TCP. |
| Import style | Package-name imports (`@andyshinn/meshcore-ts`, `@andyshinn/meshcore-ts/transports`) via a tsconfig `paths` alias → `../src`, run with `tsx` (zero build) |
| Serial session setup | Inline in each example (~4 lines) for top-to-bottom readability, not a shared bootstrap helper |
| Shared code | Only `requirePort` (arg parsing) and `waitForEvent` (event-driven request/response) in `examples/lib/helpers.ts` |
| Anti-bit-rot | `examples/tsconfig.json` + a `typecheck:examples` script so examples are type-checked against the live source |

Out of scope: a TCP example, changes to the library source, publishing/CI
workflow changes beyond the typecheck script.

## Architecture

`examples/` is **not** a separate npm project (unlike `docs/`). It runs against
the repo's own `src/` via `tsx`, with `serialport`, `@stoprocent/noble`, and
`tsx` added to the **root** `devDependencies`. A tsconfig `paths` alias lets the
example source read exactly like published-consumer code while resolving to the
local source with no build step.

```
examples/
  README.md            # the example table + run instructions + finding your port
  tsconfig.json        # extends ../tsconfig.json; paths alias; includes examples + src
  lib/
    helpers.ts         # requirePort(argv, usage), waitForEvent(session, name, pred?, ms)
  echo-bot.ts
  command-bot.ts
  get-contacts.ts
  send-contact-message.ts
  send-channel-message.ts
  get-repeater-status.ts
  get-repeater-telemetry.ts
  get-repeater-neighbours.ts
  get-sensor-telemetry.ts
  parse-advert.ts
  parse-packet.ts
  sign-data.ts
  ble-get-contacts.ts
```

### `examples/tsconfig.json`

Extends the root config and adds a `paths` alias plus its own `include`. Mirrors
the library's `moduleResolution: "bundler"` so extensionless imports resolve.

```jsonc
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "paths": {
      "@andyshinn/meshcore-ts": ["../src/index"],
      "@andyshinn/meshcore-ts/transports": ["../src/transports/index"]
    }
  },
  "include": ["./**/*.ts", "../src"]
}
```

`tsx` honours tsconfig `paths`, so `npm run example examples/echo-bot.ts ...`
resolves the alias at runtime without a build. `tsc -p examples/tsconfig.json`
type-checks every example against live `src/`.

### Root `package.json` additions

- `devDependencies`: `serialport`, `@stoprocent/noble`, `tsx`.
- `scripts`:
  - `"example": "tsx"` → usage `npm run example examples/echo-bot.ts /dev/cu.usbmodemXXXX`
  - `"typecheck:examples": "tsc -p examples/tsconfig.json"`

The library's own `build`, `typecheck`, and `tsconfig.json` are untouched.

## Components

### `examples/lib/helpers.ts`

Two small, well-bounded helpers. No transport logic lives here.

- `requirePort(argv: string[], usage: string): string` — pull the serial port
  path from `process.argv` (e.g. `argv[2]`); if absent, print `usage` and
  `process.exit(1)`.
- `waitForEvent<K extends keyof MeshCoreEventMap>(session, name, predicate?, timeoutMs = 10_000): Promise<...>`
  — resolve on the next typed event matching `predicate`; reject on timeout.
  Always removes its listener. Used by the repeater examples because those are
  event-driven (`sendStatusReq` returns `{ ok }`; the snapshot arrives on the
  `repeaterStatus` event).

### Serial example skeleton (inline, per example)

```ts
import { SerialPort } from 'serialport';
import { MeshCoreSession } from '@andyshinn/meshcore-ts';
import { SerialTransport } from '@andyshinn/meshcore-ts/transports';
import { requirePort } from './lib/helpers';

const path = requirePort(process.argv, 'usage: ... <serial-port>');
const port = new SerialPort({ path, baudRate: 115200 });
const session = new MeshCoreSession({ transport: new SerialTransport(port) });
session.start(); // SerialTransport observes open/close/error; it does not open the port
// ... example-specific logic, then port.close() / session.stop() where appropriate
```

`SerialTransport`'s state starts `connecting` and flips to `connected` on the
port's `open` event, which is what triggers the session's auto-handshake
(`DEVICE_QUERY → APP_START → GET_CONTACTS → channels → drain`). Examples that
need synced data either `await session.getContacts()` / `getChannels()` (active
re-fetch) or subscribe to `syncProgress`.

### BLE example (`ble-get-contacts.ts`)

The only BLE example, so the `@stoprocent/noble` flow is inlined here rather
than shared. `@stoprocent/noble` is a maintained, TypeScript-first noble fork,
so the example is fully typed (no `any`, no ambient shim):

1. `await noble.waitForPoweredOnAsync()`.
2. `await startScanningAsync([NORDIC_UART.service], false)` → resolve first `discover`.
3. `connectAsync()` → `discoverSomeServicesAndCharacteristicsAsync([NORDIC_UART.service], [NORDIC_UART.rxWrite, NORDIC_UART.txNotify])`.
4. `createBleTransport({ write, subscribe, watchState })` per the docs recipe:
   - `write: (bytes) => rxChar.writeAsync(Buffer.from(bytes), true)`
   - `subscribe: (onBytes) => { txChar.on('data', d => onBytes(new Uint8Array(d))); void txChar.subscribeAsync(); }`
   - `watchState: (onState) => peripheral.once('disconnect', () => onState('idle'))`
5. `new MeshCoreSession({ transport })`, `session.start()`, `await session.getContacts()`,
   print owner + contacts, disconnect.

## The 13 examples

Ported from meshcore.js `examples/`. Each maps to a documented public method;
the parse examples need no hardware.

| File | meshcore.js source | Library API exercised |
| --- | --- | --- |
| `echo-bot.ts` | `echo_bot.js` | `events.on('messages')`; reply to `messages.at(-1)` when `fromPublicKeyHex` is set (inbound), dedupe by `id`; `sendDmText(key, body, id)`; on connect `syncDeviceTime()` + `sendSelfAdvert()` |
| `command-bot.ts` | `command_bot.js` | same scaffold; `/ping` → `PONG! 🏓`, `/date` → ISO date, else help menu |
| `get-contacts.ts` | `get_contacts.js` | `await session.getContacts()` → print → `session.stop()` / `port.close()` |
| `send-contact-message.ts` | `send_contact_message.js` | `await getContacts()` → `findContactByName(name)` → `sendDmText(contact.key, text, id)` → `await waitForEvent('messageState', s => s===…)` for sent/ack |
| `send-channel-message.ts` | `send_channel_message.js` | `await getChannels()` → `findChannelByName(name)` → `sendChannelText(channel.key, text)` |
| `get-repeater-status.ts` | `get_repeater_status.js` | `findContactByPublicKeyPrefix` → `repeaterLogin(key, '')` → `sendStatusReq(key)` → `waitForEvent('repeaterStatus')` → print |
| `get-repeater-telemetry.ts` | `get_repeater_telemetry.js` | login → `sendTelemetryReq(key)` → `waitForEvent('repeaterTelemetry')` |
| `get-repeater-neighbours.ts` | `get_repeater_neighbours.js` | login → `await repeaterRequestNeighbours(key)` → print page |
| `get-sensor-telemetry.ts` | `get_sensor_telemetry.js` | `sendTelemetryReq(sensorKey)` (no login) → `waitForEvent('repeaterTelemetry')` |
| `parse-advert.ts` | `parse_advert.js` | **no transport** — strip `meshcore://`, hex→`Buffer`, `parseMeshPacket(bytes)` → `parseAdvert(payload)`; print |
| `parse-packet.ts` | `parse_packet.js` | **no transport** — hex→`Buffer` → `parseMeshPacket(bytes)`; print |
| `sign-data.ts` | `companion_sign_data.js` | connect → `await signData(Buffer.from(...))` → print hex signature |
| `ble-get-contacts.ts` | *(new — showcases BLE)* | noble scan/connect/discover → `createBleTransport` → `await getContacts()` → print owner + contacts |

### Echo / command bot correctness note

The `messages` event fires `(key, getMessagesForKey(key))` immediately after an
inbound DM is appended, so the new message is `messages.at(-1)`. Owner-sent
messages omit `fromPublicKeyHex`, so the bot only replies when
`messages.at(-1)?.fromPublicKeyHex` is set, and tracks handled `id`s to avoid
re-handling on subsequent emits (preventing reply loops).

## Data flow

Real hardware, one direction of setup:

```
serialport SerialPort ──open──▶ SerialTransport (frames) ──onData(frame)──▶ MeshCoreSession
                                                            ◀──send(frame)──
   noble peripheral ──notify──▶ createBleTransport ────────▶ MeshCoreSession
```

Example logic talks only to `MeshCoreSession` (`events`, `state`, methods) — it
never touches framing or the wire.

## Error handling

- **Missing serial port arg** → `requirePort` prints usage and exits non-zero.
- **`waitForEvent` timeout** → rejects with a clear message; the example logs and
  exits non-zero (e.g. "repeater did not respond — wrong key or not logged in?").
- **Contact/channel not found** (`findContactByName` etc. return `null`) → log a
  clear message and exit, mirroring meshcore.js.
- **Send failures** → `sendChannelText` / `sendDmText` return `{ ok, error }`;
  examples log `error` and exit non-zero.
- BLE/serial driver errors surface as transport `'error'` state; examples log and
  exit. Examples are short-lived scripts (except the two bots), so they don't
  implement reconnect — matching meshcore.js (`// todo auto reconnect`).

## Testing & verification

- `npm run typecheck:examples` type-checks all 13 examples against live `src/` —
  the primary guard against API drift. Wired into the normal check surface.
- `parse-advert.ts` and `parse-packet.ts` run with **no hardware** and produce
  deterministic output, so they double as a smoke check.
- Hardware-dependent examples are verified manually against a real MeshCore
  device; the README documents how to run each.

## Documentation

- **`examples/README.md`** — the example table, the `npm run example <file> <port>`
  command, how to find a serial port path per OS, and the BLE example's extra
  `@stoprocent/noble` requirement.
- **Root `README.md`** — a short "Examples" section linking `examples/`.
