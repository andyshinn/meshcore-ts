# meshcore-ts Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the MeshCore companion-protocol layer from the `coresense` Electron app into a standalone, application-agnostic, zero-runtime-dependency TypeScript library (`meshcore-ts`) exposing a stateful `MeshCoreSession` class with injected ports.

**Architecture:** Node-only ESM (`node:buffer`/`node:crypto`). The protocol layer is inverted from app singletons (event bus / state holder / transport manager / tslog) into four injected ports (Transport, Logger, Events, in-memory State). Per-session mutable state that today lives at module scope (FIFO queues, iterators, admin awaiters) moves onto a per-session `FeatureContext`, so the library is truly multi-instance and persists nothing. The existing `Feature`/`FeatureRegistry` extension model is preserved. The vitest suite is ported alongside each module as the safety net.

**Tech Stack:** TypeScript (ES2022, strict, no DOM), tsup (ESM + CJS + `.d.ts`), vitest, biome. **Zero runtime dependencies** — confirmed the protocol layer uses neither `@michaelhart/meshcore-decoder` nor `zustand`; crypto is `node:crypto`, logging becomes a no-op-default `Logger` interface (not tslog).

---

## 0. Decisions flagged for your review

These materially branch the implementation. My recommendation is first; rationale follows. **Verified against source** — several correct the original spec.

### D1 — Feature scope (spec under-listed)
The spec named ~11 features. The donor actually registers/uses **24** protocol feature modules, **all pure MeshCore protocol** (no app/UI logic): the spec's 11 **plus** `channels`, `channelMessages`, `directMessages`, `repeaterAdmin`, `deviceAdmin`, `pathDiagnostics`, `rawData`, `drain` (registered handlers) and `signing`, `tuning`, `floodScope`, `misc`, `contactInterop` (directly-called utilities).
**Recommendation: port the full registered feature set.** Channels/DMs/repeater-admin are the heart of a MeshCore companion library and the test suite covers them. Excluding them would gut the library.

### D2 — Singleton → per-session refactor (mandated by "not module singletons")
Features import `emit`/`stateHolder`/`child`/`discoveredStore`/`adminSessions` **at module scope** and hold module-level mutable state (DM FIFO, contacts iterator, drain flags, admin awaiters, path-discovery slot, key-export FIFO, mesh-observation buffer, pending-channel-sends).
**Recommendation: extend `FeatureContext` into a rich per-session context** carrying the injected ports + state model + per-feature mutable sub-state. Feature functions (which already take `ctx` as first arg) read deps/state from `ctx` instead of module imports. The FIFO/queue/correlation logic is relocated **verbatim** — only its home changes. This is the central, mechanical refactor and the only option that satisfies "injected dependencies, NOT module singletons."

### D3 — Transport framing contract (spec's mental model vs donor reality)
The spec says the library should "own companion-frame framing... how raw bytes are assembled into frames." **Reality:** the donor has **no byte-stream reassembler.** BLE delivers exactly one complete companion frame per GATT notification; `companionFrame.ts` only *classifies* a complete frame (mesh `0x84`/`0x88` vs companion) — and serial is an unimplemented stub.
**Recommendation: port `parseCompanionFrame` as the library's frame parser, and define the Transport contract as "each `onData(chunk)` delivers one complete companion frame"** (exactly what BLE does and what the fixtures assume). Provide an optional `FrameReader` helper stub for byte-stream transports (serial/TCP) to opt into later. True length-delimited serial framing is **not** in the donor; building it now is net-new scope. (Alternative: build a length-prefixed reassembler now — more scope, unverifiable against donor behavior.)

### D4 — Contact/Channel UI-field carve
`Contact` and `Channel` mix wire-derived fields with UI ornamentation. UI-only fields are already optional.
**Recommendation: drop pure-UI fields** `Channel.pinned`, `Channel.muted`, `Channel.order`, `Contact.pinned`, `Contact.muted`. **Keep** `Contact.favourite` (maps to firmware contact flag bit 0 — protocol-meaningful) and all path/gps/seen fields. (Alternative: keep them as optional pass-through — harmless but UI-shaped.)

### D5 — `AutoAddConfig` app-side fields
`AutoAddConfig` carries `mode`/`maxHops` (drive the contacts feature's pre-upsert hop filtering — **protocol-relevant, keep**) and `pullToRefresh`/`showPublicKeys` (pure UI — **drop**). Recommendation: keep the type, drop the two UI-only booleans. (Verify `maxHops`/`mode` usage in `contacts.ts` during the port; keep only what the feature reads.)

### D6 — Repeater type duplication
`repeater.ts` defines wire-parse types (`LoginSuccess`, `AclEntry`, `NeighboursPage`, `OwnerInfo`, `TraceData`, `LocalStats`, `StatusResponse`, `TelemetryResponse`) and `shared/types.ts` defines near-duplicate UI/event shapes (`RepeaterLoginResult`, `RepeaterAclEntry`, `RepeaterNeighboursPage`, `RepeaterOwnerInfo`, `RepeaterTrace`, `RepeaterLocalStats`, `RepeaterStatusSnapshot`, `RepeaterTelemetrySnapshot`).
**Recommendation: keep `repeater.ts`'s types as the canonical wire types** (co-located with their parsers) and keep **only the event-payload snapshot types** (`RepeaterStatusSnapshot`, `RepeaterTelemetrySnapshot`, `PathLearnedEvent`) in `types.ts`. Drop the redundant `shared/types.ts` `Repeater*` mirrors in favor of re-exporting the `repeater.ts` versions.

### D7 — Internal coordination events stay internal
The donor uses internal bus events `packet` (raw inbound) and `contactsSync` (handshake↔contacts-iterator coordination). Neither is in your public keep-list.
**Recommendation: keep both internal.** `packet` is replaced by `Transport.onData` → frame ingest → dispatch. `contactsSync` becomes an internal callback the contacts feature invokes on the context (drives the handshake's start/done waiters + `syncProgress`), **not** a public event.

### D8 — `node:sqlite` message/blocking behavior
Messages are SQLite-backed and `holder.upsertMessage` applies **block-rule annotation**. The library keeps messages **in memory** and **drops blocking entirely**.
**Recommendation: reimplement the message merge/state-precedence behavior in memory** (the `stateRank` table, path-union-by-id, `timesHeard` bump, `ts` min, `sent→heard` advance — `holder.ts:243-325`) and **omit** all `annotateBlocked`/`isMessageBlocked`/`bumpMatchCount` paths. `MessageMeta.blocked`/`blockedByRuleId` fields are dropped.

---

## 1. Injected ports (new code — full definitions)

### 1.1 Transport — `src/ports/transport.ts`
```ts
export type TransportState = 'idle' | 'scanning' | 'connecting' | 'connected' | 'error';

export interface Transport {
  /** Write one complete companion frame to the radio. */
  send(bytes: Uint8Array): Promise<void>;
  /** Subscribe to inbound data. Each chunk is ONE complete companion frame
   *  (a BLE notification's payload). The library parses + dispatches it. */
  onData(cb: (chunk: Uint8Array) => void): void;
  /** Subscribe to connection-state transitions. */
  onStateChange(cb: (s: TransportState) => void): void;
  getState(): TransportState;
}

/** In-memory loopback transport for tests: queue inbound frames, capture sent. */
export class LoopbackTransport implements Transport { /* ... */ }
```
Notes: replaces `transport/manager.ts` + `ITransport`. The donor's connect/disconnect/scan stay the **consumer's** responsibility. `send` takes `Uint8Array`; internally the library converts to/from `node:Buffer`. The session calls `transport.send(frame)` (was `transportManager.getTransport().sendBytes`) and reads `transport.getState()` (was `transportManager.getState().state`).

### 1.2 Logger — `src/ports/logger.ts`
```ts
export interface Logger {
  trace(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
export const noopLogger: Logger = { trace(){}, debug(){}, info(){}, warn(){}, error(){} };
```
Replaces `log.ts`/tslog + `child('protocol')`. Optional in the constructor; defaults to `noopLogger`.

### 1.3 Events — `src/ports/events.ts`
A typed `EventEmitter` the library **owns** (not injected — the session exposes it via `session.events`). Port ONLY protocol-domain events; internal `packet`/`contactsSync` excluded.
```ts
export interface MeshCoreEventMap {
  transportState: (s: TransportState) => void;
  channels: (channels: Channel[]) => void;
  channelPresence: (keys: string[]) => void;
  syncProgress: (progress: SyncProgress) => void;
  contacts: (contacts: Contact[]) => void;
  discovered: (rows: DiscoveredContact[]) => void;
  contactEvicted: (name: string) => void;
  contactDiscovered: (c: { key: string; name: string; kind: ContactKind }) => void;
  messages: (key: string, messages: Message[]) => void;
  messageState: (id: string, state: MessageState) => void;
  messagePathHeard: (p: { id: string; path: MessagePath; state: MessageState }) => void;
  owner: (owner: Owner | null) => void;
  radioSettings: (settings: RadioSettings) => void;
  repeaterStatus: (snap: RepeaterStatusSnapshot) => void;
  repeaterTelemetry: (snap: RepeaterTelemetrySnapshot) => void;
  pathLearned: (event: PathLearnedEvent) => void;
  deviceIdentity: (identity: DeviceIdentity) => void;
  autoAddConfig: (cfg: AutoAddConfig) => void;
  telemetryPolicy: (policy: TelemetryPolicy) => void;
  gpsConfig: (cfg: GpsConfig) => void;
  deviceInfo: (info: DeviceInfo) => void;
  deviceCapabilities: (caps: DeviceCapabilities) => void;
  /** Replaces the app's `errorMessage` toast for protocol-level surfacing
   *  (e.g. CONTACTS_FULL). Optional — drop if you'd rather throw. */
  error: (message: string) => void;
}
export type MeshCoreEvents = TypedEmitter<MeshCoreEventMap>;
```
Implemented as a tiny typed wrapper over `node:events` `EventEmitter` (avoid the reserved `'error'`-throws-with-no-listener footgun, as the donor bus does). **Kept** = your keep-list. **Dropped** = `packet`, `scanResults`, `errorMessage`(→`error`), `menuAction`, `theme`, `appSettings`, `mapSettings`, `mapManifest`, `uiState`, `blockRules`, `log:entry`, `contactsSync`(internal).

### 1.4 In-memory State — `src/state/model.ts`
Replaces `state/holder.ts` + all sqlite/JSON stores. Plain in-memory model; **emits via the events port** on change; **never** persists.
```ts
export class SessionState {
  // collections
  getContacts(): Contact[]; setContacts(c: Contact[]): void;
  upsertContact(c: Contact): void; removeContact(key: string): void;
  getChannels(): Channel[]; setChannels(c: Channel[]): void;
  upsertChannel(c: Channel): void; removeChannel(key: string): void;
  // discovered pool (was storage/discoveredContacts.ts — now in-memory)
  listDiscovered(): DiscoveredContact[]; getDiscovered(pk: string): DiscoveredContact | null;
  upsertDiscovered(row: DiscoveredContact): void; setOnRadio(pk: string, v: boolean): void;
  setFavourite(pk: string, v: boolean): void; reconcileOnRadio(seenPks: string[]): void;
  // scalars
  getOwner(): Owner | null; setOwner(o: Owner | null): void;
  getRadioSettings(): RadioSettings; setRadioSettings(r: RadioSettings): void;  // incl. pathHashMode
  getDeviceInfo(): DeviceInfo; setDeviceInfo(d: DeviceInfo): void;
  getDeviceIdentity(): DeviceIdentity; setDeviceIdentity(d: DeviceIdentity): void;
  getDeviceCapabilities(): DeviceCapabilities; setDeviceCapabilities(c: DeviceCapabilities): void;
  getAutoAddConfig(): AutoAddConfig; setAutoAddConfig(c: AutoAddConfig): void;
  getTelemetryPolicy(): TelemetryPolicy; setTelemetryPolicy(p: TelemetryPolicy): void;
  getGpsConfig(): GpsConfig; setGpsConfig(c: GpsConfig): void;
  // messages (in-memory; merge logic ported from holder.ts:243-325, blocking dropped)
  getMessagesForKey(key: string, opts?: { limit?: number; before?: number }): Message[];
  getRecentMessages(limit?: number): Message[];
  insertMessage(m: Message): void;
  upsertMessage(m: Message): void;            // stateRank precedence + path union + timesHeard
  setMessageState(id: string, s: MessageState): void;
  appendMessagePath(id: string, p: MessagePath): MessageState | null;
}
```
Removed vs donor holder: `AppSettings`/`MapSettings`/`UiState`, all `BlockRule`/search/blocking, `getSearchBlockContext`. **`getBlockRules()` callers** (`contacts.ts`) are dropped — contact ingestion no longer block-filters.
Storage stripped entirely: `storage/messages.ts`, `storage/discoveredContacts.ts`, `storage/settings.ts`, `storage/search.ts`, `node:sqlite`, `blocking/*`, `map/*`.

---

## 2. Per-session context — `src/feature.ts` (extended) + `src/session/context.ts`

The existing `FeatureContext` (`writeFrame`/`request`/`requestOrNull`) is **extended** to be the per-session runtime handed to every feature:
```ts
export interface FeatureContext {
  // transport-facing capability (unchanged semantics — see §5 races)
  writeFrame(frame: Buffer): Promise<void>;
  request(frame: Buffer, opts?: { expect?: number; timeoutMs?: number }): Promise<Buffer>;
  requestOrNull(frame: Buffer, expect: number, timeoutMs?: number): Promise<Buffer | null>;
  // injected ports / model (NEW — replaces module singletons)
  readonly events: MeshCoreEvents;
  readonly state: SessionState;
  readonly log: Logger;
  readonly admin: AdminSessionStore;      // ported bridge/adminSession.ts
  // per-session mutable feature state (NEW — replaces module-level let/const)
  readonly rt: SessionRuntime;            // see below
}

/** Per-session mutable state, one object per feature that needs it. Replaces
 *  every module-level `let`/`const new Map()` inventoried below. */
export interface SessionRuntime {
  dm: DmState;                  // dmSendQueue[], pendingDmAcks Map, adminHooks
  contactsIter: ContactsIterState; // iterTotal/Count, syncSeen[], resyncTimer, pendingContactByKey[]
  drain: DrainState;            // drainBusy, drainPending
  adminCorr: AdminCorrState;    // adminSentQueue[], pendingCli Map, pendingLocalStats
  channels: ChannelsState;      // channelByIdx Map, devicePresence Set
  pathDisc: { pending: PendingDiscovery | null };
  deviceAdmin: { pendingExports: PendingExport[] };
  meshObs: { buf: MeshObservation[] };
  pendingChannelSends: { pending: PendingSend[] };
}
```
`Feature.handle(code, frame, ctx)` already receives `ctx` — features read `ctx.events`/`ctx.state`/`ctx.log`/`ctx.rt.*` instead of imported singletons. Session-facing feature functions already take `ctx` first. **The decoupling recipe per feature is purely:** swap `emit.x(...)` → `ctx.events.emit('x', ...)`, `stateHolder()` → `ctx.state`, `child('protocol')` → `ctx.log`, `discoveredStore` → `ctx.state` (discovered methods), `adminSessions` → `ctx.admin`, and module-`let`/`const` state → `ctx.rt.<feature>`. Reset functions (`resetDmState`, `resetContactsIter`, etc.) operate on `ctx.rt`.

### Module-level state inventory to relocate (verified)
| Feature | State → `ctx.rt.*` | Reset fn |
|---|---|---|
| contacts | `iterTotal/iterCount/syncSeen[]/resyncTimer/pendingContactByKey[]` | `resetContactsIter` |
| directMessages | `dmSendQueue[]/pendingDmAcks Map/adminHooks` | `resetDmState` |
| drain | `drainBusy/drainPending` | `resetDrain` |
| repeaterAdmin | `adminSentQueue[]/pendingCli Map/pendingLocalStats` (+`admin.reset`) | `resetAdmin` |
| channels | `channelByIdx Map/devicePresence Set` | `clearPresence`/`rebuildIndexes` |
| pathDiagnostics | `pendingDiscovery` | `resetPathDiagnostics` |
| deviceAdmin | `pendingExports[]` | `resetDeviceAdmin` |
| meshObservations | `buf[]` | (`_clear` test helper → `reset`) |
| pendingChannelSends | `pending[]` | (`_clear` test helper → `reset`) |
| selfInfo/deviceInfo/battStorage/customVars/autoAdd/channelMessages | none (pure handlers) | — |

Cross-feature deps stay as direct module imports of pure functions (e.g. `directMessages` → `contacts.encodeResetPath`, `drain.isDraining`; `channelMessages` → `channels.findIdxByKey`, `meshObservations.consumeMatching`) — those are stateless and just take `ctx`.

---

## 3. Public API — `MeshCoreSession` (`src/session/session.ts`)

Ported from `ProtocolSession`. Constructor takes injected deps; everything else mirrors the donor's method surface 1:1.
```ts
export interface MeshCoreSessionOptions {
  transport: Transport;
  logger?: Logger;                 // default noopLogger
  appName?: string;                // APP_START name; donor hardcoded 'coresense'
  appVersion?: number;             // default 1
}

export class MeshCoreSession {
  constructor(opts: MeshCoreSessionOptions);
  readonly events: MeshCoreEvents;       // subscribe here
  readonly state: SessionState;          // read-only snapshots

  // lifecycle (replaces bus.on('packet'/'transportState') with transport callbacks)
  start(): void;
  stop(): void;

  // snapshots
  getSyncProgress(): SyncProgress;
  getDevicePresence(): string[];

  // messaging
  sendChannelText(channelKey, text): Promise<{ ok; error?; channelHash? }>;
  sendDmText(contactKey, text, messageId, opts?): Promise<{ ok; error? }>;
  sendDmTextWithRetry(contactKey, text, messageId): Promise<{ ok; error? }>;

  // contacts / paths
  getContactByKey(pkHex): Promise<ContactRecord | null>;
  setContactPath(contactKey, outPathHex, opts?): Promise<void>;
  resetContactPath(contactKey): Promise<void>;
  addContactToRadio(pkHex): Promise<void>;
  removeContactFromRadio(pkHex): Promise<void>;
  setContactFavourite(pkHex, favourite): Promise<void>;
  setContactPreferDirect(contactKey, preferDirect): void;
  shareContact(pkHex): Promise<void>;
  exportContact(pkHex?): Promise<string | null>;
  importContact(blobHex): Promise<void>;

  // channels
  setChannel(idx, name, secretHex): Promise<boolean>;
  markChannelPresent(channel): void; markChannelAbsent(idx): void;
  pickFreeSlot(): number | null; deriveSecret(name): string;

  // radio / device settings
  setRadioParams(opts): Promise<boolean>;
  setPathHashMode(size): Promise<void>;
  setAdvertName(name): Promise<boolean>;
  setAdvertLatLon(lat, lon, alt?): Promise<boolean>;
  setOtherParams(policy, sharePositionInAdvert): Promise<boolean>;
  setAutoAddConfig(flags): Promise<boolean>; requestAutoAddConfig(): Promise<void>;
  setGpsConfig(cfg): Promise<boolean>;
  reboot(): Promise<{ ok; error? }>;
  getDeviceTime(): Promise<number>; setDeviceTime(s): Promise<void>; syncDeviceTime(): Promise<void>;
  requestBattAndStorage(): Promise<void>; requestDeviceInfo(): Promise<void>; requestCustomVars(key?): Promise<void>;
  getTuningParams(): Promise<TuningParams>; setTuningParams(p): Promise<void>;
  setFloodScopeKey(input): Promise<void>; setDefaultFloodScope(name, keyHex): Promise<void>;
  clearDefaultFloodScope(): Promise<void>; getDefaultFloodScope(): Promise<DefaultFloodScope | null>;
  hasConnection(pkHex): Promise<boolean>; getAllowedRepeatFreq(): Promise<RepeatFreqRange[]>;

  // device admin / signing
  exportPrivateKey(): Promise<string>; importPrivateKey(hex): Promise<void>;
  setDevicePin(pin): Promise<void>; factoryReset(): Promise<void>; signData(data): Promise<string>;

  // repeater admin
  sendStatusReq(contactKey): Promise<{ ok; error? }>; sendTelemetryReq(contactKey): Promise<{ ok; error? }>;
  repeaterLogin(contactKey, password): Promise<LoginSuccess & { mode; effective }>;
  repeaterLogout(contactKey): Promise<void>;
  repeaterRequestAcl(contactKey): Promise<AclEntry[]>;
  repeaterRequestNeighbours(contactKey, opts?): Promise<NeighboursPage>;
  repeaterRequestOwnerInfo(contactKey): Promise<OwnerInfo>;
  repeaterSendCli(contactKey, command): Promise<string>;
  repeaterTracePath(opts): Promise<TraceData>;
  repeaterGetLocalStats(subtype): Promise<LocalStats>;

  // path diagnostics / raw
  sendPathDiscoveryReq(contactKey): Promise<DiscoveredPath>;
  getAdvertPath(contactKey): Promise<AdvertPath | null>;
  sendRawData(opts): Promise<void>; sendControlData(payload): Promise<void>;
  sendChannelData(opts): Promise<void>; sendRawPacket(opts): Promise<void>;
  sendSelfAdvert(flood?): Promise<{ ok; error? }>;
}
```
**Inbound path moves into the session** (was in `ble.ts:314-382`): `transport.onData(chunk)` → `parseCompanionFrame` → if mesh `log_rx` & GRP_TXT: `parseMeshPacket` → record `MeshObservation` (sha1 fingerprint) + `attributeOutgoingChannelRelay`; if companion: `onPacket` dispatch (typed-reply queue → feature registry → RESP_OK/ERR ack FIFO). `transport.onStateChange` → connect runs `handshake()` + liveness poll; disconnect fails in-flight awaiters + resets all `ctx.rt` state.

---

## 4. Type ownership carve — `src/types.ts`

**KEEP (protocol):** `TransportState`, `RawPacket`, `SyncProgress`+`DEFAULT_SYNC_PROGRESS`, `ChannelKind`, `Channel`(carved), `ContactKind`, `PathHashSize`, `Contact`(carved), `MessageState`, `MessageHop`, `MessagePath`, `MessageMeta`(drop `blocked`/`blockedByRuleId`), `Message`, `Owner`, `RadioSettings`+default, `DeviceIdentity`+default, `DeviceInfo`+default, `DeviceCapabilities`+default, `AutoAddConfig`(carved)+default, `TelemetryPolicy`+default, `GpsConfig`+default, `RepeaterStatusSnapshot`, `RepeaterTelemetrySnapshot`, `PathLearnedEvent`. `hasValidFix()` helper kept (pure predicate). Repeater wire types come from `repeater.ts` (D6).

**Carve `Channel`:** keep `key,name,kind,secretHex,idx`; **drop** `muted,pinned,order`.
**Carve `Contact`:** keep `key,publicKeyHex,name,kind,lastSeenMs,rssi,snr,hops,favourite,outPathHex,outPathHashSize,preferDirect,pathManual,pathLearnedAt,gpsLat,gpsLon`; **drop** `pinned,muted`.
**Carve `AutoAddConfig`:** keep `mode,chat,repeater,room,sensor,overwriteOldest,maxHops`; **drop** `pullToRefresh,showPublicKeys` (verify `mode`/`maxHops` are read by `contacts.ts`; drop any that aren't).
**Carve `DiscoveredContact`** (`src/contacts/discovered.ts`): keep wire fields `key,publicKeyHex,name,kind,hops,outPathHex,outPathHashSize,gpsLat,gpsLon,lastAdvertMs` + pool fields `lastHeardMs,firstHeardMs,onRadio,favourite`; **drop** `blocked`. Port `hopsFromOutPathLen`, `advTypeToKind` as-is.

**DROP (UI):** `BleDevice`, `BRIDGE_*`/`BridgeStatus`, `BlockRule*`, `Search*`/`MessageHit`/`ConversationHit`/`SearchResults`, `LogEntry`/`LogLevel`(UI), `ThemePrefValue`/`MessageStyle`/`TimeFormatPref`, `AppSettings`+default, `ContactGrouping`, `Tile*`/`TileManifest*`, `MapSettings`+default, `UiState`+default, `LeftNavGroupId`/`ThemePref`, `StateSnapshot`, `MenuAction`, `ThemePush`, `WsMessage`, `Capabilities`, `CoreSenseBridge`, `ServerStatus`, and the redundant `shared/types.ts` `Repeater*` mirrors (D6). Imports of `QuickActionId` (renderer) removed.

---

## 5. Behavior that must NOT regress (ported verbatim)

- **Reply correlation (`session.ts:864-992,1237-1280`):** the `pendingAcks` FIFO (RESP_OK/ERR, no correlation id), the typed-reply `pendingTyped` map keyed by `expect`, and `requestOrNull` arming **both** an ack-waiter and a typed-waiter against one write (shared timer + settle guard). Ported unchanged into `MeshCoreSession`.
- **`GET_CONTACT_BY_KEY` vs iterator `RESP_CONTACT` disambiguation (`session.ts:1270-1278`):** unclaimed `RESP_ERR` → `failPendingContactByKey()` before treating it as a rejected DM send. Preserved.
- **Handshake sequence (`session.ts:1156-1210`):** DEVICE_QUERY → APP_START → GET_CONTACTS (arm start+done waiters before write) → 40-slot channel enumeration with `WRITE_GAP_MS` → await contacts-done → BATT_AND_STORAGE → drain. Preserved, with `contactsSync` as an internal callback (D7).
- **DM send/ack/retry state machine (`features/directMessages.ts`):** FIFO `dmSendQueue`, `pendingDmAcks` by expected-ack hex, RESP_SENT `sending→sent`, PUSH_SEND_CONFIRMED `sent→ack`, retry + `CMD_RESET_PATH` flood fallback + path learning. Relocated to `ctx.rt.dm`, logic verbatim.
- **Mesh-observation correlation:** `log_rx` GRP_TXT → record + `attributeOutgoingChannelRelay` → `messagePathHeard`/`appendMessagePath` (`sent→heard`). Moved from `ble.ts` into the session.
- **Message merge precedence (`holder.ts:243-325`):** `stateRank{sending:0,sent:1,received:1,heard:2,ack:3,failed:0}`, path union by `id`, `timesHeard` bump, `ts` min. Reimplemented in `SessionState`.

---

## 6. File inventory

### Port as-is (only `node:buffer`/`node:crypto`/protocol-internal)
`codes.ts`, `encode.ts`, `buffer.ts`, `meshPacket.ts`, `errors.ts`, `meshObservations.ts`*, `advert.ts`, `repeater.ts` (incl. CayenneLPP table — **not** a separate `decode.ts`), `feature.ts`(extended), `registry.ts`, `features/{advert,radioParams,pathHash,time,signing,tuning,floodScope,misc,contactInterop,deviceAdmin}.ts`, `transport/companionFrame.ts`→`src/frame.ts`.
(*`meshObservations.ts` & `pendingChannelSends.ts` keep logic but move their buffer/array onto `ctx.rt`; `pendingChannelSends.ts` also drops `emit`/`stateHolder` imports → `ctx`.)

### Port WITH decoupling (swap singletons → `ctx`, relocate state → `ctx.rt`)
`session.ts`→`MeshCoreSession`, `paths.ts` (only type imports — trivial), `pendingChannelSends.ts`, `features/{selfInfo,deviceInfo,battStorage,customVars,autoAdd,contactsFull,contacts,channels,channelMessages,directMessages,repeaterAdmin,pathDiagnostics,rawData,drain}.ts`, `bridge/adminSession.ts`→`src/session/adminSessions.ts`, `shared/contacts/discovered.ts`→`src/contacts/discovered.ts`.

### Strip entirely (do NOT port)
`transport/{manager,ble,serial,types}.ts`, `@stoprocent/noble` + native deps, `log.ts`/tslog, `events/bus.ts` (replaced by typed emitter), `state/holder.ts` (replaced by `SessionState`), `storage/{messages,discoveredContacts,settings,search}.ts`, `node:sqlite`, `blocking/*`, `map/*`, `index.ts` singleton (replaced by `new MeshCoreSession()`), all UI types.

---

## 7. Package mechanics

- **`package.json`:** `name: "meshcore-ts"`, `type: "module"`, `license: "MIT"`, `files: ["dist"]`, `exports` map (`import`→`dist/index.js`, `require`→`dist/index.cjs`, `types`→`dist/index.d.ts`), `main`/`module`/`types`. Scripts: `build` (tsup), `test` (vitest run), `test:watch`, `typecheck` (tsc --noEmit), `lint` (biome check), `format` (biome format --write). devDeps: `typescript`, `tsup`, `vitest`, `@vitest/coverage-v8`, `@biomejs/biome`, `@types/node`. **No runtime deps.**
- **`tsup.config.ts`:** entry `src/index.ts`, `format: ['esm','cjs']`, `dts: true`, `target: 'es2022'`, `clean: true`, `sourcemap: true`.
- **`tsconfig.json`:** `target ES2022`, `module ESNext`, `moduleResolution bundler`, `lib: ["ES2022"]` (**no DOM**), `strict`, `declaration`, `noUnusedLocals/Parameters`, `noFallthroughCasesInSwitch`, `esModuleInterop`, `isolatedModules`, `types: ["node"]` (**no vite/client, no electron**), **no `@/*` aliases**.
- **`biome.json`:** copy donor's (single quotes, width 125, trailing commas all, semicolons always, recommended lint + `noExplicitAny: warn`); drop the css/tailwind + renderer-specific `includes`.
- **`vitest.config.ts`:** single Node-environment project, `include: ['tests/**/*.test.ts']`. No jsdom, no react, no `@` alias, no build-info stubs.

---

## 8. Test port strategy

Unit tests are **pure codec tests** (buffer-in/buffer-out, **no mocks**) — port nearly verbatim, only rewriting import paths (`src/main/protocol/...` → `src/...`). Integration tests use `FakeTransport`/`companionPacket()`/`emit.packet` + real session — port against `LoopbackTransport` + `session.events` instead of the bus. Fixtures `tests/fixtures/frames/*.json` (each entry = `{hex}` of one complete companion frame) replay through `LoopbackTransport`. Port the `tests/support/` helpers that protocol tests use (`frames.ts` loader, fake transport, frame builders); drop sqlite-temp/seams/build-info-stub. Target integration flows: `inbound/{dm-send-ack,contacts-iterator,device-info,channel-message,...}`, `outbound/{send-channel,add-contact,device-admin,...}`, `transport/replay`. Skip `integration/{api,storage}` (app-specific).

---

## 9. Implementation sequence (phases → tasks)

Each task: port module + its test, keep suite green, commit. Order respects the dependency graph (pure → state/ports → pure features → stateful features → session).

**Phase A — Scaffold & tooling.** package.json, tsconfig, tsup, biome, vitest, dir skeleton, `src/index.ts` stub. Verify `build`/`typecheck`/`test`(empty)/`lint` run.

**Phase B — Types & pure core.** `types.ts` (carved) → `codes.ts` → `buffer.ts` → `errors.ts` → `encode.ts` → `meshPacket.ts` → `advert.ts` → `repeater.ts` → `frame.ts` → `contacts/discovered.ts`. Port each test alongside. (All zero-coupling — fast.)

**Phase C — Ports & state.** `ports/{transport(+Loopback),logger,events}.ts` → `state/model.ts` (incl. message-merge port) → `session/adminSessions.ts` → `feature.ts`(extended)+`registry.ts` → `meshObservations.ts`+`paths.ts`+`pendingChannelSends.ts` (state→`ctx.rt`). Unit-test state merge + admin correlation.

**Phase D — Pure features.** `features/{advert,radioParams,pathHash,time,signing,tuning,floodScope,misc,contactInterop,deviceAdmin}.ts` + tests (mechanical; deviceAdmin's export FIFO → `ctx.rt`).

**Phase E — Decoupled handler features.** `features/{selfInfo,deviceInfo,battStorage,customVars,autoAdd,contactsFull}.ts` (singleton→`ctx`, no module state) → `features/{drain,channels,channelMessages,contacts,pathDiagnostics,rawData}.ts` (relocate state) → `features/{directMessages,repeaterAdmin}.ts` (FIFO/admin correlation → `ctx.rt`, admin hooks per-session) + tests.

**Phase F — Session (last).** `session/context.ts` (build `FeatureContext`+`SessionRuntime`+registry) → `session/session.ts` (`MeshCoreSession`: inbound ingest, handshake, ack/typed FIFOs, lifecycle, all command methods) → `src/index.ts` public exports. Port integration suites (`inbound`/`outbound`/`transport`) + fixtures.

**Phase G — Finish.** `build`+`typecheck`+`test`+`lint` all green; `README.md` (the four ports the consumer supplies + a minimal `LoopbackTransport`/BLE usage example + event list).

---

## 10. Self-review notes
- Spec coverage: all five ports (§1), admin correlation (§2/Phase C), type carve (§4), non-regression items (§5) mapped to tasks. ✓
- Corrections surfaced: feature scope under-listed (D1), `decode.ts` is actually `repeater.ts` (D6/§6), no byte-stream framing exists (D3), protocol has zero runtime deps. ✓
- Open items requiring your call: **D1–D8** above.
