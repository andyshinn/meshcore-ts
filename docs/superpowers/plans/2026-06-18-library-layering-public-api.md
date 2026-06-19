# Library Layering & Public-API Curation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize `@andyshinn/meshcore-ts` into six dependency-ordered layers and replace the flat `export *` barrel with three curated public entry points, without changing runtime behavior or breaking the `coresense` consumer.

**Architecture:** Files move into `protocol/ → model/ → ports/ → features/ → session/` (plus `transports/`), with imports allowed only downward (documented convention). Four misfiled coupling edges are fixed by relocating files to their correct layer. The public surface becomes three barrels — `.` (core), `./protocol`, `./transports` — and the `package.json` `exports` map blocks every other deep import.

**Tech Stack:** TypeScript 6 (`moduleResolution: bundler`), tsup (multi-entry build), vitest, Biome, pnpm. Mechanical moves are performed with **ts-morph**, whose `SourceFile.move()` rewrites every referencing import across `src/` and `tests/` automatically.

## Global Constraints

- **No runtime behavior change.** This is a pure structure/surface refactor; every existing test must stay green unchanged in meaning.
- **Dependency rule (documented convention, not lint-enforced):** `protocol → model → ports → features → session`; `transports` depends only on `ports` + `model`. A module imports its own layer or any layer to its left, never right.
- **Three public entry points only:** `.`, `./protocol`, `./transports`. A symbol is public *only* if a root barrel re-exports it.
- **Preserve each file's existing import-extension style** (some specifiers use `.js`, some are bare). ts-morph preserves this; do not normalize.
- **Node `>=22`, pnpm `11.6.0`, Biome `2.5.0`.** Run `pnpm` (not npm/yarn).
- **Green gate after every task:** `pnpm typecheck && pnpm test` must pass before committing.
- **History:** rely on git rename detection (`git add -A`); ts-morph rewrites file contents + paths.
- The 1571-line `src/session/session.ts` split is **out of scope** (separate spec).

**Spec:** `docs/superpowers/specs/2026-06-18-library-layering-public-api-design.md`

---

### Task 1: Mechanical-move tooling (ts-morph relayer + madge)

**Files:**
- Create: `scripts/relayer.mjs`
- Modify: `package.json` (devDependencies)

**Interfaces:**
- Produces: `scripts/relayer.mjs` — a CLI that reads a JSON move-map (`{ "src/old.ts": "src/new.ts", … }`) and applies `SourceFile.move()` to each, updating all references project-wide. Reused by Tasks 2, 3, 4, 6. Removed in Task 9.

- [ ] **Step 1: Install the dev tools**

Run:
```bash
pnpm add -D ts-morph madge
```
Expected: `ts-morph` and `madge` appear under `devDependencies`; lockfile updates.

- [ ] **Step 2: Write the relayer script**

Create `scripts/relayer.mjs`:
```js
// Mechanical layer-relocation helper. Usage: node scripts/relayer.mjs <moves.json>
// moves.json maps current src-relative paths to their new paths. ts-morph
// rewrites the moved files' own imports AND every referencing import across
// all files in the tsconfig project (src + tests), preserving specifier style.
import { Project } from 'ts-morph';
import { readFileSync } from 'node:fs';

const mapPath = process.argv[2];
if (!mapPath) {
  console.error('usage: node scripts/relayer.mjs <moves.json>');
  process.exit(1);
}
const moves = JSON.parse(readFileSync(mapPath, 'utf8'));

const project = new Project({ tsConfigFilePath: 'tsconfig.json' });

for (const [from, to] of Object.entries(moves)) {
  project.getSourceFileOrThrow(from).move(to);
}
project.saveSync();
console.log(`Relayered ${Object.keys(moves).length} files; references updated.`);
```

- [ ] **Step 3: Verify the script loads the project (dry sanity check)**

Run:
```bash
node -e "import('ts-morph').then(({Project})=>{const p=new Project({tsConfigFilePath:'tsconfig.json'});console.log('files loaded:', p.getSourceFiles().length)})"
```
Expected: prints `files loaded:` followed by a number > 140 (src + tests both load — confirms tests are in the project so their imports will be rewritten).

- [ ] **Step 4: Confirm the project still builds/tests green (no changes yet)**

Run: `pnpm typecheck && pnpm test`
Expected: PASS (this task only added tooling).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: add ts-morph relayer + madge for layered restructure"
```

---

### Task 2: Create the `protocol/` layer

**Files:**
- Move (via relayer): `src/buffer.ts`, `src/codes.ts`, `src/frame.ts`, `src/encode.ts`, `src/advert.ts`, `src/meshPacket.ts`, `src/onAirPackets.ts`, `src/pubkey.ts`, `src/repeater.ts` → `src/protocol/`
- Temp: `scripts/moves-protocol.json`

**Interfaces:**
- Consumes: `scripts/relayer.mjs` (Task 1).
- Produces: all nine wire-codec modules now live under `src/protocol/`; every importer (across `src/` + `tests/`) updated automatically.

- [ ] **Step 1: Write the move-map**

Create `scripts/moves-protocol.json`:
```json
{
  "src/buffer.ts": "src/protocol/buffer.ts",
  "src/codes.ts": "src/protocol/codes.ts",
  "src/frame.ts": "src/protocol/frame.ts",
  "src/encode.ts": "src/protocol/encode.ts",
  "src/advert.ts": "src/protocol/advert.ts",
  "src/meshPacket.ts": "src/protocol/meshPacket.ts",
  "src/onAirPackets.ts": "src/protocol/onAirPackets.ts",
  "src/pubkey.ts": "src/protocol/pubkey.ts",
  "src/repeater.ts": "src/protocol/repeater.ts"
}
```

- [ ] **Step 2: Run the relayer**

Run: `node scripts/relayer.mjs scripts/moves-protocol.json`
Expected: prints `Relayered 9 files; references updated.` and `src/protocol/` now contains the nine files.

- [ ] **Step 3: Auto-fix import ordering**

Run: `npx biome check --write src tests`
Expected: exits clean (Biome may reorder imports in touched files; that's fine).

- [ ] **Step 4: Verify green**

Run: `pnpm typecheck && pnpm test`
Expected: PASS. If typecheck reports a stray unresolved import (ts-morph edge case), fix that specifier by hand to point at `src/protocol/<name>` and re-run.

- [ ] **Step 5: Remove the temp move-map and commit**

```bash
rm scripts/moves-protocol.json
git add -A
git commit -m "refactor: move wire-codec modules into src/protocol/ layer"
```

---

### Task 3: Create the `model/` layer

**Files:**
- Move (via relayer): `src/types.ts`, `src/errors.ts`, `src/paths.ts`, `src/meshObservations.ts` → `src/model/`; `src/contacts/discovered.ts` → `src/model/contacts.ts`; `src/state/model.ts` → `src/model/state/model.ts`; `src/state/discoveredStore.ts` → `src/model/state/discoveredStore.ts`
- Temp: `scripts/moves-model.json`

**Interfaces:**
- Consumes: `scripts/relayer.mjs`; the `src/protocol/` tree from Task 2.
- Produces: domain types + state under `src/model/`; `paths.ts` is now model-layer (resolves spec smell 5); `src/contacts/` and `src/state/` directories become empty.

- [ ] **Step 1: Write the move-map**

Create `scripts/moves-model.json`:
```json
{
  "src/types.ts": "src/model/types.ts",
  "src/errors.ts": "src/model/errors.ts",
  "src/paths.ts": "src/model/paths.ts",
  "src/meshObservations.ts": "src/model/meshObservations.ts",
  "src/contacts/discovered.ts": "src/model/contacts.ts",
  "src/state/model.ts": "src/model/state/model.ts",
  "src/state/discoveredStore.ts": "src/model/state/discoveredStore.ts"
}
```

- [ ] **Step 2: Run the relayer**

Run: `node scripts/relayer.mjs scripts/moves-model.json`
Expected: prints `Relayered 7 files; references updated.`

- [ ] **Step 3: Remove now-empty source directories**

Run:
```bash
rmdir src/contacts src/state 2>/dev/null; true
```
Expected: both directories gone (they held only the moved files). If `rmdir` reports "not empty", list the leftover with `ls src/contacts src/state` and move/handle it before continuing.

- [ ] **Step 4: Auto-fix import ordering**

Run: `npx biome check --write src tests`
Expected: exits clean.

- [ ] **Step 5: Verify green**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 6: Remove the temp move-map and commit**

```bash
rm scripts/moves-model.json
git add -A
git commit -m "refactor: move domain types, paths, state into src/model/ layer"
```

---

### Task 4: Move the feature contract into `features/`

**Files:**
- Move (via relayer): `src/feature.ts` → `src/features/feature.ts`; `src/registry.ts` → `src/features/registry.ts`
- Temp: `scripts/moves-feature.json`

**Interfaces:**
- Consumes: `scripts/relayer.mjs`; trees from Tasks 2–3.
- Produces: `Feature`/`FeatureContext` (`features/feature.ts`) and `FeatureRegistry` (`features/registry.ts`) now live with the feature modules. Note: `feature.ts` still imports `../session/runtime` and `../session/adminSessions` after this task — those rightward edges are resolved in Task 6.

- [ ] **Step 1: Write the move-map**

Create `scripts/moves-feature.json`:
```json
{
  "src/feature.ts": "src/features/feature.ts",
  "src/registry.ts": "src/features/registry.ts"
}
```

- [ ] **Step 2: Run the relayer**

Run: `node scripts/relayer.mjs scripts/moves-feature.json`
Expected: prints `Relayered 2 files; references updated.`

- [ ] **Step 3: Auto-fix import ordering**

Run: `npx biome check --write src tests`
Expected: exits clean.

- [ ] **Step 4: Verify green**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 5: Remove the temp move-map and commit**

```bash
rm scripts/moves-feature.json
git add -A
git commit -m "refactor: move feature contract + registry into src/features/"
```

---

### Task 5: Smell 1 — extract `ContactRecord`/`ContactSource` into `model/`

**Files:**
- Create: `src/model/contactTypes.ts`
- Modify: `src/features/contacts.ts` (remove the two type declarations, import them from model)
- Modify: `src/ports/events.ts:3` (re-point the import)
- Test: `tests/model/contactTypes.test.ts`

**Interfaces:**
- Consumes: `src/model/` (Task 3), `src/features/` (Task 4).
- Produces: `ContactRecord` (interface) and `ContactSource` (`'sync' | 'advert'`) now exported from `src/model/contactTypes.ts`. `features/contacts.ts` imports them from there; `ports/events.ts` imports them from there (resolving `ports → features`).

- [ ] **Step 1: Write the failing test for the new module location**

Create `tests/model/contactTypes.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { ContactRecord, ContactSource } from '../../src/model/contactTypes';

describe('model/contactTypes', () => {
  it('exposes ContactRecord shape and ContactSource union', () => {
    const source: ContactSource = 'advert';
    const record: ContactRecord = {
      publicKeyHex: 'ab',
      type: 0,
      flags: 0,
      outPathLen: 0,
      outPathHex: '',
      name: 'n',
      lastAdvertUnix: 0,
      gpsLat: 0,
      gpsLon: 0,
      lastmod: 0,
    };
    expect(record.publicKeyHex).toBe('ab');
    expect(source).toBe('advert');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/model/contactTypes.test.ts`
Expected: FAIL — cannot find module `../../src/model/contactTypes`.

- [ ] **Step 3: Create the model module (declarations copied verbatim)**

Create `src/model/contactTypes.ts`:
```ts
// Consumer-facing contact value types. Previously declared inside
// features/contacts.ts; relocated to the model layer so ports/events and the
// public barrel can reference them without importing a feature.

export interface ContactRecord {
  publicKeyHex: string;
  type: number;
  flags: number;
  outPathLen: number;
  outPathHex: string;
  name: string;
  lastAdvertUnix: number;
  gpsLat: number;
  gpsLon: number;
  lastmod: number;
}

export type ContactSource = 'sync' | 'advert';
```

- [ ] **Step 4: Remove the declarations from `features/contacts.ts` and import them instead**

In `src/features/contacts.ts`, delete the `ContactRecord` interface block (the `export interface ContactRecord { … }` spanning the `publicKeyHex … lastmod` fields) and delete the line `export type ContactSource = 'sync' | 'advert';`. Then add a plain import near the top of the file (with the other `../model` imports) — `contacts.ts` itself uses both types in its function signatures, so it needs them:
```ts
import type { ContactRecord, ContactSource } from '../model/contactTypes';
```
Do **not** re-export them from `contacts.ts`: after Step 5 re-points `ports/events.ts`, nothing imports these names from `features/contacts`, so a re-export would be dead code. The public surface is controlled solely by the root barrel (Task 7).

- [ ] **Step 5: Re-point `ports/events.ts`**

In `src/ports/events.ts`, change line 3 from:
```ts
import type { ContactRecord, ContactSource } from '../features/contacts';
```
to:
```ts
import type { ContactRecord, ContactSource } from '../model/contactTypes';
```

- [ ] **Step 6: Auto-fix and verify green**

Run: `npx biome check --write src tests && pnpm typecheck && pnpm test`
Expected: PASS, including the new `tests/model/contactTypes.test.ts`.

- [ ] **Step 7: Confirm the smell is gone**

Run: `grep -rn "from '../features/contacts'" src/ports/`
Expected: no output (ports no longer imports from features).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: relocate ContactRecord/ContactSource to model (smell 1)"
```

---

### Task 6: Smells 2–4 — relocate session-scoped state into `features/`

**Files:**
- Move (via relayer): `src/session/runtime.ts` → `src/features/runtime.ts`; `src/session/adminSessions.ts` → `src/features/adminSessions.ts`; `src/pendingChannelSends.ts` → `src/features/pendingChannelSends.ts`
- Temp: `scripts/moves-runtime.json`

**Interfaces:**
- Consumes: `scripts/relayer.mjs`; trees from Tasks 2–5.
- Produces: `SessionRuntime` + `createSessionRuntime` (`features/runtime.ts`), `AdminSessionStore` (`features/adminSessions.ts`), `PendingChannelSends` (`features/pendingChannelSends.ts`) now in the features layer. `features/feature.ts` imports them same-layer; `session/session.ts` imports them downward. Every rightward edge is gone — `session/` now holds only `session.ts`.

- [ ] **Step 1: Write the move-map**

Create `scripts/moves-runtime.json`:
```json
{
  "src/session/runtime.ts": "src/features/runtime.ts",
  "src/session/adminSessions.ts": "src/features/adminSessions.ts",
  "src/pendingChannelSends.ts": "src/features/pendingChannelSends.ts"
}
```

- [ ] **Step 2: Run the relayer**

Run: `node scripts/relayer.mjs scripts/moves-runtime.json`
Expected: prints `Relayered 3 files; references updated.`

- [ ] **Step 3: Auto-fix import ordering**

Run: `npx biome check --write src tests`
Expected: exits clean.

- [ ] **Step 4: Verify green**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 5: Confirm no rightward edges remain (the layering invariant holds)**

Run:
```bash
grep -rn "from '\.\./session/" src/features src/ports src/model src/protocol || echo "OK: no features/ports/model/protocol imports point into session/"
grep -rn "from '\.\./\.\./session/" src/model/state || echo "OK: model/state clean"
```
Expected: each prints its `OK:` line (no upward imports into `session/` from lower layers).

- [ ] **Step 6: Confirm no new import cycles**

Run: `npx madge --circular --extensions ts src`
Expected: `✔ No circular dependency found!` (or madge lists none). If a cycle is reported, it will name the files — resolve by checking the move was applied and the importer points at the new path.

- [ ] **Step 7: Remove the temp move-map and commit**

```bash
rm scripts/moves-runtime.json
git add -A
git commit -m "refactor: relocate session-scoped state into features (smells 2-4)"
```

---

### Task 7: Curate the three public barrels + build wiring

**Files:**
- Overwrite: `src/index.ts`
- Create: `src/protocol.ts`
- Create: `src/transports.ts`
- Delete: `src/transports/index.ts` (replaced by `src/transports.ts`)
- Modify: `package.json` (`exports`, `sideEffects`)
- Modify: `tsup.config.ts` (`entry`)

**Interfaces:**
- Consumes: the fully relayered tree (Tasks 2–6).
- Produces: exactly three importable entry points. Core value exports: `MeshCoreSession`, `LoopbackTransport`, `VERSION`, `ProtocolError`, `ProtocolTimeoutError`, `FeatureDisabledError`, `UnknownContactError`, `ContactTableFullError`. Core type exports: `MeshCoreSessionOptions`, `Transport`, `TransportState`, `Contact`, `ContactRecord`, `ContactSource`, `Logger`, `MeshCoreEventMap`.

- [ ] **Step 1: Replace the flat core barrel**

Overwrite `src/index.ts`:
```ts
// Public entry point for @andyshinn/meshcore-ts (core surface).
import { version } from '../package.json';

export const VERSION: string = version;

// Session orchestrator + its constructor options.
export { MeshCoreSession } from './session/session';
export type { MeshCoreSessionOptions } from './session/session';

// Transport contract + the dependency-free in-memory transport.
export { LoopbackTransport } from './ports/transport';
export type { Transport } from './ports/transport';

// Domain types consumers touch.
export type { Contact, TransportState } from './model/types';
export type { ContactRecord, ContactSource } from './model/contactTypes';

// Structured-logging port (passed via MeshCoreSessionOptions.logger).
export type { Logger } from './ports/logger';

// Event map for typing session.on(...) handlers.
export type { MeshCoreEventMap } from './ports/events';

// Errors consumers catch.
export {
  ContactTableFullError,
  FeatureDisabledError,
  ProtocolError,
  ProtocolTimeoutError,
  UnknownContactError,
} from './model/errors';
```

- [ ] **Step 2: Create the `./protocol` barrel**

Create `src/protocol.ts`:
```ts
// Power-user wire-codec surface: @andyshinn/meshcore-ts/protocol.
// Forward-looking — lets consumers build/parse companion frames directly.
// NOTE: paths.ts is intentionally excluded (it is model-layer, not codec).
export * from './protocol/codes';
export * from './protocol/buffer';
export * from './protocol/frame';
export * from './protocol/encode';
export * from './protocol/advert';
export * from './protocol/meshPacket';
export * from './protocol/onAirPackets';
export * from './protocol/pubkey';
export * from './protocol/repeater';
```

- [ ] **Step 3: Create the `./transports` barrel and delete the old folder index**

Create `src/transports.ts`:
```ts
// Hardware transport adapters: @andyshinn/meshcore-ts/transports.
// Carries the optional peer deps (noble, serialport) — kept out of core.
export { createBleTransport, BleTransport, NORDIC_UART } from './transports/bleTransport';
export type { BleHooks } from './transports/bleTransport';
export { SerialTransport } from './transports/serialTransport';
export type { SerialPortLike } from './transports/serialTransport';
export { SerialDeframer, encodeSerialFrame } from './transports/serialFraming';
```

Then delete the superseded folder barrel:
```bash
git rm src/transports/index.ts
```

- [ ] **Step 4: Update `package.json` exports + sideEffects**

In `package.json`, replace the `exports` block and add `sideEffects`:
```jsonc
  "sideEffects": false,
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    },
    "./protocol": {
      "types": "./dist/protocol.d.ts",
      "import": "./dist/protocol.js",
      "require": "./dist/protocol.cjs"
    },
    "./transports": {
      "types": "./dist/transports.d.ts",
      "import": "./dist/transports.js",
      "require": "./dist/transports.cjs"
    }
  },
```
(Leave `main`/`module`/`types` pointing at `./dist/index.*` as they are.)

- [ ] **Step 5: Update tsup entries**

In `tsup.config.ts`, change the `entry` line to three entries:
```ts
  entry: {
    index: 'src/index.ts',
    protocol: 'src/protocol.ts',
    transports: 'src/transports.ts',
  },
```

- [ ] **Step 6: Verify typecheck, tests, and a full build**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: PASS, and `dist/` contains `index.{js,cjs,d.ts}`, `protocol.{js,cjs,d.ts}`, `transports.{js,cjs,d.ts}`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: curate three public entry points (core, protocol, transports)"
```

---

### Task 8: Public-surface guard test

**Files:**
- Test: `tests/publicSurface.test.ts`

**Interfaces:**
- Consumes: the curated barrels (Task 7).
- Produces: a regression test that fails if the core barrel's value exports drift, or if the `exports` map gains a wildcard / extra key (which would re-open deep imports).

- [ ] **Step 1: Write the failing guard test**

Create `tests/publicSurface.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as core from '../src/index';

describe('public surface — core barrel', () => {
  it('exports exactly the intended runtime values', () => {
    const expected = [
      'ContactTableFullError',
      'FeatureDisabledError',
      'LoopbackTransport',
      'MeshCoreSession',
      'ProtocolError',
      'ProtocolTimeoutError',
      'UnknownContactError',
      'VERSION',
    ];
    expect(Object.keys(core).sort()).toEqual(expected);
  });
});

describe('public surface — protocol & transports barrels', () => {
  it('protocol barrel exposes the codec primitives', async () => {
    const protocol = await import('../src/protocol');
    expect(protocol.BufferReader).toBeTypeOf('function');
    expect(protocol.BufferWriter).toBeTypeOf('function');
    expect(protocol.CMD).toBeDefined();
    expect(protocol.RESP).toBeDefined();
  });

  it('transports barrel exposes the adapters', async () => {
    const transports = await import('../src/transports');
    expect(transports.createBleTransport).toBeTypeOf('function');
    expect(transports.SerialTransport).toBeTypeOf('function');
    expect(transports.LoopbackTransport).toBeUndefined(); // stays in core only
  });
});

describe('package exports map blocks deep imports', () => {
  it('declares exactly three entry points and no wildcard', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(Object.keys(pkg.exports).sort()).toEqual(['.', './protocol', './transports']);
    expect(JSON.stringify(pkg.exports)).not.toContain('*');
    expect(pkg.sideEffects).toBe(false);
  });
});
```

- [ ] **Step 2: Run it**

Run: `pnpm vitest run tests/publicSurface.test.ts`
Expected: PASS. If the first assertion fails, the message shows the actual vs expected key set — reconcile by editing `src/index.ts` (do not loosen the test to hide an unintended export).

- [ ] **Step 3: Full suite green**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test: guard the curated public surface against drift"
```

---

### Task 9: Consumer guard (coresense) + remove relayer tooling

**Files:**
- Delete: `scripts/relayer.mjs`
- Modify: `package.json` (drop `ts-morph`, `madge` devDeps)

**Interfaces:**
- Consumes: the built package (Task 7) and the local `coresense` repo (`../coresense`, linked via `link:../meshcore-ts`).
- Produces: confirmation the 8-symbol consumer surface still resolves; temporary tooling removed.

- [ ] **Step 1: Rebuild and verify coresense still typechecks against the linked package**

Run:
```bash
pnpm build
pnpm --dir ../coresense install
pnpm --dir ../coresense typecheck
```
Expected: coresense typechecks clean — its imports (`MeshCoreSession`, `LoopbackTransport`, `Transport`, `TransportState`, `Contact`, `ContactRecord`, `ContactSource` from `.`; `createBleTransport` from `./transports`) all resolve.
If coresense has no `typecheck` script, run its build instead (e.g. `pnpm --dir ../coresense build`); adapt to its actual scripts.

- [ ] **Step 2: Remove the temporary tooling**

Run:
```bash
rm scripts/relayer.mjs
pnpm remove ts-morph madge
```
Expected: `scripts/relayer.mjs` gone; `ts-morph`/`madge` removed from `devDependencies`. (Leave `scripts/` if other scripts exist; otherwise `rmdir scripts 2>/dev/null; true`.)

- [ ] **Step 3: Final full verification**

Run: `pnpm typecheck && pnpm test && pnpm lint && pnpm build`
Expected: all PASS; `dist/` carries the three entry points.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: drop relayer tooling after layered restructure"
```

---

## Self-Review

**Spec coverage:**
- Six-layer architecture + file map → Tasks 2, 3, 4 (relocation).
- Dependency rule holds with no exceptions → verified in Task 6 Step 5.
- Smell 1 (ContactRecord/ContactSource → model) → Task 5.
- Smells 2–4 (session-state → features) → Task 6.
- Smell 5 (paths → model) → Task 3 (placement; no separate action, per spec).
- Three curated barrels + exact public symbols → Task 7 + guarded in Task 8.
- `package.json` exports (+`./protocol`), `sideEffects:false`, tsup 3 entries → Task 7.
- No internal per-folder barrels → satisfied (only `src/index.ts`, `src/protocol.ts`, `src/transports.ts` created; old `transports/index.ts` deleted).
- Verification gates (typecheck/test each phase, build emits 3 d.ts, public-surface guard, consumer guard, lint) → Tasks 2–9.
- `LoopbackTransport` stays in core, `MeshCoreEvents` class internal → encoded in Task 7 barrel + asserted in Task 8.
- `session.ts` split deferred → noted in Global Constraints.

**Placeholder scan:** No TBD/TODO; every code step shows complete content; verbatim declarations used for `ContactRecord`/`ContactSource`.

**Type consistency:** Barrel export names match confirmed declaration sites — `Transport` from `ports/transport`, `TransportState`/`Contact` from `model/types`, `ContactRecord`/`ContactSource` from `model/contactTypes`, `MeshCoreSessionOptions` from `session/session`, `Logger` from `ports/logger`, `MeshCoreEventMap` from `ports/events`, errors from `model/errors`. The Task 8 expected-keys list matches the Task 7 value exports exactly (8 values; type-only exports correctly excluded from the runtime `Object.keys` assertion).
