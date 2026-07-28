# Repeater CLI Console API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `repeaterSendCli` with a fire-and-forget mode, per-call timeout and cancellation, and route CLI sends off the DM message-state stream onto dedicated events.

**Architecture:** An options bag (`RepeaterCliOptions`) is threaded through `repeaterSendCli`; the module-private timeout constants move to `src/model/timeouts.ts` and become public via the `Models` namespace. CLI sends keep their slot on the DM send FIFO (`dmSendQueue` stays `string[]`) but are tagged in a new `DmRuntime.cliSends` side map, which every state-emit site consults to route to `cliSendState` instead of `messageState`. A `RESP_SENT`-driven `onSent` hook on that map entry is what resolves a fire-and-forget send.

**Tech Stack:** TypeScript (ESM, `strict`), vitest, biome, pnpm, Node ≥22.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-28-repeater-cli-console-api-design.md`.
- Branch: `repeater-cli-console-api` (already created and checked out).
- `repeaterSendCli`'s return type stays `Promise<string>`. Fire-and-forget resolves `''`.
- `opts` is optional and every field defaults to today's behavior — existing callers must be unaffected.
- `dmSendQueue` stays `string[]`. Fourteen existing assertions in `tests/features/directMessages.test.ts` depend on that shape; do not change it to an object array.
- Timeout and abort **never** pop the DM send FIFO entry. Only a write failure dequeues.
- Package manager is pnpm. Run tests with `pnpm test`, types with `pnpm typecheck`, lint with `pnpm lint`.
- Biome sorts imports alphabetically by module path. `../model/timeouts` sorts between `../model/contacts` and `../model/types`.
- Commit after every task. Do not push.

---

### Task 1: Publish the timeout defaults on `Models`

Moves the three module-private constants out of `repeaterAdmin.ts` into their own model module so consumers can render accurate countdowns without hardcoding. Pure refactor — no behavior change.

**Files:**
- Create: `src/model/timeouts.ts`
- Modify: `src/model.ts`
- Modify: `src/features/repeaterAdmin.ts:44-46` (delete the three consts), and its import block near line 33
- Test: `tests/publicSurface.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `CLI_REPLY_TIMEOUT_MS: number` (30000), `ADMIN_SENT_TIMEOUT_MS: number` (5000), `ADMIN_REPLY_TIMEOUT_MS: number` (20000), exported from `src/model/timeouts.ts` and reachable as `Models.CLI_REPLY_TIMEOUT_MS` etc. Tasks 5 and 6 import these directly from `../model/timeouts`.

- [ ] **Step 1: Write the failing test**

Add to `tests/publicSurface.test.ts`, inside the `describe('public surface — top-level', …)` block, after the `'namespaces expose representative members'` test:

```ts
  it('exposes the admin/CLI timeout defaults on Models', () => {
    expect(pkg.Models.CLI_REPLY_TIMEOUT_MS).toBe(30_000);
    expect(pkg.Models.ADMIN_SENT_TIMEOUT_MS).toBe(5_000);
    expect(pkg.Models.ADMIN_REPLY_TIMEOUT_MS).toBe(20_000);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/publicSurface.test.ts`
Expected: FAIL — `expected undefined to be 30000`.

- [ ] **Step 3: Create the timeouts module**

Create `src/model/timeouts.ts`:

```ts
// Default timeouts for the admin / CLI request families. Public so a consumer
// can render an accurate countdown or size its own queue without hardcoding
// values that belong to the library.

/** Default wait for a repeater's CLI reply ({@link repeaterSendCli}). */
export const CLI_REPLY_TIMEOUT_MS = 30_000;

/** Default wait for the radio's RESP_SENT echo after an admin write. Also the
 *  default for a fire-and-forget CLI send, which resolves on that echo. */
export const ADMIN_SENT_TIMEOUT_MS = 5_000;

/** Default wait for a mesh-routed admin reply — binary/anon requests, login. */
export const ADMIN_REPLY_TIMEOUT_MS = 20_000;
```

- [ ] **Step 4: Re-export from the Models barrel**

In `src/model.ts`, add the export so the list stays alphabetical:

```ts
export * from './model/contacts';
export * from './model/contactTypes';
export * from './model/meshObservations';
export * from './model/timeouts';
export * from './model/types';
```

- [ ] **Step 5: Import them in repeaterAdmin instead of redeclaring**

In `src/features/repeaterAdmin.ts`, delete these three lines (currently 44-46):

```ts
const ADMIN_SENT_TIMEOUT_MS = 5_000;
const ADMIN_REPLY_TIMEOUT_MS = 20_000;
const CLI_REPLY_TIMEOUT_MS = 30_000;
```

Then add this import immediately after the `import type { Contact } from '../model/types';` line's neighbours — biome wants it between `../model/contacts` and `../model/types`:

```ts
import { contactKindToAdvType } from '../model/contacts';
import { ADMIN_REPLY_TIMEOUT_MS, ADMIN_SENT_TIMEOUT_MS, CLI_REPLY_TIMEOUT_MS } from '../model/timeouts';
import type { Contact } from '../model/types';
```

- [ ] **Step 6: Run the full suite to verify nothing regressed**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all PASS. The three constants are still used at `sendBinaryReq`, `sendAnonReq`, `sendTaggedReq`, `repeaterLogin`, `repeaterSendCli` and `repeaterGetLocalStats` — TypeScript will flag any import you missed.

- [ ] **Step 7: Commit**

```bash
git add src/model/timeouts.ts src/model.ts src/features/repeaterAdmin.ts tests/publicSurface.test.ts
git commit -m "feat: export admin/CLI timeout defaults on Models"
```

---

### Task 2: Declare the `cliSendState` and `cliUnmatched` events

Adds the payload types and event-map entries. Nothing emits them yet — Tasks 3 and 4 do. Declaring them first means the compile-time drift guard in `ports/events.ts` is satisfied before any emit site references them.

**Files:**
- Modify: `src/model/types.ts` (append after `PathLearnedEvent`, which ends at line 376)
- Modify: `src/ports/events.ts` (import block, `MeshCoreEventMap`, `EventName`)
- Test: `tests/publicSurface.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type CliSendPhase = 'sent' | 'ack' | 'failed'`
  - `interface CliSendStateEvent { id: string; contactKey: string; state: CliSendPhase }`
  - `interface CliUnmatchedEvent { contactKey?: string; senderPrefixHex: string; body: string; receivedAt: number }`
  - Event keys `cliSendState` and `cliUnmatched` on `MeshCoreEventMap`; constants `EventName.CLI_SEND_STATE` and `EventName.CLI_UNMATCHED`.
  - Task 3 emits `cliSendState`; Task 4 emits `cliUnmatched`.

- [ ] **Step 1: Write the failing test**

Add to `tests/publicSurface.test.ts`, inside `describe('public surface — top-level', …)`:

```ts
  it('registers the CLI event names', () => {
    expect(pkg.Ports.EventName.CLI_SEND_STATE).toBe('cliSendState');
    expect(pkg.Ports.EventName.CLI_UNMATCHED).toBe('cliUnmatched');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/publicSurface.test.ts`
Expected: FAIL — `expected undefined to be 'cliSendState'`.

- [ ] **Step 3: Add the payload types**

Append to `src/model/types.ts`, after the closing brace of `PathLearnedEvent` (line 376):

```ts
/** Wire progress a repeater CLI send can report. Narrower than
 *  {@link MessageState}: a CLI send is never 'sending', 'heard' or 'received'. */
export type CliSendPhase = 'sent' | 'ack' | 'failed';

/** Wire-level progress of an outgoing repeater CLI command. CLI sends occupy a
 *  DM send-FIFO slot (the radio's RESP_SENT/ACK bookkeeping doesn't distinguish
 *  them) but they are not messages — they report here rather than on
 *  `messageState`, so a consumer never mistakes one for a real outbound DM. */
export interface CliSendStateEvent {
  /** Synthetic `cli-<base36>-<rand>` id the library assigned to this send. */
  id: string;
  /** Contact the command was addressed to. */
  contactKey: string;
  state: CliSendPhase;
}

/** A CLI reply (txt_type CLI_DATA) that matched no pending awaiter — a late
 *  answer to a timed-out or cancelled command, or unsolicited repeater output.
 *  These are never inserted into the message store. */
export interface CliUnmatchedEvent {
  /** Set when the sender prefix matches a known contact; absent otherwise. No
   *  placeholder contact is synthesised for CLI traffic. */
  contactKey?: string;
  /** 6-byte sender public-key prefix, lowercase hex. */
  senderPrefixHex: string;
  body: string;
  /** Wall-clock ms at which the reply was decoded. */
  receivedAt: number;
}
```

- [ ] **Step 4: Register the events**

In `src/ports/events.ts`, add both types to the existing `import type { … } from '../model/types';` block (keep it alphabetical — `CliSendStateEvent` and `CliUnmatchedEvent` go after `Channel` and before `Contact`):

```ts
import type {
  AutoAddConfig,
  Channel,
  CliSendStateEvent,
  CliUnmatchedEvent,
  Contact,
  ContactKind,
  // …rest unchanged
```

Then in `MeshCoreEventMap`, immediately after the `messagePathHeard` entry (line 63):

```ts
  /** Wire-level progress of a repeater CLI send. CLI sends never appear on
   *  {@link MeshCoreEventMap.messageState} — that channel carries only real
   *  outbound DMs. */
  cliSendState: (e: CliSendStateEvent) => void;
  /** A CLI reply that matched no pending awaiter — a late answer to a
   *  timed-out or cancelled command, or unsolicited repeater output. */
  cliUnmatched: (e: CliUnmatchedEvent) => void;
```

And in the `EventName` const, immediately after `MESSAGE_PATH_HEARD` (line 97):

```ts
  CLI_SEND_STATE: 'cliSendState',
  CLI_UNMATCHED: 'cliUnmatched',
```

- [ ] **Step 5: Run tests and typecheck to verify they pass**

Run: `pnpm vitest run tests/publicSurface.test.ts && pnpm typecheck`
Expected: PASS. The `_EventNamesCovered` guard at `src/ports/events.ts:115` fails the build if a map key has no `EventName` constant — a clean typecheck proves both halves landed.

- [ ] **Step 6: Commit**

```bash
git add src/model/types.ts src/ports/events.ts tests/publicSurface.test.ts
git commit -m "feat: declare cliSendState and cliUnmatched events"
```

---

### Task 3: Route CLI sends to `cliSendState`

Tags CLI ids in a `DmRuntime` side map and consults it at all three state-emit sites, so `messageState` stops carrying synthetic `cli-*` ids.

**Files:**
- Modify: `src/features/directMessages.ts` (`DmRuntime`, `createDmRuntime`, `enqueueDmSend`→`enqueueCliSend`, `dequeueDmSend`, `failOldestDmSend`, `resetDmState`, `handleSent`, `handleSendConfirmed`)
- Modify: `src/features/repeaterAdmin.ts:538` (call `enqueueCliSend`)
- Test: `tests/features/directMessages.test.ts`

**Interfaces:**
- Consumes: `CliSendStateEvent` / `CliSendPhase` from Task 2.
- Produces:
  - `interface CliSendMeta { contactKey: string; onSent?: () => void }`
  - `DmRuntime.cliSends: Map<string, CliSendMeta>`
  - `enqueueCliSend(ctx: FeatureContext, id: string, meta: CliSendMeta): void`
  - `enqueueDmSend` is **removed** (it had exactly one caller, the CLI path, which now uses `enqueueCliSend`).
  - Task 6 supplies the `onSent` callback to resolve a fire-and-forget send.

- [ ] **Step 1: Add a cliSendState collector to the test harness**

In `tests/features/directMessages.test.ts`, extend `makeCtx` (lines 123-162) to also capture the new channel. Change the return type annotation and the body:

```ts
function makeCtx(): {
  ctx: FeatureContext;
  state: SessionState;
  events: MeshCoreEvents;
  writes: Buffer[];
  messageStates: Array<{ id: string; state: string }>;
  cliStates: Array<{ id: string; contactKey: string; state: string }>;
} {
  const state = new SessionState();
  const events = new MeshCoreEvents();
  const writes: Buffer[] = [];
  const messageStates: Array<{ id: string; state: string }> = [];
  const cliStates: Array<{ id: string; contactKey: string; state: string }> = [];
  events.on('messageState', (id, st) => messageStates.push({ id, state: st }));
  events.on('cliSendState', (e) => cliStates.push({ id: e.id, contactKey: e.contactKey, state: e.state }));
```

and the closing return:

```ts
  return { ctx, state, events, writes, messageStates, cliStates };
}
```

(The `ctx` literal between them is unchanged.)

- [ ] **Step 2: Write the failing tests**

Append to `tests/features/directMessages.test.ts`:

```ts
describe('directMessages: CLI sends report on cliSendState, not messageState', () => {
  it('RESP_SENT for a CLI id emits cliSendState and leaves messageState untouched', () => {
    const { ctx, state, messageStates, cliStates } = makeCtx();
    addContact(state);
    enqueueCliSend(ctx, 'cli-1', { contactKey: `c:${PK}` });
    expect(ctx.rt.dm.dmSendQueue).toEqual(['cli-1']);

    directMessagesFeature.handle(0x06, sentFrame('deadbeef'), ctx);

    expect(messageStates).toHaveLength(0);
    expect(cliStates).toEqual([{ id: 'cli-1', contactKey: `c:${PK}`, state: 'sent' }]);
    expect(ctx.rt.dm.dmSendQueue).toHaveLength(0);
    resetDmState(ctx, 'cleanup');
  });

  it('fires onSent when RESP_SENT pops the entry', () => {
    const { ctx, state } = makeCtx();
    addContact(state);
    let confirmed = 0;
    enqueueCliSend(ctx, 'cli-1', { contactKey: `c:${PK}`, onSent: () => { confirmed += 1; } });
    directMessagesFeature.handle(0x06, sentFrame('deadbeef'), ctx);
    expect(confirmed).toBe(1);
    resetDmState(ctx, 'cleanup');
  });

  it('PUSH_SEND_CONFIRMED for a CLI id emits cliSendState ack and frees the entry', () => {
    const { ctx, state, messageStates, cliStates } = makeCtx();
    addContact(state);
    enqueueCliSend(ctx, 'cli-1', { contactKey: `c:${PK}` });
    directMessagesFeature.handle(0x06, sentFrame('deadbeef'), ctx);
    directMessagesFeature.handle(0x82, confirmedFrame('deadbeef'), ctx);

    expect(messageStates).toHaveLength(0);
    expect(cliStates.map((c) => c.state)).toEqual(['sent', 'ack']);
    expect(ctx.rt.dm.cliSends.size).toBe(0);
  });

  it('failOldestDmSend on a CLI id emits cliSendState failed', () => {
    const { ctx, state, messageStates, cliStates } = makeCtx();
    addContact(state);
    enqueueCliSend(ctx, 'cli-1', { contactKey: `c:${PK}` });
    failOldestDmSend(ctx, 'disconnected');
    expect(messageStates).toHaveLength(0);
    expect(cliStates).toEqual([{ id: 'cli-1', contactKey: `c:${PK}`, state: 'failed' }]);
    expect(ctx.rt.dm.cliSends.size).toBe(0);
  });

  it('frees the CLI entry immediately when no ack will follow', () => {
    const { ctx, state } = makeCtx();
    addContact(state);
    enqueueCliSend(ctx, 'cli-1', { contactKey: `c:${PK}` });
    directMessagesFeature.handle(0x06, sentFrame('00000000'), ctx);
    expect(ctx.rt.dm.cliSends.size).toBe(0);
    expect(ctx.rt.dm.pendingDmAcks.size).toBe(0);
  });

  it('routes interleaved DM and CLI sends to their own channels in FIFO order', () => {
    const { ctx, state, messageStates, cliStates } = makeCtx();
    addContact(state);
    state.insertMessage({ id: 'm1', key: `c:${PK}`, body: 'hi', ts: 1, state: 'sending' });
    ctx.rt.dm.dmSendQueue.push('m1');
    enqueueCliSend(ctx, 'cli-1', { contactKey: `c:${PK}` });
    state.insertMessage({ id: 'm2', key: `c:${PK}`, body: 'yo', ts: 2, state: 'sending' });
    ctx.rt.dm.dmSendQueue.push('m2');

    directMessagesFeature.handle(0x06, sentFrame('aaaa0001'), ctx); // → m1
    directMessagesFeature.handle(0x06, sentFrame('aaaa0002'), ctx); // → cli-1
    directMessagesFeature.handle(0x06, sentFrame('aaaa0003'), ctx); // → m2

    expect(messageStates).toEqual([
      { id: 'm1', state: 'sent' },
      { id: 'm2', state: 'sent' },
    ]);
    expect(cliStates).toEqual([{ id: 'cli-1', contactKey: `c:${PK}`, state: 'sent' }]);
    resetDmState(ctx, 'cleanup');
  });

  it('dequeueDmSend drops the CLI tag alongside the FIFO entry', () => {
    const { ctx, state } = makeCtx();
    addContact(state);
    enqueueCliSend(ctx, 'cli-1', { contactKey: `c:${PK}` });
    dequeueDmSend(ctx, 'cli-1');
    expect(ctx.rt.dm.dmSendQueue).toHaveLength(0);
    expect(ctx.rt.dm.cliSends.size).toBe(0);
  });

  it('resetDmState clears the CLI tags after failing the queue', () => {
    const { ctx, state, cliStates } = makeCtx();
    addContact(state);
    enqueueCliSend(ctx, 'cli-1', { contactKey: `c:${PK}` });
    resetDmState(ctx, 'disconnected');
    expect(cliStates).toEqual([{ id: 'cli-1', contactKey: `c:${PK}`, state: 'failed' }]);
    expect(ctx.rt.dm.cliSends.size).toBe(0);
  });
});
```

Add `dequeueDmSend` and `enqueueCliSend` to the existing import block from `'../../src/features/directMessages'` at the top of the file (alphabetical: `dequeueDmSend` after `decodeSentAck`, `enqueueCliSend` after `directMessagesFeature`).

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run tests/features/directMessages.test.ts`
Expected: FAIL — `enqueueCliSend` is not exported.

- [ ] **Step 4: Add the CLI side map to DmRuntime**

In `src/features/directMessages.ts`, replace the `DmRuntime` interface and `createDmRuntime` (lines 29-43) with:

```ts
/** A CLI send's identity on the DM send FIFO. */
export interface CliSendMeta {
  /** Contact the command was addressed to — carried on every `cliSendState`. */
  contactKey: string;
  /** Fired when RESP_SENT pops this id off the FIFO. A fire-and-forget CLI
   *  send (`expectReply: false`) resolves here. */
  onSent?: () => void;
}

/** Per-session DM send/ack state (was the module-level dmSendQueue /
 *  pendingDmAcks / adminHooks). */
export interface DmRuntime {
  // DM send → RESP_SENT has no correlation id, so we FIFO outgoing DMs and pop
  // on each RESP_SENT.
  dmSendQueue: string[];
  // expected_ack hex → message id, populated on RESP_SENT and cleared on
  // PUSH_SEND_CONFIRMED or after ACK_RETENTION_MS.
  pendingDmAcks: Map<string, { messageId: string; timer: ReturnType<typeof setTimeout> }>;
  // Ids on dmSendQueue that are CLI sends, not DMs. They share the radio's
  // send bookkeeping but report on `cliSendState`, never `messageState`.
  cliSends: Map<string, CliSendMeta>;
  adminHooks: DmAdminHooks;
}

export function createDmRuntime(): DmRuntime {
  return { dmSendQueue: [], pendingDmAcks: new Map(), cliSends: new Map(), adminHooks: {} };
}
```

- [ ] **Step 5: Replace `enqueueDmSend` with `enqueueCliSend` and extend `dequeueDmSend`**

Replace lines 196-206 of `src/features/directMessages.ts`:

```ts
/** Push a CLI send onto the DM send FIFO. CLI commands are DMs at the wire
 *  level, so they must hold a FIFO slot for the RESP_SENT/ACK bookkeeping to
 *  stay aligned — but they are tagged here so their progress reports on
 *  `cliSendState` instead of `messageState`. */
export function enqueueCliSend(ctx: FeatureContext, id: string, meta: CliSendMeta): void {
  ctx.rt.dm.cliSends.set(id, meta);
  ctx.rt.dm.dmSendQueue.push(id);
}

/** Remove an id from the DM send FIFO (on write failure), dropping its CLI tag
 *  if it had one. */
export function dequeueDmSend(ctx: FeatureContext, id: string): void {
  const i = ctx.rt.dm.dmSendQueue.indexOf(id);
  if (i !== -1) ctx.rt.dm.dmSendQueue.splice(i, 1);
  ctx.rt.dm.cliSends.delete(id);
}
```

- [ ] **Step 6: Add the routing helper**

In `src/features/directMessages.ts`, add immediately above `failOldestDmSend` (currently line 348):

```ts
/** Report a wire-state transition for a queued send. CLI sends go out on
 *  `cliSendState` and never touch the message store — there is no message
 *  record behind a synthetic CLI id, and consumers must be able to tell the
 *  two apart. DMs behave exactly as before. */
function emitSendState(ctx: FeatureContext, id: string, state: CliSendPhase): void {
  const cli = ctx.rt.dm.cliSends.get(id);
  if (cli) {
    // 'sent' is not terminal — an ACK may still follow. handleSent owns
    // freeing the entry once it knows whether one is coming.
    if (state !== 'sent') ctx.rt.dm.cliSends.delete(id);
    ctx.events.emit('cliSendState', { id, contactKey: cli.contactKey, state });
    return;
  }
  ctx.state.setMessageState(id, state);
  ctx.events.emit('messageState', id, state);
}
```

Add `CliSendPhase` to the type import at the top of the file:

```ts
import type { CliSendPhase, Contact, Message, MessageState } from '../model/types';
```

- [ ] **Step 7: Route the three emit sites through it**

In `src/features/directMessages.ts`, replace the body of `failOldestDmSend` and `resetDmState` (lines 348-362):

```ts
/** Fail the oldest in-flight send (bare RESP_ERR, or disconnect). */
export function failOldestDmSend(ctx: FeatureContext, reason: string): void {
  const messageId = ctx.rt.dm.dmSendQueue.shift();
  if (!messageId) return;
  emitSendState(ctx, messageId, 'failed');
  ctx.log.warn(`send failed id=${messageId}: ${reason}`);
}

/** Tear down the DM send/ack state on disconnect so callers don't hang. */
export function resetDmState(ctx: FeatureContext, reason: string): void {
  while (ctx.rt.dm.dmSendQueue.length > 0) failOldestDmSend(ctx, reason);
  for (const entry of ctx.rt.dm.pendingDmAcks.values()) clearTimeout(entry.timer);
  ctx.rt.dm.pendingDmAcks.clear();
  ctx.rt.dm.cliSends.clear();
}
```

Replace `handleSent` (lines 414-436):

```ts
function handleSent(frame: Buffer, ctx: FeatureContext): void {
  const sent = decodeSentAck(frame);
  if (!sent) return;
  // Admin writes are serialised and ack'd ahead of DM sends. The expected_ack
  // u32 from RESP_SENT is the same `tag` the firmware later echoes back in
  // PUSH_BINARY_RESPONSE / PUSH_LOGIN_SUCCESS.
  if (ctx.rt.dm.adminHooks.onSentTag?.(sent.expectedAckHex)) return;
  const messageId = ctx.rt.dm.dmSendQueue.shift();
  if (!messageId) {
    // RESP_SENT for a non-DM (e.g. channel send echo) — no state machine.
    return;
  }
  const cli = ctx.rt.dm.cliSends.get(messageId);
  emitSendState(ctx, messageId, 'sent');
  ctx.log.debug(
    `${cli ? 'cli' : 'dm'} sent id=${messageId} flood=${sent.flood} ack=${sent.expectedAckHex} timeout=${sent.estTimeoutMs}ms`,
  );
  // A fire-and-forget CLI send resolves the instant the radio confirms it.
  cli?.onSent?.();

  if (sent.expectedAckHex !== '00000000') {
    const timer = setTimeout(() => {
      ctx.rt.dm.pendingDmAcks.delete(sent.expectedAckHex);
      // The ack never came — stop tracking the CLI send too, so the tag map
      // can't outlive the ack window.
      ctx.rt.dm.cliSends.delete(messageId);
    }, ACK_RETENTION_MS);
    ctx.rt.dm.pendingDmAcks.set(sent.expectedAckHex, { messageId, timer });
  } else {
    // No ack will follow; 'sent' was this send's final state.
    ctx.rt.dm.cliSends.delete(messageId);
  }
}
```

Replace `handleSendConfirmed` (lines 438-448):

```ts
function handleSendConfirmed(frame: Buffer, ctx: FeatureContext): void {
  const conf = decodeSendConfirmed(frame);
  if (!conf) return;
  const entry = ctx.rt.dm.pendingDmAcks.get(conf.ackHex);
  if (!entry) return;
  clearTimeout(entry.timer);
  ctx.rt.dm.pendingDmAcks.delete(conf.ackHex);
  emitSendState(ctx, entry.messageId, 'ack');
  ctx.log.debug(`send ack id=${entry.messageId} ack=${conf.ackHex} rtt=${conf.tripTimeMs}ms`);
}
```

- [ ] **Step 8: Point the CLI send path at `enqueueCliSend`**

In `src/features/repeaterAdmin.ts`, in `repeaterSendCli`, replace line 538:

```ts
  directMessages.enqueueCliSend(ctx, syntheticId, { contactKey });
```

Also update the comment immediately above it (lines 535-536), whose claim about state flips is now stale:

```ts
  // CLI sends are still DMs at the wire level — take a DM send FIFO slot so
  // the RESP_SENT FIFO advances correctly. The id is synthetic and tagged as a
  // CLI send, so its progress reports on `cliSendState`, not `messageState`.
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `pnpm vitest run tests/features/directMessages.test.ts tests/features/repeaterAdmin.test.ts && pnpm typecheck`
Expected: PASS. If `pnpm typecheck` reports an unused `MessageState` import in `directMessages.ts`, keep it — `awaitDmOutcome` at line 326 still uses it.

- [ ] **Step 10: Run the full suite**

Run: `pnpm test && pnpm lint`
Expected: all PASS.

- [ ] **Step 11: Commit**

```bash
git add src/features/directMessages.ts src/features/repeaterAdmin.ts tests/features/directMessages.test.ts
git commit -m "feat: route CLI sends to cliSendState instead of messageState"
```

---

### Task 4: Emit `cliUnmatched` instead of storing late CLI replies

A CLI reply with no pending awaiter currently falls into the DM message store as a normal received message and can synthesise a placeholder contact. With a queue and cancellation that happens constantly.

**Files:**
- Modify: `src/features/directMessages.ts:366-412` (`handleContactMsg`)
- Test: `tests/features/directMessages.test.ts`

**Interfaces:**
- Consumes: `CliUnmatchedEvent` from Task 2.
- Produces: no new exports. Behavior: unmatched `TXT_TYPE.CLI_DATA` frames emit `cliUnmatched` and return early, without inserting a message or creating a contact. The drain pump still runs on both branches.

- [ ] **Step 1: Write the failing tests**

Append to `tests/features/directMessages.test.ts`:

```ts
describe('directMessages: unmatched CLI replies', () => {
  // RESP_CONTACT_MSG_RECV_V3 with txt_type=CLI_DATA.
  function cliReplyFrame(senderPrefixHex: string, body: string): Buffer {
    const text = Buffer.from(body, 'utf8');
    const frame = Buffer.alloc(16 + text.length);
    frame[0] = 0x10;
    Buffer.from(senderPrefixHex, 'hex').copy(frame, 4);
    frame[10] = 0xff;
    frame[11] = TXT_TYPE.CLI_DATA;
    frame.writeUInt32LE(1, 12);
    text.copy(frame, 16);
    return frame;
  }

  it('emits cliUnmatched with the contactKey and stores no message', () => {
    const { ctx, state, events } = makeCtx();
    addContact(state);
    const seen: unknown[] = [];
    events.on('cliUnmatched', (e) => seen.push(e));

    directMessagesFeature.handle(0x10, cliReplyFrame('aabbccddeeff', 'OK'), ctx);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      contactKey: `c:${PK}`,
      senderPrefixHex: 'aabbccddeeff',
      body: 'OK',
    });
    expect(state.getMessagesForKey(`c:${PK}`)).toHaveLength(0);
  });

  it('omits contactKey and creates no placeholder contact for an unknown sender', () => {
    const { ctx, state, events } = makeCtx();
    const seen: Array<{ contactKey?: string }> = [];
    events.on('cliUnmatched', (e) => seen.push(e));

    directMessagesFeature.handle(0x10, cliReplyFrame('010203040506', 'late'), ctx);

    expect(seen).toHaveLength(1);
    expect(seen[0].contactKey).toBeUndefined();
    expect(state.getContacts()).toHaveLength(0);
  });

  it('still routes to a pending awaiter when one is registered', () => {
    const { ctx, state, events } = makeCtx();
    addContact(state);
    const seen: unknown[] = [];
    events.on('cliUnmatched', (e) => seen.push(e));
    let claimed: string | null = null;
    setAdminHooks(ctx, {
      onCliReply: (_prefix, body) => {
        claimed = body;
        return true;
      },
    });

    directMessagesFeature.handle(0x10, cliReplyFrame('aabbccddeeff', 'PERM SET'), ctx);

    expect(claimed).toBe('PERM SET');
    expect(seen).toHaveLength(0);
    expect(state.getMessagesForKey(`c:${PK}`)).toHaveLength(0);
  });

  it('leaves a plain (non-CLI) DM on the normal message path', () => {
    const { ctx, state, events } = makeCtx();
    addContact(state);
    const seen: unknown[] = [];
    events.on('cliUnmatched', (e) => seen.push(e));
    const frame = cliReplyFrame('aabbccddeeff', 'hello');
    frame[11] = TXT_TYPE.PLAIN;

    directMessagesFeature.handle(0x10, frame, ctx);

    expect(seen).toHaveLength(0);
    expect(state.getMessagesForKey(`c:${PK}`)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/features/directMessages.test.ts -t "unmatched CLI"`
Expected: FAIL — the first test gets 0 `cliUnmatched` events and 1 stored message.

- [ ] **Step 3: Rewrite the CLI branch in `handleContactMsg`**

In `src/features/directMessages.ts`, replace lines 369-376 (the CLI-reply block at the top of `handleContactMsg`):

```ts
  // CLI replies arrive on the same opcode as DMs. Route them to the matching
  // admin awaiter; an unmatched one (late answer to a timed-out or cancelled
  // command, or unsolicited output) surfaces on its own channel. Either way a
  // CLI reply never enters the message store.
  if (parsed.txtType === TXT_TYPE.CLI_DATA) {
    const senderPrefixHex = parsed.senderPubKeyPrefixHex.toLowerCase();
    if (!ctx.rt.dm.adminHooks.onCliReply?.(senderPrefixHex, parsed.body)) {
      const known = ctx.state
        .getContacts()
        .find((c) => c.publicKeyHex.toLowerCase().startsWith(senderPrefixHex));
      ctx.events.emit('cliUnmatched', {
        contactKey: known?.key,
        senderPrefixHex,
        body: parsed.body,
        receivedAt: Date.now(),
      });
      ctx.log.debug(`unmatched cli reply from=${senderPrefixHex} body=${JSON.stringify(parsed.body.slice(0, 60))}`);
    }
    // The radio only tickles PUSH_MSG_WAITING once per queue event; keep
    // pulling until NO_MORE_MESSAGES. Must run on BOTH branches — this return
    // now short-circuits the pump at the end of the function.
    if (drain.isDraining(ctx)) drain.pumpAfterRecv(ctx);
    return;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/features/directMessages.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/features/directMessages.ts tests/features/directMessages.test.ts
git commit -m "feat: emit cliUnmatched for CLI replies with no awaiter"
```

---

### Task 5: `RepeaterCliOptions` — per-call `timeoutMs` and `signal`

Introduces the options bag with the two cancellation-related fields. `expectReply` is declared here but the fire-and-forget path lands in Task 6; until then every call still waits for a reply.

**Files:**
- Modify: `src/features/repeaterAdmin.ts` (`repeaterSendCli`, lines 508-552)
- Modify: `src/features.ts` (export the type)
- Modify: `src/session/session.ts:1573-1576`
- Test: `tests/features/repeaterAdmin.test.ts`

**Interfaces:**
- Consumes: `CLI_REPLY_TIMEOUT_MS` / `ADMIN_SENT_TIMEOUT_MS` from Task 1; `enqueueCliSend` from Task 3.
- Produces:
  - `interface RepeaterCliOptions { expectReply?: boolean; timeoutMs?: number; signal?: AbortSignal }`, exported from `src/features/repeaterAdmin.ts` and re-exported as `Features.RepeaterCliOptions`.
  - `repeaterSendCli(ctx, contactKey, command, opts?: RepeaterCliOptions): Promise<string>`.
  - Task 6 fills in the `expectReply: false` branch using the `onSendConfirmed` hook this task wires up.

- [ ] **Step 1: Write the failing tests**

Append to `tests/features/repeaterAdmin.test.ts`:

```ts
describe('repeaterAdmin: repeaterSendCli options — timeout + abort', () => {
  it('honours a per-call timeoutMs and clears the pendingCli slot', async () => {
    const { ctx, state } = makeCtx();
    addContact(state);
    registerAdminHooks(ctx);

    const p = repeaterSendCli(ctx, `c:${PK}`, 'ver', { timeoutMs: 10 });
    await expect(p).rejects.toThrow(/timed out after 10ms/);
    expect(ctx.rt.adminCorr.pendingCli.has(PREFIX)).toBe(false);
  });

  it('leaves the DM FIFO entry in place after a timeout', async () => {
    const { ctx, state } = makeCtx();
    addContact(state);
    registerAdminHooks(ctx);

    const p = repeaterSendCli(ctx, `c:${PK}`, 'ver', { timeoutMs: 10 });
    await expect(p).rejects.toThrow(/timed out/);
    // A RESP_SENT may still be in flight; popping the entry here would
    // mis-attribute the next real DM's 'sent' event.
    expect(ctx.rt.dm.dmSendQueue).toHaveLength(1);
    resetDmState(ctx, 'cleanup');
  });

  it('rejects immediately on an already-aborted signal, writing nothing', async () => {
    const { ctx, state, writes } = makeCtx();
    addContact(state);
    registerAdminHooks(ctx);

    const ac = new AbortController();
    ac.abort();
    await expect(repeaterSendCli(ctx, `c:${PK}`, 'ver', { signal: ac.signal })).rejects.toThrow();
    expect(writes).toHaveLength(0);
    expect(ctx.rt.dm.dmSendQueue).toHaveLength(0);
    expect(ctx.rt.adminCorr.pendingCli.has(PREFIX)).toBe(false);
  });

  it('rejects with signal.reason when aborted after the send', async () => {
    const { ctx, state } = makeCtx();
    addContact(state);
    registerAdminHooks(ctx);

    const ac = new AbortController();
    const reason = new Error('repeater switched');
    const p = repeaterSendCli(ctx, `c:${PK}`, 'ver', { signal: ac.signal });
    await tick();
    expect(ctx.rt.adminCorr.pendingCli.has(PREFIX)).toBe(true);

    ac.abort(reason);

    await expect(p).rejects.toBe(reason);
    // Awaiter dropped so the next command can use the slot; FIFO untouched.
    expect(ctx.rt.adminCorr.pendingCli.has(PREFIX)).toBe(false);
    expect(ctx.rt.dm.dmSendQueue).toHaveLength(1);
    resetDmState(ctx, 'cleanup');
  });

  it('defaults to a 30s reply wait when no timeoutMs is given', async () => {
    const { ctx, state } = makeCtx();
    addContact(state);
    registerAdminHooks(ctx);

    const p = repeaterSendCli(ctx, `c:${PK}`, 'ver');
    await tick();
    expect(ctx.rt.adminCorr.pendingCli.has(PREFIX)).toBe(true);
    // Settle it so the 30s timer doesn't hold the suite open.
    directMessagesFeature.handle(0x10, cliReplyFrame(PREFIX, 'v1.2.3'), ctx);
    await expect(p).resolves.toBe('v1.2.3');
  });

  it('rejects the promise (not just throws) when the write fails', async () => {
    const { ctx, state } = makeCtx();
    addContact(state);
    registerAdminHooks(ctx);
    ctx.writeFrame = async () => {
      throw new Error('transport down');
    };

    await expect(repeaterSendCli(ctx, `c:${PK}`, 'ver')).rejects.toThrow(/transport down/);
    expect(ctx.rt.dm.dmSendQueue).toHaveLength(0);
    expect(ctx.rt.adminCorr.pendingCli.has(PREFIX)).toBe(false);
  });
});
```

Add `resetDmState` to the existing import from `'../../src/features/directMessages'` at the top of the file (it currently imports `createDmRuntime` and `directMessagesFeature`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/features/repeaterAdmin.test.ts -t "options — timeout"`
Expected: FAIL — `repeaterSendCli` takes three arguments, so TypeScript rejects the fourth.

- [ ] **Step 3: Add the options type**

In `src/features/repeaterAdmin.ts`, add immediately above `repeaterSendCli` (replacing its current doc comment at lines 508-511):

```ts
/** Options for {@link repeaterSendCli}. */
export interface RepeaterCliOptions {
  /** Wait for the repeater's CLI reply. Default `true` — current behavior.
   *  Set `false` for commands the firmware never answers (`reboot`,
   *  `poweroff`, `clkreboot`, `start ota`): the handler reboots or powers down
   *  instead of writing a reply, and the firmware only transmits one when
   *  `strlen(reply) > 0`. Those resolve `''` once the radio confirms the send,
   *  register no awaiter, and never arm the reply timer. */
  expectReply?: boolean;
  /** Override the wait. Defaults to {@link CLI_REPLY_TIMEOUT_MS} when
   *  `expectReply` is true, {@link ADMIN_SENT_TIMEOUT_MS} when it is false. */
  timeoutMs?: number;
  /** Abort the awaiter; the promise rejects with `signal.reason`. The command
   *  may already be on the air — aborting drops our awaiter and frees the
   *  per-repeater slot, it does not recall the send. */
  signal?: AbortSignal;
}

/** Send a remote CLI command (e.g. "setperm <hex> 1", "discover.neighbors")
 *  as a text message with txt_type=CLI_DATA. The reply arrives as a normal
 *  RESP_CONTACT_MSG_RECV(_V3) with txt_type=CLI_DATA; the directMessages
 *  feature routes it back here (onCliReply) by sender prefix.
 *
 *  Only one CLI command may be outstanding per repeater — a second call
 *  supersedes the first. Callers that need queueing own it. */
```

- [ ] **Step 4: Rewrite `repeaterSendCli`**

Replace the whole function body (lines 512-552) with:

```ts
export async function repeaterSendCli(
  ctx: FeatureContext,
  contactKey: string,
  command: string,
  opts: RepeaterCliOptions = {},
): Promise<string> {
  const { signal } = opts;
  if (signal?.aborted) throw signal.reason;
  const contact = lookupRepeaterContact(ctx, contactKey);
  if (!contact.ok) throw new Error(contact.error);

  const expectReply = opts.expectReply !== false;
  const timeoutMs = opts.timeoutMs ?? (expectReply ? CLI_REPLY_TIMEOUT_MS : ADMIN_SENT_TIMEOUT_MS);
  const prefix = contact.publicKeyHex.slice(0, 12);
  const pendingCli = ctx.rt.adminCorr.pendingCli;

  // Hoisted out of the executor (which runs synchronously) so the send path
  // below can settle the promise.
  let cleanup = (): void => {};
  let failWait = (_err: Error): void => {};
  const wait = new Promise<string>((resolve, reject) => {
    let entry: PendingCli | undefined;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`CLI command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const onAbort = (): void => {
      cleanup();
      reject(signal?.reason);
    };
    // Drop our awaiter and timers. Deliberately does NOT touch the DM send
    // FIFO: a RESP_SENT may still be in flight and must find its entry, or the
    // next real DM's 'sent' event is mis-attributed to this command.
    cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (entry && pendingCli.get(prefix) === entry) pendingCli.delete(prefix);
    };
    failWait = (err: Error): void => {
      cleanup();
      reject(err);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const existing = pendingCli.get(prefix);
    if (existing) {
      clearTimeout(existing.timer);
      existing.reject(new Error('superseded by newer CLI command'));
    }
    entry = {
      pubKeyPrefixHex: prefix,
      resolve: (text) => {
        cleanup();
        resolve(text);
      },
      reject: (err) => {
        cleanup();
        reject(err);
      },
      timer,
    };
    pendingCli.set(prefix, entry);
  });

  const frame = directMessages.encodeSendDmText({
    destPublicKeyHex: contact.publicKeyHex,
    text: command,
    txtType: TXT_TYPE.CLI_DATA,
  });
  // CLI sends are still DMs at the wire level — take a DM send FIFO slot so
  // the RESP_SENT FIFO advances correctly. The id is synthetic and tagged as a
  // CLI send, so its progress reports on `cliSendState`, not `messageState`.
  const syntheticId = `cli-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  directMessages.enqueueCliSend(ctx, syntheticId, { contactKey });
  try {
    await ctx.writeFrame(frame);
  } catch (err) {
    // The radio won't reply with RESP_SENT, so pop the entry to keep the FIFO
    // aligned. Returning `wait` (rather than rethrowing) surfaces the same
    // error while leaving no dangling rejected promise behind.
    directMessages.dequeueDmSend(ctx, syntheticId);
    failWait(err as Error);
    return wait;
  }
  return wait;
}
```

Note: `cleanup` is reassigned inside the executor before any `await`, so the send path always sees the real implementation, never the `() => {}` placeholder.

- [ ] **Step 5: Export the type and thread it through the session**

In `src/features.ts`, replace the `RepeaterReachMode` line:

```ts
export type { RepeaterCliOptions, RepeaterReachMode } from './features/repeaterAdmin';
```

In `src/session/session.ts`, replace `repeaterSendCli` (lines 1573-1576):

```ts
  /** Send a remote CLI command; the reply is routed back by sender prefix.
   *  Pass `{ expectReply: false }` for the commands the firmware never answers
   *  (`reboot`, `poweroff`, `clkreboot`, `start ota`) — those resolve `''` as
   *  soon as the radio confirms the send. `timeoutMs` and `signal` bound the
   *  wait; the defaults are `Models.CLI_REPLY_TIMEOUT_MS` and
   *  `Models.ADMIN_SENT_TIMEOUT_MS`. */
  async repeaterSendCli(
    contactKey: string,
    command: string,
    opts: repeaterAdmin.RepeaterCliOptions = {},
  ): Promise<string> {
    return repeaterAdmin.repeaterSendCli(this.ctx, contactKey, command, opts);
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run tests/features/repeaterAdmin.test.ts && pnpm typecheck`
Expected: PASS, including the pre-existing `'registerAdminHooks + onCliReply resolves the pending CLI awaiter'` and `'rejects pending CLI + admin-sent awaiters'` tests — both call `repeaterSendCli` with three arguments, which the optional `opts` keeps valid.

- [ ] **Step 7: Run the full suite**

Run: `pnpm test && pnpm lint`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/features/repeaterAdmin.ts src/features.ts src/session/session.ts tests/features/repeaterAdmin.test.ts
git commit -m "feat: per-call timeoutMs and AbortSignal for repeaterSendCli"
```

---

### Task 6: `expectReply: false` fire-and-forget sends

Wires the `expectReply` flag through: no `pendingCli` entry, no reply timer, resolve `''` on RESP_SENT.

**Files:**
- Modify: `src/features/repeaterAdmin.ts` (`repeaterSendCli`, the executor and the `enqueueCliSend` call)
- Test: `tests/features/repeaterAdmin.test.ts`

**Interfaces:**
- Consumes: `CliSendMeta.onSent` from Task 3; `RepeaterCliOptions` and the `expectReply`/`timeoutMs` locals from Task 5.
- Produces: no new exports. Behavior: `expectReply: false` registers nothing on `ctx.rt.adminCorr.pendingCli` and resolves `''` when `handleSent` pops its FIFO entry.

- [ ] **Step 1: Write the failing tests**

Append to `tests/features/repeaterAdmin.test.ts`:

```ts
describe('repeaterAdmin: repeaterSendCli expectReply:false', () => {
  it('registers no pendingCli awaiter and still writes the CLI_DATA DM', async () => {
    const { ctx, state, writes } = makeCtx();
    addContact(state);
    registerAdminHooks(ctx);

    const p = repeaterSendCli(ctx, `c:${PK}`, 'reboot', { expectReply: false });
    await tick();

    expect(ctx.rt.adminCorr.pendingCli.size).toBe(0);
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe(0x02); // CMD_SEND_TXT_MSG
    expect(writes[0][1]).toBe(TXT_TYPE.CLI_DATA);
    expect(writes[0].subarray(13).toString('utf8')).toBe('reboot');
    expect(ctx.rt.dm.dmSendQueue).toHaveLength(1);

    directMessagesFeature.handle(0x06, sentTag('00000000'), ctx);
    await expect(p).resolves.toBe('');
  });

  it('does not consume the pendingCli slot a concurrent command needs', async () => {
    const { ctx, state } = makeCtx();
    addContact(state);
    registerAdminHooks(ctx);

    const fire = repeaterSendCli(ctx, `c:${PK}`, 'clkreboot', { expectReply: false });
    const ask = repeaterSendCli(ctx, `c:${PK}`, 'ver');
    await tick();

    expect(ctx.rt.adminCorr.pendingCli.has(PREFIX)).toBe(true);

    directMessagesFeature.handle(0x06, sentTag('00000000'), ctx); // pops the fire-and-forget
    await expect(fire).resolves.toBe('');

    directMessagesFeature.handle(0x10, cliReplyFrame(PREFIX, 'v1.2.3'), ctx);
    await expect(ask).resolves.toBe('v1.2.3');
  });

  it('rejects when the send is never confirmed within the timeout', async () => {
    const { ctx, state } = makeCtx();
    addContact(state);
    registerAdminHooks(ctx);

    const p = repeaterSendCli(ctx, `c:${PK}`, 'poweroff', { expectReply: false, timeoutMs: 10 });
    await expect(p).rejects.toThrow(/send was not confirmed after 10ms/);
    expect(ctx.rt.adminCorr.pendingCli.size).toBe(0);
    resetDmState(ctx, 'cleanup');
  });

  it('is abortable before the send is confirmed', async () => {
    const { ctx, state } = makeCtx();
    addContact(state);
    registerAdminHooks(ctx);

    const ac = new AbortController();
    const reason = new Error('user cancelled');
    const p = repeaterSendCli(ctx, `c:${PK}`, 'start ota', { expectReply: false, signal: ac.signal });
    await tick();
    ac.abort(reason);

    await expect(p).rejects.toBe(reason);
    resetDmState(ctx, 'cleanup');
  });

  it('reports on cliSendState even after the promise has already resolved', async () => {
    const { ctx, state, events } = makeCtx();
    addContact(state);
    registerAdminHooks(ctx);
    const seen: Array<{ id: string; contactKey: string; state: string }> = [];
    events.on('cliSendState', (e) => seen.push({ id: e.id, contactKey: e.contactKey, state: e.state }));

    const p = repeaterSendCli(ctx, `c:${PK}`, 'reboot', { expectReply: false });
    await tick();
    directMessagesFeature.handle(0x06, sentTag('deadbeef'), ctx);
    await expect(p).resolves.toBe('');

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ contactKey: `c:${PK}`, state: 'sent' });
    expect(seen[0].id.startsWith('cli-')).toBe(true);

    // A late ACK still reports — the stronger signal arrives after the resolve.
    directMessagesFeature.handle(0x82, Buffer.concat([Buffer.from([0x82]), Buffer.from('deadbeef', 'hex'), Buffer.alloc(4)]), ctx);
    expect(seen.map((s) => s.state)).toEqual(['sent', 'ack']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/features/repeaterAdmin.test.ts -t "expectReply:false"`
Expected: FAIL — the first test finds `pendingCli.size` is 1, because `expectReply` is not yet honoured.

- [ ] **Step 3: Make the awaiter conditional**

In `src/features/repeaterAdmin.ts`, inside `repeaterSendCli`'s promise executor, change the timeout message and guard the `pendingCli` registration on `expectReply`. Replace the `const timer = setTimeout(…)` line and everything from `const existing = pendingCli.get(prefix);` to `pendingCli.set(prefix, entry);` with:

```ts
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          expectReply
            ? `CLI command timed out after ${timeoutMs}ms`
            : `CLI send was not confirmed after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
```

and

```ts
    // A fire-and-forget send resolves on the radio's RESP_SENT instead — it
    // registers no awaiter, so the single per-repeater slot stays free for a
    // command that does expect an answer.
    onSendConfirmed = (): void => {
      cleanup();
      resolve('');
    };
    if (!expectReply) return;

    const existing = pendingCli.get(prefix);
    if (existing) {
      clearTimeout(existing.timer);
      existing.reject(new Error('superseded by newer CLI command'));
    }
    entry = {
      pubKeyPrefixHex: prefix,
      resolve: (text) => {
        cleanup();
        resolve(text);
      },
      reject: (err) => {
        cleanup();
        reject(err);
      },
      timer,
    };
    pendingCli.set(prefix, entry);
```

- [ ] **Step 4: Hoist `onSendConfirmed` and pass it as `onSent`**

Still in `repeaterSendCli`, add the third hoisted binding next to `cleanup` and `failWait`:

```ts
  let cleanup = (): void => {};
  let failWait = (_err: Error): void => {};
  let onSendConfirmed = (): void => {};
```

and change the `enqueueCliSend` call to hand it over only for fire-and-forget sends:

```ts
  directMessages.enqueueCliSend(ctx, syntheticId, {
    contactKey,
    // Only a fire-and-forget send settles on RESP_SENT; a reply-expecting one
    // must keep waiting for the repeater's answer.
    onSent: expectReply ? undefined : onSendConfirmed,
  });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run tests/features/repeaterAdmin.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Run the full suite**

Run: `pnpm test && pnpm lint`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/features/repeaterAdmin.ts tests/features/repeaterAdmin.test.ts
git commit -m "feat: expectReply:false fire-and-forget CLI sends"
```

---

### Task 7: End-to-end coverage and documentation

Proves the three features work through the real `MeshCoreSession` surface, and documents them.

**Files:**
- Modify: `tests/integration/inbound/repeater-admin.test.ts`
- Modify: `docs/src/content/docs/guides/events-and-state.md:32-42`
- Modify: `README.md:124`

**Interfaces:**
- Consumes: everything from Tasks 1-6.
- Produces: no code exports.

- [ ] **Step 1: Write the failing integration tests**

Append inside the existing `describe('repeater administration', …)` block in `tests/integration/inbound/repeater-admin.test.ts`:

```ts
  it('resolves a fire-and-forget CLI send on RESP_SENT without arming a reply wait', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    session.state.upsertContact(repeater());

    const states: Array<{ contactKey: string; state: string }> = [];
    session.events.on('cliSendState', (e) => states.push({ contactKey: e.contactKey, state: e.state }));
    const messageStates: string[] = [];
    session.events.on('messageState', (id) => messageStates.push(id));

    const p = session.repeaterSendCli(`c:${PK}`, 'reboot', { expectReply: false });
    await tick();
    expect(transport.sent[0][0]).toBe(0x02); // CMD_SEND_TXT_MSG
    expect(transport.sent[0][1]).toBe(1); // TXT_TYPE.CLI_DATA

    deliver(transport, respSent('00000000'));
    await expect(p).resolves.toBe('');

    expect(states).toEqual([{ contactKey: `c:${PK}`, state: 'sent' }]);
    expect(messageStates).toHaveLength(0); // no junk on the DM channel
  });

  it('cancels an in-flight CLI command via AbortSignal', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    session.state.upsertContact(repeater());

    const ac = new AbortController();
    const reason = new Error('repeater switched');
    const p = session.repeaterSendCli(`c:${PK}`, 'ver', { signal: ac.signal });
    await tick();
    ac.abort(reason);
    await expect(p).rejects.toBe(reason);

    // The slot is free, so the next command can be issued immediately.
    const next = session.repeaterSendCli(`c:${PK}`, 'time', { timeoutMs: 500 });
    await tick();
    deliver(transport, cliReply(PREFIX, '1700000000'));
    await expect(next).resolves.toBe('1700000000');
  });

  it('surfaces a late reply to a cancelled command on cliUnmatched, not the message store', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    session.state.upsertContact(repeater());

    const late: Array<{ contactKey?: string; body: string }> = [];
    session.events.on('cliUnmatched', (e) => late.push({ contactKey: e.contactKey, body: e.body }));

    const ac = new AbortController();
    const p = session.repeaterSendCli(`c:${PK}`, 'ver', { signal: ac.signal });
    await tick();
    ac.abort(new Error('cancelled'));
    await expect(p).rejects.toThrow(/cancelled/);

    deliver(transport, cliReply(PREFIX, 'v1.2.3'));
    await tick();

    expect(late).toEqual([{ contactKey: `c:${PK}`, body: 'v1.2.3' }]);
    expect(session.state.getMessagesForKey(`c:${PK}`)).toHaveLength(0);
  });
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `pnpm vitest run tests/integration/inbound/repeater-admin.test.ts`
Expected: PASS — the implementation already landed in Tasks 1-6, so these confirm the wiring end-to-end. If any fail, the defect is real; fix it in the owning source file before moving on.

- [ ] **Step 3: Document the new events**

In `docs/src/content/docs/guides/events-and-state.md`, replace the event list at lines 34-39 (add the two new keys after `messagePathHeard`):

```markdown
`transportState`, `rawPacket`, `channels`, `channelPresence`, `syncProgress`,
`contacts`, `discovered`, `contactEvicted`, `contactDiscovered`, `contactsFull`,
`contactObserved`, `messages`, `messageUpserted`, `messageState`,
`messagePathHeard`, `cliSendState`, `cliUnmatched`, `owner`, `radioSettings`,
`repeaterStatus`, `repeaterTelemetry`, `pathLearned`, `deviceIdentity`,
`autoAddConfig`, `telemetryPolicy`, `gpsConfig`, `deviceInfo`,
`deviceCapabilities`.
```

Then add this section immediately after that paragraph's "All payloads are exported types" note (line 42):

````markdown
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
````

- [ ] **Step 4: Update the README method list**

In `README.md` line 124, change the repeater-administration clause so `repeaterSendCli` advertises its options bag:

```markdown
and repeater administration (`repeaterLogin`, `repeaterSendCli` (with `expectReply` / `timeoutMs` / `signal`), `repeaterRequestAcl`, `repeaterRequestNeighbours`, `repeaterRequestOwnerInfo`, `repeaterTracePath`, `repeaterGetLocalStats`, `sendStatusReq`, `sendTelemetryReq`).
```

- [ ] **Step 5: Verify the whole build**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build`
Expected: all PASS. `pnpm build` proves the new public types survive the `tsup` d.ts rollup.

- [ ] **Step 6: Commit**

```bash
git add tests/integration/inbound/repeater-admin.test.ts docs/src/content/docs/guides/events-and-state.md README.md
git commit -m "test: end-to-end CLI console coverage; docs: cliSendState, cliUnmatched, expectReply"
```

---

## Self-review notes

**Spec coverage.** Every spec section maps to a task: exported constants → Task 1; event declarations → Task 2; `cliSendState` routing across all three emit sites plus map lifecycle → Task 3; `cliUnmatched` and the drain-pump requirement → Task 4; `RepeaterCliOptions`, `timeoutMs`, `signal`, the FIFO-untouched rule, and the `Features`/session re-exports → Task 5; `expectReply: false` and RESP_SENT resolution → Task 6; integration tests and docs → Task 7.

**Naming consistency.** `enqueueCliSend`, `CliSendMeta`, `cliSends`, `emitSendState`, `CliSendPhase`, `CliSendStateEvent`, `CliUnmatchedEvent`, `RepeaterCliOptions`, `onSent` / `onSendConfirmed`, `cleanup`, `failWait` are used identically wherever they appear across Tasks 2-6.

**Two latent bugs get fixed in passing**, both called out at their step:
- `dequeueDmSend` now drops the CLI tag as well as the FIFO entry (Task 3, Step 5), so a failed write can't leave a stale tag behind.
- The write-failure path returns the rejected `wait` instead of rethrowing (Task 5, Step 4). Today `repeaterSendCli` rejects `wait` and then throws separately, leaving `wait` rejected-but-unawaited — an unhandled rejection.
