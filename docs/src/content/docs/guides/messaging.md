---
title: Messaging
description: Send direct and channel messages and track delivery state via events.
---

The session exposes high-level send methods and surfaces delivery progress
through the `messageState` event. You supply the message id; the session tracks
its lifecycle.

## Direct messages

```ts
// You supply the message id and track state via events:
await session.sendDmText('c:<pubkeyhex>', 'hello', 'msg-1');
```

The message moves through states surfaced via the `messageState` event:

```ts
session.events.on('messageState', (id, state) => updateBubble(id, state));
// 'sending' → 'sent' (RESP_SENT) → 'ack' (PUSH_SEND_CONFIRMED)
```

Need retries? Use `sendDmTextWithRetry`:

```ts
await session.sendDmTextWithRetry('c:<pubkeyhex>', 'are you there?', 'msg-2');
```

## Channel messages

```ts
const { ok, channelHash, timestampUnix } = await session.sendChannelText('ch:General', 'hi all');
```

Optionally attribute heard repeater relays back to your message — this emits the
`messagePathHeard` event:

```ts
if (ok && channelHash != null) {
  session.registerChannelSend({ messageId: 'msg-3', channelHash, timestampUnix });
}
```

Pass `timestampUnix` whenever you have it. The radio encrypts that timestamp into
the outgoing packet, so when a relay is heard back the library can decrypt it with
the channel secret and prove which send it belongs to. Omit it and attribution
falls back to a heuristic that cannot reliably tell two sends on the same channel
apart — send twice inside the retention window and relays of the second message
may be credited to the first.

## Reading message history

Messages are kept in the in-memory state model, keyed by conversation:

```ts
const messages = session.state.getMessagesForKey('c:<pubkeyhex>');
```

See [Events & state](../events-and-state/) for the full list of readers and
events, and the [API reference](../../api/readme/) for exact signatures.
