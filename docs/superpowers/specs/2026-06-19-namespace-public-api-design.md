# Namespace-organized public API — design

**Date:** 2026-06-19
**Status:** Approved (design), pending implementation plan
**Package:** `@andyshinn/meshcore-ts` (v0.1.1)
**Builds on:** [`2026-06-18-library-layering-public-api-design.md`](./2026-06-18-library-layering-public-api-design.md)

## Problem

The previous reorg curated a deliberate, minimal **flat** surface across three
entry points (`.`, `./protocol`, `./transports`). The surface is well-bounded
but it is a flat list of symbols with no organizational grouping. Two consequences:

1. **No grouping for consumers.** Everything arrives as a flat bag of names
   (`MeshCoreSession`, `Contact`, `BufferReader`, `SerialTransport`, …) with no
   signal about which area a symbol belongs to.
2. **Flat TypeDoc output.** `starlight-typedoc` renders each entry point as one
   undifferentiated module page. There is no "Models" / "Transport" / "Protocol"
   sectioning in the generated docs.

The package is at v0.1.1 and has no external consumers yet, so this is the right
moment to reshape the surface before it ossifies.

## Goals

- Organize the public API into **distinct namespaces by area** (`Models`,
  `Protocol`, `Transports`, `Ports`, `Errors`, `Features`) so consumers get a
  grouped mental model: `Models.Contact`, `Protocol.encodeAppStart`,
  `Transports.Serial`.
- Get **grouped TypeDoc output** for free: each namespace renders as its own
  TypeDoc Namespace reflection → its own docs section/page.
- **Expand the surface intentionally** while doing so — promote the rich `model/`
  vocabulary and a bounded slice of the feature layer into public namespaces.
- Keep the implementation **tree-shakeable** and behavior-preserving.

## Non-goals

- Splitting the large `src/session/session.ts` orchestrator (still its own future
  spec).
- Any change to runtime behavior, wire encoding, or feature logic. This is a
  pure surface/organization refactor plus aliased re-exports.
- Lint-enforced layer rules (unchanged from prior design — convention only).
- Back-compat shims for the old `./protocol` / `./transports` subpaths. The
  package is unused; the subpaths are simply removed.

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Mechanism | ES-module namespace re-exports (`export * as Models from './model'`), **not** `namespace {}` keyword blocks |
| Both goals from one mechanism | Yes — `export * as` namespaces are what TypeDoc renders as grouped Namespace reflections |
| Entry-point structure | **Single `.` entry**; drop `./protocol` and `./transports` subpaths |
| Scope | **Expand widely** — rich `Models`, plus a bounded `Features` namespace |
| Contract vs adapter split | **`Ports`** (contracts you implement/inject) + **`Transports`** (adapters we ship) |
| Naming inside namespaces | **Shorten** where the namespace makes a suffix redundant (e.g. `Transports.Serial`) |
| `Features` membership | **Bounded** — public iff it appears in a public `MeshCoreSession` method signature, plus the extension contracts |
| Barrel style | **Root-level barrel files** (`src/model.ts`, …), never per-folder `index.ts` — consistent with the prior design's no-folder-barrels rule |

## Public surface layout

Single `.` entry point. Three essentials stay top-level; everything else is a
namespace.

```ts
// src/index.ts — the only entry point
import { version } from '../package.json';

export { MeshCoreSession } from './session/session';
export type { MeshCoreSessionOptions } from './session/session';
export const VERSION: string = version;

export * as Models     from './model';        // domain data vocabulary
export * as Errors     from './model/errors'; // catchable error classes
export * as Protocol   from './protocol';     // wire codec (power users)
export * as Transports from './transports';   // hardware adapters we ship
export * as Ports      from './ports';         // contracts you implement/inject
export * as Features   from './features';      // feature framework + feature types
```

Consumer experience:

```ts
import {
  MeshCoreSession, Models, Protocol, Transports, Ports, Errors, Features,
} from '@andyshinn/meshcore-ts';

const session = new MeshCoreSession({ transport, logger });
const c: Models.Contact = /* … */;
const frame = Protocol.encodeAppStart(/* … */);
const t = new Transports.Serial(myPort);            // implements Ports.Transport
try { /* … */ } catch (e) {
  if (e instanceof Errors.ProtocolTimeoutError) { /* … */ }
}
```

**Mental model:** `Ports` = contracts *you* implement/inject;
`Transports` / `Protocol` / `Models` / `Features` = what the library *provides*.
The plural/singular pairing is intentional and self-documenting:
`Transports.Serial` (an adapter) **implements** `Ports.Transport` (the contract).

## Barrels: root-level files, backing each namespace

`export * as Foo from './foo'` needs a resolvable `./foo` module. Per the prior
design's explicit rule — **no per-folder `index.ts` barrels** (they are what
invite import cycles) — each namespace is backed by a **root-level barrel file**
at `src/`, the same category as the already-allowed `src/protocol.ts` and
`src/transports.ts`.

| Namespace | Backing module | New? |
|---|---|---|
| `Models` | `src/model.ts` | **new** barrel |
| `Errors` | `src/model/errors.ts` | reuse existing module as-is |
| `Protocol` | `src/protocol.ts` | reuse existing barrel |
| `Transports` | `src/transports.ts` | reuse existing barrel (add aliases + Loopback) |
| `Ports` | `src/ports.ts` | **new** barrel |
| `Features` | `src/features.ts` | **new** barrel |

`Errors` points directly at `src/model/errors.ts` (already a clean module of
just the five error classes — no barrel needed). The underlying source files in
`model/`, `ports/`, `features/`, `protocol/`, `transports/` do **not** move; only
the root barrels are added/edited. `model/state/` and internal feature wiring are
simply never re-exported.

## Namespace membership rules

### `Models` — `src/model.ts`

The whole `model/` data vocabulary, **excluding** `model/errors` (own namespace)
and `model/state/` (internal state machinery).

- **Types:** `Contact`, `ContactKind`, `ContactRecord`, `ContactSource`,
  `Channel`, `ChannelKind`, `Message`, `MessageState`, `MessageHop`,
  `MessageHopKind`, `MessagePath`, `MessageMeta`, `Owner`, `RadioSettings`,
  `DeviceIdentity`, `DeviceInfo`, `DeviceCapabilities`, `AutoAddMode`,
  `AutoAddConfig`, `TelemetryPolicy`, `GpsConfig`, `RepeaterStatusSnapshot`,
  `RepeaterTelemetrySnapshot`, `PathLearnedEvent`, `SyncProgress`, `SyncPhase`,
  `TransportState`, `TransportType`, `FrameKind`, `RawPacket`, `PathHashSize`,
  `MeshObservation`, `DiscoveredContact`.
- **Values:** `DEFAULT_SYNC_PROGRESS`, `DEFAULT_RADIO_SETTINGS`,
  `DEFAULT_DEVICE_IDENTITY`, `DEFAULT_AUTO_ADD_CONFIG`, `DEFAULT_TELEMETRY_POLICY`,
  `DEFAULT_GPS_CONFIG`, `DEFAULT_DEVICE_INFO`, `DEFAULT_DEVICE_CAPABILITIES`,
  `hasValidFix`, `advTypeToKind`, `hopsFromOutPathLen`, `MeshObservations`.

(`paths.ts` — `channelHashOf`, `buildPath` — stays model-internal per smell 5 of
the prior design; reconsider only if a consumer needs it.)

### `Errors` — `src/model/errors.ts`

`ProtocolError`, `ProtocolTimeoutError`, `UnknownContactError`,
`ContactTableFullError`, `FeatureDisabledError`. Kept distinct from `Models`
because they are the `catch` / `instanceof` surface.

### `Protocol` — `src/protocol.ts`

Today's barrel contents: `BufferReader`, `BufferWriter`, `CMD`, `RESP`,
encode/decode functions, `advert`, `frame`, `meshPacket`, `onAirPackets`
(incl. `decodeOnAirPacket`, `OnAirPacket`, `OnAirPayload`), `pubkey`, `repeater`,
`codes`.

**Addition — `PayloadKind` named constants.** The decoder's `OnAirPayload` union
discriminates on a camelCase `kind` string (`'advert'`, `'grpTxt'`, `'trace'`,
…). To let consumers branch on readable names instead of magic strings — and
still get TypeScript narrowing — add an `as const` map in
`protocol/onAirPackets.ts`:

```ts
export const PayloadKind = { ADVERT: 'advert', GRP_TXT: 'grpTxt', /* … */ } as const
  satisfies Record<string, OnAirPayload['kind']>;
export type PayloadKind = OnAirPayload['kind'];
```

It flows into the namespace as `Protocol.PayloadKind` automatically (the barrel
already does `export * from './protocol/onAirPackets'`). A `const` map (not a TS
`enum`) is used deliberately: it is tree-shakeable, erasable, and — because its
values are the literal `kind` strings — `case Protocol.PayloadKind.GRP_TXT:`
narrows `payload`, which a string `enum` would not do against the existing
literal union. A compile-time guard asserts every `kind` has a constant.
`Protocol.PayloadKind` is intentionally distinct from the existing numeric wire
enum `Protocol.PAYLOAD_TYPE` (which keys `header.payloadType`).

**Interchangeable with raw strings (deliberate).** Because the union keeps its
literal `kind` type, the constant is *optional sugar* — a consumer may write
`case Protocol.PayloadKind.GRP_TXT:` or `case 'grpTxt':` and both compile and
narrow identically. Nothing is forced.

### `Transports` — `src/transports.ts`

Hardware adapters, with shortened names (see naming map). `LoopbackTransport`
**moves into this namespace** (re-exported from `ports/transport`) as
`Transports.Loopback`, since it is conceptually an adapter, not a contract.

### `Ports` — `src/ports.ts`

The injection contracts: `Ports.Transport` (interface), `Ports.Logger`,
`Ports.EventMap`, `Ports.Events`, and `Ports.noopLogger` (handy default).

**Addition — `EventName` named constants.** Subscriptions take a
`keyof MeshCoreEventMap` string (`session.events.on('rawPacket', …)`). To let
consumers subscribe by readable name, add an `as const` map in `ports/events.ts`,
exported via the `Ports` barrel as `Ports.EventName`:

```ts
export const EventName = { RAW_PACKET: 'rawPacket', CONTACTS_FULL: 'contactsFull', /* … */ } as const
  satisfies Record<string, keyof MeshCoreEventMap>;
export type EventName = keyof MeshCoreEventMap;
```

Named `EventName` (not `Events`, which is the emitter class `Ports.Events`). A
compile-time guard asserts every event key has a constant, so the map cannot
drift from `MeshCoreEventMap`. As with `PayloadKind`, this is **interchangeable
with raw strings**: `session.events.on(Ports.EventName.RAW_PACKET, h)` and
`session.events.on('rawPacket', h)` are equivalent and both infer the typed
listener — the constant is optional ergonomics, never required.

### `Features` — `src/features.ts`

**Membership rule:** a feature symbol is public iff it appears in a public
`MeshCoreSession` method signature, **plus** the extension contracts. Internal
wiring (`FeatureRegistry`, per-feature encoders, runtime stores) stays internal.

- **Extension contracts:** `Feature`, `FeatureContext`, `ContactsSyncSignal`.
- **Feature types (consumer-facing):** `SelfInfo`, `TuningParams`,
  `AutoAddFlagsInput`, `AdminMode`, and any others surfaced by a public session
  method. **The exact list is audited during planning** by walking
  `MeshCoreSession`'s public method signatures and including every feature type
  they accept or return.

## Naming map (shortened re-exports)

Shorten only where the namespace makes a suffix redundant. The underlying
class/type keeps its real declared name (so stack traces and error messages stay
meaningful); the barrel aliases on re-export.

| Declared name | Public name |
|---|---|
| `SerialTransport` | `Transports.Serial` |
| `BleTransport` | `Transports.Ble` |
| `LoopbackTransport` | `Transports.Loopback` |
| `createBleTransport` | `Transports.createBle` |
| `NORDIC_UART` | `Transports.NORDIC_UART` (unchanged) |
| `encodeSerialFrame`, `SerialDeframer`, `BleHooks`, `SerialPortLike` | unchanged within `Transports` |
| `MeshCoreEventMap` | `Ports.EventMap` |
| `MeshCoreEvents` | `Ports.Events` |
| `Transport`, `Logger`, `noopLogger` | unchanged within `Ports` |
| everything in `Models`, `Errors`, `Protocol` | unchanged |

## Build & docs wiring

- **`package.json` `exports`:** collapse to a single `"."` block. Remove
  `./protocol` and `./transports`. Keep `"sideEffects": false`.
- **`tsup.config.ts` `entry`:** single entry `{ index: 'src/index.ts' }`.
- **TypeDoc (`docs/astro.config.mjs`):** `entryPoints: ['../src/index.ts']`
  (drop the other two). Each `export * as` namespace renders as its own TypeDoc
  Namespace reflection → grouped docs section. Add a one-line `@module` /
  file-level doc comment atop each root barrel to caption its section.
- **Guides + `examples/`:** rewrite imports to the single-entry namespaced style.

Resulting `exports` map:

```jsonc
"exports": {
  ".": {
    "types":   "./dist/index.d.ts",
    "import":  "./dist/index.js",
    "require": "./dist/index.cjs"
  }
}
```

## Trade-offs accepted

- **Single entry → eager module init for non-bundled Node consumers.** Importing
  the barrel evaluates every namespace's module graph. Cheap here: the transport
  adapters take **injected** ports and import no real peer deps (`serialport` /
  `noble` are never imported by this package), so there is no heavy code to drag
  in. Bundled consumers still tree-shake (`sideEffects: false`, static
  `Namespace.member` access).
- **Larger public surface** (rich `Models` + bounded `Features`) = more to keep
  stable across versions. Bounded by the membership rules above.
- **Loss of subpath opt-in.** The prior design used `./protocol` / `./transports`
  as opt-in subpaths; they are gone. Acceptable because there are no heavy deps
  to quarantine and the package is unused.

## Migration mechanics

Behavior-preserving; no source files move (only root barrels added/edited).
Suggested phases, each its own commit, each green-gated on
`pnpm typecheck && pnpm test`:

1. **Add the three new barrels** (`src/model.ts`, `src/ports.ts`,
   `src/features.ts`) with curated + aliased exports per the membership rules and
   naming map. Audit `MeshCoreSession`'s public signatures to finalize the
   `Features` member list.
2. **Adjust `src/transports.ts`** for shortened aliases + relocate `Loopback`
   into it; **adjust `src/ports.ts`** to drop `LoopbackTransport`.
3. **Rewrite `src/index.ts`** to the namespaced single-entry form.
4. **Wire build + docs:** collapse `package.json` `exports`, set tsup single
   entry, update TypeDoc `entryPoints`, add `@module` captions.
5. **Update consumers of the surface:** `tests/`, `examples/`, and the docs
   guides to the new import style.

## Verification (the contract)

- `pnpm typecheck` + `pnpm test` green after every phase.
- `pnpm build` produces `dist/index.{js,cjs,d.ts}` only.
- **Public-surface guard** (`tests/publicSurface.test.ts`, rewritten): top-level
  runtime values are exactly `{ MeshCoreSession, VERSION }`; the six namespaces
  (`Models`, `Errors`, `Protocol`, `Transports`, `Ports`, `Features`) are present
  and are objects; `package.json` `exports` has exactly the key `"."` with no
  `*`; `sideEffects` is `false`; plus spot-checks —
  `Transports.Serial`/`Transports.Loopback` are functions, `Protocol.CMD`/`RESP`
  defined, `Errors.ProtocolError` is a function, `Ports.noopLogger` defined, and
  a type-level assertion that `Models.Contact` / `Ports.Transport` resolve.
- **Docs guard:** `pnpm docs:build` succeeds and the generated TypeDoc sidebar
  shows the namespaces as distinct sections.
- `pnpm lint` / `biome format` clean.

## Open questions

None outstanding. The exact `Features` member list is a planning-time audit, not
an open design question (the rule that bounds it is fixed).
