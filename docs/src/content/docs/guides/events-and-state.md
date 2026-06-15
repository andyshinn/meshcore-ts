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
session.events.on('owner', (owner) => console.log('this device:', owner?.name));
session.events.on('contacts', (contacts) => persistContacts(contacts));
session.events.on('syncProgress', (p) => console.log(p.phase, p.contacts));

session.start();
transport.setState('connected');
```

## The events

`transportState`, `channels`, `channelPresence`, `syncProgress`, `contacts`,
`discovered`, `contactEvicted`, `contactDiscovered`, `messages`, `messageState`,
`messagePathHeard`, `owner`, `radioSettings`, `repeaterStatus`,
`repeaterTelemetry`, `pathLearned`, `deviceIdentity`, `autoAddConfig`,
`telemetryPolicy`, `gpsConfig`, `deviceInfo`, `deviceCapabilities`.

All payloads are exported types — see `MeshCoreEventMap` in the
[API reference](../../api/readme/).

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
