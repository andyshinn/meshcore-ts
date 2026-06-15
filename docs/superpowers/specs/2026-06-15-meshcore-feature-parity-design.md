# MeshCore.js Feature Parity — Design

**Date:** 2026-06-15
**Status:** Approved
**Scope:** Close four feature gaps in `meshcore-ts` relative to the reference
`@liamcottle/meshcore.js` (v1.13.0): #2 hashtag region-key derivation, #3 generic
binary request, #4 `GetAvgMinMax` telemetry, #5 active re-fetch getters + find
helpers.

## Background

`meshcore-ts` is a TypeScript port of `@liamcottle/meshcore.js`. At the command
level it is already a superset of the reference (it implements ~30 CMD opcodes the
JS library lacks, and its CayenneLPP decoder covers more types). A gap analysis
surfaced four behaviors the reference provides that the port did not. This design
closes all four while matching the port's existing architecture:

- Features are pure functions over a `FeatureContext` (`src/feature.ts`); they
  export `encode*`/`decode*` and session-facing functions.
- `MeshCoreSession` (`src/session/session.ts`) delegates each public method to a
  feature function: `async setFloodScopeKey(input) { return floodScope.setFloodScopeKey(this.ctx, input); }`.
- The inbound router (`src/session/session.ts:444-487`) dispatches a frame in
  three tiers: (1) solicited typed replies (`ctx.request` with `expect`) get
  first crack **and `return`** — so they BYPASS the feature handler; (2)
  code-owned frames go to their feature; (3) the shared RESP_OK/RESP_ERR ack FIFO.
- Tests are vitest, per-feature under `tests/features/`, with a `LoopbackTransport`
  harness at `tests/support/harness.ts`.

## #2 — Hashtag region-key derivation

The reference exposes `TransportKeyUtil.getHashtagRegionKey(regionName)`: prepend
`#` if missing, SHA-256 the UTF-8 bytes, return the 32-byte hash. Callers slice
the first 16 bytes for the flood-scope key. The port's flood-scope APIs
(`setFloodScopeKey`, `setDefaultFloodScope`) already take a 16-byte `keyHex`.

**Design:** add a pure helper and a convenience setter in
`src/features/floodScope.ts`.

```ts
// Prepend '#' if absent, SHA-256 the UTF-8 bytes, return the FIRST 16 bytes as hex.
export function deriveFloodScopeKey(region: string): string;
```

- Returns the 16-byte flood-scope key hex (first half of the SHA-256), ready to
  pass to `setFloodScopeKey({ keyHex })` / `setDefaultFloodScope(name, keyHex)`.
- Normalizes by prepending `#` when missing (matches the reference).
- Uses `node:crypto` `createHash('sha256')`, consistent with `channels.ts:46`.

Session convenience:

```ts
async setFloodScopeRegion(region: string): Promise<void>; // derive + setFloodScopeKey({ keyHex })
```

## #3 — Generic `sendBinaryRequest`

The internal `sendBinaryReq(ctx, contactKey, reqData)` (`repeaterAdmin.ts:161`)
already issues `CMD_SEND_BINARY_REQ`, parks an awaiter on the matching
`PUSH_BINARY_RESPONSE` tag, and resolves the response body. Promote it to public.

**Design:**

```ts
// session
async sendBinaryRequest(contactKey: string, reqData: Buffer, opts?: { timeoutMs?: number }): Promise<Buffer>;
```

- `reqData` = `[REQ_TYPE byte, ...params]` — same shape as the reference's
  `requestCodeAndParams`.
- Returns the raw response body (bytes after the tag), exactly what the internal
  helper resolves today.
- Existing `repeaterRequestAcl`/`Neighbours`/`OwnerInfo` keep delegating to the
  same internal helper — no behavior change. The internal `sendBinaryReq` gains an
  optional `timeoutMs` parameter (defaults to the current `ADMIN_REPLY_TIMEOUT_MS`).

## #4 — `GetAvgMinMax` (reverse-engineered from firmware)

The reference only defines the `GetAvgMinMax = 0x04` constant — no method, no
parser. The wire format was reverse-engineered from the firmware at
`MeshCore/examples/simple_sensor/SensorMesh.cpp`.

**Request** (`SensorMesh.cpp:189-202`) — `reqData`:

```
[0x04][start_secs_ago u32 LE][end_secs_ago u32 LE][res1=0][res2=0]   // 11 bytes
```

`res1`/`res2` must both be 0 or the firmware returns no series data.

**Response body** (`SensorMesh.cpp:204-221`), after the companion strips the
4-byte tag (the reflected `sender_timestamp`):

```
[now u32 LE]                                   // repeater's current RTC time
then N × entries:
  [channel u8][lpp_type u8][min][max][avg]     // each of min/max/avg is `size` BE bytes
```

Each min/max/avg is decoded by the firmware's `getFloat` (`SensorMesh.cpp:133-148`):
read `size` bytes big-endian into an unsigned int; if the type is signed and the
top bit is set, apply two's-complement; value = sign × raw / multiplier.

The firmware's `getDataSize`/`getMultiplier`/`isSigned` tables
(`SensorMesh.cpp:76-131`) differ subtly from standard CayenneLPP — notably
**Current (0x75) is UNSIGNED** here, whereas the telemetry-decode path
(`CAYENNE_TYPES` in `repeater.ts`) treats it as signed. Therefore this feature
adds a **dedicated firmware-faithful descriptor table** (size / multiplier /
signed) plus a `getFloat`-equivalent decoder in `repeater.ts` rather than reusing
`CAYENNE_TYPES`. Names and units are borrowed from `CAYENNE_TYPES` where present.

Firmware tables to mirror:
- size: GPS=9, POLYLINE=8, GYROMETER/ACCELEROMETER=6, GENERIC/FREQUENCY/DISTANCE/
  ENERGY/UNIXTIME=4, COLOUR=3, ANALOG_IN/OUT, LUMINOSITY, TEMPERATURE,
  CONCENTRATION, BAROMETRIC, HUMIDITY, ALTITUDE, VOLTAGE, CURRENT, DIRECTION,
  POWER=2, else 1.
- multiplier: CURRENT/DISTANCE/ENERGY=1000, VOLTAGE/ANALOG_IN/OUT=100,
  TEMPERATURE/BAROMETRIC/HUMIDITY=10, else 1.
- signed: ALTITUDE, TEMPERATURE, GYROMETER, ANALOG_IN/OUT, GPS, ACCELEROMETER.

Multi-axis types (GPS/accelerometer/gyrometer/colour) are decoded as the firmware
does — a single big-endian integer over `size` bytes — since the series API stores
one scalar per min/max/avg. Realistic series data is scalar sensors.

**Design:**

```ts
// codes.ts
REQ_TYPE.GET_AVG_MIN_MAX = 0x04;

// session
async repeaterRequestAvgMinMax(
  contactKey: string,
  opts: { startSecsAgo: number; endSecsAgo: number },
): Promise<AvgMinMaxResult>;

interface AvgMinMaxSeries {
  channel: number;
  lppType: number;
  typeHex: string;   // e.g. "0x67"
  name: string;      // from CAYENNE_TYPES, else "Unknown"
  unit?: string;
  min: number;
  max: number;
  avg: number;
}

interface AvgMinMaxResult {
  nowUnix: number;
  series: AvgMinMaxSeries[];
}
```

Built on the generic binary-request path (#3): the request goes through
`sendBinaryReq`, and the response body is parsed by a new `parseAvgMinMax(body)`
in `repeater.ts`. An unknown `lpp_type` is decoded at the firmware's default size
of 1 byte (matching `getDataSize`'s fallback) with `name: "Unknown"`, so the
parser stays in frame; parsing stops only when the remaining buffer is too short
for the current entry.

## #5 — Active re-fetch getters + find helpers

The reference's `getContacts()`/`getChannels()`/`getChannel()`/`getSelfInfo()`
actively re-query the device. The port syncs that data during the connect-time
handshake and holds it in `state`, emitting events on change. Decision (approved):
implement **active re-fetch** semantics — the getters re-issue the device commands,
update state, emit events, and resolve fresh data.

### Find helpers (synchronous, over `state`)

No device round-trip; thin wrappers over `state.getContacts()` / `state.getChannels()`:

```ts
findContactByName(name: string): Contact | null;
findContactByPublicKeyPrefix(prefixHex: string): Contact | null;  // case-insensitive startsWith
findChannelByName(name: string): Channel | null;
findChannelBySecret(secretHex: string): Channel | null;           // case-insensitive equality
```

### Active re-fetch (async)

```ts
async getSelfInfo(): Promise<SelfInfo>;
async getContacts(): Promise<Contact[]>;
async getChannels(): Promise<Channel[]>;
async getChannel(idx: number): Promise<Channel | null>;
```

**The bypass problem.** Typed replies consumed via `ctx.request({expect})` /
`ctx.requestOrNull(expect)` `return` before the feature handler runs
(`session.ts:451-467`), so a naive re-fetch would not update `state` or emit
events. Fix: **factor each feature handler body into a reusable `apply*`
function** called by both the feature handler and the getter.

- `applySelfInfo(ctx, frame): SelfInfo | null` in `selfInfo.ts`. `getSelfInfo`
  does `request(encodeAppStart(...), { expect: RESP.SELF_INFO })` then
  `applySelfInfo` (so `owner` still emits). The `selfInfoFeature.handle` body
  becomes a call to `applySelfInfo`.
- `applyChannelInfo(ctx, frame): Channel | null` in `channels.ts`. `getChannel`
  does `requestOrNull(encodeGetChannel(idx), RESP.CHANNEL_INFO)` then
  `applyChannelInfo`; returns the decoded channel or null (RESP_ERR → null →
  empty slot). `getChannels` loops idx `0..CHANNEL_SLOT_COUNT-1` over `getChannel`
  and returns `state.getChannels()`. The `channelsFeature.handle` body becomes a
  call to `applyChannelInfo`.
- `getContacts` reuses the existing handshake plumbing: arm
  `contactsStartWaiter` + `contactsDoneWaiter` (via `armWaiter`), write
  `encodeGetContacts()`, await both waiters, return `state.getContacts()`. The
  contacts feature handles the CONTACTS_START / CONTACT×N / END_OF_CONTACTS
  stream and emits `contacts` as it does during handshake.

### Concurrency — sync mutex

`armWaiter` slots are single-use ("re-arming overwrites") and the typed-reply
FIFO is shared. A re-fetch overlapping the connect-time handshake (or another
re-fetch) would clobber waiters or steal frames. Introduce a promise-chain mutex:

```ts
private syncLock: Promise<unknown> = Promise.resolve();
private withSyncLock<T>(fn: () => Promise<T>): Promise<T>;
```

`handshake()`, `getContacts()`, `getChannels()`, `getChannel()`, and
`getSelfInfo()` all run inside `withSyncLock`. A getter called during the
handshake waits for it to finish, then runs. (`getChannels` takes the lock once
and calls an unlocked internal `getChannelInner` per slot to avoid self-deadlock.)

## Testing

Per-feature vitest suites, following existing patterns in `tests/features/` and
the `LoopbackTransport` harness:

- `floodScope.test.ts`: extend with `deriveFloodScopeKey` known-answer vectors
  (verify `#region` normalization and 16-byte truncation against a computed
  SHA-256), and `setFloodScopeRegion` emits the expected frame.
- `repeaterAdmin.test.ts`: `sendBinaryRequest` round-trips a request + tagged
  response; `repeaterRequestAvgMinMax` builds the 11-byte request and parses a
  synthesized response (cover a signed type, an unsigned-but-scaled type like
  Current, and a multi-byte type) including the leading `now` timestamp.
- `repeater.test.ts`: unit-test `parseAvgMinMax` directly with hand-built buffers.
- `session.core.test.ts` / `commands.test.ts`: find helpers return matches/null;
  active getters re-issue the right frames, update state, emit events, and
  serialize under `withSyncLock` (a getter awaiting an in-flight sync).

## Out of scope

- Bundled transport implementations (the port is transport-agnostic by design).
- Decoding POLYLINE (0xF0 / 240) in either telemetry path (neither library does).
- Changing existing telemetry (`CAYENNE_TYPES`) signedness to match the firmware's
  series tables — the two paths legitimately differ; only the new AvgMinMax path
  uses the firmware-faithful table.
