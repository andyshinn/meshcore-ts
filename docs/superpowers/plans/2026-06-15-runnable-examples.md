# Runnable Examples Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a runnable `examples/` directory that ports the meshcore.js example set onto `MeshCoreSession`, using the library's built-in transports (`SerialTransport`, `createBleTransport`).

**Architecture:** Examples are thin scripts run via `tsx` against the repo's own `src/` (no separate npm project). A tsconfig `paths` alias lets each example import `@andyshinn/meshcore-ts` and `@andyshinn/meshcore-ts/transports` exactly as a published consumer would, while resolving to local source. Serial setup is inlined per example; only `requireArg` and `waitForEvent` are shared.

**Verification model (read this):** These are hardware-facing scripts, so unit-test TDD does not apply. The per-task gate is `npm run typecheck:examples`, which type-checks every example against live `src/` and is the real guard against API drift. The two parse examples (`parse-packet`, `parse-advert`) run with **no hardware** and produce deterministic output, so they are additionally *run* to verify. Hardware-dependent examples are verified by typecheck + manual run against a device.

**Tech Stack:** TypeScript, `tsx`, `serialport`, `@stoprocent/noble` (a maintained, TypeScript-first noble fork), the existing `@andyshinn/meshcore-ts` source.

---

## File Structure

```
examples/
  README.md                    # run instructions + example table + finding your port
  tsconfig.json                # extends ../tsconfig.json; paths alias; includes examples + src
  lib/
    helpers.ts                 # requireArg(argv, index, usage); waitForEvent(session, event, opts)
  parse-packet.ts              # no hardware
  parse-advert.ts              # no hardware
  get-contacts.ts
  send-contact-message.ts
  send-channel-message.ts
  echo-bot.ts
  command-bot.ts
  sign-data.ts
  get-repeater-status.ts
  get-repeater-telemetry.ts
  get-repeater-neighbours.ts
  get-sensor-telemetry.ts
  ble-get-contacts.ts          # BLE via @stoprocent/noble
```

Root `package.json` gains devDeps (`serialport`, `@stoprocent/noble`, `tsx`) and scripts (`example`, `typecheck:examples`). Root `README.md` gains an "Examples" section. Library source, `build`, `typecheck`, and root `tsconfig.json` are untouched.

---

## Task 1: Scaffold — deps, tsconfig, scripts, shared helpers

**Files:**
- Modify: `package.json` (devDependencies + scripts)
- Create: `examples/tsconfig.json`
- Create: `examples/lib/helpers.ts`

- [ ] **Step 1: Add devDependencies and scripts to `package.json`**

Add to `devDependencies` (alphabetical placement to match the existing block):

```jsonc
"@stoprocent/noble": "^1.12.0",
"serialport": "^13.0.0",
"tsx": "^4.19.2",
```

Add to `scripts`:

```jsonc
"example": "tsx",
"typecheck:examples": "tsc -p examples/tsconfig.json",
```

- [ ] **Step 2: Install**

Run: `npm install`
Expected: completes; `node_modules/tsx`, `node_modules/serialport`, `node_modules/@stoprocent/noble` exist.

- [ ] **Step 3: Create `examples/tsconfig.json`**

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

- [ ] **Step 4: Create `examples/lib/helpers.ts`**

```ts
import type { MeshCoreEventMap, MeshCoreSession } from '@andyshinn/meshcore-ts';

/** Read a required positional CLI arg; print `usage` and exit(1) if absent. */
export function requireArg(argv: string[], index: number, usage: string): string {
  const value = argv[index];
  if (!value) {
    console.error(usage);
    process.exit(1);
  }
  return value;
}

/**
 * Resolve with a typed event's arguments the next time it fires (optionally
 * gated by `predicate`); reject on timeout. Always removes its listener.
 * Used for the event-driven repeater request/response flows.
 */
export function waitForEvent<K extends keyof MeshCoreEventMap>(
  session: MeshCoreSession,
  event: K,
  opts: {
    predicate?: (...args: Parameters<MeshCoreEventMap[K]>) => boolean;
    timeoutMs?: number;
  } = {},
): Promise<Parameters<MeshCoreEventMap[K]>> {
  const { predicate, timeoutMs = 15_000 } = opts;
  return new Promise((resolve, reject) => {
    const listener = ((...args: Parameters<MeshCoreEventMap[K]>) => {
      if (predicate && !predicate(...args)) return;
      cleanup();
      resolve(args);
    }) as MeshCoreEventMap[K];

    const cleanup = (): void => {
      clearTimeout(timer);
      session.events.off(event, listener);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for '${String(event)}' after ${timeoutMs}ms`));
    }, timeoutMs);

    session.events.on(event, listener);
  });
}
```

- [ ] **Step 5: Verify typecheck passes**

Run: `npm run typecheck:examples`
Expected: PASS (exit 0, no output). This compiles `helpers.ts` against live `src/` and proves the `paths` alias resolves.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json examples/tsconfig.json examples/lib/helpers.ts
git commit -m "build(examples): scaffold examples project (deps, tsconfig paths, helpers)"
```

---

## Task 2: Parse examples (no hardware, deterministic)

**Files:**
- Create: `examples/parse-packet.ts`
- Create: `examples/parse-advert.ts`

These talk to no device. `parseMeshPacket(bytes)` returns a `MeshPacketHeader` whose `.payload` is the body; `parseAdvert(payload)` decodes an advert. The hex/URL constants are copied verbatim from meshcore.js's `parse_packet.js` / `parse_advert.js` so output is deterministic.

- [ ] **Step 1: Create `examples/parse-packet.ts`**

```ts
import { Buffer } from 'node:buffer';
import { parseMeshPacket } from '@andyshinn/meshcore-ts';

// Raw mesh-packet bytes (from meshcore.js examples/parse_packet.js).
const bytes = Buffer.from('0200B401DF6528CC9778A56F36FE9399A5CF6B0C7EDE', 'hex');

const header = parseMeshPacket(bytes);
if (!header) {
  console.error('Failed to parse mesh packet');
  process.exit(1);
}
console.dir(header, { depth: null });
```

- [ ] **Step 2: Create `examples/parse-advert.ts`**

```ts
import { Buffer } from 'node:buffer';
import { parseAdvert, parseMeshPacket } from '@andyshinn/meshcore-ts';

// A meshcore:// advert URL (from meshcore.js examples/parse_advert.js).
const advertUrl =
  'meshcore://1100e04b135959ffac9397b600add84822cb8bf4a050a7f40965dd1ab7aea3ddd3743327e668b5db95bc8fbc3894b115415d6e4cca36f9c9e62e923afd37c3e2a154b27b0c53b6cfddd45bb3faf56fdaf08860d985ca2da44f9dcac1d7d76fc2b86d7b26e004814c69616d20436f74746c6520f09fa4a0';
const advertHex = advertUrl.replace('meshcore://', '');
const bytes = Buffer.from(advertHex, 'hex');

const packet = parseMeshPacket(bytes);
if (!packet) {
  console.error('Failed to parse mesh packet from advert URL');
  process.exit(1);
}

const advert = parseAdvert(packet.payload);
if (!advert) {
  console.error('Failed to parse advert from packet payload');
  process.exit(1);
}
console.dir(advert, { depth: null });
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck:examples`
Expected: PASS.

- [ ] **Step 4: Run both (no hardware needed)**

Run: `npm run example examples/parse-packet.ts`
Expected: prints a `MeshPacketHeader` object (fields `routeType`, `payloadType`, `pathHex`, `payload`, …); exits 0.

Run: `npm run example examples/parse-advert.ts`
Expected: prints an `Advert` object including `publicKeyHex`, `timestampUnix`, and `appData` with the advertised name; exits 0.

> If `parse-advert` prints "Failed to parse advert", the advert URL's payload offset differs from expectation — fall back to `parseContactBlob(packet.payload)` and re-run. (Library has both `parseAdvert` and `parseContactBlob`.)

- [ ] **Step 5: Commit**

```bash
git add examples/parse-packet.ts examples/parse-advert.ts
git commit -m "docs(examples): parse-packet + parse-advert (no hardware)"
```

---

## Task 3: get-contacts

**Files:**
- Create: `examples/get-contacts.ts`

Uses the active re-fetch getter `await session.getContacts()`. `SerialTransport` flips to `connected` on the port's `open` event, which triggers the session handshake; `getContacts()` awaits the sync internally.

- [ ] **Step 1: Create `examples/get-contacts.ts`**

```ts
import { SerialPort } from 'serialport';
import { MeshCoreSession } from '@andyshinn/meshcore-ts';
import { SerialTransport } from '@andyshinn/meshcore-ts/transports';
import { requireArg } from './lib/helpers';

const path = requireArg(
  process.argv,
  2,
  'usage: npm run example examples/get-contacts.ts <serial-port>',
);

const port = new SerialPort({ path, baudRate: 115200 });
const session = new MeshCoreSession({ transport: new SerialTransport(port) });

session.events.on('transportState', async (state) => {
  if (state !== 'connected') return;
  console.log('Connected');
  try {
    const contacts = await session.getContacts();
    for (const contact of contacts) {
      console.log(`Contact: ${contact.name} (${contact.publicKeyHex.slice(0, 12)}…)`);
    }
  } catch (err) {
    console.error('Failed to fetch contacts:', err);
  } finally {
    session.stop();
    port.close();
  }
});

session.start();
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck:examples`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add examples/get-contacts.ts
git commit -m "docs(examples): get-contacts over serial"
```

---

## Task 4: send-contact-message + send-channel-message

**Files:**
- Create: `examples/send-contact-message.ts`
- Create: `examples/send-channel-message.ts`

`findContactByName` / `findChannelByName` read current state, so each example first `await`s the active getter to ensure state is populated. DM send state is tracked via the `messageState` event.

- [ ] **Step 1: Create `examples/send-contact-message.ts`**

```ts
import { SerialPort } from 'serialport';
import { MeshCoreSession } from '@andyshinn/meshcore-ts';
import { SerialTransport } from '@andyshinn/meshcore-ts/transports';
import { requireArg, waitForEvent } from './lib/helpers';

const usage =
  'usage: npm run example examples/send-contact-message.ts <serial-port> <contact-name> [text]';
const path = requireArg(process.argv, 2, usage);
const contactName = requireArg(process.argv, 3, usage);
const text = process.argv[4] ?? 'Hello from meshcore-ts';

const port = new SerialPort({ path, baudRate: 115200 });
const session = new MeshCoreSession({ transport: new SerialTransport(port) });

session.events.on('transportState', async (state) => {
  if (state !== 'connected') return;
  console.log('Connected');
  try {
    await session.getContacts();
    const contact = session.findContactByName(contactName);
    if (!contact) {
      console.error(`Contact not found: ${contactName}`);
      return;
    }

    const messageId = `send-${Date.now()}`;
    console.log('Sending message…');
    const result = await session.sendDmText(contact.key, text, messageId);
    if (!result.ok) {
      console.error('Send failed:', result.error);
      return;
    }

    // Wait for delivery confirmation (sent → ack), or give up after the timeout.
    const [, finalState] = await waitForEvent(session, 'messageState', {
      predicate: (id, state) => id === messageId && (state === 'ack' || state === 'failed'),
    });
    console.log(`Message ${finalState}`);
  } catch (err) {
    console.error('Error:', err);
  } finally {
    session.stop();
    port.close();
  }
});

session.start();
```

- [ ] **Step 2: Create `examples/send-channel-message.ts`**

```ts
import { SerialPort } from 'serialport';
import { MeshCoreSession } from '@andyshinn/meshcore-ts';
import { SerialTransport } from '@andyshinn/meshcore-ts/transports';
import { requireArg } from './lib/helpers';

const usage =
  'usage: npm run example examples/send-channel-message.ts <serial-port> <channel-name> [text]';
const path = requireArg(process.argv, 2, usage);
const channelName = requireArg(process.argv, 3, usage);
const text = process.argv[4] ?? 'Hello from meshcore-ts';

const port = new SerialPort({ path, baudRate: 115200 });
const session = new MeshCoreSession({ transport: new SerialTransport(port) });

session.events.on('transportState', async (state) => {
  if (state !== 'connected') return;
  console.log('Connected');
  try {
    await session.getChannels();
    const channel = session.findChannelByName(channelName);
    if (!channel) {
      console.error(`Channel not found: ${channelName}`);
      return;
    }

    console.log('Sending message…');
    const result = await session.sendChannelText(channel.key, text);
    if (!result.ok) {
      console.error('Send failed:', result.error);
      return;
    }
    console.log('Sent to channel');
  } catch (err) {
    console.error('Error:', err);
  } finally {
    session.stop();
    port.close();
  }
});

session.start();
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck:examples`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add examples/send-contact-message.ts examples/send-channel-message.ts
git commit -m "docs(examples): send-contact-message + send-channel-message"
```

---

## Task 5: echo-bot + command-bot

**Files:**
- Create: `examples/echo-bot.ts`
- Create: `examples/command-bot.ts`

The `messages` event fires `(key, fullThread)` right after an inbound DM is appended, so the new message is `messages.at(-1)`. Owner-sent messages omit `fromPublicKeyHex`; the bot replies only when it is set, and dedupes by `id` to avoid reply loops.

- [ ] **Step 1: Create `examples/echo-bot.ts`**

```ts
import { SerialPort } from 'serialport';
import { MeshCoreSession } from '@andyshinn/meshcore-ts';
import { SerialTransport } from '@andyshinn/meshcore-ts/transports';
import { requireArg } from './lib/helpers';

const path = requireArg(
  process.argv,
  2,
  'usage: npm run example examples/echo-bot.ts <serial-port>',
);

const port = new SerialPort({ path, baudRate: 115200 });
const session = new MeshCoreSession({ transport: new SerialTransport(port) });

const handled = new Set<string>();

session.events.on('transportState', async (state) => {
  if (state !== 'connected') return;
  console.log('Connected');
  await session.syncDeviceTime();
  await session.sendSelfAdvert(true);
});

session.events.on('messages', async (key, messages) => {
  const last = messages.at(-1);
  // Only inbound messages (owner sends omit fromPublicKeyHex), once each.
  if (!last || !last.fromPublicKeyHex || handled.has(last.id)) return;
  handled.add(last.id);

  console.log(`Echoing to ${key}: ${last.body}`);
  await session.sendDmText(key, last.body, `echo-${last.id}`);
});

session.start();
console.log('Echo bot running. Ctrl-C to stop.');
```

- [ ] **Step 2: Create `examples/command-bot.ts`**

```ts
import { SerialPort } from 'serialport';
import { MeshCoreSession } from '@andyshinn/meshcore-ts';
import { SerialTransport } from '@andyshinn/meshcore-ts/transports';
import { requireArg } from './lib/helpers';

const path = requireArg(
  process.argv,
  2,
  'usage: npm run example examples/command-bot.ts <serial-port>',
);

const port = new SerialPort({ path, baudRate: 115200 });
const session = new MeshCoreSession({ transport: new SerialTransport(port) });

const handled = new Set<string>();

const helpMenu = [
  '🤖 Command Bot Help',
  '/help - show this menu',
  '/ping - replies with pong',
  '/date - replies with current date',
].join('\n');

function reply(text: string): string {
  switch (text.trim()) {
    case '/ping':
      return 'PONG! 🏓';
    case '/date':
      return new Date().toISOString();
    default:
      return helpMenu;
  }
}

session.events.on('transportState', async (state) => {
  if (state !== 'connected') return;
  console.log('Connected');
  await session.syncDeviceTime();
  await session.sendSelfAdvert(true);
});

session.events.on('messages', async (key, messages) => {
  const last = messages.at(-1);
  if (!last || !last.fromPublicKeyHex || handled.has(last.id)) return;
  handled.add(last.id);

  console.log(`Command from ${key}: ${last.body}`);
  await session.sendDmText(key, reply(last.body), `cmd-${last.id}`);
});

session.start();
console.log('Command bot running. Ctrl-C to stop.');
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck:examples`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add examples/echo-bot.ts examples/command-bot.ts
git commit -m "docs(examples): echo-bot + command-bot"
```

---

## Task 6: sign-data

**Files:**
- Create: `examples/sign-data.ts`

`signData(Buffer)` resolves to a hex signature string.

- [ ] **Step 1: Create `examples/sign-data.ts`**

```ts
import { Buffer } from 'node:buffer';
import { SerialPort } from 'serialport';
import { MeshCoreSession } from '@andyshinn/meshcore-ts';
import { SerialTransport } from '@andyshinn/meshcore-ts/transports';
import { requireArg } from './lib/helpers';

const usage = 'usage: npm run example examples/sign-data.ts <serial-port> [text]';
const path = requireArg(process.argv, 2, usage);
const text = process.argv[3] ?? 'meshcore-ts';

const port = new SerialPort({ path, baudRate: 115200 });
const session = new MeshCoreSession({ transport: new SerialTransport(port) });

session.events.on('transportState', async (state) => {
  if (state !== 'connected') return;
  console.log('Connected');
  try {
    const signature = await session.signData(Buffer.from(text, 'utf8'));
    console.log(`Signature: ${signature}`);
  } catch (err) {
    console.error('Sign failed:', err);
  } finally {
    session.stop();
    port.close();
  }
});

session.start();
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck:examples`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add examples/sign-data.ts
git commit -m "docs(examples): sign-data over serial"
```

---

## Task 7: Repeater examples (status, telemetry, neighbours, sensor)

**Files:**
- Create: `examples/get-repeater-status.ts`
- Create: `examples/get-repeater-telemetry.ts`
- Create: `examples/get-repeater-neighbours.ts`
- Create: `examples/get-sensor-telemetry.ts`

`sendStatusReq` / `sendTelemetryReq` return `{ ok }`; the data arrives on the `repeaterStatus` / `repeaterTelemetry` events (use `waitForEvent`). `repeaterRequestNeighbours` returns a `NeighboursPage` directly. The target is selected by public-key prefix via `findContactByPublicKeyPrefix`.

- [ ] **Step 1: Create `examples/get-repeater-status.ts`**

```ts
import { SerialPort } from 'serialport';
import { MeshCoreSession } from '@andyshinn/meshcore-ts';
import { SerialTransport } from '@andyshinn/meshcore-ts/transports';
import { requireArg, waitForEvent } from './lib/helpers';

const usage =
  'usage: npm run example examples/get-repeater-status.ts <serial-port> <pubkey-prefix-hex> [password]';
const path = requireArg(process.argv, 2, usage);
const prefix = requireArg(process.argv, 3, usage);
const password = process.argv[4] ?? '';

const port = new SerialPort({ path, baudRate: 115200 });
const session = new MeshCoreSession({ transport: new SerialTransport(port) });

session.events.on('transportState', async (state) => {
  if (state !== 'connected') return;
  console.log('Connected');
  try {
    await session.getContacts();
    const repeater = session.findContactByPublicKeyPrefix(prefix);
    if (!repeater) {
      console.error(`Repeater not found for prefix: ${prefix}`);
      return;
    }

    console.log('Logging in…');
    await session.repeaterLogin(repeater.key, password);

    console.log('Fetching status…');
    const sent = await session.sendStatusReq(repeater.key);
    if (!sent.ok) {
      console.error('Status request failed:', sent.error);
      return;
    }
    const [status] = await waitForEvent(session, 'repeaterStatus');
    console.dir(status, { depth: null });
  } catch (err) {
    console.error('Error:', err);
  } finally {
    session.stop();
    port.close();
  }
});

session.start();
```

- [ ] **Step 2: Create `examples/get-repeater-telemetry.ts`**

```ts
import { SerialPort } from 'serialport';
import { MeshCoreSession } from '@andyshinn/meshcore-ts';
import { SerialTransport } from '@andyshinn/meshcore-ts/transports';
import { requireArg, waitForEvent } from './lib/helpers';

const usage =
  'usage: npm run example examples/get-repeater-telemetry.ts <serial-port> <pubkey-prefix-hex> [password]';
const path = requireArg(process.argv, 2, usage);
const prefix = requireArg(process.argv, 3, usage);
const password = process.argv[4] ?? '';

const port = new SerialPort({ path, baudRate: 115200 });
const session = new MeshCoreSession({ transport: new SerialTransport(port) });

session.events.on('transportState', async (state) => {
  if (state !== 'connected') return;
  console.log('Connected');
  try {
    await session.getContacts();
    const repeater = session.findContactByPublicKeyPrefix(prefix);
    if (!repeater) {
      console.error(`Repeater not found for prefix: ${prefix}`);
      return;
    }

    console.log('Logging in…');
    await session.repeaterLogin(repeater.key, password);

    console.log('Fetching telemetry…');
    const sent = await session.sendTelemetryReq(repeater.key);
    if (!sent.ok) {
      console.error('Telemetry request failed:', sent.error);
      return;
    }
    const [telemetry] = await waitForEvent(session, 'repeaterTelemetry');
    console.dir(telemetry, { depth: null });
  } catch (err) {
    console.error('Error:', err);
  } finally {
    session.stop();
    port.close();
  }
});

session.start();
```

- [ ] **Step 3: Create `examples/get-repeater-neighbours.ts`**

```ts
import { SerialPort } from 'serialport';
import { MeshCoreSession } from '@andyshinn/meshcore-ts';
import { SerialTransport } from '@andyshinn/meshcore-ts/transports';
import { requireArg } from './lib/helpers';

const usage =
  'usage: npm run example examples/get-repeater-neighbours.ts <serial-port> <pubkey-prefix-hex> [password]';
const path = requireArg(process.argv, 2, usage);
const prefix = requireArg(process.argv, 3, usage);
const password = process.argv[4] ?? '';

const port = new SerialPort({ path, baudRate: 115200 });
const session = new MeshCoreSession({ transport: new SerialTransport(port) });

session.events.on('transportState', async (state) => {
  if (state !== 'connected') return;
  console.log('Connected');
  try {
    await session.getContacts();
    const repeater = session.findContactByPublicKeyPrefix(prefix);
    if (!repeater) {
      console.error(`Repeater not found for prefix: ${prefix}`);
      return;
    }

    console.log('Logging in…');
    await session.repeaterLogin(repeater.key, password);

    console.log('Fetching neighbours…');
    const page = await session.repeaterRequestNeighbours(repeater.key);
    console.dir(page, { depth: null });
  } catch (err) {
    console.error('Error:', err);
  } finally {
    session.stop();
    port.close();
  }
});

session.start();
```

- [ ] **Step 4: Create `examples/get-sensor-telemetry.ts`**

```ts
import { SerialPort } from 'serialport';
import { MeshCoreSession } from '@andyshinn/meshcore-ts';
import { SerialTransport } from '@andyshinn/meshcore-ts/transports';
import { requireArg, waitForEvent } from './lib/helpers';

const usage =
  'usage: npm run example examples/get-sensor-telemetry.ts <serial-port> <pubkey-prefix-hex>';
const path = requireArg(process.argv, 2, usage);
const prefix = requireArg(process.argv, 3, usage);

const port = new SerialPort({ path, baudRate: 115200 });
const session = new MeshCoreSession({ transport: new SerialTransport(port) });

session.events.on('transportState', async (state) => {
  if (state !== 'connected') return;
  console.log('Connected');
  try {
    await session.getContacts();
    const sensor = session.findContactByPublicKeyPrefix(prefix);
    if (!sensor) {
      console.error(`Sensor not found for prefix: ${prefix}`);
      return;
    }

    // Sensors answer telemetry without a login.
    console.log('Fetching telemetry…');
    const sent = await session.sendTelemetryReq(sensor.key);
    if (!sent.ok) {
      console.error('Telemetry request failed:', sent.error);
      return;
    }
    const [telemetry] = await waitForEvent(session, 'repeaterTelemetry');
    console.dir(telemetry, { depth: null });
  } catch (err) {
    console.error('Error:', err);
  } finally {
    session.stop();
    port.close();
  }
});

session.start();
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck:examples`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add examples/get-repeater-status.ts examples/get-repeater-telemetry.ts examples/get-repeater-neighbours.ts examples/get-sensor-telemetry.ts
git commit -m "docs(examples): repeater status/telemetry/neighbours + sensor telemetry"
```

---

## Task 8: ble-get-contacts (BLE via noble)

**Files:**
- Create: `examples/ble-get-contacts.ts`

The only BLE example, so the `@stoprocent/noble` scan/connect/discover flow is inlined here. It builds a transport with `createBleTransport` and then does the same "get contacts" action as Task 3, over BLE.

`@stoprocent/noble` is a maintained noble fork that ships TypeScript types (exporting `Peripheral`, `Characteristic`, `ServicesAndCharacteristics`, …) and a promise-first API (`waitForPoweredOnAsync`, `*Async` methods). The example is fully typed — no `any`, no ambient shim.

- [ ] **Step 1: Create `examples/ble-get-contacts.ts`**

```ts
import { Buffer } from 'node:buffer';
import noble, { type Characteristic, type Peripheral } from '@stoprocent/noble';
import { MeshCoreSession } from '@andyshinn/meshcore-ts';
import { createBleTransport, NORDIC_UART } from '@andyshinn/meshcore-ts/transports';

// noble compares 128-bit UUIDs without dashes, lowercased.
const toNoble = (uuid: string): string => uuid.replace(/-/g, '').toLowerCase();
const SERVICE = toNoble(NORDIC_UART.service);
const RX = toNoble(NORDIC_UART.rxWrite); // host → device
const TX = toNoble(NORDIC_UART.txNotify); // device → host

async function main(): Promise<void> {
  await noble.waitForPoweredOnAsync();

  console.log('Scanning for a MeshCore device…');
  await noble.startScanningAsync([SERVICE], false);

  const peripheral = await new Promise<Peripheral>((resolve) => {
    noble.once('discover', resolve);
  });
  await noble.stopScanningAsync();

  console.log(`Connecting to ${peripheral.advertisement?.localName ?? peripheral.id}…`);
  await peripheral.connectAsync();

  const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
    [SERVICE],
    [RX, TX],
  );
  const rxChar = characteristics.find((c: Characteristic) => c.uuid === RX);
  const txChar = characteristics.find((c: Characteristic) => c.uuid === TX);
  if (!rxChar || !txChar) {
    console.error('MeshCore characteristics not found on device');
    await peripheral.disconnectAsync();
    return;
  }

  const transport = createBleTransport({
    write: (bytes) => rxChar.writeAsync(Buffer.from(bytes), true),
    subscribe: (onBytes) => {
      txChar.on('data', (data: Buffer) => onBytes(new Uint8Array(data)));
      void txChar.subscribeAsync();
    },
    watchState: (onState) => {
      peripheral.once('disconnect', () => onState('idle'));
    },
  });

  const session = new MeshCoreSession({ transport });
  session.events.on('owner', (owner) => console.log('Device:', owner?.name));
  session.start();

  try {
    const contacts = await session.getContacts();
    for (const contact of contacts) {
      console.log(`Contact: ${contact.name} (${contact.publicKeyHex.slice(0, 12)}…)`);
    }
  } finally {
    session.stop();
    await peripheral.disconnectAsync();
  }
}

main().catch((err) => {
  console.error('BLE example failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck:examples`
Expected: PASS.

> If `noble.once('discover', resolve)` flags a listener-arity type error, widen with `noble.once('discover', (p: Peripheral) => resolve(p))`. If a `node-gyp`/prebuild install error occurs for `@stoprocent/noble`, that affects *running* the BLE example only — typecheck still passes against the shipped `.d.ts`.

- [ ] **Step 3: Commit**

```bash
git add examples/ble-get-contacts.ts
git commit -m "docs(examples): ble-get-contacts (createBleTransport + @stoprocent/noble)"
```

---

## Task 9: Documentation

**Files:**
- Create: `examples/README.md`
- Modify: `README.md` (add an "Examples" section)

- [ ] **Step 1: Create `examples/README.md`**

````markdown
# Examples

Runnable examples for `@andyshinn/meshcore-ts`, ported from
[meshcore.js](https://github.com/liamcottle/meshcore.js). They use the library's
built-in transports (`SerialTransport`, `createBleTransport`) and run with `tsx`
against the local source — no build step.

## Running

```
npm run example examples/<file>.ts [args]
```

Most examples take your device's serial port as the first argument:

```
npm run example examples/get-contacts.ts /dev/cu.usbmodemXXXX
```

Finding your serial port:

- **macOS:** `ls /dev/cu.usbmodem*`
- **Linux:** `ls /dev/ttyACM* /dev/ttyUSB*`
- **Windows:** a `COM<n>` port (Device Manager → Ports)

## The examples

| Example | Needs device? | What it does |
| --- | --- | --- |
| `parse-packet.ts` | no | Parse raw mesh-packet bytes |
| `parse-advert.ts` | no | Parse an advert from a `meshcore://` URL |
| `get-contacts.ts` | serial | List the device's contacts |
| `send-contact-message.ts <port> <name> [text]` | serial | DM a contact found by name |
| `send-channel-message.ts <port> <channel> [text]` | serial | Post to a channel found by name |
| `echo-bot.ts` | serial | Echo every incoming DM back to the sender |
| `command-bot.ts` | serial | Reply to `/ping`, `/date`, `/help` |
| `sign-data.ts <port> [text]` | serial | Sign data with the device key |
| `get-repeater-status.ts <port> <pubkey-prefix> [pw]` | serial | Login + fetch repeater status |
| `get-repeater-telemetry.ts <port> <pubkey-prefix> [pw]` | serial | Login + fetch repeater telemetry |
| `get-repeater-neighbours.ts <port> <pubkey-prefix> [pw]` | serial | Login + fetch repeater neighbours |
| `get-sensor-telemetry.ts <port> <pubkey-prefix>` | serial | Fetch sensor telemetry (no login) |
| `ble-get-contacts.ts` | BLE | List contacts over BLE (requires `@stoprocent/noble`) |

The two parse examples run with no hardware and print deterministic output.
````

- [ ] **Step 2: Add an "Examples" section to root `README.md`**

Insert before the `## Scripts` section:

```markdown
## Examples

Runnable examples live in [`examples/`](examples/) — the meshcore.js example set
ported onto `MeshCoreSession` using the built-in serial and BLE transports. Run
any of them with `tsx` (no build step):

```
npm run example examples/get-contacts.ts /dev/cu.usbmodemXXXX
```

See [`examples/README.md`](examples/README.md) for the full list. The
`parse-packet` / `parse-advert` examples run with no hardware.
```

- [ ] **Step 3: Verify typecheck still clean**

Run: `npm run typecheck:examples`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add examples/README.md README.md
git commit -m "docs(examples): README + examples index"
```

---

## Final verification

- [ ] Run `npm run typecheck:examples` → PASS (all 13 examples compile against live `src/`).
- [ ] Run `npm run example examples/parse-packet.ts` → prints a packet header.
- [ ] Run `npm run example examples/parse-advert.ts` → prints an advert with a name.
- [ ] Run `npm run typecheck` and `npm test` → still PASS (library untouched; confirms no regressions).
- [ ] Run `npm run lint` → PASS (or fix formatting with `npm run format`).
