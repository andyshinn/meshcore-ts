# Repeater CLI console API

Three additive changes to `repeaterSendCli` so a consumer can build a real CLI
console — fire-and-forget commands, per-call timeout and cancellation, and CLI
sends kept out of the DM message-state stream.

## Motivation

`coresense` drives repeater CLI over the mesh via
`MeshCoreSession.repeaterSendCli(contactKey, command)` and is building a console
on top of it (autocomplete, client-side FIFO queue, live transcript). Three gaps
block it:

1. **Commands that never answer.** `reboot`, `poweroff`, `clkreboot` and
   `start ota` reboot or power the repeater down instead of writing a reply, and
   the firmware only transmits a reply when `strlen(reply) > 0`
   (`MyMeshRepeater.cpp:724`). Today `repeaterSendCli` always registers a
   `pendingCli` awaiter and arms `CLI_REPLY_TIMEOUT_MS`, so a *successful*
   `reboot` surfaces as a timeout rejection 30 seconds later — and the single
   per-repeater `pendingCli` slot is occupied that whole time.
2. **No per-call timeout or cancellation.** `CLI_REPLY_TIMEOUT_MS` is
   module-private, so consumers hardcode `30000` to render a countdown. A FIFO
   queue in front of a one-outstanding-command API needs to drop queued and
   in-flight work on repeater switch or user cancel; today the only way to clear
   an awaiter is to supersede it with another command.
3. **CLI sends leak into the DM stream.** A CLI send pushes a synthetic
   `cli-<base36>-<rand>` id onto the DM send FIFO so RESP_SENT/ACK bookkeeping
   advances. That id then appears in `messageState` events, indistinguishable
   from a real outbound DM, so consumers write a no-op message-state row and
   broadcast a junk frame for every CLI command.

## Public API

```ts
// src/features/repeaterAdmin.ts, re-exported as Features.RepeaterCliOptions
export interface RepeaterCliOptions {
  /** Wait for the repeater's CLI reply. Default true (current behavior). */
  expectReply?: boolean;
  /** Override the wait. Defaults to CLI_REPLY_TIMEOUT_MS when expectReply is
   *  true, ADMIN_SENT_TIMEOUT_MS when it is false. */
  timeoutMs?: number;
  /** Drop the awaiter and reject with `signal.reason` when aborted. */
  signal?: AbortSignal;
}

repeaterSendCli(
  contactKey: string,
  command: string,
  opts?: RepeaterCliOptions,
): Promise<string>
```

`opts` is optional and every field defaults to today's behavior, so existing
callers are unaffected.

### Exported timeout defaults

The three constants currently private to `repeaterAdmin.ts` move to a new
`src/model/timeouts.ts` and are re-exported by the `Models` barrel:

```ts
Models.CLI_REPLY_TIMEOUT_MS    // 30_000
Models.ADMIN_SENT_TIMEOUT_MS   //  5_000
Models.ADMIN_REPLY_TIMEOUT_MS  // 20_000
```

`repeaterAdmin.ts` imports them from that module rather than redeclaring, so
there is a single source of truth. `Models` is the right home: it already
carries policy defaults such as `DEFAULT_RADIO_SETTINGS`, and `Features` is a
type-only namespace (asserted by `tests/publicSurface.test.ts`) that cannot hold
runtime values.

### Return type

`Promise<string>` is unchanged. With `expectReply: false` it resolves `''`.
Firmware never sends an empty reply, so `''` is unambiguous.

## Send-path behavior

|                       | `expectReply: true` (default)      | `expectReply: false`               |
| --------------------- | ---------------------------------- | ---------------------------------- |
| `pendingCli` entry    | registered, as today               | none — the slot stays free         |
| reply timer           | `timeoutMs ?? CLI_REPLY_TIMEOUT_MS`| not armed                          |
| resolves with         | the repeater's reply text          | `''`                               |
| resolves on           | `RESP_CONTACT_MSG_RECV` (CLI_DATA) | `RESP_SENT`                        |
| send-confirm timer    | —                                  | `timeoutMs ?? ADMIN_SENT_TIMEOUT_MS` |

Both modes send the same `TXT_TYPE.CLI_DATA` DM and both keep their FIFO slot.

### Why RESP_SENT rather than ACK

`RESP_SENT` is the local radio confirming transmission; it always arrives. A
`PUSH_SEND_CONFIRMED` (ACK) requires the repeater to answer, and a repeater
mid-`reboot`/`poweroff` may never send one — waiting for it would reintroduce
the timeout-on-success bug this change exists to fix. The stronger signal is
still surfaced: if an ACK does land it emits `cliSendState` with `state: 'ack'`,
after the promise has already resolved.

### Timeout and abort semantics

- An already-aborted `signal` rejects before the frame is written; nothing is
  enqueued and no frame goes out.
- Abort after the write clears the `pendingCli` entry (if any) and its timer,
  then rejects with `signal.reason` — a `DOMException` named `AbortError` by
  default, or whatever reason the caller passed to `AbortController.abort()`.
  This is the standard `AbortSignal` idiom and lets a consumer distinguish
  "repeater switched" from "user cancelled".
- Timeout rejects with the existing `Error` message shape, using the effective
  timeout value: `CLI command timed out after <n>ms`. For `expectReply: false`
  the message is `CLI send was not confirmed after <n>ms`.
- **Timeout and abort never pop the DM FIFO entry.** Popping it would misalign
  the FIFO against a RESP_SENT still in flight and mis-attribute the next real
  DM's `'sent'` event. The entry drains naturally when RESP_SENT arrives, which
  emits `cliSendState` for an id whose promise is already settled — harmless.
- A write failure still dequeues (the radio will not reply with RESP_SENT, so
  the FIFO must be realigned), exactly as today.
- Abort listeners are removed on every settle path so no listener leaks onto a
  long-lived signal.

## `cliSendState` — CLI sends off the DM stream

`dmSendQueue` stays `string[]`. `DmRuntime` gains a side map:

```ts
cliSends: Map<string, { contactKey: string; onSent?: () => void }>
```

`repeaterSendCli` registers through a new `enqueueCliSend(ctx, id, meta)` in the
directMessages feature, which pushes onto `dmSendQueue` and records the entry.
All three state-emit sites consult the map before emitting:

| Site                  | DM id                                | CLI id                                     |
| --------------------- | ------------------------------------ | ------------------------------------------ |
| `handleSent`          | `messageState(id, 'sent')`           | `cliSendState({…, state: 'sent'})` + `onSent()` |
| `handleSendConfirmed` | `messageState(id, 'ack')`            | `cliSendState({…, state: 'ack'})`          |
| `failOldestDmSend`    | `messageState(id, 'failed')`         | `cliSendState({…, state: 'failed'})`       |

`ctx.state.setMessageState()` is skipped for CLI ids. It is already a no-op
(there is no message record for a synthetic id), but the skip makes the intent
explicit rather than incidental.

```ts
cliSendState: (e: {
  id: string;
  contactKey: string;
  state: 'sent' | 'ack' | 'failed';
}) => void
```

The state union is narrower than `MessageState`: `'sending'`, `'heard'` and
`'received'` cannot occur for a CLI send. `contactKey` is carried because it is
more useful to a console than the synthetic id.

`handleSent`'s `onSent` hook is what resolves the `expectReply: false` promise —
the same seam that routes the event also completes the send.

Map entries are freed when a CLI send reaches `'ack'` or `'failed'`, when
`handleSent` sees `expected_ack == 0` (no ACK will follow), on the existing
`ACK_RETENTION_MS` timer otherwise, and by `resetDmState` on disconnect.

**After this change `messageState` fires only for real outbound DMs.**

## `cliUnmatched` — late and unsolicited CLI replies

Today a CLI reply with no pending awaiter falls through
`directMessages.ts:371` into the DM message store as a normal received message,
and synthesises a placeholder contact when the sender prefix is unknown. A queue
with cancellation hits this constantly: every timed-out or cancelled command
whose repeater answers late writes a junk row.

When `onCliReply` returns false, the frame is no longer inserted into the
message store. It emits instead:

```ts
cliUnmatched: (e: {
  contactKey?: string;
  senderPrefixHex: string;
  body: string;
  receivedAt: number;
}) => void
```

`contactKey` is populated when the prefix matches a known contact and absent
otherwise. No synthetic placeholder contact is created for CLI traffic. The
existing drain pump (`drain.pumpAfterRecv`) still runs, so message draining is
unaffected.

## Event registration

Both events are added to `MeshCoreEventMap` and to the `EventName` constant map
(`CLI_SEND_STATE: 'cliSendState'`, `CLI_UNMATCHED: 'cliUnmatched'`) — the
compile-time drift guard in `ports/events.ts` requires the pair. Their payload
types live in `model/types.ts` alongside the other event payload shapes, so they
are reachable as `Models.CliSendStateEvent` and `Models.CliUnmatchedEvent`.

## Testing

**`tests/features/repeaterAdmin.test.ts`**

- `expectReply: false` registers no `pendingCli` entry and arms no reply timer.
- `expectReply: false` resolves `''` when RESP_SENT pops its FIFO entry.
- `expectReply: false` rejects when RESP_SENT does not arrive within the
  send-confirm timeout.
- `timeoutMs` overrides the default reply timeout in both directions.
- An already-aborted signal rejects without writing a frame.
- Abort after the write rejects with `signal.reason`, clears the `pendingCli`
  entry, and leaves `dmSendQueue` intact.
- A reply-timeout leaves `dmSendQueue` intact.
- Default behavior (no `opts`) is byte-for-byte what it is today.

**`tests/features/directMessages.test.ts`**

- RESP_SENT for a CLI id emits `cliSendState` and not `messageState`.
- PUSH_SEND_CONFIRMED for a CLI id emits `cliSendState` with `'ack'`.
- `failOldestDmSend` on a CLI id emits `cliSendState` with `'failed'`.
- Interleaved DM and CLI sends each route to the right channel in FIFO order.
- An unmatched CLI_DATA reply emits `cliUnmatched`, inserts no message, and
  creates no placeholder contact.
- `cliSends` entries are freed on terminal states and by `resetDmState`.

**`tests/integration/inbound/repeater-admin.test.ts`**

- End-to-end `expectReply: false` over a loopback session.
- End-to-end cancellation via `AbortController`.

**`tests/publicSurface.test.ts`**

- The three timeout constants are reachable on `Models`.
- `Ports.EventName.CLI_SEND_STATE` / `CLI_UNMATCHED` resolve.
- `Features` remains type-only.

## Documentation

- `docs/src/content/docs/guides/events-and-state.md` — document `cliSendState`
  and `cliUnmatched`, and note that `messageState` no longer carries CLI ids.
- `README.md` — mention the `repeaterSendCli` options bag in the method list.

## Out of scope

- Adding `timeoutMs`/`signal` to the other admin calls. `sendBinaryRequest`
  already takes `timeoutMs`; the rest are unchanged.
- Any queueing or serialisation inside the library. The one-outstanding-CLI-per-
  repeater constraint stands; the consumer owns the FIFO.
- The pre-existing hazard where a concurrent admin request's RESP_SENT can be
  mis-attributed, since `onSentTag` gets first crack at every RESP_SENT.

## Compatibility

Additive except for two behavior changes agreed during design:

1. CLI ids no longer appear on `messageState`; they move to `cliSendState`.
2. Unmatched CLI replies no longer land in the DM message store; they move to
   `cliUnmatched`.

Both are the fixes being asked for. No existing method signature changes and no
export is removed.
