# Library layering & public-API curation — design

**Date:** 2026-06-18
**Status:** Approved (design), pending implementation plan
**Package:** `@andyshinn/meshcore-ts` (v0.1.1)

## Problem

`src/index.ts` is a flat barrel of ~48 `export * from './…'` lines. This has two
coupled problems:

1. **No public/private boundary.** Every internal helper (`BufferReader`,
   `encode*`/`decode*` functions, `SerialDeframer`, etc.) becomes published API
   the moment it ships, so nothing can be refactored without a semver-major
   bump. The boundary is currently accidental, not designed (e.g. `pubkey.ts`
   is *not* exported, while many internals are).
2. **No internal layering.** Files sit mostly flat at `src/` root with a few
   folders (`features/`, `ports/`, `session/`, `state/`, `transports/`). There
   is no enforced dependency direction, and there are real rightward
   (lower-imports-higher) coupling smells (see below).

The real consumer ([`coresense`](../../../../coresense), linked via
`link:../meshcore-ts`) imports exactly **8 symbols**:

- From core (`.`): `MeshCoreSession`, `LoopbackTransport`, and the types
  `Transport`, `TransportState`, `Contact`, `ContactRecord`, `ContactSource`.
- From `./transports`: `createBleTransport`.

So the published surface is hundreds of symbols wide while the actual contract
is eight. This design curates the surface and reorganizes the internals into
explicit layers.

## Goals

- Curate the public API to a deliberate, minimal, supportable surface.
- Reorganize internals into explicit layers with a one-directional dependency
  rule, so the structure is self-documenting and resists re-tangling.
- Fix the existing coupling smells as part of the move (not band-aid around
  them).
- Do not break the real consumer (`coresense`): its 8 imports must keep
  resolving.

## Non-goals

- **Splitting the 1571-line `src/session/session.ts` god-object.** It is a real
  maintainability problem but orthogonal to this reorg; it gets its own spec
  afterward.
- Lint-enforcement of the layer rule. The rule is documented convention, not a
  CI gate (per decision below).
- Any change to runtime behavior. This is a pure structure/surface refactor.

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Primary goal | Both: lock down public API **and** tidy internal structure |
| Restructure scope | Full layered restructure |
| Public entry points | Three: `.` (core), `./transports`, `./protocol` |
| Layer-rule enforcement | Documented convention (no lint rule) |
| Smell resolution | Relocate misfiled files to their correct layer |
| Internal barrels | None — only three root public barrels (see rationale) |

## Architecture: six layers, downward-only dependencies

```
src/
  protocol/    bottom layer — wire codec, no upward deps    (→ ./protocol)
    codes.ts  buffer.ts  frame.ts  encode.ts  advert.ts
    meshPacket.ts  onAirPackets.ts  pubkey.ts  repeater.ts
  model/       domain types + in-memory state + errors
    types.ts  errors.ts  contacts.ts (was contacts/discovered.ts)
    contactTypes.ts (NEW: ContactRecord/ContactSource, moved out of features)
    paths.ts (operates on Channel/MessagePath domain types)
    meshObservations.ts
    state/{ model.ts, discoveredStore.ts }
  ports/       pure interfaces + in-memory adapters
    events.ts  logger.ts  transport.ts (holds LoopbackTransport)
  features/    feature modules + feature contract + registry + session-scoped state
    feature.ts  registry.ts  runtime.ts  adminSessions.ts
    pendingChannelSends.ts  <all current features/*.ts>
  session/     orchestrator
    session.ts
  transports/  hardware adapters (optional peer deps)        (→ ./transports)
    bleTransport.ts  serialTransport.ts  serialFraming.ts
  index.ts  protocol.ts  transports.ts   ← three curated package barrels
```

**Dependency rule (the invariant):**
`protocol → model → ports → features → session`, with `transports` depending
only on `ports` + `model`. A module may import from its own layer or any layer
to its **left**, never to its **right**. This is documented convention,
expressed by the folder structure and an architecture note — not enforced by
lint.

### File moves from today's flat layout

| From | To |
|---|---|
| `buffer.ts`, `frame.ts`, `encode.ts`, `advert.ts`, `meshPacket.ts`, `onAirPackets.ts`, `pubkey.ts`, `repeater.ts`, `codes.ts` | `protocol/` |
| `types.ts`, `errors.ts`, `paths.ts`, `meshObservations.ts` | `model/` |
| `contacts/discovered.ts` | `model/contacts.ts` |
| `state/model.ts`, `state/discoveredStore.ts` | `model/state/` |
| `feature.ts`, `registry.ts` | `features/` |
| `session/session.ts` | `session/` (unchanged) |
| `transports/*` | `transports/` (unchanged) |

This table covers **phase 1 (pure relocation)** only. The smell-driven moves —
`session/runtime.ts` and `session/adminSessions.ts` → `features/`,
`pendingChannelSends.ts` → `features/`, and the new `model/contactTypes.ts` —
happen in **phase 2** and are intentionally absent here. `pendingChannelSends.ts`
stays at `src/` root through phase 1 and moves directly to `features/` in phase 2
(no double-move).

## Coupling smells and their resolution (relocation, not inversion)

Five rightward (rule-violating) edges exist today. Three (smells 2–4) are the
same mistake: session-*lifetime* state was filed under `session/` even though it
is conceptually *feature* state. The other two are simple misclassifications
(smells 1 and 5). Relocating fixes all of them with no interface-extraction /
dependency-inversion gymnastics.

1. **`ports/events.ts` → `features/contacts` (`ContactRecord`, `ContactSource`).**
   These are consumer-facing domain types buried in a feature module. **Move to
   `model/contactTypes.ts`.** Then `ports/events` and `features/contacts` both
   import them downward. (These are exactly two of the types `coresense`
   imports, so they belong in the public model layer.)

2. **`feature.ts` → `session/runtime` (`FeatureContext.rt: SessionRuntime`).**
   `SessionRuntime` is "every feature's per-session mutable state in one place";
   every member type (`ChannelsRuntime`, `DmRuntime`, …) already lives in
   `features/*`. **Move `SessionRuntime` + `createSessionRuntime()` →
   `features/runtime.ts`.** `feature.ts → ./runtime` becomes a same-layer import
   (type cycles within a layer are fine); `session.ts` reaches it downward.

3. **`feature.ts` → `session/adminSessions` (`FeatureContext.admin:
   AdminSessionStore`).** `AdminSessionStore` is auth/pending state owned by the
   repeaterAdmin feature and has zero internal deps. **Move →
   `features/adminSessions.ts`.** `features/repeaterAdmin` imports it same-layer.

4. **`pendingChannelSends.ts` → `ports/events` (model importing ports).**
   It is part of the runtime bundle and emits events. **Move →
   `features/pendingChannelSends.ts`** (`features → ports` is downward, legal).
   `MeshObservations` stays in `model/` — it is a pure data structure with no
   event dependency.

5. **`paths.ts` → `types` (would-be `protocol → model`).** `paths.ts` imports
   the domain types `Channel`, `MessageHop`, `MessagePath` and builds
   `MessagePath` structures from wire path-hex — it is domain-level mapping, not
   raw byte codec. **Classify it as `model/paths.ts`, not `protocol/`.** Then
   `paths → types` is same-layer, and its importers (`features/channelMessages`,
   `features/pendingChannelSends`) reach it downward. Consequence: `paths` is
   **not** part of the `./protocol` public barrel (it stays model-internal;
   expose later only if a consumer needs it — YAGNI).

**Net effect:** `session/` collapses to essentially just `session.ts` (the
orchestrator). Every rightward edge disappears and the dependency rule holds
with **no documented exceptions**, purely by moving files to the layer they
always conceptually belonged to.

Alternatives considered: extracting interfaces and inverting dependencies
(DIP), or accepting the type-only edges as documented exceptions. Relocation is
simpler and more honest than both.

## Public surface: the three barrels

**Rule that defines "public":** a symbol is package-public **only if it is
re-exported from one of the three root barrels.** Internal modules keep their
`export` keyword for cross-layer imports, but the `package.json` `exports` map
blocks deep paths (`@andyshinn/meshcore-ts/dist/anything` will not resolve), so
nothing leaks. No `@internal` annotations required.

### `.` — `src/index.ts` (core)

- **Values:** `MeshCoreSession`, `LoopbackTransport`, `VERSION`, and the error
  classes `ProtocolError`, `ProtocolTimeoutError`, `FeatureDisabledError`,
  `UnknownContactError`, `ContactTableFullError` (consumers catch these).
- **Types:** `MeshCoreSessionOptions`, `Transport`, `TransportState`, `Logger`,
  `Contact`, `ContactRecord`, `ContactSource`, `MeshCoreEventMap` (to type
  `session.on(...)` handlers).

### `./transports` — `src/transports.ts`

`createBleTransport`, `BleTransport`, `BleHooks`, `NORDIC_UART`,
`SerialTransport`, `SerialPortLike`, `encodeSerialFrame`, `SerialDeframer`.
Optional peer deps (`noble`, `serialport`) stay quarantined behind this entry.

This new `src/transports.ts` barrel **replaces** the current
`src/transports/index.ts` (which today does `export *` over the transport
folder). The folder index is removed; `src/transports.ts` curates the named
exports above. The `transports/` source files themselves do not move.

### `./protocol` — `src/protocol.ts`

The whole `protocol/` layer for power users: `codes` (CMD/RESP), `encode*`/
`decode*` functions, `frame`, `advert`, `meshPacket`, `onAirPackets`,
`pubkey`, `repeater`, `BufferReader`/`BufferWriter`. (`paths` is **not** here —
it is model-internal; see smell 5.) Forward-looking;
`coresense` does not use it yet (it decodes via the external
`@michaelhart/meshcore-decoder`), so adding it has zero migration cost.

### Judgment calls

- `MeshCoreEvents` **class** stays internal; only the `MeshCoreEventMap`
  **type** is public.
- `LoopbackTransport` stays in **core**, not `./transports` — it is
  dependency-free and `coresense` imports it from core today.

### Internal barrels: none

No per-folder `index.ts` barrels. Internal code uses direct relative imports
(`../model/types`). Reason: internal barrels are what invite import cycles, and
this codebase already had one (`feature ↔ session`). The only barrels are the
three root public files; the layer rule lives in docs + folder structure.

## Build wiring

- `package.json` `exports`: add `./protocol`; keep `.` and `./transports`.
- `package.json`: add `"sideEffects": false` for tree-shaking (barrels are pure
  re-exports).
- `tsup.config.ts` `entry`: three entries —
  `{ index: 'src/index.ts', protocol: 'src/protocol.ts', transports: 'src/transports.ts' }`.

Resulting `exports` map:

```jsonc
"exports": {
  ".":           { "types": "./dist/index.d.ts",      "import": "./dist/index.js",      "require": "./dist/index.cjs" },
  "./protocol":  { "types": "./dist/protocol.d.ts",   "import": "./dist/protocol.js",   "require": "./dist/protocol.cjs" },
  "./transports":{ "types": "./dist/transports.d.ts", "import": "./dist/transports.js", "require": "./dist/transports.cjs" }
}
```

## Migration mechanics

**Scope of churn:** ~50 source files + ~95 test files (under `tests/`, which
import deep internal paths like `../../src/state/model`, `../../src/feature`,
`../../src/pendingChannelSends`, `../../src/ports/events`, mirroring the source
tree). No tsconfig path aliases — all imports are relative, so every move
requires rewriting referencing import specifiers. Preserve each file's existing
extension convention (some imports use `.js`, some are bare). Tests that import
the public barrel (`../../src/index.js`) are unaffected.

**Execution as three green-gated phases** (each is its own commit; history
preserved with `git mv`; each ends with typecheck + tests passing):

1. **Relocate into layer folders.** `git mv` files into
   `protocol/ model/ ports/ features/ session/`; rewrite all internal + test
   import specifiers in lockstep. Pure motion, no logic change.
   Gate: `pnpm typecheck && pnpm test`.
2. **Resolve smells 1–4.** Move `ContactRecord`/`ContactSource` →
   `model/contactTypes.ts`; move `SessionRuntime` + `createSessionRuntime`,
   `AdminSessionStore`, `PendingChannelSends` → `features/`. Update references.
   (Smell 5 needs no separate work — `paths.ts` is simply placed in `model/`
   during phase 1.) Gate: typecheck + tests, plus `madge --circular src` to
   confirm no new cycles.
3. **Curate the public surface.** Author `src/index.ts`, `src/protocol.ts`,
   `src/transports.ts`; remove the flat `export *`; update `package.json`
   `exports` (+`./protocol`, `"sideEffects": false`) and tsup `entry`.
   Gate: `pnpm build` emits all three `.d.ts`; build `coresense` against the
   `link:` dep to confirm the public surface did not regress.

## Verification (the contract)

- `pnpm typecheck` + `pnpm test` green after every phase.
- `pnpm build` produces `dist/{index,protocol,transports}.{js,cjs,d.ts}`.
- **Public-surface guard:** a smoke test asserting the root barrel exports
  exactly the intended symbols (and nothing internal leaks), and that a deep
  import such as `@andyshinn/meshcore-ts/dist/buffer` fails to resolve.
- **Consumer guard:** `coresense` typechecks/builds unchanged — its 8 imports
  still resolve.
- `pnpm lint` / `biome format` clean.

## Open questions

None outstanding. (`session.ts` split is deferred to a separate spec.)
