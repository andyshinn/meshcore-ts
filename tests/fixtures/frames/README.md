# Protocol frame fixtures

Real MeshCore companion-protocol frames, used by the per-feature protocol decoder unit tests.

## Provenance

- **Source:** `coresense.log` in the repo root — a BLE device-connect session.
- **Device:** Heltec T114, firmware `v1.15.0`, app protocol version 4.
- **Frame form:** each `hex` is the full de-framed companion frame (leading
  code byte + payload), i.e. exactly what a feature's `decode*(frame)` /
  `parse*(frame)` receives (decoders now live in the per-feature modules under
  `src/main/protocol/features/` and in `src/main/protocol/repeater.ts`).

## Regenerating / extending

Run `node scripts/extract-fixtures.mjs <path-to-log>` to dump every `hex=...`
line from a log file (grouped by frame code) for inspection, then copy the
frames you want into `connect-session.json` (or a new fixture file) with a note
about what each one represents.
