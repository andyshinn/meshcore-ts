---
title: Changelog
description: Notable changes to meshcore-ts, newest first.
---

Notable changes to `meshcore-ts`, newest first. Versions follow
[semantic versioning](https://semver.org/); pre-`1.0` minor bumps may still
carry behaviour changes.

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
