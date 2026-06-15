---
title: Getting started
description: Install meshcore-ts, construct a session, and send your first message.
---

`meshcore-ts` speaks the MeshCore **companion-radio** wire protocol — the framing
a phone or desktop app uses to talk to a MeshCore device over BLE or serial. It
owns the protocol logic, frame parsing, the connect handshake, the DM/channel
messaging state machines, and repeater administration, and keeps an in-memory
model of contacts, channels, messages, and device state.

You bring a [Transport](../transports/) (the bytes in and out of your radio); the
library does everything above that line and emits typed events.

## Install

```sh
npm install @andyshinn/meshcore-ts
```

> **Node-only.** Uses `node:buffer` and `node:crypto`. Not a browser build.

## Construct a session and send a message

The exported `LoopbackTransport` lets you run the whole flow without hardware —
swap it for your BLE/serial adapter later.

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
```

## What happens on connect

When your transport reports `connected`, the session runs the connect handshake
for you and emits events as state arrives. Subscribe before calling
`transport.setState('connected')` so you observe the full sync.

Next steps:

- [Implement a Transport](../transports/) for your radio.
- [Send DMs and channel messages](../messaging/) and track delivery state.
- [Browse the events and state model](../events-and-state/).
- [Full API reference](../../api/readme/).
