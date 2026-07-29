---
title: Events & state
description: Subscribe to the typed event emitter and read the in-memory state model.
---

You don't inject events or state — the session creates them and exposes them:

- `session.events` — a typed emitter. Subscribe with `session.events.on('contacts', cb)`.
- `session.state` — the in-memory model. Read with `session.state.getContacts()`,
  `getChannels()`, `getOwner()`, `getMessagesForKey(key)`, and friends.

## Subscribe before connecting

Subscribe **before** driving the transport to `connected` so you observe the
full handshake and initial sync:

```ts
import { Ports } from '@andyshinn/meshcore-ts';

session.events.on('owner', (owner) => console.log('this device:', owner?.name));
session.events.on('contacts', (contacts) => persistContacts(contacts));
session.events.on('syncProgress', (p) => console.log(p.phase, p.contacts));

// Named constants are available for every event key — both forms are equivalent:
session.events.on(Ports.EventName.RAW_PACKET, (pkt) => { /* … */ });
// equivalent to: session.events.on('rawPacket', (pkt) => { … })

session.start();
transport.setState('connected');
```

## The events

`transportState`, `rawPacket`, `channels`, `channelPresence`, `syncProgress`,
`contacts`, `discovered`, `contactEvicted`, `contactDiscovered`, `contactsFull`,
`contactObserved`, `messages`, `messageUpserted`, `messageState`,
`messagePathHeard`, `cliSendState`, `cliUnmatched`, `owner`, `radioSettings`,
`repeaterStatus`, `repeaterTelemetry`, `pathLearned`, `deviceIdentity`,
`autoAddConfig`, `telemetryPolicy`, `gpsConfig`, `deviceInfo`,
`deviceCapabilities`.

All payloads are exported types — see `Ports.EventMap` in the
[API reference](../../api/readme/).

## CLI sends are not DMs

A repeater CLI command (`repeaterSendCli`) travels as a direct message on the
wire, so it takes a slot in the same send queue a DM does. It is not a message
though, and it never appears on `messageState` — its wire progress reports on
`cliSendState` instead:

```ts
session.events.on('cliSendState', ({ id, contactKey, state }) => {
  // state: 'sent' (radio transmitted) | 'ack' (repeater received) | 'failed'
});
```

A CLI reply that matches no outstanding command — a late answer to one that
timed out or was cancelled, or unsolicited repeater output — is never inserted
into the message store. It surfaces on `cliUnmatched`:

```ts
session.events.on('cliUnmatched', ({ contactKey, body }) => {
  // contactKey is undefined when the sender prefix matches no known contact
});
```

Commands that never answer — `reboot`, `poweroff`, `clkreboot`, `start ota` —
should be sent with `expectReply: false`, which resolves as soon as the radio
confirms the send rather than waiting out the full reply timeout:

```ts
import { Models } from '@andyshinn/meshcore-ts';

await session.repeaterSendCli(key, 'reboot', { expectReply: false });

// Bound or cancel a command that does expect an answer. The defaults are
// Models.CLI_REPLY_TIMEOUT_MS and Models.ADMIN_SENT_TIMEOUT_MS.
const ac = new AbortController();
const reply = session.repeaterSendCli(key, 'ver', {
  timeoutMs: Models.CLI_REPLY_TIMEOUT_MS,
  signal: ac.signal,
});
```

There is intentionally no generic `error` event. Specific recoverable
conditions get their own dedicated event instead — for example `contactsFull`
fires when the radio's contact store is full and a new advert could not be
auto-added. Adapters can bridge such events onto their own error/toast channel.

`rawPacket` carries the raw on-air bytes of each received LoRa packet; pair it
with `decodeOnAirPacket` to structurally decode them — see
[Decoding on-air packets](../decoding-packets/).

## What the session can do

Beyond messaging, the session covers contacts & paths (`getContactByKey`,
`setContactPath`, `addContactToRadio`, `setContactFavourite`, …), channels
(`setChannel`, `pickFreeSlot`, `deriveSecret`, …), radio/device settings
(`setRadioParams`, `setAdvertName`, `setGpsConfig`, `reboot`, …), time
(`getDeviceTime` / `setDeviceTime` / `syncDeviceTime`), device admin & signing
(`exportPrivateKey`, `setDevicePin`, `factoryReset`, `signData`), path
diagnostics & raw frames (`sendPathDiscoveryReq`, `sendRawData`, …), and
repeater administration (`repeaterLogin`, `repeaterSendCli`, `repeaterTracePath`,
`sendStatusReq`, `sendTelemetryReq`, …).

See the [API reference](../../api/readme/) for the complete, typed surface.
