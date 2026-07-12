---
title: Changelog
description: Notable changes to meshcore-ts, newest first.
---

Notable changes to `meshcore-ts`, newest first. Versions follow
[semantic versioning](https://semver.org/); pre-`1.0` minor bumps may still
carry behaviour changes.

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
