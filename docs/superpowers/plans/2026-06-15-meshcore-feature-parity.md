# MeshCore.js Feature Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close four feature gaps in `meshcore-ts` vs. the reference `@liamcottle/meshcore.js`: hashtag region-key derivation (#2), a public generic binary request (#3), `GetAvgMinMax` telemetry (#4), and active re-fetch getters + find helpers (#5).

**Architecture:** Features stay pure `(ctx, ...)` functions exporting `encode*`/`decode*`/session-facing helpers; `MeshCoreSession` delegates thin public methods to them. Active re-fetch getters reuse the handshake's contact-stream waiters and the typed-reply path; because typed replies bypass feature handlers, each feature's handler body is factored into a reusable `apply*` function. A promise-chain sync mutex serializes the handshake and all re-fetch getters.

**Tech Stack:** TypeScript (ESM, Node ≥20), vitest, biome, tsup. SHA-256 via `node:crypto`.

**Spec:** `docs/superpowers/specs/2026-06-15-meshcore-feature-parity-design.md`

---

## File Structure

**Modify:**
- `src/codes.ts` — add `REQ_TYPE.GET_AVG_MIN_MAX = 0x04`.
- `src/features/floodScope.ts` — add `deriveFloodScopeKey`, `setFloodScopeRegion`.
- `src/features/repeaterAdmin.ts` — export `sendBinaryReq` (+ optional timeout); add `repeaterRequestAvgMinMax`.
- `src/repeater.ts` — add firmware-faithful avg/min/max tables, `parseAvgMinMax`, types.
- `src/features/selfInfo.ts` — factor `applySelfInfo`.
- `src/features/channels.ts` — factor `applyChannelInfo`; add `getChannel`.
- `src/session/session.ts` — add `setFloodScopeRegion`, `sendBinaryRequest`, `repeaterRequestAvgMinMax`, `getSelfInfo`, `getContacts`, `getChannels`, `getChannel`, find helpers; add `syncLock`/`withSyncLock`; wrap `handshake`.

**Test (create/extend):**
- `tests/features/floodScope.test.ts` — extend.
- `tests/features/repeaterAdmin.test.ts` — extend.
- `tests/repeater.test.ts` — extend.
- `tests/features/selfInfo.test.ts` — extend.
- `tests/features/channels.test.ts` — extend.
- `tests/session/getters.test.ts` — create.

Conventions: `vitest`; pure feature fns tested with a hand-built `ctx` (see `makeCtx` in `repeaterAdmin.test.ts`); session methods tested with `makeSession()`/`LoopbackTransport` (see `tests/support/harness.ts`). Run a single test with `npx vitest run <file> -t "<name>"`.

---

## Task 1: #2 — Hashtag region-key derivation

**Files:**
- Modify: `src/features/floodScope.ts`
- Modify: `src/session/session.ts`
- Test: `tests/features/floodScope.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/features/floodScope.test.ts`:

```ts
import { createHash } from 'node:crypto';
import { deriveFloodScopeKey } from '../../src/features/floodScope';

describe('floodScope: deriveFloodScopeKey', () => {
  const sha16 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 32);

  it('returns the first 16 bytes of SHA-256("#region") as hex', () => {
    expect(deriveFloodScopeKey('#MyRegion')).toBe(sha16('#MyRegion'));
    expect(deriveFloodScopeKey('#MyRegion')).toHaveLength(32);
  });

  it('prepends "#" when absent (so "Region" and "#Region" match)', () => {
    expect(deriveFloodScopeKey('Region')).toBe(sha16('#Region'));
    expect(deriveFloodScopeKey('Region')).toBe(deriveFloodScopeKey('#Region'));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/features/floodScope.test.ts -t "deriveFloodScopeKey"`
Expected: FAIL — `deriveFloodScopeKey is not a function` / import error.

- [ ] **Step 3: Implement `deriveFloodScopeKey` + `setFloodScopeRegion`**

In `src/features/floodScope.ts`, add the import at the top (after the existing `node:buffer` import):

```ts
import { createHash } from 'node:crypto';
```

Add these exports at the end of the file:

```ts
// Derive the 16-byte flood-scope key for a public hashtag region, matching the
// reference's TransportKeyUtil.getHashtagRegionKey: normalize to "#name",
// SHA-256 the UTF-8 bytes, and take the first 16 bytes (the firmware uses the
// first half of the 32-byte hash as the scope key). Returns 32 hex chars.
export function deriveFloodScopeKey(region: string): string {
  const normalized = region.startsWith('#') ? region : `#${region}`;
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 32);
}

// Convenience: derive the key for a region name and apply it as the send-scope
// override (CMD_SET_FLOOD_SCOPE_KEY).
export async function setFloodScopeRegion(ctx: FeatureContext, region: string): Promise<void> {
  await setFloodScopeKey(ctx, { keyHex: deriveFloodScopeKey(region) });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/features/floodScope.test.ts`
Expected: PASS (all floodScope tests).

- [ ] **Step 5: Add the session delegation + test**

In `src/session/session.ts`, find the existing `setDefaultFloodScope` method (≈ line 1243) and add directly after the `setFloodScopeKey` method:

```ts
  /** Derive the 16-byte key for a public hashtag region and set it as the
   *  send-scope override. Shorthand for setFloodScopeKey({ keyHex }). */
  async setFloodScopeRegion(region: string): Promise<void> {
    return floodScope.setFloodScopeRegion(this.ctx, region);
  }
```

Add to `tests/features/floodScope.test.ts`:

```ts
import { CMD } from '../../src/codes';
import { makeSession } from '../support/harness';

describe('floodScope: setFloodScopeRegion (session)', () => {
  it('writes CMD_SET_FLOOD_SCOPE_KEY with the derived 16-byte key', async () => {
    const { session, transport } = makeSession();
    await session.setFloodScopeRegion('#TestRegion');
    const sent = Buffer.from(transport.sent.at(-1)!);
    expect(sent[0]).toBe(CMD.SET_FLOOD_SCOPE_KEY);
    expect(sent[1]).toBe(0x00);
    expect(sent.subarray(2).toString('hex')).toBe(deriveFloodScopeKey('#TestRegion'));
    expect(sent.subarray(2)).toHaveLength(16);
  });
});
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run tests/features/floodScope.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
npm run format
git add src/features/floodScope.ts src/session/session.ts tests/features/floodScope.test.ts
git commit -m "feat: deriveFloodScopeKey + setFloodScopeRegion (hashtag region scope)"
```

---

## Task 2: #3 — Public generic `sendBinaryRequest`

**Files:**
- Modify: `src/features/repeaterAdmin.ts:161` (the internal `sendBinaryReq`)
- Modify: `src/session/session.ts`
- Test: `tests/features/repeaterAdmin.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/features/repeaterAdmin.test.ts` (the file already has `makeCtx`, `PK`, `PREFIX`, an `addContact` helper, and imports `repeaterAdminFeature`, `registerAdminHooks`, `directMessagesFeature`, `PUSH`). Add `sendBinaryReq` to the import block from `../../src/features/repeaterAdmin`:

```ts
describe('repeaterAdmin: sendBinaryReq (generic)', () => {
  it('writes CMD_SEND_BINARY_REQ and resolves the tagged response body', async () => {
    const { ctx, state, writes } = makeCtx();
    addContact(state);
    registerAdminHooks(ctx);

    const reqData = Buffer.from([0x05, 0x00, 0x00]); // arbitrary REQ_TYPE + params
    const p = sendBinaryReq(ctx, `c:${PK}`, reqData);

    // CMD_SEND_BINARY_REQ = [0x32][32B pubkey][reqData]
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe(0x32);
    expect(writes[0].subarray(1, 33).toString('hex')).toBe(PK);
    expect(writes[0].subarray(33).toString('hex')).toBe('050000');

    // RESP_SENT echoes the tag; the admin hook claims it ahead of the DM FIFO.
    const sent = Buffer.alloc(10);
    sent[0] = 0x06;
    Buffer.from('cafebabe', 'hex').copy(sent, 2);
    directMessagesFeature.handle(0x06, sent, ctx);

    // PUSH_BINARY_RESPONSE = [0x8c][reserved][tag u32][body...]
    const resp = Buffer.alloc(6 + 2);
    resp[0] = PUSH.BINARY_RESPONSE;
    Buffer.from('cafebabe', 'hex').copy(resp, 2);
    resp[6] = 0xab;
    resp[7] = 0xcd;
    repeaterAdminFeature.handle(PUSH.BINARY_RESPONSE, resp, ctx);

    await expect(p.then((b) => b.toString('hex'))).resolves.toBe('abcd');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/features/repeaterAdmin.test.ts -t "sendBinaryReq"`
Expected: FAIL — `sendBinaryReq` is not exported (import error).

- [ ] **Step 3: Export `sendBinaryReq` with an optional timeout**

In `src/features/repeaterAdmin.ts`, change the internal helper (≈ line 161) from `async function sendBinaryReq(...)` to an exported function with an optional timeout:

```ts
/** Generic mesh request (ACL / neighbours / owner / avg-min-max, or any custom
 *  REQ_TYPE). Issues CMD_SEND_BINARY_REQ, parks an awaiter for the matching
 *  PUSH_BINARY_RESPONSE tag, and returns the response body (which the caller
 *  decodes per req_type). `reqData` is `[REQ_TYPE byte, ...params]`. */
export async function sendBinaryReq(
  ctx: FeatureContext,
  contactKey: string,
  reqData: Buffer,
  timeoutMs: number = ADMIN_REPLY_TIMEOUT_MS,
): Promise<Buffer> {
  const contact = lookupRepeaterContact(ctx, contactKey);
  if (!contact.ok) throw new Error(contact.error);
  const frame = buildSendBinaryReq(contact.publicKeyHex, reqData);
  const tagHex = await writeAdminAndAwaitTag(ctx, frame);
  return ctx.admin.awaitTag<Buffer>(tagHex, timeoutMs);
}
```

(Existing callers `repeaterRequestAcl`/`Neighbours`/`OwnerInfo` pass two/three args and keep working — the new param is optional.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/features/repeaterAdmin.test.ts -t "sendBinaryReq"`
Expected: PASS.

- [ ] **Step 5: Add the session method**

In `src/session/session.ts`, find the repeater-admin delegations (`repeaterRequestOwnerInfo` ≈ line 1390) and add after `repeaterRequestNeighbours`/`repeaterRequestOwnerInfo`:

```ts
  /** Send a generic binary request to a contact and resolve the raw response
   *  body. `reqData` is [REQ_TYPE byte, ...params]. The ACL/neighbours/owner/
   *  avg-min-max helpers are thin wrappers over this. */
  async sendBinaryRequest(contactKey: string, reqData: Buffer, opts: { timeoutMs?: number } = {}): Promise<Buffer> {
    return repeaterAdmin.sendBinaryReq(this.ctx, contactKey, reqData, opts.timeoutMs);
  }
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run tests/features/repeaterAdmin.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
npm run format
git add src/features/repeaterAdmin.ts src/session/session.ts tests/features/repeaterAdmin.test.ts
git commit -m "feat: public sendBinaryRequest (expose generic binary req)"
```

---

## Task 3: #4a — `parseAvgMinMax` + firmware-faithful tables

**Files:**
- Modify: `src/repeater.ts`
- Test: `tests/repeater.test.ts`

Wire format (firmware `MeshCore/examples/simple_sensor/SensorMesh.cpp:204-221`), response body after the companion strips the 4-byte tag: `[now u32 LE]` then N × `[channel u8][lpp_type u8][min][max][avg]`, each value `size` big-endian bytes, value = raw/multiplier with two's-complement when signed. `size`/`multiplier`/`signed` come from the firmware tables (`SensorMesh.cpp:76-131`).

- [ ] **Step 1: Write the failing tests**

Append to `tests/repeater.test.ts` (check its existing imports; add `parseAvgMinMax` to the import from `../src/repeater`):

```ts
import { parseAvgMinMax } from '../src/repeater';

describe('parseAvgMinMax', () => {
  it('parses now + a signed Temperature series (size 2, /10)', () => {
    const body = Buffer.alloc(4 + 2 + 6);
    body.writeUInt32LE(1000, 0); // now
    body[4] = 1; // channel
    body[5] = 0x67; // LPP_TEMPERATURE
    body.writeInt16BE(200, 6); // min 20.0
    body.writeInt16BE(255, 8); // max 25.5
    body.writeInt16BE(225, 10); // avg 22.5
    const res = parseAvgMinMax(body)!;
    expect(res.nowUnix).toBe(1000);
    expect(res.series).toEqual([
      { channel: 1, lppType: 0x67, typeHex: '0x67', name: 'Temperature', unit: '°C', min: 20, max: 25.5, avg: 22.5 },
    ]);
  });

  it('treats Current (0x75) as UNSIGNED per the firmware series table', () => {
    const body = Buffer.alloc(4 + 2 + 6);
    body.writeUInt32LE(0, 0);
    body[4] = 2;
    body[5] = 0x75; // LPP_CURRENT, size 2, /1000, UNSIGNED here
    body.writeUInt16BE(0xffff, 6); // min
    body.writeUInt16BE(0xffff, 8); // max
    body.writeUInt16BE(0xffff, 10); // avg
    const res = parseAvgMinMax(body)!;
    // 65535 / 1000 = 65.535 (NOT negative)
    expect(res.series[0]).toMatchObject({ lppType: 0x75, name: 'Current', unit: 'A', min: 65.535 });
  });

  it('returns null on a body too short for "now"', () => {
    expect(parseAvgMinMax(Buffer.from([0x00, 0x01]))).toBeNull();
  });

  it('stops cleanly on a truncated final entry', () => {
    const body = Buffer.alloc(4 + 2 + 2); // declares a temp entry but only 2 of 6 value bytes
    body.writeUInt32LE(5, 0);
    body[4] = 1;
    body[5] = 0x67;
    const res = parseAvgMinMax(body)!;
    expect(res.nowUnix).toBe(5);
    expect(res.series).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/repeater.test.ts -t "parseAvgMinMax"`
Expected: FAIL — `parseAvgMinMax` not exported.

- [ ] **Step 3: Implement the tables + parser**

In `src/repeater.ts`, add near the `CAYENNE_TYPES` table (it is defined ≈ line 535; add this block immediately after the `decodeCayenneLPP` function, ≈ line 611):

```ts
// ---- Avg/Min/Max series (REQ_TYPE_GET_AVG_MIN_MAX) ---------------------
// The series response packs each min/max/avg with size/scale/sign drawn from
// the firmware's getDataSize/getMultiplier/isSigned (NOT the standard CayenneLPP
// decode path — notably Current is UNSIGNED here). Mirrors
// MeshCore/examples/simple_sensor/SensorMesh.cpp:76-148.

function avgMinMaxSize(type: number): number {
  switch (type) {
    case 136: return 9; // GPS
    case 240: return 8; // POLYLINE
    case 134: case 113: return 6; // GYROMETER, ACCELEROMETER
    case 100: case 118: case 130: case 131: case 133: return 4; // GENERIC, FREQ, DIST, ENERGY, UNIXTIME
    case 135: return 3; // COLOUR
    case 2: case 3: case 101: case 103: case 125: case 115: case 104:
    case 121: case 116: case 117: case 132: case 128: return 2;
    default: return 1;
  }
}

function avgMinMaxMultiplier(type: number): number {
  switch (type) {
    case 117: case 130: case 131: return 1000; // CURRENT, DISTANCE, ENERGY
    case 116: case 2: case 3: return 100; // VOLTAGE, ANALOG_IN/OUT
    case 103: case 115: case 104: return 10; // TEMPERATURE, BAROMETRIC, HUMIDITY
    default: return 1;
  }
}

function avgMinMaxSigned(type: number): boolean {
  // ALTITUDE, TEMPERATURE, GYROMETER, ANALOG_IN/OUT, GPS, ACCELEROMETER
  return type === 121 || type === 103 || type === 134 || type === 2 || type === 3 || type === 136 || type === 113;
}

// Big-endian integer / multiplier, two's-complement when signed. Number math
// (not bitwise) so signedness is correct for multi-byte sizes.
function decodeSeriesFloat(buf: Buffer, size: number, multiplier: number, signed: boolean): number {
  let value = 0;
  for (let i = 0; i < size; i += 1) value = value * 256 + buf[i];
  if (signed) {
    const max = 2 ** (size * 8);
    if (value >= max / 2) value -= max;
  }
  return value / multiplier;
}

export interface AvgMinMaxSeries {
  channel: number;
  lppType: number;
  typeHex: string;
  name: string;
  unit?: string;
  min: number;
  max: number;
  avg: number;
}

export interface AvgMinMaxResult {
  /** Repeater's RTC time (unix seconds) at the moment it built the response. */
  nowUnix: number;
  series: AvgMinMaxSeries[];
}

// `body` is the PUSH_BINARY_RESPONSE payload (tag already stripped):
//   [now u32 LE] then N × [channel u8][lpp_type u8][min][max][avg].
export function parseAvgMinMax(body: Buffer): AvgMinMaxResult | null {
  if (body.length < 4) return null;
  const nowUnix = body.readUInt32LE(0);
  const series: AvgMinMaxSeries[] = [];
  let i = 4;
  while (i + 2 <= body.length) {
    const channel = body[i];
    const lppType = body[i + 1];
    const size = avgMinMaxSize(lppType); // unknown types default to 1 (firmware fallback)
    const entryLen = 2 + size * 3;
    if (i + entryLen > body.length) break; // truncated final entry — stop in frame
    const mult = avgMinMaxMultiplier(lppType);
    const signed = avgMinMaxSigned(lppType);
    const base = i + 2;
    const min = decodeSeriesFloat(body.subarray(base, base + size), size, mult, signed);
    const max = decodeSeriesFloat(body.subarray(base + size, base + 2 * size), size, mult, signed);
    const avg = decodeSeriesFloat(body.subarray(base + 2 * size, base + 3 * size), size, mult, signed);
    const desc = CAYENNE_TYPES[lppType];
    series.push({
      channel,
      lppType,
      typeHex: `0x${lppType.toString(16).padStart(2, '0')}`,
      name: desc?.name ?? 'Unknown',
      unit: desc?.unit,
      min,
      max,
      avg,
    });
    i += entryLen;
  }
  return { nowUnix, series };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/repeater.test.ts -t "parseAvgMinMax"`
Expected: PASS (all four cases).

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/repeater.ts tests/repeater.test.ts
git commit -m "feat: parseAvgMinMax + firmware-faithful series tables"
```

---

## Task 4: #4b — `repeaterRequestAvgMinMax` + session method

**Files:**
- Modify: `src/codes.ts:348` (`REQ_TYPE`)
- Modify: `src/features/repeaterAdmin.ts`
- Modify: `src/session/session.ts`
- Test: `tests/features/repeaterAdmin.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/features/repeaterAdmin.test.ts` (add `repeaterRequestAvgMinMax` to the repeaterAdmin import):

```ts
describe('repeaterAdmin: repeaterRequestAvgMinMax', () => {
  it('builds the 11-byte request and parses the response', async () => {
    const { ctx, state, writes } = makeCtx();
    addContact(state);
    registerAdminHooks(ctx);

    const p = repeaterRequestAvgMinMax(ctx, `c:${PK}`, { startSecsAgo: 3600, endSecsAgo: 0 });

    // reqData = [0x04][start u32 LE][end u32 LE][0][0]; framed as CMD_SEND_BINARY_REQ.
    const reqData = writes[0].subarray(33);
    expect(reqData).toHaveLength(11);
    expect(reqData[0]).toBe(0x04);
    expect(reqData.readUInt32LE(1)).toBe(3600);
    expect(reqData.readUInt32LE(5)).toBe(0);
    expect(reqData[9]).toBe(0);
    expect(reqData[10]).toBe(0);

    // Tag echo, then a tagged response: now=42 + one temperature entry.
    const sent = Buffer.alloc(10);
    sent[0] = 0x06;
    Buffer.from('11223344', 'hex').copy(sent, 2);
    directMessagesFeature.handle(0x06, sent, ctx);

    const respBody = Buffer.alloc(4 + 2 + 6);
    respBody.writeUInt32LE(42, 0);
    respBody[4] = 1;
    respBody[5] = 0x67;
    respBody.writeInt16BE(200, 6);
    respBody.writeInt16BE(255, 8);
    respBody.writeInt16BE(225, 10);
    const resp = Buffer.alloc(6 + respBody.length);
    resp[0] = PUSH.BINARY_RESPONSE;
    Buffer.from('11223344', 'hex').copy(resp, 2);
    respBody.copy(resp, 6);
    repeaterAdminFeature.handle(PUSH.BINARY_RESPONSE, resp, ctx);

    const res = await p;
    expect(res.nowUnix).toBe(42);
    expect(res.series[0]).toMatchObject({ channel: 1, name: 'Temperature', min: 20, max: 25.5, avg: 22.5 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/features/repeaterAdmin.test.ts -t "repeaterRequestAvgMinMax"`
Expected: FAIL — `repeaterRequestAvgMinMax` not exported.

- [ ] **Step 3: Add the REQ_TYPE constant**

In `src/codes.ts`, in the `REQ_TYPE` object (≈ line 348), add the entry after `GET_TELEMETRY_DATA`:

```ts
  GET_TELEMETRY_DATA: 0x03,
  GET_AVG_MIN_MAX: 0x04,
  GET_ACCESS_LIST: 0x05,
```

- [ ] **Step 4: Implement `repeaterRequestAvgMinMax`**

In `src/features/repeaterAdmin.ts`, add `parseAvgMinMax` and `type AvgMinMaxResult` to the existing import block from `../repeater`:

```ts
  parseAvgMinMax,
  type AvgMinMaxResult,
```

Add the function after `repeaterRequestOwnerInfo` (≈ line 295):

```ts
/** Request a min/max/avg series window from a sensor (REQ_TYPE_GET_AVG_MIN_MAX).
 *  `startSecsAgo`/`endSecsAgo` are the window bounds relative to the repeater's
 *  clock (end is usually 0 = now). Requires read-only ACL perms on the device. */
export async function repeaterRequestAvgMinMax(
  ctx: FeatureContext,
  contactKey: string,
  opts: { startSecsAgo: number; endSecsAgo: number },
): Promise<AvgMinMaxResult> {
  const reqData = Buffer.alloc(11);
  reqData[0] = REQ_TYPE.GET_AVG_MIN_MAX;
  reqData.writeUInt32LE(opts.startSecsAgo >>> 0, 1);
  reqData.writeUInt32LE(opts.endSecsAgo >>> 0, 5);
  // bytes 9,10 reserved = 0 (firmware returns no data unless both are zero)
  const payload = await sendBinaryReq(ctx, contactKey, reqData);
  const parsed = parseAvgMinMax(payload);
  if (!parsed) throw new Error('failed to parse avg/min/max response');
  return parsed;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/features/repeaterAdmin.test.ts -t "repeaterRequestAvgMinMax"`
Expected: PASS.

- [ ] **Step 6: Add the session method**

In `src/session/session.ts`, add `AvgMinMaxResult` to the type imports from `../repeater` (find the existing `import { ... } from '../repeater'` block; if there is none, add `import type { AvgMinMaxResult } from '../repeater';`). Then add the method next to `sendBinaryRequest`:

```ts
  /** Request a min/max/avg series window from a sensor contact. */
  async repeaterRequestAvgMinMax(
    contactKey: string,
    opts: { startSecsAgo: number; endSecsAgo: number },
  ): Promise<AvgMinMaxResult> {
    return repeaterAdmin.repeaterRequestAvgMinMax(this.ctx, contactKey, opts);
  }
```

- [ ] **Step 7: Run tests + typecheck**

Run: `npx vitest run tests/features/repeaterAdmin.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 8: Commit**

```bash
npm run format
git add src/codes.ts src/features/repeaterAdmin.ts src/session/session.ts tests/features/repeaterAdmin.test.ts
git commit -m "feat: repeaterRequestAvgMinMax (GET_AVG_MIN_MAX series)"
```

---

## Task 5: #5a — Factor `applySelfInfo` and `applyChannelInfo`

Refactor only — existing behavior and tests stay green. This lets the active getters reuse the feature side effects (state update + event emit), which the typed-reply path would otherwise bypass.

**Files:**
- Modify: `src/features/selfInfo.ts`
- Modify: `src/features/channels.ts`
- Test: existing `tests/features/selfInfo.test.ts`, `tests/features/channels.test.ts`

- [ ] **Step 1: Confirm existing tests pass (baseline)**

Run: `npx vitest run tests/features/selfInfo.test.ts tests/features/channels.test.ts`
Expected: PASS.

- [ ] **Step 2: Factor `applySelfInfo`**

In `src/features/selfInfo.ts`, add a `FeatureContext` import and replace the `selfInfoFeature` definition (the whole `export const selfInfoFeature` block) with:

```ts
import type { Feature, FeatureContext } from '../feature';
```
(replace the existing `import type { Feature } from '../feature';`)

```ts
/** Decode RESP_SELF_INFO, publish the radio identity as the app Owner, and
 *  return the parsed SelfInfo. Shared by the feature handler and the on-demand
 *  getSelfInfo() getter (which consumes the frame via the typed-reply path, so
 *  it must invoke this explicitly). */
export function applySelfInfo(ctx: FeatureContext, frame: Buffer): SelfInfo | null {
  const parsed = decodeSelfInfo(frame);
  if (!parsed) return null;
  const owner: Owner = {
    name: parsed.name,
    publicKeyHex: parsed.publicKeyHex,
    publicKeyShort: parsed.publicKeyHex.slice(0, 12),
  };
  ctx.state.setOwner(owner);
  ctx.events.emit('owner', owner);
  ctx.log.debug(`self-info: "${owner.name}" (${owner.publicKeyShort})`);
  return parsed;
}

export const selfInfoFeature: Feature = {
  handles: [RESP.SELF_INFO],
  handle: (_code, frame, ctx) => {
    applySelfInfo(ctx, frame);
  },
};
```

- [ ] **Step 3: Factor `applyChannelInfo`**

In `src/features/channels.ts`, replace the `export const channelsFeature` block (≈ lines 187-222) with an extracted function + a thin feature:

```ts
/** Decode RESP_CHANNEL_INFO, update the idx→Channel map, device-presence set,
 *  and persisted channel state, emitting the relevant events. Returns the
 *  decoded Channel, or null for an empty/unparseable slot. Shared by the feature
 *  handler and the on-demand getChannel() getter (typed-reply path bypasses the
 *  handler, so the getter calls this explicitly). */
export function applyChannelInfo(ctx: FeatureContext, frame: Buffer): Channel | null {
  const info = decodeChannelInfo(frame);
  if (!info) return null;
  if (info.empty) {
    const existing = ctx.rt.channels.channelByIdx.get(info.idx);
    if (existing) {
      ctx.rt.channels.channelByIdx.delete(info.idx);
      ctx.rt.channels.devicePresence.delete(existing.key);
      ctx.events.emit('channelPresence', [...ctx.rt.channels.devicePresence]);
    }
    return null;
  }

  const key = `ch:${info.name}`;
  const channel: Channel = {
    key,
    name: info.name,
    kind: info.name.startsWith('#') ? 'hashtag' : info.name === 'Public' ? 'public' : 'private',
    secretHex: info.secretHex,
    idx: info.idx,
  };

  ctx.rt.channels.channelByIdx.set(info.idx, channel);
  ctx.rt.channels.devicePresence.add(key);
  ctx.events.emit('channelPresence', [...ctx.rt.channels.devicePresence]);

  ctx.state.upsertChannel(channel);
  ctx.events.emit('channels', ctx.state.getChannels());
  ctx.log.debug(`channel idx=${info.idx} "${info.name}"`);
  return channel;
}

export const channelsFeature: Feature = {
  handles: [RESP.CHANNEL_INFO],
  handle: (_code, frame, ctx) => {
    applyChannelInfo(ctx, frame);
  },
};
```

- [ ] **Step 4: Run the baseline tests to verify they still pass**

Run: `npx vitest run tests/features/selfInfo.test.ts tests/features/channels.test.ts && npm run typecheck`
Expected: PASS, no type errors (the feature handlers behave identically).

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/features/selfInfo.ts src/features/channels.ts
git commit -m "refactor: factor applySelfInfo / applyChannelInfo for reuse by getters"
```

---

## Task 6: #5b — `channels.getChannel` feature function

**Files:**
- Modify: `src/features/channels.ts`
- Test: `tests/features/channels.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/features/channels.test.ts`. It needs a `ctx` whose `requestOrNull` returns a canned frame; build a minimal one inline (mirror the `makeCtx` shape used in `repeaterAdmin.test.ts`, but `requestOrNull` returns the frame). Add imports as needed (`getChannel`, `createChannelsRuntime`, `RESP`, `SessionState`, `MeshCoreEvents`, `noopLogger`, etc.):

```ts
import { getChannel } from '../../src/features/channels';

function channelInfoFrame(idx: number, name: string, keyHex: string): Buffer {
  const f = Buffer.alloc(50);
  f[0] = 0x12; // RESP_CHANNEL_INFO
  f[1] = idx;
  Buffer.from(name, 'utf8').copy(f, 2);
  Buffer.from(keyHex, 'hex').copy(f, 34);
  return f;
}

describe('channels: getChannel', () => {
  it('resolves the decoded Channel and updates state when a slot is present', async () => {
    const frame = channelInfoFrame(2, 'Public', 'ab'.repeat(16));
    const events = new MeshCoreEvents();
    const state = new SessionState();
    const ctx = {
      requestOrNull: async () => frame,
      events,
      state,
      log: noopLogger,
      rt: { channels: createChannelsRuntime() },
    } as unknown as FeatureContext;

    const ch = await getChannel(ctx, 2);
    expect(ch).toMatchObject({ key: 'ch:Public', name: 'Public', kind: 'public', idx: 2 });
    expect(state.getChannels()).toHaveLength(1);
  });

  it('resolves null for an empty slot (requestOrNull → null)', async () => {
    const ctx = {
      requestOrNull: async () => null,
      events: new MeshCoreEvents(),
      state: new SessionState(),
      log: noopLogger,
      rt: { channels: createChannelsRuntime() },
    } as unknown as FeatureContext;
    expect(await getChannel(ctx, 5)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/features/channels.test.ts -t "getChannel"`
Expected: FAIL — `getChannel` not exported.

- [ ] **Step 3: Implement `getChannel`**

In `src/features/channels.ts`, add after `applyChannelInfo`:

```ts
/** Actively re-query a single channel slot (CMD_GET_CHANNEL) and apply the
 *  reply. Resolves the decoded Channel, or null for an empty/missing slot
 *  (RESP_ERR). Uses requestOrNull so an empty-slot RESP_ERR is consumed via the
 *  ack FIFO instead of being mistaken for a rejected send. */
export async function getChannel(ctx: FeatureContext, idx: number): Promise<Channel | null> {
  const frame = await ctx.requestOrNull(encodeGetChannel(idx), RESP.CHANNEL_INFO);
  if (!frame) return null;
  return applyChannelInfo(ctx, frame);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/features/channels.test.ts -t "getChannel" && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/features/channels.ts tests/features/channels.test.ts
git commit -m "feat: channels.getChannel (active single-slot re-fetch)"
```

---

## Task 7: #5c — Sync mutex + wrap the handshake

**Files:**
- Modify: `src/session/session.ts`
- Test: `tests/session/getters.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/session/getters.test.ts`:

```ts
import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { makeSession } from '../support/harness';

describe('session: withSyncLock serialization', () => {
  it('runs getSelfInfo calls one at a time (second waits for the first)', async () => {
    const { session, transport } = makeSession();
    const order: string[] = [];

    // RESP_SELF_INFO: [0x05][adv_type][tx][max_tx][32B pubkey][name...]
    const selfInfo = (name: string, pk: string) => {
      const f = Buffer.alloc(36 + name.length);
      f[0] = 0x05;
      Buffer.from(pk, 'hex').copy(f, 4);
      Buffer.from(name, 'utf8').copy(f, 36);
      return f;
    };

    const p1 = session.getSelfInfo().then((r) => order.push(`done:${r.name}`));
    // Only one APP_START should be in flight; the second call is queued behind the lock.
    const p2 = session.getSelfInfo().then((r) => order.push(`done:${r.name}`));

    // Let microtasks settle: exactly one APP_START (0x01) written so far.
    await Promise.resolve();
    const appStarts = () => transport.sent.filter((b) => b[0] === 0x01).length;
    expect(appStarts()).toBe(1);

    // Answer the first; the lock releases and the second writes its APP_START.
    transport.receive(selfInfo('first', 'aa'.repeat(32)));
    await Promise.resolve();
    await Promise.resolve();
    expect(appStarts()).toBe(2);

    transport.receive(selfInfo('second', 'bb'.repeat(32)));
    await Promise.all([p1, p2]);
    expect(order).toEqual(['done:first', 'done:second']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/session/getters.test.ts -t "withSyncLock"`
Expected: FAIL — `getSelfInfo` is not a function (added in Task 8) / mutex absent. (This test is finalized in Task 8; for now it fails on the missing method.)

- [ ] **Step 3: Add the mutex + wrap the handshake**

In `src/session/session.ts`, add the field near the other private waiter fields (≈ line 152, by `syncProgress`):

```ts
  /** Serializes device-sync operations (handshake + active re-fetch getters)
   *  that share the single-use armWaiter slots and the typed-reply FIFO. */
  private syncLock: Promise<unknown> = Promise.resolve();
```

Add the helper next to `armWaiter` (≈ line 622):

```ts
  /** Run `fn` once the previous sync operation settles, so concurrent
   *  handshake/getContacts/getChannels/getSelfInfo calls don't clobber the
   *  shared waiter slots. Errors propagate to the caller but never poison the
   *  lock for the next operation. */
  private withSyncLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.syncLock.then(fn, fn);
    this.syncLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
```

Wrap the handshake: rename the existing `private async handshake(): Promise<void> {` (≈ line 624) to `private async handshakeInner(): Promise<void> {`, and add a wrapper:

```ts
  private handshake(): Promise<void> {
    return this.withSyncLock(() => this.handshakeInner());
  }
```

(The two existing `void this.handshake()` call sites at ≈ lines 227 and 495 stay unchanged.)

- [ ] **Step 4: Defer running this test until Task 8**

The serialization test depends on `getSelfInfo` from Task 8. Proceed to Task 8; this test runs green there.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
Expected: no type errors (the test file references `getSelfInfo`, which is fine — tests aren't typechecked by `tsc --noEmit` of `src`; if your `tsconfig` includes tests, this step's commit moves with Task 8 instead).

```bash
npm run format
git add src/session/session.ts
git commit -m "feat: sync mutex (withSyncLock) serializing handshake + getters"
```

---

## Task 8: #5d — Active re-fetch getters on the session

**Files:**
- Modify: `src/session/session.ts`
- Test: `tests/session/getters.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/session/getters.test.ts`:

```ts
import { CMD } from '../../src/codes';

describe('session: getChannel / getChannels (active re-fetch)', () => {
  const channelInfo = (idx: number, name: string, keyHex: string) => {
    const f = Buffer.alloc(50);
    f[0] = 0x12;
    f[1] = idx;
    Buffer.from(name, 'utf8').copy(f, 2);
    Buffer.from(keyHex, 'hex').copy(f, 34);
    return f;
  };

  it('getChannel resolves a present slot and updates state', async () => {
    const { session, transport } = makeSession();
    const p = session.getChannel(0);
    transport.receive(channelInfo(0, 'Public', 'cc'.repeat(16)));
    const ch = await p;
    expect(ch).toMatchObject({ name: 'Public', idx: 0 });
    expect(transport.sent.some((b) => b[0] === CMD.GET_CHANNEL && b[1] === 0)).toBe(true);
  });

  it('getChannels enumerates all slots and returns present channels', async () => {
    const present = new Map<number, Buffer>([
      [0, channelInfo(0, 'Public', 'cc'.repeat(16))],
      [3, channelInfo(3, '#region', 'dd'.repeat(16))],
    ]);
    // Auto-respond to each GET_CHANNEL as it is sent (waiter is registered first).
    const transport = new (class extends (await import('../../src/index.js')).LoopbackTransport {
      async send(bytes: Uint8Array): Promise<void> {
        await super.send(bytes);
        const buf = Buffer.from(bytes);
        if (buf[0] === CMD.GET_CHANNEL) {
          const reply = present.get(buf[1]);
          this.receive(reply ?? Uint8Array.from([0x01, 0x02])); // RESP_ERR NOT_FOUND for empty
        }
      }
    })();
    const session = new (await import('../../src/index.js')).MeshCoreSession({ transport });
    session.start();

    const channels = await session.getChannels();
    expect(channels.map((c) => c.name).sort()).toEqual(['#region', 'Public']);
  });
});

describe('session: getContacts (active re-fetch)', () => {
  it('re-issues GET_CONTACTS and resolves the contact list', async () => {
    const { session, transport } = makeSession();
    const p = session.getContacts();

    // RESP_CONTACTS_START [0x02][count u32 LE]
    const start = Buffer.alloc(5);
    start[0] = 0x02;
    start.writeUInt32LE(1, 1);
    transport.receive(start);

    // One RESP_CONTACT (148-byte record): [0x03][32B pubkey][type][flags][64B path][32B name ...]
    const contact = Buffer.alloc(148);
    contact[0] = 0x03;
    Buffer.from('ee'.repeat(32), 'hex').copy(contact, 1);
    contact[33] = 0; // type chat
    Buffer.from('Alice', 'utf8').copy(contact, 99); // name field offset (pubkey 1..33, type 33, flags 34, path 35..99)
    transport.receive(contact);

    // RESP_END_OF_CONTACTS [0x04][lastmod u32 LE]
    transport.receive(Buffer.from([0x04, 0, 0, 0, 0]));

    const contacts = await p;
    expect(transport.sent.some((b) => b[0] === CMD.GET_CONTACTS)).toBe(true);
    expect(contacts.some((c) => c.name === 'Alice')).toBe(true);
  });
});
```

> Note: the RESP_CONTACT byte layout above must match `decodeContact` in `src/features/contacts.ts`. Before writing this test, open that decoder and align the `type`/`flags`/`path`/`name` offsets and the `name` placement exactly; adjust the buffer in the test to whatever the decoder reads. (The decoder is the source of truth — do not guess.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/session/getters.test.ts`
Expected: FAIL — `getChannel`/`getChannels`/`getContacts`/`getSelfInfo` not functions.

- [ ] **Step 3: Implement the getters**

In `src/session/session.ts`:

Add imports — `applySelfInfo` + `SelfInfo` from selfInfo, and `Contact`/`Channel` types if not already imported:

```ts
import { applySelfInfo, encodeAppStart, selfInfoFeature, type SelfInfo } from '../features/selfInfo';
```
(extend the existing `import { encodeAppStart, selfInfoFeature } from '../features/selfInfo';` line). Ensure `RESP` is imported from `../codes` and `Contact`, `Channel` from `../types` (add to existing type imports if missing).

Add the methods in the user-facing command surface (e.g. right after `getContactByKey` ≈ line 934). `getSelfInfo` reads `this.appName`/`this.appVersion` (existing fields):

```ts
  /** Actively re-query the radio's self-info (APP_START → RESP_SELF_INFO),
   *  publish it as the Owner, and return it. */
  async getSelfInfo(): Promise<SelfInfo> {
    return this.withSyncLock(async () => {
      const frame = await this.request(encodeAppStart(this.appName, this.appVersion), { expect: RESP.SELF_INFO });
      const info = applySelfInfo(this.ctx, frame);
      if (!info) throw new Error('failed to decode self-info');
      return info;
    });
  }

  /** Actively re-enumerate the radio's contact store (GET_CONTACTS) and resolve
   *  the fresh list. Reuses the handshake's contact-stream waiters. */
  async getContacts(): Promise<Contact[]> {
    return this.withSyncLock(async () => {
      const start = this.armWaiter('contactsStartWaiter', CONTACTS_START_WAIT_MS);
      const done = this.armWaiter('contactsDoneWaiter', CONTACTS_DONE_WAIT_MS);
      await this.writeFrame(encodeGetContacts());
      await start;
      await done;
      return this.state.getContacts();
    });
  }

  /** Actively re-enumerate channel slots (GET_CHANNEL 0..N-1) and resolve the
   *  fresh list. */
  async getChannels(): Promise<Channel[]> {
    return this.withSyncLock(async () => {
      for (let i = 0; i < CHANNEL_SLOT_COUNT; i += 1) {
        await channels.getChannel(this.ctx, i);
      }
      return this.state.getChannels();
    });
  }

  /** Actively re-query a single channel slot. */
  async getChannel(idx: number): Promise<Channel | null> {
    return this.withSyncLock(() => channels.getChannel(this.ctx, idx));
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/session/getters.test.ts`
Expected: PASS (serialization test from Task 7 + the getter tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
Expected: no type errors.

```bash
npm run format
git add src/session/session.ts tests/session/getters.test.ts
git commit -m "feat: active re-fetch getters (getSelfInfo/getContacts/getChannels/getChannel)"
```

---

## Task 9: #5e — Find helpers

**Files:**
- Modify: `src/session/session.ts`
- Test: `tests/session/getters.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/session/getters.test.ts`:

```ts
describe('session: find helpers', () => {
  const channelInfo = (idx: number, name: string, keyHex: string) => {
    const f = Buffer.alloc(50);
    f[0] = 0x12;
    f[1] = idx;
    Buffer.from(name, 'utf8').copy(f, 2);
    Buffer.from(keyHex, 'hex').copy(f, 34);
    return f;
  };

  it('findChannelByName / findChannelBySecret match seeded channels', () => {
    const { session, transport } = makeSession();
    transport.receive(channelInfo(0, 'Public', 'ab'.repeat(16)));
    expect(session.findChannelByName('Public')?.idx).toBe(0);
    expect(session.findChannelByName('Nope')).toBeNull();
    expect(session.findChannelBySecret('AB'.repeat(16))?.name).toBe('Public'); // case-insensitive
    expect(session.findChannelBySecret('00'.repeat(16))).toBeNull();
  });

  it('findContactByPublicKeyPrefix matches a seeded contact (case-insensitive)', () => {
    const { session, transport } = makeSession();
    const start = Buffer.alloc(5);
    start[0] = 0x02;
    start.writeUInt32LE(1, 1);
    transport.receive(start);
    const contact = Buffer.alloc(148);
    contact[0] = 0x03;
    Buffer.from('ee'.repeat(32), 'hex').copy(contact, 1);
    Buffer.from('Bob', 'utf8').copy(contact, 99); // align with decodeContact (see Task 8 note)
    transport.receive(contact);
    transport.receive(Buffer.from([0x04, 0, 0, 0, 0]));

    expect(session.findContactByName('Bob')?.publicKeyHex).toBe('ee'.repeat(32));
    expect(session.findContactByPublicKeyPrefix('EEEE')?.name).toBe('Bob');
    expect(session.findContactByPublicKeyPrefix('ffff')).toBeNull();
  });
});
```

> Same caveat as Task 8: align the RESP_CONTACT buffer with `decodeContact`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/session/getters.test.ts -t "find helpers"`
Expected: FAIL — `findChannelByName` etc. not functions.

- [ ] **Step 3: Implement the find helpers**

In `src/session/session.ts`, add near the other read accessors (e.g. after `getContactByKey`):

```ts
  /** Find a contact in current session state by exact display name, or null. */
  findContactByName(name: string): Contact | null {
    return this.state.getContacts().find((c) => c.name === name) ?? null;
  }

  /** Find a contact whose public key starts with the given hex prefix
   *  (case-insensitive), or null. */
  findContactByPublicKeyPrefix(prefixHex: string): Contact | null {
    const p = prefixHex.toLowerCase();
    return this.state.getContacts().find((c) => c.publicKeyHex.toLowerCase().startsWith(p)) ?? null;
  }

  /** Find a channel in current session state by exact name, or null. */
  findChannelByName(name: string): Channel | null {
    return this.state.getChannels().find((c) => c.name === name) ?? null;
  }

  /** Find a channel by its 16-byte secret (hex, case-insensitive), or null. */
  findChannelBySecret(secretHex: string): Channel | null {
    const s = secretHex.toLowerCase();
    return this.state.getChannels().find((c) => (c.secretHex ?? '').toLowerCase() === s) ?? null;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/session/getters.test.ts -t "find helpers" && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/session/session.ts tests/session/getters.test.ts
git commit -m "feat: find helpers (findContactByName/PublicKeyPrefix, findChannelByName/BySecret)"
```

---

## Task 10: Full verification

- [ ] **Step 1: Run the whole suite, typecheck, lint, build**

Run:
```bash
npm test && npm run typecheck && npm run lint && npm run build
```
Expected: all tests PASS; no type errors; biome clean; build succeeds.

- [ ] **Step 2: Fix any fallout, then final commit (if any changes)**

```bash
npm run format
git add -A
git commit -m "chore: lint/format fixups for feature-parity work"
```

---

## Self-Review (completed during planning)

- **Spec coverage:** #2 → Task 1; #3 → Task 2; #4 → Tasks 3-4; #5 (apply* refactor) → Task 5; #5 (getChannel fn) → Task 6; #5 (mutex) → Task 7; #5 (getters) → Task 8; #5 (find helpers) → Task 9. All four spec items covered.
- **Type consistency:** `AvgMinMaxResult`/`AvgMinMaxSeries` defined in Task 3, consumed in Task 4 and the session method. `applySelfInfo`/`applyChannelInfo` defined in Task 5, consumed in Tasks 6 & 8. `getChannel(ctx, idx)` defined in Task 6, used in Task 8. `withSyncLock` defined in Task 7, used in Task 8. `Contact`/`Channel` field names (`name`, `publicKeyHex`, `secretHex`, `idx`) verified against `src/types.ts`.
- **Known risk flagged:** the RESP_CONTACT byte layout in Tasks 8-9 must be aligned with `decodeContact` in `src/features/contacts.ts` (noted inline) — the decoder is the source of truth.
- **Placeholders:** none — every code step shows complete code.
