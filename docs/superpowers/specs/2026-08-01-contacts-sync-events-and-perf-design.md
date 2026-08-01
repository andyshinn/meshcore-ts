# Contact events & sync performance

Split the contact event stream into deltas and snapshots, coalesce the full-list
snapshots during a bulk `GET_CONTACTS` sync, and make per-contact ingest O(1).

## Motivation

A browser consumer profiled connect + contact load: main thread pegged for
~4.5s, frames of 800–1000ms, roughly 500ms of work per contact. Every
`RESP_CONTACT` runs `ingestContact` synchronously, and each call does:

| Work | Cost |
| --- | --- |
| `getContacts().some(fullKey)` (`contacts.ts:354`) | O(N) |
| `getContacts().find(fullKey)` (`contacts.ts:297`) | O(N) |
| `upsertContact` — `findIndex` + `map` (`model.ts:84`) | O(N), allocates a fresh N-array |
| `getContacts().some(placeholderKey)` (`contacts.ts:341`) | O(N) |
| `emit('contacts', …)` | full list |
| `discovered.list()` — spread + `sort` + `map` (`discoveredStore.ts:124`) | O(N log N), allocates **N fresh objects** |
| `emit('discovered', …)` | full list |
| `emit('contactObserved', …)` | O(1) |

Syncing N contacts is therefore O(N² log N) comparisons and ~N²/2 object
allocations, and fires 2N full-list events. `rowToDiscovered` is the dominant
term — N² object constructions matches the observed per-contact cost far better
than the linear scans do.

Two related costs sit at the edges:

- `RESP_END_OF_CONTACTS` prunes stale contacts with a loop over `getContacts()`
  calling `removeContact` (`contacts.ts:514`), and `removeContact` is an O(N)
  filter — O(N·M) for M removals.
- `Feature.handle` is synchronous, so a read burst runs as one un-yielding task.
  This spec does not introduce yielding; it removes the work instead.

Consumers have no incremental option either. `contacts` and `discovered` are
full-list snapshots, so a UI is forced into a full re-render per contact even
though exactly one row changed.

## Public API

### Three new events

```ts
// src/ports/events.ts — MeshCoreEventMap
/** A single inserted/updated contact — a delta companion to `contacts`. */
contactUpserted: (contact: Contact) => void;
/** A contact dropped from the local store — the delta companion to a removal
 *  reflected in `contacts`. Carries the contact key (`c:<pubkey>`). */
contactRemoved: (key: string) => void;
/** A GET_CONTACTS iteration finished. Fires after the flushed `contacts` and
 *  `discovered` snapshots, so both are current when it lands. */
contactsSynced: (summary: ContactsSyncedSummary) => void;
```

```ts
// src/model/types.ts, alongside PathLearnedEvent
export interface ContactsSyncedSummary {
  /** RESP_CONTACT records delivered in this iteration. */
  count: number;
  /** `most_recent_lastmod` from RESP_END_OF_CONTACTS — feed it back as the
   *  `since` argument of `encodeGetContacts` for an incremental re-sync.
   *  Null when the frame was too short to decode. */
  mostRecentLastmod: number | null;
}
```

Each gets an `EventName` constant: `CONTACT_UPSERTED`, `CONTACT_REMOVED`,
`CONTACTS_SYNCED`. The existing compile-time drift guard in `events.ts` enforces
coverage.

`contactUpserted` carries the **merged** `Contact`, not the wire record.
`contactObserved` already exposes the raw `ContactRecord` and is unchanged — the
two are complementary. The merge in `upsertOnRadioContact` is not mechanical
(`keepManualPath`, the `pathChanged → pathManual = false` rule, the 0/0-GPS
fallback, `lastSeenMs` falling back to the existing value); making consumers
reimplement it is how the library's view and the consumer's view drift apart.

`contactsSynced` carries `mostRecentLastmod` because the value is currently
decoded and dropped into a log line (`contacts.ts:507`) even though
`encodeGetContacts(since)` is public. Today a consumer has no way to obtain the
argument that parameter wants.

### Emit semantics

The rule is uniform, with no per-call-site exceptions:

- **Deltas** (`contactUpserted`, `contactRemoved`, `contactObserved`,
  `contactDiscovered`) always fire immediately, including inside a bulk sync.
  All are O(1).
- **Snapshots** (`contacts`, `discovered`) coalesce during a bulk sync: the emit
  is replaced by a dirty bit and flushed once at `RESP_END_OF_CONTACTS`.

Ordering at the end of a sync is fixed: `contacts` → `discovered` →
`contactsSynced`. A consumer that re-renders on `contactsSynced` therefore
already holds both fresh lists.

Outside a bulk sync nothing changes — every snapshot emit fires synchronously
exactly as it does today.

### `SessionState.getContact`

```ts
/** O(1) lookup by contact key. */
getContact(key: string): Contact | null;
```

Additive. Replaces the `getContacts().find((c) => c.key === …)` scans in
`contacts.ts`, `session.ts`, `repeaterAdmin.ts` and `pathDiagnostics.ts`.

The two prefix scans in `directMessages.ts:420` and `:437` match on a
`publicKeyHex` prefix rather than a key, so they stay linear. They run per
inbound DM, not per contact, and are not on the hot path.

## Design

### Emit chokepoint

`contacts.ts` imports no other feature — `directMessages`, `pathDiagnostics` and
`repeaterAdmin` already import *from* it, so it is the natural home for shared
contact-emit helpers with no cycle risk. `emitDiscovered` already lives there.

```ts
// src/features/contacts.ts
export function emitContacts(ctx: FeatureContext): void;   // gated
export function emitDiscovered(ctx: FeatureContext): void; // gated (existing)

/** Commit a contact and broadcast it: the `contactUpserted` delta fires
 *  immediately, the `contacts` snapshot coalesces during a bulk sync. */
export function upsertContact(ctx: FeatureContext, contact: Contact): void;

/** Drop a contact and broadcast it: `contactRemoved` immediately, `contacts`
 *  coalesced. */
export function removeContact(ctx: FeatureContext, key: string): void;
```

Every existing `state.upsertContact(…)` + `emit('contacts', …)` pair collapses
into `upsertContact(ctx, …)`; every `state.removeContact(…)` + emit collapses
into `removeContact(ctx, …)`. That includes the session's command methods
(`setContactPath`, `resetContactPath`, `removeContactFromRadio`,
`setContactFavourite`, `setContactPreferDirect`), which reach it through
`this.ctx`.

`SessionState` keeps its `NO dependency on the events port` invariant — it still
exposes plain `upsertContact` / `removeContact` mutators, and the feature layer
owns the broadcasting.

### The bulk window

`ContactsIterRuntime` gains:

```ts
/** True between RESP_CONTACTS_START and RESP_END_OF_CONTACTS. Full-list
 *  snapshot emits coalesce while set. */
bulk: boolean;
/** Snapshot emits requested while `bulk` was set, flushed on close. */
pendingContacts: boolean;
pendingDiscovered: boolean;
/** Idle watchdog — force-closes a bulk window the radio never terminated. */
bulkWatchdog: ReturnType<typeof setTimeout> | null;
```

`bulk` is set on `RESP_CONTACTS_START` and cleared by a single
`closeContactsBulk(ctx)`, which clears the watchdog and flushes whichever
pending snapshots are dirty.

`RESP_END_OF_CONTACTS` marks **both** snapshots pending before closing the
window, then emits `contactsSynced`. The unconditional mark matters:
`reconcileOnRadio` rewrites `on_radio` across the discovered pool without going
through an emit helper, so an iteration that delivered no contacts still has
state consumers need to see. This preserves today's behavior, where both emits
at `RESP_END_OF_CONTACTS` are unconditional.

`contactsSynced` fires **only** from `RESP_END_OF_CONTACTS`. A window
force-closed by the watchdog or by a disconnect flushes its snapshots but emits
no `contactsSynced` — no sync completed, and a consumer keying incremental
re-sync off `mostRecentLastmod` must not be handed a value the radio never
confirmed.

### Fail-safes

A gate that is never closed strands consumers on a stale list forever, and two
paths can leave it open today:

1. **Mid-sync disconnect.** The transport-state handler resolves the contact
   waiters (`session.ts:568`) but never calls `resetContactsIter` — only `stop()`
   does. The disconnect path must call `closeContactsBulk(ctx)`. Flushing the
   partial list is correct: it is what the session actually holds.
2. **Stalled but connected.** If the radio stops mid-iteration without
   disconnecting, `CONTACTS_DONE_WAIT_MS` resolves the session's waiter but the
   feature never learns. An idle watchdog inside the feature, rearmed on
   `RESP_CONTACTS_START` and on each `RESP_CONTACT`, force-closes the window.
   Its interval is a feature-local `CONTACTS_BULK_IDLE_MS = 10_000`, matching
   the session's private `CONTACTS_DONE_WAIT_MS` so it never pre-empts a
   healthy sync. `syncSeen` and the iterator counters are left untouched, so a
   late `RESP_END_OF_CONTACTS` still reconciles and emits `contactsSynced`
   correctly; it simply finds the window already closed.

`resetContactsIter` also calls `closeContactsBulk` so `stop()` cannot leave the
gate latched into the next session.

A solicited `getContactByKey` reply is consumed before the iterator sees it
(`contacts.ts:487`), so a single-contact refresh never opens or extends a bulk
window.

### Map-backed contacts

```ts
private contactsByKey = new Map<string, Contact>();
private contactsArray: Contact[] | null = null;  // materialized on demand
```

`getContacts()` returns `(this.contactsArray ??= [...this.contactsByKey.values()])`.
`upsertContact` / `removeContact` / `setContacts` invalidate by setting
`contactsArray = null`.

Ordering is unchanged: `Map.set` appends on a new key and updates in place on an
existing one, which is exactly what the `findIndex`/`map` pair did.

**Invalidation must allocate a new array, never mutate the cached one.** The
`RESP_END_OF_CONTACTS` prune loop iterates `getContacts()` while calling
`removeContact`, and depends on holding a stable pre-removal snapshot. The
current code is safe because `removeContact` reassigns to a filtered copy;
copy-on-write invalidation preserves that. This also matches the existing
contract that `getContacts()` hands back its internal array by reference — old
references stay valid snapshots.

`setContacts(next)` rebuilds the Map, which collapses duplicate keys where the
array form would have preserved them. A duplicate-key contacts array is already
malformed, so this is a fix rather than a regression.

Removal becomes an O(1) `Map.delete`, so the prune loop drops from O(N·M) to
O(M).

### Memoized `DiscoveredStore.list()`

A cached `DiscoveredContact[]` behind a dirty flag, invalidated by every
mutator: `upsert`, `setOnRadio`, `reconcileOnRadio`, `setFavourite`, `remove`,
`clearDiscoveredOnly`.

This alone does **not** fix the sync path — every ingest dirties the cache, so
without coalescing the list would still be rebuilt per contact. Coalescing is
what removes the N² term. The memo pays off for the repeated
`state.listDiscovered()` reads that happen between mutations, and for the
`emitDiscovered` + consumer-read double compute.

Like `getContacts()`, the memo returns the cached array by reference and any
mutation rebuilds a new one, so old references remain valid snapshots. `get()`
returns a live `DiscoveredRow`; callers must not mutate it outside the store's
own mutators or the memo goes stale. Every current caller in `session.ts` only
reads, and a comment records the invariant.

### Resulting cost

Per contact, ingest becomes three O(1) Map reads, one O(1) Map write, and two
O(1) delta emits. A full sync goes from O(N² log N) to O(N log N), with N object
allocations instead of ~N²/2, and from 2N full-list events to 2.

## Breaking changes

| Change | Who breaks |
| --- | --- |
| `contacts` / `discovered` fire once per sync instead of once per contact | Behavioral. A consumer relying on incremental list growth mid-sync. No type change. |
| `MeshCoreEventMap` gains three keys | Only a consumer doing exhaustive `Record<keyof MeshCoreEventMap, …>`. |
| `DiscoveredStore.list()` returns a memoized array | A consumer sorting the result in place. Matches `getContacts()`, which already returns its internal array. |

No renames, no removals, no signature changes.

**Version: 0.7.0.** Pre-1.0, minor is where breaking change goes — the
changelog's own header already states that pre-`1.0` minor bumps may carry
behaviour changes. The behavioral change is real even though nothing is
type-incompatible, so it belongs under `### Changed` in the changelog, not as a
bullet under `### Fixed`. See [Documentation](#documentation) for the release
mechanics: the version comes from the release tag, not from an edit to
`package.json`.

**No compat shim and no opt-in flag.** The old cadence is a performance bug, not
a contract — nothing depends on receiving the identical list N times, and the
flushed emit is a strict superset of the information. The one legitimate need it
served, incremental visibility during a long sync, is now covered better by
`contactUpserted` plus the existing `syncProgress`. A flag would permanently
fork the emit paths and double the test matrix for a behavior nobody should
choose.

## Testing

`pnpm test`, `pnpm typecheck` and `pnpm lint` must pass.

- **New — event cardinality.** Drive `RESP_CONTACTS_START(N)`, N ×
  `RESP_CONTACT`, `RESP_END_OF_CONTACTS` through the loopback harness for
  N = 5 and N = 50. Assert `contacts` and `discovered` each fired exactly once
  in both runs (the count must not vary with N), `contactUpserted` fired exactly
  N times, and `contactsSynced` fired once with `count === N` and the decoded
  `mostRecentLastmod`.
- **New — flush ordering.** Assert the last three events of a sync are
  `contacts`, `discovered`, `contactsSynced` in that order, and that the
  `contacts` payload already contains all N.
- **New — fail-safes.** A bulk window closed by disconnect flushes the partial
  snapshot; a window left open with no `RESP_END_OF_CONTACTS` flushes when the
  watchdog fires (fake timers). Neither force-close emits `contactsSynced`, and
  neither latches the gate into the next sync.
- **New — empty sync.** `RESP_CONTACTS_START(0)` → `RESP_END_OF_CONTACTS` still
  emits `contacts` and `discovered`, so a `reconcileOnRadio` that cleared
  `on_radio` flags reaches consumers.
- **New — `contactRemoved`.** Fires on placeholder reconciliation, on the
  `END_OF_CONTACTS` prune, on `PUSH_CONTACT_DELETED`, and on
  `removeContactFromRadio`.
- **New — `SessionState`.** `getContact` hit/miss; upsert ordering matches the
  old array semantics (append on new, in place on existing); `getContacts()`
  returns a stable snapshot across a subsequent `removeContact`.
- **New — `DiscoveredStore`.** Every mutator invalidates the memo; repeated
  `list()` calls with no mutation return the same reference.
- **Updated — `tests/publicSurface.test.ts`.** Assert the three new `EventName`
  constants, matching the existing CLI-event assertion style.
- **Existing.** `tests/features/contacts.test.ts`, `tests/state/*`,
  `tests/session/*` and `tests/ports/events.test.ts` are checked for assumptions
  about per-contact snapshot emits and updated where they encode the old cadence.

## Documentation

Exactly two files enumerate the events by hand; both must be updated or the list
silently goes stale.

**`README.md:122`** — the flat `## Events` list. Add `contactUpserted`,
`contactRemoved` and `contactsSynced`. Keep them adjacent to `contacts` /
`discovered` rather than appended at the end, so the delta/snapshot pairing
reads off the list.

**`docs/src/content/docs/guides/events-and-state.md:34-40`** — the same list,
plus the substantive prose change. Add a section after "The events" covering:

- Snapshot vs. delta: `contacts` / `discovered` are full lists; `contactUpserted`
  / `contactRemoved` are per-contact deltas.
- The coalescing rule — during a `GET_CONTACTS` sync the snapshots fire **once**,
  at the end, while deltas keep flowing. This is the behavior change consumers
  most need to read about, so it is stated here, not only in the changelog.
- The map-maintaining consumer pattern, as a short snippet:

  ```ts
  let byKey = new Map<string, Contact>();
  session.events.on('contacts', (all) => { byKey = new Map(all.map((c) => [c.key, c])); });
  session.events.on('contactUpserted', (c) => byKey.set(c.key, c));
  session.events.on('contactRemoved', (key) => byKey.delete(key));
  session.events.on('contactsSynced', ({ count, mostRecentLastmod }) => { /* re-render once */ });
  ```

- That `contactObserved` remains the raw-wire-record channel and is unaffected,
  so the two are not alternatives.

**`docs/src/content/docs/changelog.md`** — the changelog is this Starlight page;
there is no root `CHANGELOG.md`. Match the existing structure: an `## 0.7.0`
heading, a one-line italic summary beneath it (`_…_`, as every prior entry has),
then `### Added` for the three events, `ContactsSyncedSummary` and `getContact`,
and `### Changed` for the emit cadence. There is no "Behavior change" heading in
this changelog's vocabulary — `### Changed` is where it goes, and the page
header already tells readers that pre-`1.0` minor bumps may carry behaviour
changes.

`package.json` is **not** hand-bumped: the publish job derives the version from
the GitHub Release tag, and main carries a `-dev.N` version between releases.
The spec's `0.7.0` is the tag to cut, not a file to edit.

### Generated and no-op surfaces

Recorded so the implementer doesn't go looking for them:

- **`docs/src/content/docs/api/**` is gitignored**, not committed — it is
  regenerated at build time by `starlight-typedoc` from `../src/index.ts`. There
  is nothing to hand-edit, which raises the bar on the TSDoc comments: the
  comments written on the three `MeshCoreEventMap` members, on
  `ContactsSyncedSummary` and on `getContact` *are* the published API reference.
- **`llms.txt` is generated** by the `starlight-llms-txt` plugin at build time.
  No manual file.
- **`examples/` needs no change.** `waitForEvent` in `examples/lib/helpers.ts` is
  generic over `keyof Ports.EventMap`, so it types the new events with no edit,
  and `examples/get-contacts.ts` uses the awaited `session.getContacts()` rather
  than the event stream — adding a listener there would muddy the example. The
  delta pattern belongs in the guide snippet above. `pnpm typecheck:examples`
  still compiles the directory, so any accidental break surfaces.

## Out of scope

Assessed and deliberately deferred, per the brief:

**A DataView/Uint8Array reader replacing `BufferReader`.** The library imports
`node:buffer` and `node:events` with `engines: node >=22` and no `browser`
field, so bundlers pull the ~50KB feross/buffer polyfill into browser builds,
and `BufferReader` does many small reads per contact. This is a separate change
with its own scope: it touches every decoder, not just contacts, and its payoff
is mostly bundle size rather than the sync-path CPU this spec targets — after
coalescing, per-contact decode is a fixed ~148-byte parse rather than an N²
term. It should be measured against a real browser build before being committed
to, and it wants its own spec.

Also out of scope: yielding between frames in `Feature.handle` (removing the
work is the cheaper fix), and any change to `contactObserved`,
`contactDiscovered`, `syncProgress` or the internal `ContactsSyncSignal`.
