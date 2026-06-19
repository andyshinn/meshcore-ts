# Namespace-Organized Public API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reshape the package's public API into a single `.` entry point that exposes six area namespaces (`Models`, `Errors`, `Protocol`, `Transports`, `Ports`, `Features`) via `export * as` re-exports, giving consumers grouped access and TypeDoc grouped output.

**Architecture:** Each namespace is backed by a **root-level barrel file** under `src/` (never a per-folder `index.ts`, per the prior layering design). `src/index.ts` re-exports those barrels as namespaces with `export * as`. Three essentials (`MeshCoreSession`, `MeshCoreSessionOptions`, `VERSION`) stay top-level. No source files move; no runtime behavior changes — this is barrels + aliased re-exports + build/docs rewiring.

**Tech Stack:** TypeScript (ESM, `target: es2022`), tsup (esbuild) for build, Vitest for tests, Biome for lint/format, Astro + starlight-typedoc for docs.

## Global Constraints

- Package `@andyshinn/meshcore-ts` v0.1.1, `"type": "module"`, Node `>=22`.
- `package.json` `"sideEffects": false` MUST be retained (tree-shaking; barrels are pure re-exports).
- Mechanism is **ES-module namespace re-exports** (`export * as X from './x'`), never the `namespace {}` keyword.
- Barrels are **root-level files** under `src/` only. Do NOT create per-folder `index.ts` barrels (they invite import cycles — prior design rule).
- No source files in `model/`, `ports/`, `features/`, `protocol/`, `transports/` move. `model/state/`, `model/errors` (own namespace), `model/paths.ts`, and internal feature wiring (`FeatureRegistry`, encoders, runtime stores) are never re-exported into `Models`/`Features`.
- Aliased re-exports keep the underlying declared name (so stack traces stay meaningful); only the re-export is renamed.
- `pnpm typecheck` runs `tsc --noEmit && tsc -p examples/tsconfig.json` — examples MUST typecheck. `pnpm test`, `pnpm build`, `pnpm lint`, `pnpm docs:build` are the other gates.
- Use Biome formatting conventions already in the repo (2-space indent, single quotes, trailing commas). Run `pnpm lint` before each commit.

**Definitive namespace membership (audited against `MeshCoreSession`'s public signatures):**

| Namespace | Backing barrel | Members |
|---|---|---|
| top-level | `src/index.ts` | `MeshCoreSession` (value), `MeshCoreSessionOptions` (type), `VERSION` (value) |
| `Models` | `src/model.ts` (new) | everything from `model/types.ts`, `model/contactTypes.ts`, `model/contacts.ts`, `model/meshObservations.ts` |
| `Errors` | `src/model/errors.ts` (existing, used directly) | `ProtocolError`, `ProtocolTimeoutError`, `UnknownContactError`, `ContactTableFullError`, `FeatureDisabledError` |
| `Protocol` | `src/protocol.ts` (existing barrel unchanged; `onAirPackets.ts` gains `PayloadKind`) | current contents (codec; `decodeOnAirPacket`, `OnAirPacket`, `OnAirPayload`; `protocol/repeater.ts` types `LoginSuccess`, `AclEntry`, `NeighboursPage`, `OwnerInfo`, `LocalStats`, `AvgMinMaxResult`, `TraceData`) **+ new `PayloadKind` const/type** |
| `Transports` | `src/transports.ts` (edit) | `Serial`, `Ble`, `Loopback`, `createBle`, `NORDIC_UART`, `SerialDeframer`, `encodeSerialFrame`, `SerialPortLike`, `BleHooks` |
| `Ports` | `src/ports.ts` (new); `ports/events.ts` gains `EventName` | `Transport`, `Logger`, `noopLogger`, `EventMap`, `Events`, **+ new `EventName` const/type** |
| `Features` | `src/features.ts` (new) | `Feature`, `FeatureContext`, `ContactsSyncSignal`, `SelfInfo`, `TuningParams`, `AutoAddFlagsInput`, `AdminMode`, `RepeaterReachMode`, `DefaultFloodScope`, `FloodScopeInput`, `RepeatFreqRange`, `AdvertPath`, `DiscoveredPath` (all type-only) |

**Naming map (aliased re-exports):**

| Declared name (module) | Public name |
|---|---|
| `SerialTransport` (`transports/serialTransport`) | `Transports.Serial` |
| `BleTransport` (`transports/bleTransport`) | `Transports.Ble` |
| `LoopbackTransport` (`ports/transport`) | `Transports.Loopback` |
| `createBleTransport` (`transports/bleTransport`) | `Transports.createBle` |
| `MeshCoreEventMap` (`ports/events`) | `Ports.EventMap` |
| `MeshCoreEvents` (`ports/events`) | `Ports.Events` |
| all other members | unchanged |

**Named-constant maps (`PayloadKind`, `EventName`) — rules:**
- Implement as `as const` objects, **never** TS `enum`s (tree-shakeable, erasable; preserve literal types).
- The underlying public types stay literal-string unions (`OnAirPayload['kind']`, `keyof MeshCoreEventMap`), so the constant and the raw string are **fully interchangeable** — `case 'grpTxt':` and `case Protocol.PayloadKind.GRP_TXT:` both compile and narrow; `.on('rawPacket', h)` and `.on(Ports.EventName.RAW_PACKET, h)` are equivalent. Do NOT retype any union field to the const — that would break the raw-string form.
- Each map carries a compile-time drift guard so it cannot fall out of sync with its source union/map.

---

### Task 1: `Models` namespace barrel

**Files:**
- Create: `src/model.ts`
- Test: `tests/namespaces/models.test.ts`

**Interfaces:**
- Produces: module `../src/model` whose namespace object exposes the full `model/` data vocabulary — runtime values `DEFAULT_RADIO_SETTINGS`, `hasValidFix`, `MeshObservations`, `advTypeToKind`, `hopsFromOutPathLen`, `DEFAULT_*`; types `Contact`, `Channel`, `Message`, `RadioSettings`, `DeviceInfo`, `SyncProgress`, `ContactRecord`, `ContactSource`, `RawPacket`, `TransportState`, `MeshObservation`, `DiscoveredContact`, etc.

- [ ] **Step 1: Write the failing test**

```ts
// tests/namespaces/models.test.ts
import { describe, expect, it } from 'vitest';
import * as Models from '../../src/model';

describe('Models namespace barrel', () => {
  it('exposes domain value helpers and defaults', () => {
    expect(Models.DEFAULT_RADIO_SETTINGS).toBeDefined();
    expect(Models.hasValidFix).toBeTypeOf('function');
    expect(Models.MeshObservations).toBeTypeOf('function');
    expect(Models.advTypeToKind).toBeTypeOf('function');
  });

  it('does NOT leak errors or internal state', () => {
    const keys = Object.keys(Models);
    expect(keys).not.toContain('ProtocolError');
    expect(keys).not.toContain('SessionState');
  });

  it('exposes domain types (compile-time)', () => {
    const c: Models.Contact = {} as Models.Contact;
    const s: Models.SyncProgress = Models.DEFAULT_SYNC_PROGRESS;
    expect(c).toBeDefined();
    expect(s).toBe(Models.DEFAULT_SYNC_PROGRESS);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/namespaces/models.test.ts`
Expected: FAIL — cannot find module `../../src/model`.

- [ ] **Step 3: Create the barrel**

```ts
// src/model.ts
// Domain data vocabulary (the `Models` namespace). Errors live in their own
// namespace; model/state and model/paths stay internal.
export * from './model/contactTypes';
export * from './model/contacts';
export * from './model/meshObservations';
export * from './model/types';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/namespaces/models.test.ts`
Expected: PASS (all three cases).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: no errors (new file is additive; nothing consumes it yet).

- [ ] **Step 6: Commit**

```bash
git add src/model.ts tests/namespaces/models.test.ts
git commit -m "feat: add Models namespace barrel (src/model.ts)"
```

---

### Task 2: `Ports` namespace barrel (+ `EventName` constants)

**Files:**
- Modify: `src/ports/events.ts` (add `EventName` const/type + drift guard)
- Create: `src/ports.ts`
- Test: `tests/namespaces/ports.test.ts`

**Interfaces:**
- Consumes: `ports/transport.ts` (`Transport`), `ports/logger.ts` (`Logger`, `noopLogger`), `ports/events.ts` (`MeshCoreEventMap`, `MeshCoreEvents`, new `EventName`).
- Produces: module `../src/ports` exposing values `noopLogger`, `Events`, `EventName`; types `Transport`, `Logger`, `EventMap`, `EventName`. **`LoopbackTransport` is intentionally NOT here** — it belongs to `Transports` (Task 5). `Ports.EventName.RAW_PACKET === 'rawPacket'`, interchangeable with the raw string.

- [ ] **Step 1: Write the failing test**

```ts
// tests/namespaces/ports.test.ts
import { describe, expect, it } from 'vitest';
import * as Ports from '../../src/ports';

describe('Ports namespace barrel', () => {
  it('exposes injection-contract values', () => {
    expect(Ports.noopLogger).toBeDefined();
    expect(Ports.Events).toBeTypeOf('function'); // MeshCoreEvents, aliased
  });

  it('does NOT include LoopbackTransport (that is a Transports adapter)', () => {
    expect(Object.keys(Ports)).not.toContain('LoopbackTransport');
    expect(Object.keys(Ports)).not.toContain('Loopback');
  });

  it('exposes contract types (compile-time)', () => {
    const t: Ports.Transport = {} as Ports.Transport;
    const l: Ports.Logger = Ports.noopLogger;
    const m: Ports.EventMap = {} as Ports.EventMap;
    expect(t).toBeDefined();
    expect(l).toBe(Ports.noopLogger);
    expect(m).toBeDefined();
  });

  it('exposes EventName constants equal to the raw event keys', () => {
    expect(Ports.EventName.RAW_PACKET).toBe('rawPacket');
    expect(Ports.EventName.CONTACTS_FULL).toBe('contactsFull');
    expect(Ports.EventName.DEVICE_CAPABILITIES).toBe('deviceCapabilities');
  });

  it('subscription accepts BOTH the constant and the raw string, typed identically', () => {
    const events = new Ports.Events();
    // Constant form — handler arg is fully typed.
    events.on(Ports.EventName.RAW_PACKET, (pkt) => void pkt.hex);
    // Raw-string form — equivalent, same typed handler.
    events.on('rawPacket', (pkt) => void pkt.hex);
    expect(events).toBeInstanceOf(Ports.Events);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/namespaces/ports.test.ts`
Expected: FAIL — cannot find module `../../src/ports`.

- [ ] **Step 3: Add `EventName` constants to `src/ports/events.ts`**

Insert, immediately after the `MeshCoreEventMap` interface (before `type RawListener`):

```ts
/** Named constants for every key in {@link MeshCoreEventMap}, so consumers may
 *  subscribe by readable name instead of a bare string:
 *  `session.events.on(EventName.RAW_PACKET, …)`. Values equal the event keys, so
 *  the constant and the raw string are interchangeable and both infer the typed
 *  listener. `satisfies` validates each value; the guard below enforces coverage. */
export const EventName = {
  TRANSPORT_STATE: 'transportState',
  RAW_PACKET: 'rawPacket',
  CHANNELS: 'channels',
  CHANNEL_PRESENCE: 'channelPresence',
  SYNC_PROGRESS: 'syncProgress',
  CONTACTS: 'contacts',
  DISCOVERED: 'discovered',
  CONTACT_EVICTED: 'contactEvicted',
  CONTACTS_FULL: 'contactsFull',
  CONTACT_DISCOVERED: 'contactDiscovered',
  CONTACT_OBSERVED: 'contactObserved',
  MESSAGES: 'messages',
  MESSAGE_UPSERTED: 'messageUpserted',
  MESSAGE_STATE: 'messageState',
  MESSAGE_PATH_HEARD: 'messagePathHeard',
  OWNER: 'owner',
  RADIO_SETTINGS: 'radioSettings',
  REPEATER_STATUS: 'repeaterStatus',
  REPEATER_TELEMETRY: 'repeaterTelemetry',
  PATH_LEARNED: 'pathLearned',
  DEVICE_IDENTITY: 'deviceIdentity',
  AUTO_ADD_CONFIG: 'autoAddConfig',
  TELEMETRY_POLICY: 'telemetryPolicy',
  GPS_CONFIG: 'gpsConfig',
  DEVICE_INFO: 'deviceInfo',
  DEVICE_CAPABILITIES: 'deviceCapabilities',
} as const satisfies Record<string, keyof MeshCoreEventMap>;

/** Union of event-name keys (= `keyof MeshCoreEventMap`); interchangeable with `EventName` values. */
export type EventName = keyof MeshCoreEventMap;

// Compile-time drift guard: fails to build if any event key lacks an EventName constant.
type _EventNamesCovered = keyof MeshCoreEventMap extends (typeof EventName)[keyof typeof EventName]
  ? true
  : never;
const _eventNamesCovered: _EventNamesCovered = true;
void _eventNamesCovered;
```

- [ ] **Step 4: Create the barrel**

```ts
// src/ports.ts
// Injection contracts the consumer implements/provides (the `Ports` namespace).
// LoopbackTransport is an adapter and lives in `Transports`, not here.
export type { Transport } from './ports/transport';
export { type Logger, noopLogger } from './ports/logger';
export {
  EventName,
  type MeshCoreEventMap as EventMap,
  MeshCoreEvents as Events,
} from './ports/events';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run tests/namespaces/ports.test.ts`
Expected: PASS (all five cases).

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: no errors. If a future event key were missing from `EventName`, the drift guard makes `_EventNamesCovered` resolve to `never` and `tsc` fails here.

- [ ] **Step 7: Commit**

```bash
git add src/ports.ts src/ports/events.ts tests/namespaces/ports.test.ts
git commit -m "feat: add Ports namespace barrel + EventName constants"
```

---

### Task 3: `Features` namespace barrel

**Files:**
- Create: `src/features.ts`
- Test: `tests/namespaces/features.test.ts`

**Interfaces:**
- Consumes: feature modules `feature.ts`, `selfInfo.ts`, `tuning.ts`, `autoAdd.ts`, `adminSessions.ts`, `repeaterAdmin.ts`, `floodScope.ts`, `misc.ts`, `pathDiagnostics.ts`.
- Produces: module `../src/features` exposing the bounded, **type-only** Features surface. Because every member is a type, the runtime namespace object is empty — assert membership at compile time.

- [ ] **Step 1: Write the failing test**

```ts
// tests/namespaces/features.test.ts
// NOTE: a *value* import (not `import type`), so the module resolves at runtime —
// that is what makes the red state below fire. The barrel is type-only, so the
// runtime namespace object is empty; the per-type checks are enforced by `tsc`
// (Step 5), since each `Features.X` reference errors if X is not exported.
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as Features from '../../src/features';

describe('Features namespace barrel', () => {
  it('loads as a (type-only → empty) namespace object', () => {
    expect(Features).toBeTypeOf('object');
  });

  it('exposes the bounded public feature types (enforced by tsc)', () => {
    // Extension contracts.
    expectTypeOf<Features.Feature>().not.toBeNever();
    expectTypeOf<Features.FeatureContext>().not.toBeNever();
    expectTypeOf<Features.ContactsSyncSignal>().not.toBeNever();
    // Public feature types reached by MeshCoreSession's public methods.
    expectTypeOf<Features.SelfInfo>().not.toBeNever();
    expectTypeOf<Features.TuningParams>().not.toBeNever();
    expectTypeOf<Features.AutoAddFlagsInput>().not.toBeNever();
    expectTypeOf<Features.AdminMode>().not.toBeNever();
    expectTypeOf<Features.RepeaterReachMode>().not.toBeNever();
    expectTypeOf<Features.DefaultFloodScope>().not.toBeNever();
    expectTypeOf<Features.FloodScopeInput>().not.toBeNever();
    expectTypeOf<Features.RepeatFreqRange>().not.toBeNever();
    expectTypeOf<Features.AdvertPath>().not.toBeNever();
    expectTypeOf<Features.DiscoveredPath>().not.toBeNever();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/namespaces/features.test.ts`
Expected: FAIL — cannot find module `../../src/features` (the value import does not resolve until Step 3 creates the barrel).

- [ ] **Step 3: Create the barrel**

```ts
// src/features.ts
// Feature framework contracts + the bounded set of feature types that appear in
// MeshCoreSession's public method signatures (the `Features` namespace).
// Internal wiring (FeatureRegistry, encoders, runtime stores) stays internal.
export type { ContactsSyncSignal, Feature, FeatureContext } from './features/feature';
export type { AutoAddFlagsInput } from './features/autoAdd';
export type { AdminMode } from './features/adminSessions';
export type { RepeaterReachMode } from './features/repeaterAdmin';
export type { DefaultFloodScope, FloodScopeInput } from './features/floodScope';
export type { RepeatFreqRange } from './features/misc';
export type { AdvertPath, DiscoveredPath } from './features/pathDiagnostics';
export type { SelfInfo } from './features/selfInfo';
export type { TuningParams } from './features/tuning';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/namespaces/features.test.ts`
Expected: PASS — note this only confirms the (empty, type-only) module loads. `expectTypeOf` is a runtime no-op under `vitest run`; the actual type membership is enforced by `tsc` in the next step.

- [ ] **Step 5: Typecheck (the real gate for this type-only namespace)**

Run: `pnpm typecheck`
Expected: no errors. `tsc` checks the test file, so a wrong/missing `export type` surfaces here as "has no exported member" or "Namespace has no exported member" — fix against the source module's actual export name.

- [ ] **Step 6: Commit**

```bash
git add src/features.ts tests/namespaces/features.test.ts
git commit -m "feat: add Features namespace barrel (src/features.ts)"
```

---

### Task 4: `Protocol.PayloadKind` payload-kind constants

Additive: the `Protocol` barrel (`src/protocol.ts`) already does `export * from './protocol/onAirPackets'`, so adding the const there flows into the namespace with no barrel edit. Independent of the barrels and cutover — can run any time before docs (Task 6).

**Files:**
- Modify: `src/protocol/onAirPackets.ts` (add `PayloadKind` const/type + drift guard)
- Test: `tests/protocol/payloadKind.test.ts`

**Interfaces:**
- Consumes: existing `OnAirPayload` union + `decodeOnAirPacket` in `protocol/onAirPackets.ts`.
- Produces: `PayloadKind` const map (`PayloadKind.GRP_TXT === 'grpTxt'`, etc.) + `type PayloadKind = OnAirPayload['kind']`, reachable as `Protocol.PayloadKind` after the cutover. Interchangeable with raw `kind` strings.

- [ ] **Step 1: Write the failing test**

```ts
// tests/protocol/payloadKind.test.ts
import { describe, expect, it } from 'vitest';
import { type OnAirPayload, PayloadKind } from '../../src/protocol/onAirPackets';

describe('PayloadKind constants', () => {
  it('maps readable names to the kind discriminant literals', () => {
    expect(PayloadKind.ADVERT).toBe('advert');
    expect(PayloadKind.GRP_TXT).toBe('grpTxt');
    expect(PayloadKind.TRACE).toBe('trace');
    expect(PayloadKind.RAW).toBe('raw');
  });

  it('narrows payload in a switch — via the constant AND the raw string', () => {
    const payload = { kind: 'grpTxt', channelHash: '01', macHex: '0203', cipherLen: 4 } as OnAirPayload;

    let viaConst: string | undefined;
    switch (payload.kind) {
      case PayloadKind.GRP_TXT:
        viaConst = payload.channelHash; // narrows: channelHash is in scope
        break;
    }
    expect(viaConst).toBe('01');

    let viaString: number | undefined;
    switch (payload.kind) {
      case 'grpTxt': // raw string — equivalent, still narrows
        viaString = payload.cipherLen;
        break;
    }
    expect(viaString).toBe(4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/protocol/payloadKind.test.ts`
Expected: FAIL — `PayloadKind` is not exported from `../../src/protocol/onAirPackets`.

- [ ] **Step 3: Add `PayloadKind` to `src/protocol/onAirPackets.ts`**

Insert immediately after the `OnAirPayload` union declaration (before the `PAYLOAD_TYPE_NAMES` const):

```ts
/** Named constants for the {@link OnAirPayload} `kind` discriminant, so consumers
 *  branch on readable names instead of bare strings:
 *  `case PayloadKind.GRP_TXT` (=== 'grpTxt'). Values equal the `kind` literals, so
 *  the constant and the raw string are interchangeable and both narrow `payload`.
 *  Distinct from the numeric wire enum {@link PAYLOAD_TYPE} (keys `header.payloadType`). */
export const PayloadKind = {
  ADVERT: 'advert',
  TXT_MSG: 'txtMsg',
  GRP_TXT: 'grpTxt',
  REQ: 'req',
  RESPONSE: 'response',
  ANON_REQ: 'anonReq',
  ACK: 'ack',
  PATH: 'path',
  TRACE: 'trace',
  CONTROL_DISCOVER_REQ: 'controlDiscoverReq',
  CONTROL_DISCOVER_RESP: 'controlDiscoverResp',
  CONTROL_OTHER: 'controlOther',
  RAW: 'raw',
} as const satisfies Record<string, OnAirPayload['kind']>;

/** Union of the `kind` discriminant values (`'advert' | 'grpTxt' | …`); interchangeable with `PayloadKind` values. */
export type PayloadKind = OnAirPayload['kind'];

// Compile-time drift guard: fails to build if any payload kind lacks a PayloadKind constant.
type _PayloadKindsCovered = OnAirPayload['kind'] extends (typeof PayloadKind)[keyof typeof PayloadKind]
  ? true
  : never;
const _payloadKindsCovered: _PayloadKindsCovered = true;
void _payloadKindsCovered;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/protocol/payloadKind.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: no errors. The `satisfies` clause rejects a typo'd value; the drift guard rejects a missing `kind`.

- [ ] **Step 6: Commit**

```bash
git add src/protocol/onAirPackets.ts tests/protocol/payloadKind.test.ts
git commit -m "feat: add Protocol.PayloadKind payload-kind constants"
```

---

### Task 5: The surface cutover (single namespaced entry point)

This task is **atomic** — it flips the public surface from the flat 3-entry layout to the single namespaced entry. Renaming `src/transports.ts` members and collapsing `package.json` `exports` both break the current examples simultaneously, so the transports edit, index rewrite, package/build rewiring, guard-test rewrite, and example updates must land together to keep `pnpm typecheck` green.

**Files:**
- Modify: `src/transports.ts` (add aliases + Loopback)
- Modify: `src/index.ts` (rewrite to namespaced single entry)
- Modify: `package.json` (collapse `exports` to `.`)
- Modify: `tsup.config.ts` (single entry)
- Modify: `examples/tsconfig.json` (drop subpath path mappings)
- Modify: every `examples/*.ts` that imports a subpath or a renamed/root symbol (enumerated below)
- Rewrite: `tests/publicSurface.test.ts`

**Interfaces:**
- Consumes: barrels from Tasks 1–3 (`./model`, `./ports`, `./features`), existing `./protocol`, edited `./transports`, `./model/errors`.
- Produces: package root `@andyshinn/meshcore-ts` exporting top-level `MeshCoreSession`/`MeshCoreSessionOptions`/`VERSION` and namespaces `Models`/`Errors`/`Protocol`/`Transports`/`Ports`/`Features`. Subpaths `./protocol` and `./transports` no longer resolve.

- [ ] **Step 1: Rewrite the public-surface guard test (the failing spec)**

```ts
// tests/publicSurface.test.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as pkg from '../src/index';

describe('public surface — top-level', () => {
  it('exposes only the essentials + namespaces, with no leakage', () => {
    // `Features` is type-only: whether it survives as an empty `{}` runtime
    // binding is bundler-dependent, so allow it but do not require it. Every
    // other namespace has runtime members and must be present.
    const allowed = [
      'Errors', 'Features', 'MeshCoreSession', 'Models', 'Ports', 'Protocol', 'Transports', 'VERSION',
    ];
    const required = ['Errors', 'MeshCoreSession', 'Models', 'Ports', 'Protocol', 'Transports', 'VERSION'];
    const keys = Object.keys(pkg);
    for (const k of keys) expect(allowed).toContain(k); // no internal leakage
    for (const r of required) expect(keys).toContain(r);
    // Internals stay out of the top level.
    expect(keys).not.toContain('ProtocolError');
    expect(keys).not.toContain('SerialTransport');
    expect(keys).not.toContain('LoopbackTransport');
  });

  it('top-level values are the three essentials', () => {
    expect(pkg.MeshCoreSession).toBeTypeOf('function');
    expect(pkg.VERSION).toBeTypeOf('string');
  });

  it('namespaces expose representative members', () => {
    expect(pkg.Models.DEFAULT_RADIO_SETTINGS).toBeDefined();
    expect(pkg.Errors.ProtocolError).toBeTypeOf('function');
    expect(pkg.Protocol.BufferReader).toBeTypeOf('function');
    expect(pkg.Protocol.CMD).toBeDefined();
    expect(pkg.Protocol.RESP).toBeDefined();
    expect(pkg.Transports.Serial).toBeTypeOf('function');
    expect(pkg.Transports.Loopback).toBeTypeOf('function');
    expect(pkg.Ports.noopLogger).toBeDefined();
    // Named-constant maps reachable via their namespaces.
    expect(pkg.Protocol.PayloadKind.GRP_TXT).toBe('grpTxt');
    expect(pkg.Ports.EventName.RAW_PACKET).toBe('rawPacket');
  });

  it('Features is a type-only namespace (compile-time reachable)', () => {
    const _check: import('../src/index').Features.SelfInfo | undefined = undefined;
    expect(_check).toBeUndefined();
  });
});

describe('package exports map — single entry, no wildcard', () => {
  it('declares exactly the "." entry and keeps sideEffects false', () => {
    const meta = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(Object.keys(meta.exports)).toEqual(['.']);
    expect(JSON.stringify(meta.exports)).not.toContain('*');
    expect(meta.sideEffects).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/publicSurface.test.ts`
Expected: FAIL — `pkg` still has the old flat exports and `package.json` still lists three entries.

- [ ] **Step 3: Edit `src/transports.ts` (shorten names + relocate Loopback)**

```ts
// src/transports.ts
// Hardware transport adapters (the `Transports` namespace). Adapters take an
// already-constructed port/hooks object; this package imports no peer deps.
export type { BleHooks } from './transports/bleTransport';
export {
  BleTransport as Ble,
  createBleTransport as createBle,
  NORDIC_UART,
} from './transports/bleTransport';
export { encodeSerialFrame, SerialDeframer } from './transports/serialFraming';
export type { SerialPortLike } from './transports/serialTransport';
export { SerialTransport as Serial } from './transports/serialTransport';
// Loopback is a dependency-free adapter — grouped with the adapters, not Ports.
export { LoopbackTransport as Loopback } from './ports/transport';
```

- [ ] **Step 4: Rewrite `src/index.ts` (namespaced single entry)**

```ts
// src/index.ts
// Public entry point for @andyshinn/meshcore-ts.
// Three essentials are top-level; everything else is grouped by area namespace.
import { version } from '../package.json';

export const VERSION: string = version;

// Session orchestrator + its constructor options.
export { MeshCoreSession } from './session/session';
export type { MeshCoreSessionOptions } from './session/session';

/** Domain data model: contacts, channels, messages, device/radio settings, defaults. */
export * as Models from './model';
/** Error classes consumers catch (`instanceof Errors.ProtocolError`). */
export * as Errors from './model/errors';
/** Wire codec for building/parsing companion + on-air frames (power users). */
export * as Protocol from './protocol';
/** Hardware transport adapters this library ships (Serial, Ble, Loopback). */
export * as Transports from './transports';
/** Contracts you implement/inject: Transport, Logger, EventMap. */
export * as Ports from './ports';
/** Feature framework contracts + the feature types surfaced by session methods. */
export * as Features from './features';
```

- [ ] **Step 5: Collapse `package.json` `exports` to a single entry**

Replace the entire `"exports"` block (and confirm `main`/`module`/`types` still point at `index`) with:

```jsonc
"exports": {
  ".": {
    "types": "./dist/index.d.ts",
    "import": "./dist/index.js",
    "require": "./dist/index.cjs"
  }
},
```

Leave `"main": "./dist/index.cjs"`, `"module": "./dist/index.js"`, `"types": "./dist/index.d.ts"`, and `"sideEffects": false` unchanged.

- [ ] **Step 6: Set tsup to a single entry**

```ts
// tsup.config.ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  target: 'es2022',
  clean: true,
  sourcemap: true,
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.js' };
  },
});
```

- [ ] **Step 7: Simplify `examples/tsconfig.json` path mappings**

Replace the `paths` block with the single root mapping (drop the two subpath lines):

```jsonc
"paths": {
  "@andyshinn/meshcore-ts": ["../src/index"]
}
```

- [ ] **Step 8: Update example imports to the namespaced style**

Apply these exact transformations. Each distinct pattern is shown in full; apply the matching pattern to every file in its list, prefixing every usage site.

**Pattern A — Serial-transport examples.** Files: `get-repeater-neighbours.ts`, `get-device-info.ts`, `command-bot.ts`, `get-sensor-telemetry.ts`, `echo-bot.ts`, `send-channel-message.ts`, `get-contacts.ts`, `get-repeater-status.ts`, `get-repeater-telemetry.ts`, `send-contact-message.ts`, `sign-data.ts`.

```ts
// before
import { MeshCoreSession } from '@andyshinn/meshcore-ts';
import { SerialTransport } from '@andyshinn/meshcore-ts/transports';
// ...
const session = new MeshCoreSession({ transport: new SerialTransport(port) });

// after
import { MeshCoreSession, Transports } from '@andyshinn/meshcore-ts';
// ...
const session = new MeshCoreSession({ transport: new Transports.Serial(port) });
```

**Pattern B — BLE examples.** Files: `ble-get-contacts.ts`, `ble-get-device-info.ts`.

```ts
// before
import { MeshCoreSession } from '@andyshinn/meshcore-ts';
import { createBleTransport, NORDIC_UART } from '@andyshinn/meshcore-ts/transports';
// ... NORDIC_UART.service / .rxWrite / .txNotify and createBleTransport({...})

// after
import { MeshCoreSession, Transports } from '@andyshinn/meshcore-ts';
// replace NORDIC_UART -> Transports.NORDIC_UART (each use)
// replace createBleTransport(...) -> Transports.createBle(...)
```

**Pattern C — Protocol examples.** Files: `decode-on-air-packet.ts` (`decodeOnAirPacket`), `parse-packet.ts` (`parseMeshPacket`), `parse-advert.ts` (`parseAdvert`, `parseMeshPacket`).

```ts
// before
import { parseAdvert, parseMeshPacket } from '@andyshinn/meshcore-ts/protocol';
// ... parseMeshPacket(bytes) / parseAdvert(packet.payload)

// after
import { Protocol } from '@andyshinn/meshcore-ts';
// ... Protocol.parseMeshPacket(bytes) / Protocol.parseAdvert(packet.payload)
// (decode-on-air-packet.ts: decodeOnAirPacket -> Protocol.decodeOnAirPacket, incl. comment refs)
```

**Pattern D — event-map helper.** File: `examples/lib/helpers.ts`.

```ts
// before
import type { MeshCoreEventMap, MeshCoreSession } from '@andyshinn/meshcore-ts';
// ... MeshCoreEventMap used in 5 type positions

// after
import type { MeshCoreSession, Ports } from '@andyshinn/meshcore-ts';
// replace every `MeshCoreEventMap` -> `Ports.EventMap`
```

- [ ] **Step 9: Run the full guard + typecheck**

Run: `pnpm vitest run tests/publicSurface.test.ts tests/namespaces && pnpm typecheck`
Expected: PASS — guard green, `tsc` and `tsc -p examples/tsconfig.json` clean.

- [ ] **Step 10: Run the whole test suite**

Run: `pnpm test`
Expected: PASS. (Tests that import `../../src/index` for `MeshCoreSession` are unaffected; any test importing the old top-level error classes or `LoopbackTransport` from `../src/index` must move to `pkg.Errors.*` / `pkg.Transports.Loopback` — fix any such failures by updating the import to the namespace.)

- [ ] **Step 11: Build and confirm a single entry is emitted**

Run: `pnpm build && ls dist`
Expected: `dist/index.js`, `dist/index.cjs`, `dist/index.d.ts` present; **no** `protocol.*` or `transports.*` outputs.

- [ ] **Step 12: Lint, then commit**

Run: `pnpm lint`
Expected: clean (run `pnpm format` if Biome reports formatting).

```bash
git add src/index.ts src/transports.ts package.json tsup.config.ts examples tests/publicSurface.test.ts
git commit -m "feat: collapse to single namespaced entry point"
```

---

### Task 6: TypeDoc + docs guides

**Files:**
- Modify: `docs/astro.config.mjs` (single TypeDoc entry point)
- Modify: `docs/src/content/docs/guides/transports.md` (and any other guide importing old subpaths/symbols)
- Modify: `docs/src/content/docs/guides/decoding-packets.md` (use `Protocol.PayloadKind`)
- Modify: `docs/src/content/docs/guides/events-and-state.md` (use `Ports.EventName`, if it subscribes with raw strings)

**Interfaces:**
- Consumes: the namespaced `src/index.ts` from Task 5, plus `Protocol.PayloadKind` (Task 4) and `Ports.EventName` (Task 2).
- Produces: a docs build whose TypeDoc sidebar shows the six namespaces as distinct sections, with guide examples on the namespaced API.

- [ ] **Step 1: Point TypeDoc at the single entry**

In `docs/astro.config.mjs`, change the `starlightTypeDoc` `entryPoints` to one entry:

```js
starlightTypeDoc({
  entryPoints: ['../src/index.ts'],
  tsconfig: '../tsconfig.json',
  typeDoc: {
    useCodeBlocks: true,
    parametersFormat: 'table',
  },
}),
```

- [ ] **Step 2: Update guide imports to the namespaced style**

In `docs/src/content/docs/guides/transports.md`, rewrite the code-fence imports the same way as the examples:

```md
import { MeshCoreSession, Transports } from '@andyshinn/meshcore-ts';
// new Transports.Serial(port), new Transports.Loopback(), Transports.createBle(...), Transports.NORDIC_UART
```

Replace the prose line referencing the `@andyshinn/meshcore-ts/transports` subpath with one describing the `Transports` namespace. Grep the other guides for stale imports and fix them the same way:

Run: `grep -rn "meshcore-ts/transports\|meshcore-ts/protocol\|LoopbackTransport\|SerialTransport\|MeshCoreEventMap" docs/src/content`
Fix each hit: `LoopbackTransport` → `Transports.Loopback`, `SerialTransport` → `Transports.Serial`, `MeshCoreEventMap` → `Ports.EventMap`, subpath imports → root `Transports`/`Protocol` import.

- [ ] **Step 3: Make the packet-decoding guide use `Protocol.PayloadKind`**

In `docs/src/content/docs/guides/decoding-packets.md`, replace the aspirational example (which imported a nonexistent `PayloadTypes` and compared against `ADVERT`/`GRP_TXT`/`TRACE`) with the real, type-checked form:

```ts
import { Protocol } from '@andyshinn/meshcore-ts';

session.events.on('rawPacket', (pkt) => {
  const packet = Protocol.decodeOnAirPacket(pkt.hex); // also accepts a Uint8Array
  console.log(packet.payloadTypeName); // e.g. 'GRP_TXT'

  switch (packet.payload.kind) {
    case Protocol.PayloadKind.ADVERT:
      console.log(packet.payload.advert.appData.name);
      break;
    case Protocol.PayloadKind.GRP_TXT:
      console.log(packet.payload.channelHash, packet.payload.cipherLen);
      break;
    case Protocol.PayloadKind.TRACE:
      console.log(packet.payload.tag, packet.payload.hopCount, packet.payload.snr);
      break;
    // …txtMsg, req, response, anonReq, ack, path, control*, raw
  }
});
```

Add a one-line note that the raw discriminant strings (`case 'grpTxt':`) work too — `Protocol.PayloadKind` is optional sugar.

- [ ] **Step 4: Make the events guide use `Ports.EventName` (if present)**

In `docs/src/content/docs/guides/events-and-state.md`, if it subscribes with raw strings, show the constant form alongside (do not remove the string form — both are valid):

```ts
import { Ports } from '@andyshinn/meshcore-ts';

session.events.on(Ports.EventName.RAW_PACKET, (pkt) => { /* … */ });
// equivalent to: session.events.on('rawPacket', (pkt) => { … })
```

- [ ] **Step 5: Build the docs**

Run: `pnpm docs:build`
Expected: build succeeds; TypeDoc emits a Namespace page/section per `export * as` namespace (`Models`, `Errors`, `Protocol`, `Transports`, `Ports`, `Features`).

- [ ] **Step 6: Commit**

```bash
git add docs/astro.config.mjs docs/src/content
git commit -m "docs: single TypeDoc entry + namespaced guide imports + PayloadKind/EventName"
```

---

### Task 7: Final full verification

**Files:** none (verification only).

- [ ] **Step 1: Run every gate in sequence**

Run: `pnpm typecheck && pnpm test && pnpm build && pnpm lint && pnpm docs:build`
Expected: all green — `tsc` + examples clean, full Vitest suite passes (incl. `tests/namespaces/*` and the rewritten `tests/publicSurface.test.ts`), single-entry build emitted, Biome clean, docs build succeeds.

- [ ] **Step 2: Confirm no stale subpath references remain**

Run: `grep -rn "meshcore-ts/transports\|meshcore-ts/protocol" examples docs/src tests 2>/dev/null; echo "exit:$?"`
Expected: no matches (grep `exit:1`). Any hit is a missed migration — fix and re-run Step 1.

- [ ] **Step 3: Commit any final fixes**

```bash
git add -A
git commit -m "chore: finalize namespace public-API migration"
```

---

## Self-Review

**Task map:** 1 Models barrel · 2 Ports barrel + `EventName` · 3 Features barrel · 4 `Protocol.PayloadKind` · 5 cutover (index + transports + package/tsup + guard + examples) · 6 TypeDoc + guides · 7 final verification.

**Spec coverage:**
- Single `.` entry + six namespaces via `export * as` → Tasks 1–4 (barrels/consts) + Task 5 (index). ✓
- Membership rules (rich Models; bounded type-only Features; Ports = contracts; Transports = adapters incl. Loopback) → Tasks 1–5, Global Constraints table. ✓
- Naming map (shortened adapter/event names) → Task 5 Step 3, Global Constraints. ✓
- Errors as own namespace from `model/errors` → Task 5 Step 4. ✓
- **`Protocol.PayloadKind` constants (interchangeable with raw strings)** → Task 4; guard spot-check Task 5 Step 1; docs Task 6 Step 3. ✓
- **`Ports.EventName` constants (interchangeable with raw strings)** → Task 2 (const + barrel + tests); guard spot-check Task 5 Step 1; docs Task 6 Step 4. ✓
- Both constant maps use `as const` (not `enum`) + a compile-time drift guard → Tasks 2 & 4 Step 3, Global Constraints. ✓
- `package.json` exports collapse + `sideEffects: false` retained + tsup single entry → Task 5 Steps 5–6. ✓
- TypeDoc single entry + namespace sections + JSDoc captions above each `export * as` → Task 5 Step 4 (captions) + Task 6. ✓
- Guides + examples rewired → Task 5 Step 8, Task 6 Steps 2–4. ✓
- Verification contract (typecheck/test/build/lint/docs:build + guard test) → Tasks 5 & 7. ✓
- Trade-offs (eager init; no heavy peer deps) — informational in spec; no task needed. ✓

**Placeholder scan:** No TBD/TODO; every code/config/test step shows complete content; the example migration uses four fully-shown patterns with explicit file lists (no "similar to" hand-waving). ✓

**Type consistency:** Public names are consistent across tasks — `Transports.Serial`/`.Ble`/`.Loopback`/`.createBle`/`.NORDIC_UART`, `Ports.EventMap`/`.Events`/`.noopLogger`/`.Transport`/`.Logger`/`.EventName`, `Errors.ProtocolError`, `Protocol.BufferReader`/`.CMD`/`.RESP`/`.PayloadKind`, `Models.DEFAULT_RADIO_SETTINGS`. The `Features` member list matches the audited set everywhere (Task 3 barrel, Task 3 test, Global Constraints table). `PayloadKind`/`EventName` values match their source unions (`OnAirPayload['kind']`, `keyof MeshCoreEventMap`) and are enforced by `satisfies` + the drift guards. ✓
