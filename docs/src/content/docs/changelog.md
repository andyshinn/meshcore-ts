---
title: Changelog
description: Notable changes to meshcore-ts, newest first.
---

Notable changes to `meshcore-ts`, newest first. Versions follow
[semantic versioning](https://semver.org/); pre-`1.0` minor bumps may still
carry behaviour changes.

## 0.8.1

_Two things 0.8.0 made reachable — an empty path that could not say why it was
empty, and an auto-add gate that was never really consulted — plus the
`transportState` event finally leaving the session, the two regressions that
emitting it introduced on the way, and a stale serial frame that no longer
survives a reconnect._

### Fixed

- **A decoded path could not say whether "zero hops" meant "heard direct" or
  "no path at all".** 0.8.0 taught both `path_len` helpers that `0xFF` is the
  flood / no-path sentinel rather than a compound length, which is what stopped
  a flood reply from being rejected as a short frame. But it left `path_len`
  `0x00` and `path_len` `0xFF` decoding to the identical
  `{ hops: 0, pathHex: '' }`, and `getAdvertPath` / `sendPathDiscoveryReq`
  hand the caller nothing else — unlike a contact row, which keeps its raw
  `outPathLen` byte alongside the decoded path, so its consumer can still tell
  the two apart.

  Downstream, that empty path reads as a fact: an app building an inbound-hops
  column from `getAdvertPath` persisted "heard direct — 0 hops" for nodes it
  held no path information about whatsoever, and the value is stored and sorted
  on, so the wrong reading outlives the query that produced it.

  `AdvertPath` now carries `flood?: true`, and `DiscoveredPath` carries
  `outFlood?: true` / `inFlood?: true` — each leg has its own `path_len` byte,
  so either can be the sentinel independently of the other. The flags are
  optional and only ever `true`: every existing field keeps its type and
  existing consumers keep compiling. Widening `hops` to `number | undefined`
  would have said the same thing more honestly and broken every consumer doing
  arithmetic on it; it was deliberately not taken.

- **The post-advert re-sync ignored the auto-add flags it was supposed to
  check.** `shouldAutoAdd` gated on `AutoAddConfig.mode`, which nothing in this
  library ever assigns — so for any consumer that does not seed the mirror
  itself, `mode` sits at its `'all'` default forever and the function
  short-circuited to `true` for every advert type, never reading the per-kind
  `chat` / `repeater` / `room` / `sensor` flags.

  That was inert while `encodeSetOtherParams` hardcoded
  `manual_add_contacts = 0`: the radio was forced to auto-add everything, so
  essentially every advert arrived as an on-radio `PUSH_ADVERT` (0x80) and
  never reached the gate. 0.8.0 let consumers set bit 0 — and then every
  *refused* advert (`PUSH_NEW_ADVERT`, 0x8a, not on radio) reaches it, each one
  scheduling a full `CMD_GET_CONTACTS` walk behind the 1.5s debounce. On a busy
  mesh that is near-continuous contact enumeration for contacts the radio has
  already declined to store.

  The master switch is now bit 0 of `manualAddContacts`, a genuinely
  radio-mirrored field (`RESP_SELF_INFO` byte 47) rather than app-side state:
  clear means the radio auto-adds everything and its per-kind flags are inert
  (`MyMesh::shouldAutoAddContactType` returns `true` before it ever reads
  `_prefs.autoadd_config`), set means those flags decide.

  `mode` is no longer consulted at all — not in either direction, not as a
  fallback. Only radio-mirrored state can answer a question about what the
  radio would do, and `mode` is not that: the library never assigns it, so it
  reflects whatever the consumer last seeded, which can be arbitrarily stale
  against a byte the radio may have changed since (or that another client
  changed). Honouring it "only where it narrows" was tried and rejected: a
  stored `'selected'` against a radio reporting bit 0 clear would then
  *suppress* a re-sync the radio's own behaviour justifies, and a suppressed
  legitimate walk is a worse failure than an occasional redundant one.

  Two refusals deliberately survive the gate, documented at the
  `scheduleContactsResync` call site rather than guessed at in code, because
  `PUSH_NEW_ADVERT` is emitted by all three of `BaseChatMesh::onAdvertRecv`'s
  early returns and only the first is answerable from the auto-add flags: the
  advert exceeded `getAutoAddMaxHops()`, or `allocateContactSlot()` returned
  `NULL` because the contact store is *full*. Each still schedules a walk that
  cannot produce the contact. The hop case is declined rather than infeasible —
  gating it would mean guessing the firmware's exact comparison — and the
  store-full case the firmware reports separately as `PUSH_CONTACTS_FULL`
  (0x90), which this library already surfaces as the `contactsFull` event.

- **`transportState` was declared, documented, and never emitted.** The event is
  in `MeshCoreEventMap`, exposed as `EventName.TRANSPORT_STATE` and described in
  the README and the events guide, but nothing in the session ever emitted it:
  `onTransportState` drove handshake, liveness and teardown internally and threw
  the state away. Consumers could not route around it either — `Transport.onStateChange`
  is a single-slot setter in every implementation and the session claims that
  slot in `start()`, so 11 of the 17 files in `examples/` gated their whole body
  on an event that never arrived.

  It is now emitted at the *end* of `onTransportState`, after the
  connect/disconnect branch, so a handler never observes half-torn-down session
  state. `start()` routes the already-connected case through the same function
  instead of setting `connected` and kicking the handshake inline, which is what
  used to skip the broadcast — along with the presence clear and the liveness
  poll that branch also owns, so a session started on a live link never polled
  it. That drive is deferred to a microtask, both so a consumer subscribing
  after `start()` in the same tick still hears it and so a transport that
  announces its own open port (as `SerialTransport` does) gets there first and
  leaves it a no-op. Exactly one `'connected'` either way, with no
  de-duplication of the event bus, so genuinely repeated states from a transport
  still reach consumers.

  **That deferral had two consequences of its own, fixed before release in the
  next two entries.** The defer itself is right — it is what makes the event
  reachable at all, and it stands. What it exposed is that `connected` was
  carrying two meanings at once: as well as marking the connect edge it was the
  gate on eleven of the session's commands, so deferring it deferred those too;
  and clearing it in `stop()` (which the same change introduced, correctly, so
  that `stop()` then `start()` is not a silent no-op) left the disconnect
  teardown with no edge to match. What the entries below change is not the defer
  but the double duty: `connected` no longer answers "can I write to the
  radio".

- **`start()` followed immediately by an awaited command wrote nothing.** The
  first of two regressions from the entry above, both in `session.ts` and both
  on the shipped BLE and serial paths. v0.8.0's `start()` set `connected = true`
  synchronously on an already-connected transport; the deferred drive replaced
  that with a `queueMicrotask`. But eleven public commands gated on that same
  field, so it doubled as a "can I write to the radio" flag, and deferring it
  left all eleven returning early for one microtask after `start()`. `start()`
  is synchronous and non-awaitable, so `session.start()` followed by
  `await session.setAdvertName(name)` is the natural call shape — and it wrote
  nothing and returned `false`.

  BLE is always the already-connected case: `createBleTransport` initialises its
  state to `'connected'` and its `watchState` hook is optional, so a consumer
  that omits it gets no announcement at all and `start()`'s microtask is the
  only thing that ever moves the latch. Measured on a BLE-shaped transport: the
  same tick wrote opcodes `[0x16]` and returned `false`; one microtask later it
  wrote `[0x16, 0x08]` and returned `true`.

  The two meanings are now split apart rather than the defer undone. `connected`
  stays exactly the edge latch it became — its one job is keeping
  `onTransportState`'s connect and disconnect branches to a single run per
  connect — and the eleven commands moved to `isCommandable()`,
  `started && transport.getState() === 'connected'`, which asks the transport
  directly the way v0.8.0's synchronous assignment did. The liveness poll's
  guard deliberately stays on `connected`: that timer is armed by the connect
  branch and cleared by the disconnect branch, so it belongs to the edge, not to
  the command surface.

- **`session.stop()` stopped tearing the connection down.** The second
  regression from the same change. Clearing `connected` in `stop()` is right for
  restart — latching it true made `stop()` then `start()` on a still-connected
  transport a silent no-op — but it also meant a later transport
  `'disconnected'` no longer matched the `wasConnected` edge, so the disconnect
  branch never ran at all. `session.stop()` followed by `port.close()` is the
  shipped teardown order in nine of the examples (the two BLE examples do the
  same with `peripheral.disconnectAsync()`), so this is the common path.
  Measured: `stop()` then an idle state change left `getSyncProgress().phase`
  latched at `'syncing'` forever, and a typed awaiter rode the full 5 s
  `REQUEST_TIMEOUT_MS` instead of rejecting; v0.8.0 gave `idle` and an immediate
  rejection.

  The disconnect branch is now extracted verbatim into
  `tearDownConnection(reason)` and called from `stop()` while the latch is still
  set, before clearing it — a pure extraction, same work in the same order, with
  the provenance comments moved alongside the code. The teardown is what clears
  those awaiters, so nothing is left for a late reply to be matched against, and
  `stop()` is immediately followed by closing the transport in every shipped
  example; leaving them queued only makes callers wait out a timeout for an answer that can no longer arrive. All
  fifteen `transportState` tests still pass unchanged; none of them had encoded
  the buggy behaviour.

- **A half-received serial frame survived a reconnect and swallowed the frames
  behind it.** `SerialDeframer.reset()` existed but had zero callers in `src/` —
  only its own unit test called it. `SerialTransport` observes a `SerialPort`
  the consumer owns, and its `'close'` handler only set the state to `'idle'`,
  so a partial frame sitting in the deframer buffer at close time survived into
  the next open of that same port object.

  That is not self-correcting. `push()` drops a byte only when the HEADER is
  invalid, and a buffered partial frame has a valid header, so it is never
  resynced away: it splices the reconnect's first bytes into itself, fabricating
  one bogus frame and swallowing the real ones behind it. Observed at session
  level — feed a 5-byte partial (`3e 10 00 aa bb`), close, reopen, then deliver
  `RESP_SELF_INFO`: the deframer emitted a single bogus 16-byte frame (the stale
  tail, then the reconnect's real header, then the first 11 bytes of the real
  payload) and zero real frames, leaving `session.state.getOwner()` `null` where
  the same run without the partial yields the real owner key.

  `'close'` now resets the deframer. The `'error'` handler is deliberately left
  alone: a serialport `'error'` does not imply the byte stream ended (a failed
  write leaves the port open and data flowing), so resetting there would discard
  a legitimate in-flight partial frame — and an error that really does end the
  stream emits `'close'` as well, which now resets. This one is **pre-existing
  rather than a 0.8.1 regression**: the new tests fail against v0.8.0's
  `serialTransport.ts` too, which differs from the pre-fix 0.8.1 file only by a
  comment. `TcpTransport` is unaffected and untouched — `connect()` rejects when
  a socket already exists and `close()` never clears it, so the instance is
  single-use and its deframer cannot outlive its socket.

- **`parseCompanionFrame` could not name RESP code `0x1a`.** `frame.ts` kept its
  own hand-written `PUSH_NAMES` / `RESP_NAMES` mirrors of the code tables in
  `codes.ts`, and the copy had drifted: `RESP_ALLOWED_REPEAT_FREQ` (26) was
  missing, so a frame carrying it came back with the
  `codeName: 'frame 0x1a'` fallback. Consumers render that string — a packet
  inspector or a trace log prints it verbatim — so the gap was visible, not
  internal.

  Both tables are now derived from `codes.ts` by inverting it, so a new
  `PUSH_*` / `RESP_*` constant is named automatically and the two cannot drift
  again. `codeName` for `0x1a` changes from `'frame 0x1a'` to
  `'RESP_ALLOWED_REPEAT_FREQ'`; every other code keeps the name it had in
  v0.8.0 (a full 256-code sweep of `parseCompanionFrame` finds that one
  difference and no other). If you have a fixture, a filter or a log assertion
  keyed on the `'frame 0x1a'` fallback, that is the one string to update.

### Added

- **`Protocol.PUSH.LOG_RX_DATA` (`0x88`).** The one push code the `PUSH` table
  was missing, added while `frame.ts` moved off its private `const
  PUSH_LOG_RX_DATA = 0x88` copy onto the shared table. Purely additive — if you
  were hand-rolling the constant to recognise raw on-air frames, you can now
  import it.

### For consumers

- **`AutoAddConfig.mode` no longer influences the post-advert re-sync.** The
  field is unchanged, still public, still defaulting to `'all'`; only its
  effect on that internal gate is gone. If you seed the mirror through
  `session.state.setAutoAddConfig` and were relying on `mode: 'selected'` to
  hold the gate closed before the radio had reported byte 47, set bit 0 of
  `manualAddContacts` instead — that is the value the gate reads, and the one
  the radio will confirm or correct on the next `RESP_SELF_INFO`.

- **`transportState` now actually fires, so a handler you already wrote goes
  live.** Through v0.8.0 the event was declared, typed and documented but
  emitted from nowhere, so any subscription to it was dead code — and upgrading
  activates it with no edit on your side. That makes it the one change here you
  should look at before taking the bump: check that your handler is idempotent
  (nothing de-duplicates the channel, and a transport that reports the same
  state twice means it twice), and that it is not competing with your own
  transport-state plumbing for the same downstream state. The payload is a bare
  `TransportState` and carries no device identity, so a handler that
  re-broadcasts it onto an app-level bus expecting one can blank whatever the
  app had recorded — that is exactly what it did to the first consumer to take
  0.8.1, whose re-broadcast had been inert since it was written.

- **The two session-lifecycle fixes and the serial-deframer fix ask nothing of
  you.** No public type, field, event payload or call signature changed in any
  of the three, and the members the lifecycle fix adds — `started`,
  `isCommandable()`, `tearDownConnection()` — are all private. Upgrading is the
  entire action.

  Worth naming anyway, because one of them restores a call shape.
  `session.start()` followed immediately by an awaited command — say
  `await session.setAdvertName(name)` — writes the frame in 0.8.1 exactly as it
  did in 0.8.0. It stopped writing only on unreleased `main`, in between — the
  `transportState` work that broke it and the fix that restored it both land
  here — so **no published version has that regression**, and there is no
  version to avoid. If you are tracking `main` and added a timer, a
  `queueMicrotask`, or a wait on the `transportState` event to work around it,
  that workaround is no longer needed; it also stays correct, so there is no
  hurry to unpick it.

## 0.8.0

_The contact list finally goes live: a newly auto-added contact no longer waits
for a reconnect._

### Fixed

- **A node the radio had just auto-added never reached the contact list.** The
  firmware announces it with `PUSH_ADVERT` (0x80) — and this library dropped
  exactly that case on the floor, because it looked the pubkey up in its own map
  first and returned when it found nothing. The contact stayed invisible until
  the next full `CMD_GET_CONTACTS` sync, which in practice means a reconnect.
  That was the entirety of "the contact list is not live".

  The two push codes mean the opposite of what their names suggest, and this is
  worth writing down permanently. `BaseChatMesh::onAdvertRecv`
  (`src/helpers/BaseChatMesh.cpp`) declares

  ```cpp
  bool is_new = false; // true = not in contacts[], false = exists in contacts[]
  ```

  and **never assigns it `true` anywhere in the function** — `grep -n is_new
  BaseChatMesh.cpp` returns exactly two hits, the declaration and the final
  call. The only `true` values are three *literals* passed on three *early
  return* paths, and every one of those is a **refusal**: auto-add is off for
  that contact type, the advert exceeded `getAutoAddMaxHops()`, or
  `allocateContactSlot()` returned `NULL`. The success path — including the very
  first time a node is heard and auto-added — falls straight through to

  ```cpp
  onDiscoveredContact(*from, is_new, packet->path_len, packet->path);  // still false
  ```

  and `MyMesh::onDiscoveredContact` (`examples/companion_radio/MyMesh.cpp`) maps
  `false` to `PUSH_CODE_ADVERT` and `true` to `PUSH_CODE_NEW_ADVERT`. So on the
  wire, `0x8a` **`PUSH_NEW_ADVERT`** (148 B) means *"here is a node I refused to
  store"* — it is **not** on the radio — and `0x80` **`PUSH_ADVERT`** (33 B)
  means *"a node that is in my contact store advertised"*, **including
  microseconds after the radio itself auto-added it**. `0x80` is the only frame
  that ever announces a newly auto-added contact. There is no other.

  `PUSH_ADVERT` now always schedules the debounced
  `CMD_GET_CONTACT_BY_KEY` re-fetch, for any pubkey it decodes, rather than only
  for contacts already in the map. The `lastSeenMs` touch still requires an
  existing contact — there is nothing to merge into otherwise. The refresh
  remains fire-and-forget and de-duplicated per pubkey, so a burst of adverts
  still produces a single request; when the radio genuinely does not hold the
  contact the lookup resolves `null` and the cost is one wasted 33-byte request.

- **A contact recovered that way would still not have appeared, because
  `onRadio` was inferred from the ingest source.** `ingestContact` derived
  `onRadio` as `source === 'sync' ? true : alreadyOnRadio`, and only an
  `onRadio` record reaches `upsertOnRadioContact` — the call that actually puts
  the contact into state and fires `contactUpserted` and the `contacts`
  snapshot. For the brand-new contact the fix above exists to rescue,
  `alreadyOnRadio` is `false` by definition, so simply re-ingesting as
  `'advert'` would have changed nothing observable.

  "Is it on the radio" and "did we hear it live" are independent facts, and the
  old code conflated them. A record returned by `CMD_GET_CONTACT_BY_KEY` is on
  the radio by construction — the radio answered for it — so the refresh path
  now asserts `onRadio: true` explicitly, whatever the source. A genuinely
  first-seen contact consequently emits `contactDiscovered`, records a real
  first-heard timestamp in the discovered pool, and lands in the contact list
  within the 50 ms debounce.

- **`lastSeenMs` could jump backwards — sometimes by years — moments after a
  correct value was shown.** `upsertOnRadioContact` set it from
  `record.lastAdvertUnix`, which is `ContactInfo.last_advert_timestamp`: a value
  the firmware copies straight off the advert packet. It is the **advertising
  node's own RTC**, not ours and not the radio's, and mesh nodes routinely run
  with unset or badly-skewed clocks. The `PUSH_ADVERT` handler would stamp an
  honest `Date.now()`, and ~50 ms later the debounced refresh re-ingested the
  same contact and overwrote it with the advertiser's claim.

  `lastSeenMs` is now monotonic. The advertiser's timestamp is first clamped to
  the present — otherwise a node whose clock reads 2031 pins the field to a
  future value that the monotonic guard then makes permanent — and then
  `Math.max`'d against the value already held. `undefined` is still produced
  when nothing is known, so an unknown last-seen never renders as the epoch.

- **Every telemetry or share-position save silently forced the radio into
  auto-add-everything, and made `CMD_SET_AUTO_ADD_CONFIG` a no-op.**
  `encodeSetOtherParams` wrote a hardcoded `0` into byte 1 of
  `CMD_SET_OTHER_PARAMS`, commented `// reserved`. Byte 1 is not reserved. It is
  the first thing `MyMesh::handleCmdFrame` assigns, before every length guard:

  ```cpp
  } else if (cmd_frame[0] == CMD_SET_OTHER_PARAMS) {
      _prefs.manual_add_contacts = cmd_frame[1];
      if (len >= 3) { ...telemetry... }
      savePrefs();
  ```

  and that pref gates auto-add entirely:

  ```cpp
  bool MyMesh::shouldAutoAddContactType(uint8_t contact_type) const {
    if ((_prefs.manual_add_contacts & 1) == 0) {
      return true;                     // auto-add EVERYTHING; autoadd_config ignored
    }
    ... return (_prefs.autoadd_config & type_bit) != 0;
  }
  ```

  Two consequences compounded. Writing bit 0 clear put the radio into
  auto-add-everything, so every advert from an unknown node was auto-added — and
  therefore arrived as a `0x80` frame, precisely the frame this library dropped.
  The two defects were the same bug seen from opposite ends. And because
  `shouldAutoAddContactType` returns `true` before ever consulting
  `_prefs.autoadd_config`, this library's entire `setAutoAddConfig` surface —
  the per-kind chat/repeater/room/sensor flags — was writing a byte the firmware
  then refused to read. Downstream auto-add settings UIs were decorative.

  `manual_add_contacts` is now preserved rather than zeroed. It was already
  decoded from `RESP_SELF_INFO` byte 47 and then dropped on the floor; it is now
  folded into `AutoAddConfig` and written back on every successful
  `setOtherParams`.

- **`repeaterStatus` fields now match the firmware's `RepeaterStats` struct.**
  The repeater memcpy's the struct straight onto the wire
  (`examples/simple_repeater/MyMesh.h`), so the payload is packed, naturally
  aligned, little-endian, with no padding. We were decoding
  `battery u32 / tx_queue u32 / free_queue u32 / last_rssi i16 / …` — the
  widths were wrong from byte 2 onward, and `free_queue` is not a field at all.
  The real head of the struct is `u16 batt_milli_volts`,
  `u16 curr_tx_queue_len`, `i16 noise_floor`, `i16 last_rssi`, then the u32
  counters.

  Battery appeared to work only because an idle repeater's TX queue is zero:
  reading `[0..3]` as a u32 picked up `batt_mv | (tx_queue << 16)`, which equals
  `batt_mv` exactly when the queue is empty. On a busy repeater with 3 queued
  packets, a 4.02 V battery was reported as 200.628 V. Every field after it —
  RSSI, packet counts, airtime, uptime, dup counters — was read from the wrong
  offset and was garbage regardless of queue depth.

  Fields added, previously missing entirely: **Noise floor** (`i16`, dBm),
  **RX airtime** (`u32`, seconds) and **RX errors** (`u32`). Renamed:
  `Airtime` → **TX airtime** (it is `total_air_time_secs`, the TX side — the
  new `RX airtime` would otherwise be ambiguous); `Queue-full evts` →
  **Error events** (the firmware renamed `n_full_events` to `err_events`).
  Removed: `Free queue`, which never existed. `Direct dups` / `Flood dups` are
  `u16`, not `u8`, so counts above 255 no longer wrap.

  Frames are decoded field by field against the length actually received, so a
  pre-v1.12.0 repeater's 52-byte frame (no `n_recv_errors`) still decodes
  everything up to `RX airtime` instead of throwing.

  The old unit test built its fixture to the same wrong layout, so it confirmed
  the bug rather than catching it. It now builds frames from the firmware struct
  — including a non-zero TX queue, which is what exposes the battery error, and
  a legacy 52-byte frame.

- **Every ACL role decoded wrong.** `parseAclList` read the permissions byte as
  independent flag bits (`perms & 0x01` = admin, `perms & 0x02` = guest), but the
  firmware stores a 2-bit role *value* there (`helpers/ClientACL.h`:
  `PERM_ACL_GUEST=0`, `READ_ONLY=1`, `READ_WRITE=2`, `ADMIN=3`, with
  `isAdmin() == ((permissions & PERM_ACL_ROLE_MASK) == PERM_ACL_ADMIN)`). All
  four roles came out incorrect, not just the edge cases: read-only reported as
  admin, read-write as guest, admin as both admin *and* guest, and guest as
  neither. Any consumer gating on `isAdmin` was granting or denying on noise.

  Decoding now goes through the existing `PERM_BITS` constants. Deleted and
  padding entries are filtered the way both producers do it — the repeater skips
  clients with `permissions == 0` when building the list, and meshcore_py's
  `parse_acl` drops all-zero pubkey prefixes — without which trailing padding
  surfaced as bogus guest entries.

  `parseLoginSuccess` is unaffected: its `frame[1]` genuinely is a boolean
  (`reply_data[6] = client->isAdmin() ? 1 : 0`), and the raw role byte at
  `frame[12]` was already masked correctly. Only its comment changed.

- **A flood-routed advert was rejected instead of decoded.** The mesh `path_len`
  byte is normally compound (low 6 bits = hop count, top 2 bits + 1 =
  bytes-per-hop), but `0xFF` is a sentinel meaning flood / no path, with no path
  bytes following. `pathByteLen()` unpacked it blindly as 63 hops × 4 bytes = 252
  required bytes, so `decodeAdvertPath` threw out an otherwise valid
  `RESP_ADVERT_PATH` frame rather than decoding it as a zero-hop result. The same
  blind spot hit `decodePathDiscoveryResponse`'s `out_path_len` and `in_path_len`.

  Both helpers now special-case the sentinel, so every caller sees zero hops and
  an empty path. `AdvertPath` deliberately kept its shape rather than gaining a
  flood flag — an empty path is already how the rest of the library surfaces a
  `0xFF` path length (`decodeContact`, the session contact rows). That call did
  not hold: with no raw `path_len` to fall back on, a `getAdvertPath` caller
  could no longer tell "heard direct" from "no path cached", so 0.8.1 adds the
  flag after all.

- **Zero-filled trailing entries surfaced as real frequency ranges.**
  `decodeAllowedRepeatFreq` walked the whole `RESP_ALLOWED_REPEAT_FREQ` frame in
  8-byte steps and emitted every pair it found, so a zero-padded frame produced
  spurious `{ lowerKhz: 0, upperKhz: 0 }` ranges. It now stops at a pair with
  either bound zero, matching meshcore_py's end-of-list sentinel. The
  companion_radio firmware writes exactly one pair per configured range and sizes
  the frame to match, so this is defensive rather than a fix for observed output;
  the existing tolerance for a trailing partial (<8 byte) chunk is unchanged.

### Changed

- **`MeshCoreSession.setOtherParams` takes an optional third argument,
  `manualAddContacts?: number`.** Omit it — as every existing caller does — and
  the value the radio last reported is preserved. Existing callers saving
  telemetry policy or share-position get the correct behaviour on upgrade with
  no source change; that is deliberate, since neither of those operations is
  about auto-add and forcing them to supply an unrelated byte is how the
  original bug arrived. Pass it explicitly only to change auto-add behaviour:
  bit 0 clear = auto-add everything and ignore `autoadd_config`, bit 0 set =
  honour the per-kind flags.

- **`OtherParamsInput.manualAddContacts` is required** on the internal
  `encodeSetOtherParams`. The encoder is not re-exported, so this is not a
  public break; it exists to make the compiler find any call site that would
  otherwise silently reintroduce the zero.

- `PUSH_ADVERT` re-fetches now carry the `'advert'` source through to
  `contactObserved` and the discovered pool, where they previously reported
  `'sync'`. `PUSH_PATH_UPDATED` still reports `'sync'` — a path update is not an
  advert and must not mark a contact heard-live. Where a `PUSH_ADVERT` lands
  inside an already-running `PUSH_PATH_UPDATED` debounce, the pending refresh is
  upgraded to `'advert'` rather than swallowing the flag.

### Added

- **`AutoAddConfig.manualAddContacts: number`** — the firmware's
  `_prefs.manual_add_contacts`, decoded from `RESP_SELF_INFO` byte 47 and
  emitted on the existing `autoAddConfig` event, so consumers can read and
  round-trip it. It corresponds to the existing `AutoAddConfig.mode` — `'all'` ↔
  bit 0 clear, `'selected'` ↔ bit 0 set — so `mode`, documented as an app-side
  convenience, turns out to describe a real firmware bit. The two are **not**
  kept in sync by the library: nothing here ever assigns `mode`, so it sits at
  its default while `manualAddContacts` tracks the radio. Treat the byte as the
  source of truth; a consumer with an auto-add settings panel should drive the
  byte and derive its `mode` display from it, not the reverse.


- **`AclEntry.role: AclRole`** (`'guest' | 'readOnly' | 'readWrite' | 'admin'`) —
  the authoritative reading of the permissions byte's low 2 bits, alongside the
  raw `permissions` byte that is still exposed. `isAdmin` and `isGuest` remain,
  now as exact role checks rather than flag tests.

- **`decodeAclRole(permissions: number): AclRole`** is exported for callers
  holding a raw permissions byte from somewhere other than an ACL list entry —
  `LoginSuccess.aclPermissions`, for instance.

### For consumers

- **`heardLive`-style checks on `source === 'advert'` keep working and become
  correct with no code change.** `ContactSource` is unchanged (`'sync' |
  'advert'`); widening it to add a `'re-advert'` member was considered and
  rejected, because every downstream `source === 'advert'` check would have
  silently stopped meaning "heard live" — a behavioural regression that compiles
  clean. A consumer doing
  `discoveredStore.upsert(record, { heardLive: source === 'advert' })` gets
  accurate first-heard data from a version bump alone.
- **One type-level caveat:** `AutoAddConfig` gains a *required* member, which
  breaks external code that builds one as an object literal. Spread an existing
  config, or add `manualAddContacts` to the literal. Code that only reads
  `AutoAddConfig` is unaffected.
- **The ACL role fix changes what `isAdmin` means.** `AclEntry.isAdmin` was
  `(permissions & 0x01) !== 0` and is now `role === 'admin'`. Code gating admin
  UI or destructive repeater actions on it was previously wrong for every role —
  it needs no source change, but it will start behaving differently, and that is
  the point.
- **A second type-level caveat:** `AclEntry` gains a *required* `role` member,
  which breaks external code that builds one as an object literal (test fixtures,
  mostly). Code that only reads `AclEntry` is unaffected.
- `ingestContact` and `scheduleContactRefresh` changed signatures but are
  internal — neither is re-exported from `src/index.ts` or `src/features.ts`.

## 0.7.2

_Reverts 0.7.1: the V3 message header byte read as RSSI is a firmware reserved
byte, so 0.7.1 published `rssi: 0` on every received message._

### Fixed

- **`Message.meta.rssi` is no longer populated from a reserved byte.** 0.7.1
  read byte 2 of `RESP_CONTACT_MSG_RECV_V3` (0x10) and
  `RESP_CHANNEL_MSG_RECV_V3` (0x11) as RSSI. It is not RSSI. The firmware emits
  `out_frame[i++] = 0; // reserved1` followed by `= 0; // reserved2` for 0x10,
  0x11 and 0x1B alike (`companion_radio/MyMesh.cpp`), and the official
  `companion_protocol.md` documents "Bytes 2-3: Reserved", with pseudocode that
  does `offset += 3  # Skip SNR + reserved`.

  The `[code][snr*4 i8][rssi i8][0xFF]` header 0.7.1 assumed belongs to
  `PUSH_RAW_DATA` (0x84) — the parsers in `rawData.ts` were right all along —
  along with 0x88 and 0x8e. Those are the only frames the firmware fills from
  `getLastRSSI()`, which is why RSSI has always reached the packet log but
  never a `Message`.

  Because byte 2 is a compile-time `0`, 0.7.1 published `rssi: 0` on **every**
  received V3 message, and `0 !== undefined` meant the conditional spread always
  emitted the key. Consumers that gate on `rssi != null` therefore rendered a
  full-strength "0 dBm" reading on every message — worse than the absent value
  the change set out to fix. **Upgrade from 0.7.1 — it reports a bogus RSSI on
  every received message.**

  `MessageMeta.rssi` remains declared but unpopulated. Filling it in means
  correlating the separate 0x88 RX-log push, the way `meta.paths` already is —
  the approach `meshcore_py` takes. Prefer `meta.snr`, which is real.

  Three regression tests now build V3 frames with deliberately non-zero
  reserved bytes and assert no `rssi` surfaces, so re-reading byte 2 fails in
  CI rather than on a radio.

## 0.7.1

:::caution[Retracted — superseded by 0.7.2]
**The frame layout described below is wrong, and this release should not be
used.** Bytes 2-3 of the V3 message frames are firmware reserved bytes
(hardcoded 0), not `[rssi][1B rsv]`. Reading byte 2 made `meta.rssi` a constant
`0` on every received message. See [0.7.2](#072). The entry is kept as written
for the historical record.
:::

_`meta.rssi` is finally populated on inbound messages._

### Fixed

- **`Message.meta.rssi` was never populated.** The V3 message frames carry both
  link metrics in one header — `[code][snr*4 i8][rssi i8][1B rsv][…]` — but
  `decodeChannelMsgV3` and `decodeContactMsgV3` read byte 1 for SNR and then
  jumped straight to byte 4, so the RSSI byte was dropped. RSSI reached
  `rawPacket` (whose parsers do read byte 2) but never a `Message`, so
  `MessageMeta.rssi` — which has been declared all along — was always
  `undefined`. Both V3 decoders now read byte 2 and include it in `meta` at the
  two `messageUpserted` emit sites, alongside `snr`.

  `rssi` is optional on `ChannelMsgV3` / `ContactMsgV3` and spread
  conditionally. V1 frames carry no signal header at all (which is why they
  hardcode `snrDb` 0), so a V1-decoded message has no RSSI to report — and
  omitting the key rather than setting it `undefined` keeps a V1 re-receipt
  from wiping an RSSI that an earlier V3 reception merged onto the same row.

## 0.7.0

_Syncing contacts stops being quadratic, and consumers get per-contact deltas._

### Added

- **`contactUpserted` and `contactRemoved`** — per-contact delta events, so a
  consumer can maintain its own map instead of re-rendering the whole list on
  every change. `contactUpserted` carries the merged `Contact`, not the raw wire
  record, so the library's path/GPS/favourite merge rules aren't something you
  have to reimplement.
- **`contactsSynced`** — fires when a `GET_CONTACTS` iteration completes,
  carrying `ContactsSyncedSummary { count, mostRecentLastmod }`.
  `mostRecentLastmod` was previously decoded and discarded, leaving no way to
  obtain the value an incremental re-sync needs.
- **`SessionState.getContact(key)`** — O(1) lookup by contact key.

### Changed

- **`contacts` and `discovered` are coalesced during a contact sync.** They
  previously fired once per `RESP_CONTACT`; they now fire once, at the end of
  the iteration, immediately before `contactsSynced`. Syncing N contacts emits
  2 full-list events instead of 2N. If you were relying on the list growing
  incrementally mid-sync, subscribe to `contactUpserted` instead — and
  `syncProgress` still reports done/total throughout.
- Contact ingest is O(1) per record rather than O(N): `SessionState` is backed
  by a `Map` and `DiscoveredStore.list()` is memoized behind a dirty flag. A
  full sync drops from O(N² log N) to O(N log N). `getContacts()` and
  `DiscoveredStore.list()` now return memoized arrays — treat them as
  immutable, as `getContacts()` already required.
- Placeholder-to-full-key reconciliation now removes the placeholder before
  upserting the real contact, not after. The placeholder is the synthesised
  stand-in a DM from an unknown sender creates until an advert supplies the
  full public key; reconciling it outside a coalesced sync window — for
  example, `addContactToRadio` committing a discovered contact that already
  has an outstanding placeholder — now fires one `contacts` snapshot where
  the contact is absent entirely, immediately followed by a second snapshot
  with the real contact. Both emits land in the same synchronous call, so
  batching frameworks (React 18+) never render the gap, but code that reacts
  to `contacts` directly will see the transient.

## 0.6.0

_Heard repeater relays are attributed to the send they actually belong to._

### Fixed

- **Channel relay chips landed on the wrong message.** Sending two channel
  messages inside the retention window, where the first was never relayed,
  credited every relay of the *second* send to the *first* one — the first
  bubble showed `✓ ×2` while the second stayed `sent`. Attribution matched on
  arrival order rather than on identity: the first pending entry whose channel
  hash matched and which had not yet locked a ciphertext claimed the
  observation, with no content, causality, or ownership check. Three distinct
  failures came out of that one rule, all now fixed:
  - relays of a later send credited to an earlier unheard one;
  - a late relay of the earlier send then credited to the later one, swapping
    the two permanently;
  - a stranger's message on the same channel claiming a pending entry, after
    which the sender's own relay no longer matched at all.
- **Expiry only ever inspected the oldest entry.** Eviction walked the head of
  the buffer and stopped at the first live entry, so anything behind a
  longer-lived entry survived indefinitely. It now scans the whole buffer.
- **Stale sends survived a reconnect.** Pending sends and recorded mesh
  observations are now dropped on `session.stop()` and on transport disconnect,
  so the first relay heard after reconnecting cannot be claimed by a send from
  the previous link.

### Added

- **`Protocol.decryptGrpTxt(secretHex, macAndCipher)`.** Verifies the 2-byte
  HMAC-SHA256 MAC on a channel packet and decrypts the AES-128-ECB body,
  returning `{ timestampUnix, flags, body }`. Validated against a real captured
  `#bachelorette` packet.
- **`sendChannelText` returns `timestampUnix`** — the timestamp the radio
  encrypts into the outgoing packet.
- **`registerChannelSend` accepts `timestampUnix`.** Supplying it upgrades relay
  attribution from a heuristic to an exact match: the timestamp inside a heard
  packet identifies which send it is a relay of, and the MAC check rejects
  packets from a foreign channel whose one-byte hash collides with yours.
  Existing callers that omit it keep the previous (improved) heuristic
  behaviour.

## 0.5.0

_A repeater CLI console API: its own send-state events, per-call timeouts,
cancellation, and fire-and-forget commands._

### Added

- **`cliSendState` event.** A repeater CLI command travels as a direct message
  on the wire but is not conversation traffic, so it no longer lands in the
  message store. Its lifecycle surfaces on `cliSendState`
  (`{ id, contactKey, state }`) instead.
- **`cliUnmatched` event.** A CLI reply that arrives with no awaiter waiting for
  it — a late answer, or one the console already gave up on — is emitted as
  `cliUnmatched` (`{ contactKey, body }`) rather than dropped or forced into the
  message store.
- **`repeaterSendCli(contactKey, command, opts)` options:**
  - `timeoutMs` — per-call override of the wait.
  - `signal` — an `AbortSignal`; the promise rejects with `signal.reason`. The
    command may already be on the air, so aborting drops our awaiter and frees
    the per-repeater slot, it does not recall the send.
  - `expectReply: false` — for commands the firmware never answers (`reboot`,
    `poweroff`, `clkreboot`, `start ota`): the handler reboots or powers down
    instead of writing a reply, and the firmware only transmits one when the
    reply is non-empty. Such a send registers no awaiter, resolves `''` as soon
    as the radio confirms the send, and rejects as soon as the send definitively
    fails. Its timer bounds that confirmation rather than a reply, so the
    default drops from `CLI_REPLY_TIMEOUT_MS` to the much shorter
    `ADMIN_SENT_TIMEOUT_MS`.
- **Timeout defaults exported on `Models`:** `CLI_REPLY_TIMEOUT_MS` (30s),
  `ADMIN_REPLY_TIMEOUT_MS` (20s), `ADMIN_SENT_TIMEOUT_MS` (5s).

### Changed

- **CLI sends no longer emit `messageState` or enter the message store.**
  Consumers driving a repeater console listen on `cliSendState`; anything that
  correlated CLI traffic through `messageState` has to move.

### Fixed

- **Unhandled rejection when a CLI send was aborted mid-write.**
  `repeaterSendCli` awaited `ctx.writeFrame` before anything was attached to its
  wait promise, so an abort, supersede, or short timeout landing inside that
  window rejected a promise nobody was holding — fatal in the consumer's process
  under Node's default `--unhandled-rejections=throw`, and not catchable by the
  caller, since the rejection was detected before `return wait` ever chained it.
  The headline case is a console user clicking Cancel while a BLE GATT write
  drains. The write is now fired off and the wait returned in the same
  synchronous turn.
- **Fire-and-forget sends reported the wrong failure reason.** A send with
  `expectReply: false` registers no pending entry, so a disconnect or a radio
  rejection left it pending until its timeout, which then blamed "send was not
  confirmed" rather than what actually happened.

## 0.4.1

_Tagged `v0.4.1` but never published to npm — no GitHub Release was cut, so the
publish workflow never ran. Shipped as part of 0.5.0._

### Fixed

- **`repeaterLogin` mislabelled a direct neighbour as flood.** The `effective`
  label derived reachability from `outPathHex`, so a known 0-hop route (empty
  `out_path`, but `out_path_len != 0xFF`) read as flood. The label now derives
  from `contact.hops`, matching meshcore_py: undefined (`out_path_len` `0xFF`,
  py's `-1`) is the only flood case, `0` is direct, and `>= 1` is a routed path.
  `sendAnonReq`'s zero-hop-direct routing already mirrored meshcore_py and is
  unchanged.

### Changed

- **Sends nobody has relayed yet expire after 30s** rather than riding out the
  full 90s retention. An unclaimed entry is the one that can mis-claim a
  passing packet, so it should not linger; 30s still comfortably covers a
  one-way relay. Sends whose relay has been heard keep the full 90s window so
  late extra hops still attribute.

## 0.4.0

_Guest logins, and repeater logins now route over the mesh._

### Added

- **Guest login.** `session.repeaterLogin(contactKey, '')` now performs a guest
  login with an empty password. This is the bootstrap a public repeater expects
  before it will answer login-gated requests: the flooded login reply installs
  the contact's `out_path` and adds you to the repeater's ACL.

### Changed

- **Repeater logins always dispatch via `CMD_SEND_LOGIN` (`0x1a`).** The radio
  routes the frame for us — **direct** when the contact's `out_path` is known,
  **flood** when it isn't — so the one command covers Direct / Flood / N-hop.
  Previously only `preferDirect` contacts used `CMD_SEND_LOGIN`; mesh logins went
  out as an anonymous request (`CMD_SEND_ANON_REQ`, `0x39`) that rejected empty
  passwords, so a guest login was impossible.
- `repeaterLogin`'s signature and return shape are unchanged
  (`repeaterLogin(contactKey, password) → LoginSuccess & { mode, effective }`);
  `mode`/`effective` remain UI labels derived from the contact's path state.

### Removed

- **`Protocol.buildAnonLogin`.** It only existed to wrap a password as anon-request
  data for the old mesh-login path, and it could not build a valid guest frame (an
  empty anon request is rejected by the firmware). Login framing now goes through
  `Protocol.buildSendLogin`, which accepts an empty password.

## 0.3.2

_Developed after 0.3.1 as the `0.3.2-dev` series and shipped as part of 0.4.0._

### Fixed

- **Public owner-info and telemetry now work without a login.** These requests
  previously targeted the wrong companion command families, so a repeater serving
  them publicly never answered (while `meshcore_py` did).
  - `session.repeaterRequestOwnerInfo(contactKey)` now uses the public anon OWNER
    request and parses `[now][name\nowner]`; it returns `OwnerInfo | null`
    (`firmwareVersion` is empty — the anon response carries no version).
  - `session.sendTelemetryReq(contactKey)` now uses the binary TELEMETRY request
    and decodes the tagged CayenneLPP payload, re-emitting the same
    `repeaterTelemetry` snapshot. The legacy `PUSH_TELEMETRY_RESPONSE` handler is
    retained for self/legacy devices.
- **Multi-byte path-hash sizes are handled correctly.** The `out_path` length byte
  is now packed/parsed as MeshCore's `((hashSize - 1) << 6) | hopCount`, and routes
  are reversed by hop, so hash sizes larger than one byte are no longer mangled
  (previously the code assumed 1-byte hashes).

### Added

- Low-level public anon request access: `session.sendAnonReq(contactKey, anonType)`
  (`anonType` from `Protocol.ANON_REQ_TYPE`).
- Typed public anon wrappers: `session.repeaterRequestRegions(contactKey)`
  (region-name listing) and `session.repeaterRequestClock(contactKey)` (the
  repeater's RTC clock, unix seconds).
