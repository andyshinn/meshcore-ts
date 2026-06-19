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
| `Protocol` | `src/protocol.ts` (existing, unchanged) | current contents (codec; includes `protocol/repeater.ts` types like `LoginSuccess`, `AclEntry`, `NeighboursPage`, `OwnerInfo`, `LocalStats`, `AvgMinMaxResult`, `TraceData`) |
| `Transports` | `src/transports.ts` (edit) | `Serial`, `Ble`, `Loopback`, `createBle`, `NORDIC_UART`, `SerialDeframer`, `encodeSerialFrame`, `SerialPortLike`, `BleHooks` |
| `Ports` | `src/ports.ts` (new) | `Transport`, `Logger`, `noopLogger`, `EventMap`, `Events` |
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

### Task 2: `Ports` namespace barrel

**Files:**
- Create: `src/ports.ts`
- Test: `tests/namespaces/ports.test.ts`

**Interfaces:**
- Consumes: `ports/transport.ts` (`Transport`), `ports/logger.ts` (`Logger`, `noopLogger`), `ports/events.ts` (`MeshCoreEventMap`, `MeshCoreEvents`).
- Produces: module `../src/ports` exposing values `noopLogger`, `Events`; types `Transport`, `Logger`, `EventMap`. **`LoopbackTransport` is intentionally NOT here** — it belongs to `Transports` (Task 4).

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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/namespaces/ports.test.ts`
Expected: FAIL — cannot find module `../../src/ports`.

- [ ] **Step 3: Create the barrel**

```ts
// src/ports.ts
// Injection contracts the consumer implements/provides (the `Ports` namespace).
// LoopbackTransport is an adapter and lives in `Transports`, not here.
export type { Transport } from './ports/transport';
export { type Logger, noopLogger } from './ports/logger';
export { type MeshCoreEventMap as EventMap, MeshCoreEvents as Events } from './ports/events';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/namespaces/ports.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/ports.ts tests/namespaces/ports.test.ts
git commit -m "feat: add Ports namespace barrel (src/ports.ts)"
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
import { describe, expectTypeOf, it } from 'vitest';
import type * as Features from '../../src/features';

describe('Features namespace barrel', () => {
  it('exposes the bounded public feature types (compile-time)', () => {
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
Expected: FAIL — cannot find module `../../src/features`.

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

### Task 4: The surface cutover (single namespaced entry point)

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

### Task 5: TypeDoc + docs guides

**Files:**
- Modify: `docs/astro.config.mjs` (single TypeDoc entry point)
- Modify: `docs/src/content/docs/guides/transports.md` (and any other guide importing old subpaths/symbols)

**Interfaces:**
- Consumes: the namespaced `src/index.ts` from Task 4.
- Produces: a docs build whose TypeDoc sidebar shows the six namespaces as distinct sections.

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

- [ ] **Step 3: Build the docs**

Run: `pnpm docs:build`
Expected: build succeeds; TypeDoc emits a Namespace page/section per `export * as` namespace (`Models`, `Errors`, `Protocol`, `Transports`, `Ports`, `Features`).

- [ ] **Step 4: Commit**

```bash
git add docs/astro.config.mjs docs/src/content
git commit -m "docs: single TypeDoc entry + namespaced guide imports"
```

---

### Task 6: Final full verification

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

**Spec coverage:**
- Single `.` entry + six namespaces via `export * as` → Tasks 1–4 (barrels) + Task 4 (index). ✓
- Membership rules (rich Models; bounded type-only Features; Ports = contracts; Transports = adapters incl. Loopback) → Tasks 1–4, Global Constraints table. ✓
- Naming map (shortened adapter/event names) → Task 4 Step 3, Global Constraints. ✓
- Errors as own namespace from `model/errors` → Task 4 Step 4. ✓
- `package.json` exports collapse + `sideEffects: false` retained + tsup single entry → Task 4 Steps 5–6. ✓
- TypeDoc single entry + namespace sections + `@module`-style captions (JSDoc above each `export * as`) → Task 4 Step 4 (captions) + Task 5. ✓
- Guides + examples rewired → Task 4 Step 8, Task 5 Step 2. ✓
- Verification contract (typecheck/test/build/lint/docs:build + guard test) → Tasks 4 & 6. ✓
- Trade-offs (eager init; no heavy peer deps) — informational in spec; no task needed. ✓

**Placeholder scan:** No TBD/TODO; every code/config/test step shows complete content; the example migration uses four fully-shown patterns with explicit file lists (no "similar to" hand-waving). ✓

**Type consistency:** Public names are consistent across tasks — `Transports.Serial`/`.Ble`/`.Loopback`/`.createBle`/`.NORDIC_UART`, `Ports.EventMap`/`.Events`/`.noopLogger`/`.Transport`/`.Logger`, `Errors.ProtocolError`, `Protocol.BufferReader`/`.CMD`/`.RESP`, `Models.DEFAULT_RADIO_SETTINGS`. The `Features` member list matches the audited set in every place it appears (Task 3 barrel, Task 3 test, Global Constraints table). ✓
