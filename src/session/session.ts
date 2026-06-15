import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { ADV_TYPE, ERR_CODE, RESP, type STATS_TYPE } from '../codes';
import { buildReboot, buildSendSelfAdvert } from '../encode';
import { ContactTableFullError, ProtocolError, ProtocolTimeoutError, UnknownContactError } from '../errors';
import type { ContactsSyncSignal, FeatureContext } from '../feature';
import { encodeSetAdvertLatLon, encodeSetAdvertName, encodeSetOtherParams } from '../features/advert';
import { type AutoAddFlagsInput, autoAddFeature, requestAutoAddConfig, setAutoAddConfig } from '../features/autoAdd';
import { battStorageFeature, encodeGetBattAndStorage } from '../features/battStorage';
import * as channelMessages from '../features/channelMessages';
import * as channels from '../features/channels';
import * as contactInterop from '../features/contactInterop';
import {
  type ContactRecord,
  contactsFeature,
  emitDiscovered,
  encodeAddUpdateContact,
  encodeGetContacts,
  encodeRemoveContact,
  encodeResetPath,
  failPendingContactByKey,
  getContactByKey,
  resetContactsIter,
  scheduleContactsResync,
  upsertOnRadioContact,
} from '../features/contacts';
import { contactsFullFeature } from '../features/contactsFull';
import { customVarsFeature, encodeGetCustomVar, encodeSetCustomVar } from '../features/customVars';
import * as deviceAdmin from '../features/deviceAdmin';
import { deviceInfoFeature, encodeDeviceQuery } from '../features/deviceInfo';
import * as directMessages from '../features/directMessages';
import { drainFeature, resetDrain, scheduleDrain } from '../features/drain';
import * as floodScope from '../features/floodScope';
import * as misc from '../features/misc';
import * as pathDiagnostics from '../features/pathDiagnostics';
import { encodeSetPathHashMode, pathHashSizeToMode } from '../features/pathHash';
import { encodeSetRadioParams, encodeSetRadioTxPower } from '../features/radioParams';
import * as rawData from '../features/rawData';
import * as repeaterAdmin from '../features/repeaterAdmin';
import { encodeAppStart, selfInfoFeature } from '../features/selfInfo';
import * as signing from '../features/signing';
import { getDeviceTime, setDeviceTime, syncDeviceTime } from '../features/time';
import { getTuningParams, setTuningParams, type TuningParams } from '../features/tuning';
import { parseCompanionFrame } from '../frame';
import { PAYLOAD_TYPE, parseMeshPacket } from '../meshPacket';
import { MeshCoreEvents } from '../ports/events';
import { type Logger, noopLogger } from '../ports/logger';
import type { Transport } from '../ports/transport';
import { FeatureRegistry } from '../registry';
import type { AclEntry, LocalStats, LoginSuccess, NeighboursPage, OwnerInfo, TraceData } from '../repeater';
import { SessionState } from '../state/model';
import type { Channel, ContactKind, RawPacket, SyncProgress, TransportState } from '../types';
import { DEFAULT_SYNC_PROGRESS } from '../types';
import { type AdminMode, AdminSessionStore } from './adminSessions';
import { createSessionRuntime, type SessionRuntime } from './runtime';

const DEFAULT_APP_NAME = 'meshcore-ts';
const DEFAULT_APP_VERSION = 1;
const CHANNEL_SLOT_COUNT = 40; // enumerate idx 0..39 on connect (matches official firmware)

// Cap on how long the handshake waits for RESP_CONTACTS_START before falling
// back to enumerating channels with an unknown contact total. The radio
// normally answers within a frame; this just keeps us from stalling forever on
// a misbehaving device.
const CONTACTS_START_WAIT_MS = 3000;

// Cap on how long the handshake waits for RESP_END_OF_CONTACTS after the
// channel-enumeration loop completes. Without this, a dropped end-frame leaves
// the UI stuck in 'syncing' forever.
const CONTACTS_DONE_WAIT_MS = 10_000;

// Small delay between consecutive cmd writes so the BLE link doesn't queue too
// many frames the radio can't ack in time. Empirical on Heltec/RAK hardware.
const WRITE_GAP_MS = 50;

// How long to wait for RESP_OK / RESP_ERR after a SET_CHANNEL write before
// giving up. The radio normally responds within ~50ms; 2s leaves slack for a
// busy BLE link without leaving the UI hanging on a dead device.
const SET_CHANNEL_TIMEOUT_MS = 2000;

// Periodic CMD_DEVICE_QUERY to keep the link warm — the firmware replies with
// RESP_DEVICE_INFO so a dead link surfaces as a write timeout or missing reply
// rather than waiting on user-initiated traffic. Mirrors meshcore-open's
// battery/radio-stats polling pattern (protocol traffic doubles as liveness).
const LIVENESS_POLL_MS = 60_000;

// Default wait for a typed RESP_* reply to a feature ctx.request({ expect }).
const REQUEST_TIMEOUT_MS = 5_000;

export interface AckResult {
  ok: boolean;
  /** Firmware error code byte from a RESP_ERR reply (frame[1]); undefined on
   *  RESP_OK or on timeout. */
  errorCode?: number;
}

interface PendingAck {
  resolve: (result: AckResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

// Awaiter for a solicited typed reply (a GET command's RESP_* frame), keyed by
// expected code in `pendingTyped`. FIFO per code.
interface PendingTyped {
  resolve: (frame: Buffer) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface MeshCoreSessionOptions {
  transport: Transport;
  logger?: Logger;
  /** APP_START app name. Default 'meshcore-ts'. */
  appName?: string;
  /** APP_START version byte. Default 1. */
  appVersion?: number;
}

/**
 * The protocol session core: owns the inbound-frame ingest, the reply-
 * correlation FIFOs (ack + typed), the handshake, the liveness poll, and the
 * transport-state lifecycle. Feature modules receive a {@link FeatureContext}
 * bound to this session and own their own wire codes via the registry.
 *
 * Ported verbatim from the donor `ProtocolSession`; the ~60 user-facing command
 * methods are layered on in a later task.
 */
export class MeshCoreSession {
  private readonly transport: Transport;
  private readonly appName: string;
  private readonly appVersion: number;

  /** Typed event bus the session and consumers subscribe to. */
  readonly events = new MeshCoreEvents();
  /** In-memory session model. */
  readonly state = new SessionState();
  /** Repeater admin auth + pending-request store. */
  readonly admin = new AdminSessionStore();
  /** Structured logger (defaults to no-op). */
  readonly log: Logger;
  /** Per-session mutable feature state. */
  readonly rt: SessionRuntime;

  private connected = false;
  /** Queue of awaiters for the next RESP_OK / RESP_ERR. The companion protocol
   *  has no correlation id, so we FIFO: any OK/ERR routes to the oldest
   *  pending awaiter. Only SET_CHANNEL currently uses this; if more writers
   *  appear we'll need to serialize them through here too. */
  private readonly pendingAcks: PendingAck[] = [];
  /** High-level handshake progress surfaced to the UI footer. Updated as we
   *  enumerate channel slots (and, later, contacts) during handshake. */
  private syncProgress: SyncProgress = { ...DEFAULT_SYNC_PROGRESS };
  /** Resolved when RESP_CONTACTS_START arrives during the handshake, so the
   *  channel-enumeration loop can wait for the contact total and avoid the
   *  progress bar jumping backwards when total grows mid-sync. */
  private contactsStartWaiter: {
    resolve: () => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  /** Resolved when RESP_END_OF_CONTACTS arrives. The handshake awaits this
   *  after the channel loop so we can flip phase to 'done' inline rather than
   *  juggling completion flags across two async streams. */
  private contactsDoneWaiter: {
    resolve: () => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  /** FIFO of awaiters per expected RESP_* code, for ctx.request({ expect }). */
  private readonly pendingTyped = new Map<number, PendingTyped[]>();
  private livenessTimer: ReturnType<typeof setInterval> | null = null;

  /** The capability surface handed to feature modules. */
  private readonly ctx: FeatureContext;
  /** Inbound-frame dispatch: every code-owned RESP/PUSH frame is handled by
   *  exactly one of these feature modules. The only frames NOT routed here are
   *  solicited typed replies (ctx.request `expect`, via pendingTyped) and the
   *  shared RESP_OK/RESP_ERR ack channel — see onPacket. */
  private readonly registry = new FeatureRegistry([
    contactsFullFeature,
    battStorageFeature,
    autoAddFeature,
    deviceInfoFeature,
    selfInfoFeature,
    customVarsFeature,
    contactsFeature,
    drainFeature,
    channels.channelsFeature,
    channelMessages.channelMessagesFeature,
    directMessages.directMessagesFeature,
    repeaterAdmin.repeaterAdminFeature,
    deviceAdmin.deviceAdminFeature,
    pathDiagnostics.pathDiagnosticsFeature,
    rawData.rawDataFeature,
  ]);

  constructor(opts: MeshCoreSessionOptions) {
    this.transport = opts.transport;
    this.log = opts.logger ?? noopLogger;
    this.appName = opts.appName ?? DEFAULT_APP_NAME;
    this.appVersion = opts.appVersion ?? DEFAULT_APP_VERSION;
    this.rt = createSessionRuntime();
    this.ctx = {
      writeFrame: (frame) => this.writeFrame(frame),
      request: (frame, reqOpts) => this.request(frame, reqOpts),
      requestOrNull: (frame, expect, timeoutMs) => this.requestOrNull(frame, expect, timeoutMs),
      events: this.events,
      state: this.state,
      log: this.log,
      admin: this.admin,
      rt: this.rt,
      getTransportState: () => this.getTransportState(),
      contactsSync: (signal) => this.contactsSync(signal),
    };
  }

  start(): void {
    this.transport.onData((chunk) => this.ingest(chunk));
    this.transport.onStateChange((s) => this.onTransportState(s));
    // The repeaterAdmin feature owns the admin awaiter queues and registers the
    // directMessages intercept hooks (RESP_SENT tag + CLI reply) against them.
    repeaterAdmin.registerAdminHooks(this.ctx);
    this.purgeCorruptedChannels();
    channels.rebuildIndexes(this.ctx);
    // If the transport already happens to be connected at start (e.g. auto-
    // reconnect on app launch), kick the handshake immediately.
    if (this.transport.getState() === 'connected') {
      this.connected = true;
      void this.handshake();
    }
  }

  /** Drop persisted channels whose name contains non-printable bytes — these
   *  are leftovers from before parseChannelInfo correctly null-terminated the
   *  name field. The radio will re-publish the clean version on next handshake. */
  private purgeCorruptedChannels(): void {
    const printable = /^[\x20-\x7e][\x20-\x7e\s]*$/;
    const all = this.state.getChannels();
    const kept = all.filter((c) => printable.test(c.name));
    if (kept.length !== all.length) {
      this.log.warn(`purging ${all.length - kept.length} channel(s) with non-printable names`);
      this.state.setChannels(kept);
      this.events.emit('channels', kept);
    }
  }

  stop(): void {
    resetContactsIter(this.ctx);
    resetDrain(this.ctx);
    directMessages.resetDmState(this.ctx, 'session stopped');
    repeaterAdmin.resetAdmin(this.ctx, 'session stopped');
    deviceAdmin.resetDeviceAdmin(this.ctx, 'session stopped');
    pathDiagnostics.resetPathDiagnostics(this.ctx, 'session stopped');
    this.stopLivenessPoll();
  }

  /** Current transport connection state. */
  getTransportState(): TransportState {
    return this.transport.getState();
  }

  private async writeFrame(frame: Buffer): Promise<void> {
    await this.transport.send(frame);
  }

  /** Generic send→await for feature modules. See FeatureContext.request. */
  private async request(frame: Buffer, opts?: { expect?: number; timeoutMs?: number }): Promise<Buffer> {
    if (opts?.expect === undefined) {
      // RESP_OK / RESP_ERR path — reuse the shared, correlation-id-less ack FIFO
      // (see the pendingAcks field comment): concurrent OK/ERR writers can
      // cross-resolve, so callers must serialize. A timeout surfaces here as
      // ProtocolError(undefined) — indistinguishable from a real bare RESP_ERR.
      const { promise, entry } = this.awaitAck(opts?.timeoutMs ?? REQUEST_TIMEOUT_MS);
      try {
        await this.writeFrame(frame);
      } catch (err) {
        this.popPendingAck(entry);
        throw err;
      }
      const ack = await promise;
      if (!ack.ok) throw new ProtocolError(ack.errorCode);
      return Buffer.alloc(0);
    }
    // Typed-reply path — resolve the next inbound frame whose code === expect.
    const expect = opts.expect;
    // RESP_OK / RESP_ERR must flow through the bare-ack path above (omit `expect`);
    // intercepting them as typed replies would steal a concurrent device-write's ack.
    if (expect === RESP.OK || expect === RESP.ERR) {
      throw new Error('request({ expect }) cannot await RESP_OK/RESP_ERR — omit `expect`');
    }
    const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    return new Promise<Buffer>((resolve, reject) => {
      const queue = this.pendingTyped.get(expect) ?? [];
      const remove = () => {
        const q = this.pendingTyped.get(expect);
        if (!q) return;
        const i = q.indexOf(entry);
        if (i !== -1) q.splice(i, 1);
        if (q.length === 0) this.pendingTyped.delete(expect);
      };
      const timer = setTimeout(() => {
        remove();
        reject(new ProtocolTimeoutError(expect));
      }, timeoutMs);
      const entry: PendingTyped = { resolve, reject, timer };
      queue.push(entry);
      this.pendingTyped.set(expect, queue);
      this.writeFrame(frame).catch((err) => {
        clearTimeout(timer);
        remove();
        reject(err as Error);
      });
    });
  }

  /** Send a frame and resolve EITHER its typed reply (code === expect) OR null
   *  on a RESP_ERR. Arms a typed-reply waiter and an ack waiter against one
   *  write so a "not found" RESP_ERR is consumed via the ack FIFO (never leaking
   *  to failOldestDmSend) rather than waiting out the typed-reply timeout. The
   *  two waiters share a timer and a settle guard; whichever fires first removes
   *  the other. See FeatureContext.requestOrNull. */
  private requestOrNull(frame: Buffer, expect: number, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<Buffer | null> {
    if (expect === RESP.OK || expect === RESP.ERR) {
      return Promise.reject(new Error('requestOrNull cannot expect RESP_OK/RESP_ERR — they resolve to null'));
    }
    return new Promise<Buffer | null>((resolve, reject) => {
      let settled = false;
      const removeTyped = () => {
        const q = this.pendingTyped.get(expect);
        if (!q) return;
        const i = q.indexOf(typedEntry);
        if (i !== -1) q.splice(i, 1);
        if (q.length === 0) this.pendingTyped.delete(expect);
      };
      const removeAck = () => {
        const i = this.pendingAcks.indexOf(ackEntry);
        if (i !== -1) this.pendingAcks.splice(i, 1);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        removeTyped();
        removeAck();
        reject(new ProtocolTimeoutError(expect));
      }, timeoutMs);
      // RESP_OK / RESP_ERR routes here via the ack FIFO → resolve null.
      const ackEntry: PendingAck = {
        resolve: () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          removeTyped();
          resolve(null);
        },
        timer,
      };
      // The typed reply (the success case) routes here via pendingTyped.
      const typedEntry: PendingTyped = {
        resolve: (f: Buffer) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          removeAck();
          resolve(f);
        },
        reject: (err: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          removeAck();
          reject(err);
        },
        timer,
      };
      this.pendingAcks.push(ackEntry);
      const queue = this.pendingTyped.get(expect) ?? [];
      queue.push(typedEntry);
      this.pendingTyped.set(expect, queue);
      this.writeFrame(frame).catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        removeTyped();
        removeAck();
        reject(err as Error);
      });
    });
  }

  /** Decode one inbound transport chunk (a complete companion frame). Mesh
   *  frames are recorded as flood observations only; companion frames are built
   *  into a RawPacket and dispatched through onPacket. Moved verbatim from the
   *  BLE transport's onData. */
  private ingest(chunk: Uint8Array): void {
    const frame = Buffer.from(chunk);
    const parsed = parseCompanionFrame(frame);
    if (!parsed) return;
    const fullHex = frame.toString('hex');
    const fullBytes = [...frame];
    if (parsed.kind === 'mesh') {
      // PUSH_CODE_LOG_RX_DATA (0x88) carries the raw on-air mesh packet,
      // including the per-hop path bytes our PathViewer renders. Decode it
      // here and tee the observation into the side-channel buffer so the
      // later RESP_CHANNEL_MSG_RECV_V3 can correlate.
      if (parsed.source === 'log_rx') {
        const mesh = parseMeshPacket(parsed.meshBytes);
        if (mesh && mesh.payloadType === PAYLOAD_TYPE.GRP_TXT && mesh.payload.length >= 1) {
          const channelHash = mesh.payload[0];
          const encrypted = mesh.payload.subarray(1);
          const payloadFingerprint = createHash('sha1').update(encrypted).digest('hex').slice(0, 16);
          const observation = {
            recordedAt: Date.now(),
            channelHash,
            hashSize: mesh.hashSize,
            hashCount: mesh.hashCount,
            pathHex: mesh.pathHex,
            finalSnr: parsed.snr,
            payloadFingerprint,
          };
          this.rt.meshObs.record(observation);
          // If this observation is a repeater relaying one of our recent
          // outgoing channel sends, attribute it back to that message — the
          // helper appends a MessagePath and broadcasts messagePathHeard.
          this.rt.pendingChannelSends.attributeObservation(observation, this.state, this.events);
        }
      }
      // Mesh frames are not routed through onPacket — the donor's onPacket
      // early-returns on non-companion kinds. The observation tee above is the
      // only side effect.
      return;
    }
    const rawPacket: RawPacket = {
      timestamp: Date.now(),
      transportType: 'ble',
      kind: 'companion',
      hex: fullHex,
      bytes: fullBytes,
      payloadHex: parsed.payloadHex,
      payloadBytes: [...parsed.payloadBytes],
      code: parsed.code,
      codeName: parsed.codeName,
    };
    this.onPacket(rawPacket);
  }

  private onPacket = (p: RawPacket): void => {
    if (p.kind !== 'companion') return;
    const code = p.code;
    if (code === undefined) return;
    const frame = Buffer.from(p.bytes);
    this.log.trace(`rx code=0x${code.toString(16).padStart(2, '0')} (${p.codeName ?? '?'}) len=${frame.length}`);

    // (1) Solicited typed replies (ctx.request with `expect`) get first crack.
    const typedQueue = this.pendingTyped.get(code);
    if (typedQueue && typedQueue.length > 0) {
      const entry = typedQueue.shift();
      if (typedQueue.length === 0) this.pendingTyped.delete(code);
      if (entry) {
        clearTimeout(entry.timer);
        entry.resolve(frame);
        return;
      }
    }
    // (2) Code-owned frames go to their feature module.
    const feature = this.registry.get(code);
    if (feature) {
      feature.handle(code, frame, this.ctx);
      return;
    }

    // (3) The shared RESP_OK / RESP_ERR ack channel. These have no correlation
    //     id and aren't owned by any single feature — they route to the oldest
    //     queued device-write awaiter (the pendingAcks FIFO that backs every
    //     ctx.request()). A RESP_ERR carries an error-code byte (frame[1]) so
    //     callers like addContactToRadio can detect ERR_CODE_TABLE_FULL. If no
    //     awaiter is queued, a bare RESP_ERR means the radio rejected an
    //     in-flight send — fail the oldest DM. Any other unclaimed code is a
    //     no-op (e.g. a reply to a command we don't issue yet).
    if (code === RESP.OK || code === RESP.ERR) {
      const errorCode = code === RESP.ERR ? frame[1] : undefined;
      if (this.resolveNextAck(code === RESP.OK, errorCode)) return;
      if (code === RESP.ERR) {
        // A getContactByKey miss (RESP_ERR NOT_FOUND) has no queued ack; resolve
        // it null before treating an unclaimed RESP_ERR as a rejected DM send.
        if (failPendingContactByKey(this.ctx)) return;
        directMessages.failOldestDmSend(this.ctx, 'radio rejected send');
      }
    }
  };

  private onTransportState = (state: TransportState): void => {
    const wasConnected = this.connected;
    this.connected = state === 'connected';
    if (this.connected && !wasConnected) {
      this.log.info('transport connected — running handshake');
      channels.clearPresence(this.ctx);
      void this.handshake();
      this.startLivenessPoll();
    } else if (!this.connected && wasConnected) {
      this.log.info('transport disconnected');
      this.stopLivenessPoll();
      // Abandon any in-flight drain round; a reconnect's handshake starts fresh.
      resetDrain(this.ctx);
      channels.clearPresence(this.ctx);
      this.updateSyncProgress({ ...DEFAULT_SYNC_PROGRESS });
      // Resolve any in-flight acks as failures rather than leaving callers hung.
      for (const p of this.pendingAcks.splice(0)) {
        clearTimeout(p.timer);
        p.resolve({ ok: false });
      }
      // Any DM still awaiting RESP_SENT will never get one — fail them so the
      // UI doesn't leave 'sending' spinners forever.
      directMessages.resetDmState(this.ctx, 'transport disconnected');
      // Fail in-flight admin awaiters + drop login sessions.
      repeaterAdmin.resetAdmin(this.ctx, 'transport disconnected');
      // Fail any in-flight private-key export awaiter.
      deviceAdmin.resetDeviceAdmin(this.ctx, 'transport disconnected');
      // Fail any in-flight path-discovery awaiter.
      pathDiagnostics.resetPathDiagnostics(this.ctx, 'transport disconnected');
      // Fail any typed-reply awaiters (ctx.request with `expect`) so feature GETs
      // reject promptly on disconnect instead of waiting out their timeout.
      for (const queue of this.pendingTyped.values()) {
        for (const entry of queue) {
          clearTimeout(entry.timer);
          entry.reject(new Error('transport disconnected'));
        }
      }
      this.pendingTyped.clear();
    }
  };

  /** Snapshot of channel keys currently present on the radio. Empty when the
   *  transport is disconnected. */
  getDevicePresence(): string[] {
    return channels.getDevicePresence(this.ctx);
  }

  /** Snapshot of handshake progress. */
  getSyncProgress(): SyncProgress {
    return {
      phase: this.syncProgress.phase,
      channels: { ...this.syncProgress.channels },
      contacts: { ...this.syncProgress.contacts },
    };
  }

  /** Shallow-merge a patch into the current sync progress and broadcast. Each
   *  sub-object (channels, contacts) is replaced wholesale if present in the
   *  patch — callers pass the new `{done,total}` pair rather than mutating. */
  private updateSyncProgress(patch: Partial<SyncProgress>): void {
    this.syncProgress = { ...this.syncProgress, ...patch };
    this.events.emit('syncProgress', this.getSyncProgress());
  }

  private awaitAck(timeoutMs: number = SET_CHANNEL_TIMEOUT_MS): {
    promise: Promise<AckResult>;
    entry: PendingAck;
  } {
    let entry!: PendingAck;
    const promise = new Promise<AckResult>((resolve) => {
      const timer = setTimeout(() => {
        const i = this.pendingAcks.indexOf(entry);
        if (i !== -1) this.pendingAcks.splice(i, 1);
        resolve({ ok: false });
      }, timeoutMs);
      entry = { resolve, timer };
      this.pendingAcks.push(entry);
    });
    return { promise, entry };
  }

  /** Pop a still-pending ack entry off the FIFO. Used by setters that fail at
   *  write time so a never-arriving RESP_OK doesn't permanently shift the FIFO
   *  off-by-one. */
  private popPendingAck(entry: PendingAck): void {
    const i = this.pendingAcks.indexOf(entry);
    if (i !== -1) this.pendingAcks.splice(i, 1);
    clearTimeout(entry.timer);
  }

  private resolveNextAck(ok: boolean, errorCode?: number): boolean {
    const entry = this.pendingAcks.shift();
    if (!entry) return false;
    clearTimeout(entry.timer);
    entry.resolve({ ok, errorCode });
    return true;
  }

  private startLivenessPoll(): void {
    this.stopLivenessPoll();
    this.livenessTimer = setInterval(() => {
      if (!this.connected) return;
      this.writeFrame(encodeDeviceQuery()).catch((err) => {
        this.log.debug(`liveness DEVICE_QUERY failed: ${(err as Error).message}`);
      });
      // Refresh battery/storage on the same cadence so the identity card's
      // battery readout stays current without a manual device refresh.
      this.writeFrame(encodeGetBattAndStorage()).catch((err) => {
        this.log.debug(`liveness GET_BATT_AND_STORAGE failed: ${(err as Error).message}`);
      });
    }, LIVENESS_POLL_MS);
  }

  private stopLivenessPoll(): void {
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = null;
    }
  }

  /** Arm a one-shot waiter resolved by a future response handler (or a
   *  timeout). Returns the promise; stores the slot so the handler can find
   *  and resolve it. The slot is single-use — re-arming overwrites. */
  private armWaiter(slot: 'contactsStartWaiter' | 'contactsDoneWaiter', timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (this[slot]) {
          this[slot] = null;
          resolve();
        }
      }, timeoutMs);
      this[slot] = { resolve, timer };
    });
  }

  private async handshake(): Promise<void> {
    this.updateSyncProgress({
      phase: 'syncing',
      channels: { done: 0, total: CHANNEL_SLOT_COUNT },
      contacts: { done: 0, total: 0 },
    });
    try {
      // DEVICE_QUERY first: it carries our protocol version (4), which the
      // firmware reads into app_target_ver. Without this we'd get V1 message
      // frames (no SNR). APP_START's "version" byte is reserved on the device
      // side, so APP_START alone is not enough to negotiate V3.
      await this.writeFrame(encodeDeviceQuery());
      await sleep(WRITE_GAP_MS);
      await this.writeFrame(encodeAppStart(this.appName, this.appVersion));
      await sleep(WRITE_GAP_MS);
      // Kick the contact iterator FIRST so RESP_CONTACTS_START gives us the
      // contact total before we start incrementing channel progress, and so
      // RESP_CONTACT × N can stream in via onPacket while the channel loop
      // runs below. We arm contactsDone *before* writing GET_CONTACTS so a
      // very fast END_OF_CONTACTS can't race past us.
      const contactsStart = this.armWaiter('contactsStartWaiter', CONTACTS_START_WAIT_MS);
      const contactsDone = this.armWaiter('contactsDoneWaiter', CONTACTS_DONE_WAIT_MS);
      await this.writeFrame(encodeGetContacts());
      await contactsStart;
      await sleep(WRITE_GAP_MS);
      // Enumerate channels. Empty slots return RESP_ERR or an all-zero key
      // RESP_CHANNEL_INFO; both are filtered by decodeChannelInfo / channelsFeature.
      for (let i = 0; i < CHANNEL_SLOT_COUNT; i += 1) {
        await this.writeFrame(channels.encodeGetChannel(i));
        await sleep(WRITE_GAP_MS);
        this.updateSyncProgress({
          channels: { done: i + 1, total: CHANNEL_SLOT_COUNT },
        });
      }
      // Wait for the contact stream to finish (or its watchdog to fire)
      // before flipping phase, so the UI doesn't show 'done' while contacts
      // are still ticking in.
      await contactsDone;
      this.updateSyncProgress({
        phase: 'done',
        channels: { done: CHANNEL_SLOT_COUNT, total: CHANNEL_SLOT_COUNT },
      });
      // Pull battery/storage once up front so the identity card has a reading
      // immediately on connect; the liveness poll keeps it fresh thereafter.
      await this.writeFrame(encodeGetBattAndStorage());
      await sleep(WRITE_GAP_MS);
      // Drain any messages queued during the disconnect window. Self-advert
      // is user-initiated only — matching the official mobile clients, which
      // never auto-advertise.
      void scheduleDrain(this.ctx);
    } catch (err) {
      this.log.warn(`handshake failed: ${(err as Error).message}`);
      this.updateSyncProgress({ ...DEFAULT_SYNC_PROGRESS });
    }
  }

  private resolveWaiter(slot: 'contactsStartWaiter' | 'contactsDoneWaiter'): void {
    const w = this[slot];
    if (!w) return;
    clearTimeout(w.timer);
    this[slot] = null;
    w.resolve();
  }

  /** Bridge the contacts feature's iterator signals into the handshake's
   *  progress bar + start/done waiters. The feature owns the iterator state;
   *  the session owns the composite SyncProgress and the handshake coordination.
   *  This runs synchronously from the feature's frame handler, so the timing
   *  matches the old inline `updateSyncProgress` / `resolveWaiter` calls. */
  private contactsSync(s: ContactsSyncSignal): void {
    if (s.phase === 'start') {
      if (s.total !== null) this.updateSyncProgress({ contacts: { done: 0, total: s.total } });
      this.resolveWaiter('contactsStartWaiter');
    } else if (s.phase === 'progress') {
      this.updateSyncProgress({ contacts: { done: s.done, total: s.total } });
    } else {
      this.updateSyncProgress({ contacts: { done: s.done, total: s.done } });
      this.resolveWaiter('contactsDoneWaiter');
    }
  }

  // =========================================================================
  // User-facing command surface
  // =========================================================================

  // ---- Channel-relay attribution ----------------------------------------

  /** Track an outgoing channel send so heard repeater relays (0x88) are
   *  attributed back to it (emits 'messagePathHeard'). Call after sendChannelText
   *  returns a channelHash, passing your message id. */
  registerChannelSend(params: { messageId: string; channelHash: number; sentAt?: number }): void {
    this.rt.pendingChannelSends.register({
      messageId: params.messageId,
      channelHash: params.channelHash,
      sentAt: params.sentAt ?? Date.now(),
    });
  }

  // ---- Messaging ---------------------------------------------------------

  /** Returns ok on transport-level write success. When ok, `channelHash` is
   *  the byte the firmware tags GRP_TXT packets with on this channel — the
   *  caller uses it to register a pending-send entry so subsequent
   *  PUSH_CODE_LOG_RX_DATA observations matching that byte can be attributed
   *  back to the outgoing message (repeater relays we hear over the air). */
  async sendChannelText(channelKey: string, text: string): Promise<{ ok: boolean; error?: string; channelHash?: number }> {
    return channelMessages.sendChannelText(this.ctx, channelKey, text);
  }

  /** Send a DM to a contact. Returns ok on transport-level write success; the
   *  message state machine continues asynchronously: RESP_SENT flips 'sending'
   *  → 'sent', PUSH_SEND_CONFIRMED flips 'sent' → 'ack'. */
  async sendDmText(
    contactKey: string,
    text: string,
    messageId: string,
    opts: { attempt?: number } = {},
  ): Promise<{ ok: boolean; error?: string }> {
    return directMessages.sendDmText(this.ctx, contactKey, text, messageId, opts);
  }

  /** Send a DM with retry + flood fallback, mirroring the official client's
   *  behavior. */
  async sendDmTextWithRetry(contactKey: string, text: string, messageId: string): Promise<{ ok: boolean; error?: string }> {
    return directMessages.sendDmTextWithRetry(this.ctx, contactKey, text, messageId);
  }

  // ---- Path management ---------------------------------------------------

  /** Write a contact's out_path back to the radio so the firmware uses it for
   *  future source-routed sends. Round-trips the contact's current type/flags/
   *  name (firmware *replaces* on update, not merges). On RESP_OK, updates
   *  local state with the new path + `pathManual`. */
  async setContactPath(
    contactKey: string,
    outPathHex: string,
    opts: { manual: boolean; preferDirect?: boolean } = { manual: true },
  ): Promise<void> {
    const state = this.state;
    const contact = state.getContacts().find((c) => c.key === contactKey);
    if (!contact) throw new Error(`unknown contact ${contactKey}`);
    if (!contact.publicKeyHex || contact.publicKeyHex.length < 64) {
      throw new Error(`contact ${contactKey} has no full 32B public key`);
    }
    const hashSize = state.getRadioSettings().pathHashMode;
    if (outPathHex.length % 2 !== 0) {
      throw new Error(`outPathHex must be even-length, got ${outPathHex.length}`);
    }
    const pathBytes = outPathHex.length / 2;
    if (pathBytes % hashSize !== 0) {
      throw new Error(`outPathHex length ${pathBytes}B must be a multiple of pathHashMode ${hashSize}B`);
    }
    const frame = encodeAddUpdateContact({
      publicKeyHex: contact.publicKeyHex,
      advType: contactKindToAdvType(contact.kind),
      flags: 0,
      outPathHex,
      name: contact.name,
    });
    await this.writeFrame(frame);
    state.upsertContact({
      ...contact,
      outPathHex: outPathHex || undefined,
      outPathHashSize: outPathHex ? hashSize : contact.outPathHashSize,
      preferDirect: opts.preferDirect ?? contact.preferDirect,
      pathManual: opts.manual,
      pathLearnedAt: opts.manual ? contact.pathLearnedAt : Date.now(),
      hops: outPathHex ? pathBytes / hashSize : undefined,
    });
    this.events.emit('contacts', state.getContacts());
  }

  /** Drop a contact's path back to flood. Mirrors CMD_RESET_PATH. */
  async resetContactPath(contactKey: string): Promise<void> {
    const state = this.state;
    const contact = state.getContacts().find((c) => c.key === contactKey);
    if (!contact) throw new Error(`unknown contact ${contactKey}`);
    if (!contact.publicKeyHex || contact.publicKeyHex.length < 64) {
      throw new Error(`contact ${contactKey} has no full 32B public key`);
    }
    await this.writeFrame(encodeResetPath(contact.publicKeyHex));
    state.upsertContact({
      ...contact,
      outPathHex: undefined,
      pathManual: true,
      hops: undefined,
    });
    this.events.emit('contacts', state.getContacts());
  }

  // ---- Contacts ----------------------------------------------------------

  /** Commit a discovered contact to the radio's store (CMD_ADD_UPDATE_CONTACT).
   *  Awaits the radio's RESP_OK/ERR before marking the contact on-radio. */
  async addContactToRadio(publicKeyHex: string): Promise<void> {
    const row = this.state.discovered.get(publicKeyHex);
    if (!row) {
      this.log.warn(`unknown discovered contact ${publicKeyHex.slice(0, 12)}`);
      throw new UnknownContactError(publicKeyHex);
    }
    const hasFix = row.gps_lat !== 0 || row.gps_lon !== 0;
    const frame = encodeAddUpdateContact({
      publicKeyHex,
      advType: row.type,
      flags: row.flags,
      outPathHex: row.out_path_len === 0xff ? '' : row.out_path_hex,
      name: row.name,
      ...(hasFix ? { gpsLat: row.gps_lat, gpsLon: row.gps_lon, lastAdvertUnix: row.last_advert_unix } : {}),
    });
    // Await the radio's reply before claiming the contact is on-radio. RESP_ERR
    // with ERR_CODE_TABLE_FULL means the store is full — surface it and leave
    // on_radio untouched rather than lying to the UI.
    const ack = this.awaitAck();
    try {
      await this.writeFrame(frame);
    } catch (err) {
      this.popPendingAck(ack.entry);
      throw err;
    }
    const result = await ack.promise;
    if (!result.ok) {
      if (result.errorCode === ERR_CODE.TABLE_FULL) {
        this.log.warn(`add contact rejected: contact table full ${publicKeyHex.slice(0, 12)}`);
        throw new ContactTableFullError();
      }
      throw new Error('radio did not confirm add-contact');
    }
    this.state.discovered.setOnRadio(publicKeyHex, true);
    upsertOnRadioContact(this.ctx, {
      publicKeyHex,
      type: row.type,
      flags: row.flags,
      outPathLen: row.out_path_len,
      outPathHex: row.out_path_hex,
      name: row.name,
      lastAdvertUnix: row.last_advert_unix,
      gpsLat: row.gps_lat,
      gpsLon: row.gps_lon,
      lastmod: row.lastmod,
    });
    emitDiscovered(this.ctx);
    scheduleContactsResync(this.ctx);
  }

  /** Delete a contact from the radio's store (CMD_REMOVE_CONTACT). Keeps it in
   *  the discovered pool, flagged off-radio. */
  async removeContactFromRadio(publicKeyHex: string): Promise<void> {
    await this.writeFrame(encodeRemoveContact(publicKeyHex));
    this.state.discovered.setOnRadio(publicKeyHex, false);
    const state = this.state;
    state.removeContact(`c:${publicKeyHex}`);
    this.events.emit('contacts', state.getContacts());
    emitDiscovered(this.ctx);
  }

  /** Toggle the favourite flag (contact flags bit 0). For on-radio contacts,
   *  round-trips CMD_ADD_UPDATE_CONTACT so the firmware persists the flag
   *  (protects from overwrite-oldest). Discovered-only contacts update locally. */
  async setContactFavourite(publicKeyHex: string, favourite: boolean): Promise<void> {
    const row = this.state.discovered.get(publicKeyHex);
    if (!row) {
      this.log.warn(`unknown discovered contact ${publicKeyHex.slice(0, 12)}`);
      throw new UnknownContactError(publicKeyHex);
    }
    if (row.on_radio !== 0) {
      const flags = favourite ? row.flags | 0x01 : row.flags & ~0x01;
      const hasFix = row.gps_lat !== 0 || row.gps_lon !== 0;
      const frame = encodeAddUpdateContact({
        publicKeyHex,
        advType: row.type,
        flags,
        outPathHex: row.out_path_len === 0xff ? '' : row.out_path_hex,
        name: row.name,
        ...(hasFix ? { gpsLat: row.gps_lat, gpsLon: row.gps_lon, lastAdvertUnix: row.last_advert_unix } : {}),
      });
      await this.writeFrame(frame);
    }
    this.state.discovered.setFavourite(publicKeyHex, favourite);
    const state = this.state;
    const existing = state.getContacts().find((c) => c.key === `c:${publicKeyHex}`);
    if (existing) {
      state.upsertContact({ ...existing, favourite });
      this.events.emit('contacts', state.getContacts());
    }
    emitDiscovered(this.ctx);
  }

  /** Toggle the per-contact "always use direct (companion-side) login" flag.
   *  Local-only; no firmware write. */
  setContactPreferDirect(contactKey: string, preferDirect: boolean): void {
    const state = this.state;
    const contact = state.getContacts().find((c) => c.key === contactKey);
    if (!contact) throw new Error(`unknown contact ${contactKey}`);
    state.upsertContact({ ...contact, preferDirect });
    this.events.emit('contacts', state.getContacts());
  }

  /** Set the radio's global path-hash mode (bytes per hop). Persists on the
   *  radio and updates local RadioSettings on RESP_OK. */
  async setPathHashMode(size: 1 | 2 | 3): Promise<void> {
    await this.writeFrame(encodeSetPathHashMode(pathHashSizeToMode(size)));
    const state = this.state;
    const current = state.getRadioSettings();
    state.setRadioSettings({ ...current, pathHashMode: size });
    this.events.emit('radioSettings', state.getRadioSettings());
  }

  /** Look up a single contact on the radio by public key, or null if absent. */
  async getContactByKey(destPublicKeyHex: string): Promise<ContactRecord | null> {
    return getContactByKey(this.ctx, destPublicKeyHex);
  }

  // ---- Channels ----------------------------------------------------------

  /** Write a channel slot (add / edit / delete). Delete = empty name + zero
   *  key, which our enumerator filters as `empty`. Returns true if the radio
   *  acked, false on RESP_ERR / timeout / disconnect. */
  async setChannel(idx: number, name: string, secretHex: string): Promise<boolean> {
    return channels.setChannel(this.ctx, idx, name, secretHex);
  }

  /** Mark a channel as present on the device. Call after a successful
   *  SET_CHANNEL ack — the firmware doesn't echo CHANNEL_INFO back, so without
   *  this the new channel would stay grayed-out in the UI until the next
   *  full re-enumeration. */
  markChannelPresent(channel: Channel): void {
    channels.markChannelPresent(this.ctx, channel);
  }

  /** Mark a slot as no longer on the device (paired with a zero-key write).
   *  Frees the slot for pickFreeSlot and clears the presence flag. */
  markChannelAbsent(idx: number): void {
    channels.markChannelAbsent(this.ctx, idx);
  }

  /** Lowest unused slot index in 0..15, or null if all 16 are taken. */
  pickFreeSlot(): number | null {
    return channels.pickFreeSlot(this.ctx);
  }

  /** Derive the 16-byte secret for a public/hashtag channel by name. Callers
   *  supplying their own secret (e.g. private channel imported from a share
   *  link) should pass it directly to setChannel instead. */
  deriveSecret(name: string): string {
    return channels.deriveChannelSecret(name);
  }

  // ---- Radio / device params (inline ack sequences) ----------------------

  /** Push LoRa modulation params (freq/bw/sf/cr) and TX power to the radio.
   *  Sent as two separate frames since the firmware splits them. Includes the
   *  trailing `clientRepeat` byte only when the connected firmware supports it
   *  (ver_code ≥ 9 — surfaced via DeviceCapabilities.repeatMode). */
  async setRadioParams(opts: {
    frequencyHz: number;
    bandwidthHz: number;
    spreadingFactor: number;
    codingRate: number;
    txPowerDbm: number;
    repeatMode: boolean;
  }): Promise<boolean> {
    if (!this.connected) return false;
    const caps = this.state.getDeviceCapabilities();
    const paramsAck = this.awaitAck();
    try {
      await this.writeFrame(
        encodeSetRadioParams({
          frequencyHz: opts.frequencyHz,
          bandwidthHz: opts.bandwidthHz,
          spreadingFactor: opts.spreadingFactor,
          codingRate: opts.codingRate,
          clientRepeat: caps.repeatMode ? opts.repeatMode : undefined,
        }),
      );
    } catch (err) {
      this.popPendingAck(paramsAck.entry);
      this.log.warn(`setRadioParams write failed: ${(err as Error).message}`);
      return false;
    }
    const ok1 = (await paramsAck.promise).ok;
    if (!ok1) return false;
    await sleep(WRITE_GAP_MS);
    const powerAck = this.awaitAck();
    try {
      await this.writeFrame(encodeSetRadioTxPower(opts.txPowerDbm));
    } catch (err) {
      this.popPendingAck(powerAck.entry);
      this.log.warn(`setRadioTxPower write failed: ${(err as Error).message}`);
      return false;
    }
    const ok2 = (await powerAck.promise).ok;
    if (!ok2) return false;
    const state = this.state;
    const next = {
      ...state.getRadioSettings(),
      frequencyHz: opts.frequencyHz,
      bandwidthHz: opts.bandwidthHz,
      spreadingFactor: opts.spreadingFactor,
      codingRate: opts.codingRate,
      txPowerDbm: opts.txPowerDbm,
      repeatMode: opts.repeatMode,
    };
    state.setRadioSettings(next);
    this.events.emit('radioSettings', next);
    return true;
  }

  /** Push the device's advertised display name. */
  async setAdvertName(name: string): Promise<boolean> {
    if (!this.connected) return false;
    const ack = this.awaitAck();
    try {
      await this.writeFrame(encodeSetAdvertName(name));
    } catch (err) {
      this.popPendingAck(ack.entry);
      this.log.warn(`setAdvertName write failed: ${(err as Error).message}`);
      return false;
    }
    const ok = (await ack.promise).ok;
    if (!ok) return false;
    const state = this.state;
    state.setDeviceIdentity({ ...state.getDeviceIdentity(), name });
    this.events.emit('deviceIdentity', state.getDeviceIdentity());
    const owner = state.getOwner();
    if (owner) {
      const nextOwner = { ...owner, name };
      state.setOwner(nextOwner);
      this.events.emit('owner', nextOwner);
    }
    return true;
  }

  /** Push device GPS coords used in self-adverts. */
  async setAdvertLatLon(lat: number, lon: number, alt?: number): Promise<boolean> {
    if (!this.connected) return false;
    const ack = this.awaitAck();
    try {
      await this.writeFrame(encodeSetAdvertLatLon(lat, lon, alt));
    } catch (err) {
      this.popPendingAck(ack.entry);
      this.log.warn(`setAdvertLatLon write failed: ${(err as Error).message}`);
      return false;
    }
    const ok = (await ack.promise).ok;
    if (!ok) return false;
    const state = this.state;
    state.setDeviceIdentity({ ...state.getDeviceIdentity(), lat, lon });
    this.events.emit('deviceIdentity', state.getDeviceIdentity());
    return true;
  }

  /** Push telemetry policy + multi-acks + advert-location-policy as one frame.
   *  The advert-location-policy flag mirrors `DeviceIdentity.sharePositionInAdvert`
   *  and `TelemetryPolicy` fields drive the rest. */
  async setOtherParams(
    policy: { base: 0 | 1 | 2; loc: 0 | 1 | 2; env: 0 | 1 | 2; multiAcks: number },
    sharePositionInAdvert: boolean,
  ): Promise<boolean> {
    if (!this.connected) return false;
    const ack = this.awaitAck();
    try {
      await this.writeFrame(
        encodeSetOtherParams({
          telemetryBase: policy.base,
          telemetryLoc: policy.loc,
          telemetryEnv: policy.env,
          advertLocationPolicy: sharePositionInAdvert ? 1 : 0,
          multiAcks: policy.multiAcks,
        }),
      );
    } catch (err) {
      this.popPendingAck(ack.entry);
      this.log.warn(`setOtherParams write failed: ${(err as Error).message}`);
      return false;
    }
    const ok = (await ack.promise).ok;
    if (!ok) return false;
    const state = this.state;
    state.setTelemetryPolicy({ ...policy });
    state.setDeviceIdentity({ ...state.getDeviceIdentity(), sharePositionInAdvert });
    this.events.emit('telemetryPolicy', state.getTelemetryPolicy());
    this.events.emit('deviceIdentity', state.getDeviceIdentity());
    return true;
  }

  /** Push the auto-add flags byte. App-side `mode`/`maxHops`/`pullToRefresh`/
   *  `showPublicKeys` are stored locally and don't go on the wire. */
  async setAutoAddConfig(flags: AutoAddFlagsInput): Promise<boolean> {
    if (!this.connected) return false;
    return setAutoAddConfig(this.ctx, flags);
  }

  /** Ask the radio for its current auto-add flags. RESP_AUTOADD_CONFIG lands in
   *  the feature handler → updates state + emits. */
  async requestAutoAddConfig(): Promise<void> {
    if (!this.connected) return;
    await requestAutoAddConfig(this.ctx);
  }

  /** Toggle the GPS module / change interval via custom-var KV. The firmware
   *  ignores intervals outside [60, 86399]; we clamp client-side too. */
  async setGpsConfig(cfg: { enabled: boolean; intervalSec: number }): Promise<boolean> {
    if (!this.connected) return false;
    const interval = Math.min(86399, Math.max(60, Math.floor(cfg.intervalSec)));
    const ack1 = this.awaitAck();
    try {
      await this.writeFrame(encodeSetCustomVar('gps', cfg.enabled));
    } catch (err) {
      this.popPendingAck(ack1.entry);
      this.log.warn(`setCustomVar(gps) write failed: ${(err as Error).message}`);
      return false;
    }
    if (!(await ack1.promise).ok) return false;
    await sleep(WRITE_GAP_MS);
    const ack2 = this.awaitAck();
    try {
      await this.writeFrame(encodeSetCustomVar('gps_interval', interval));
    } catch (err) {
      this.popPendingAck(ack2.entry);
      this.log.warn(`setCustomVar(gps_interval) write failed: ${(err as Error).message}`);
      return false;
    }
    if (!(await ack2.promise).ok) return false;
    const state = this.state;
    state.setGpsConfig({ enabled: cfg.enabled, intervalSec: interval });
    this.events.emit('gpsConfig', state.getGpsConfig());
    return true;
  }

  /** Reboot the connected device. The link drops within a few hundred ms; the
   *  transport state machine will reflect that via its own state push. */
  async reboot(): Promise<{ ok: boolean; error?: string }> {
    if (!this.connected) return { ok: false, error: 'no radio attached' };
    try {
      await this.writeFrame(buildReboot());
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** Query battery + storage. Replies land in onPacket and update DeviceInfo. */
  async requestBattAndStorage(): Promise<void> {
    if (!this.connected) return;
    try {
      await this.writeFrame(encodeGetBattAndStorage());
    } catch (err) {
      this.log.warn(`requestBattAndStorage write failed: ${(err as Error).message}`);
    }
  }

  /** Re-issue DEVICE_QUERY to refresh DeviceInfo + capabilities. */
  async requestDeviceInfo(): Promise<void> {
    if (!this.connected) return;
    try {
      await this.writeFrame(encodeDeviceQuery());
    } catch (err) {
      this.log.warn(`requestDeviceInfo write failed: ${(err as Error).message}`);
    }
  }

  /** Query the firmware's custom-var store ("gps", "gps_interval", etc.).
   *  Empty key requests all known keys. Reply: RESP_CUSTOM_VARS. */
  async requestCustomVars(key = ''): Promise<void> {
    if (!this.connected) return;
    try {
      await this.writeFrame(encodeGetCustomVar(key));
    } catch (err) {
      this.log.warn(`requestCustomVars write failed: ${(err as Error).message}`);
    }
  }

  /** Send a self-advert. `flood=true` propagates many hops (so DM-able by
   *  distant peers); `flood=false` is zero-hop (cheap, only direct neighbors). */
  async sendSelfAdvert(flood = true): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.writeFrame(buildSendSelfAdvert(flood));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  // ---- Time --------------------------------------------------------------

  /** Read the radio's RTC clock (unix seconds). */
  getDeviceTime(): Promise<number> {
    return getDeviceTime(this.ctx);
  }

  /** Set the radio's RTC clock (unix seconds). Rejects ProtocolError if the
   *  radio returns RESP_ERR (e.g. a clock earlier than its own → ILLEGAL_ARG). */
  setDeviceTime(epochSecs: number): Promise<void> {
    return setDeviceTime(this.ctx, epochSecs);
  }

  /** Push the host's current time to the radio. */
  syncDeviceTime(): Promise<void> {
    return syncDeviceTime(this.ctx);
  }

  // ---- Tuning / flood-scope / misc ---------------------------------------

  /** Read the radio airtime/backoff tuning params (CMD_GET_TUNING_PARAMS). */
  async getTuningParams(): Promise<TuningParams> {
    return getTuningParams(this.ctx);
  }

  /** Write the radio airtime/backoff tuning params (CMD_SET_TUNING_PARAMS). */
  async setTuningParams(params: TuningParams): Promise<void> {
    return setTuningParams(this.ctx, params);
  }

  /** Override the send-scope key for outgoing flood packets (set / clear / unscoped). */
  async setFloodScopeKey(input: floodScope.FloodScopeInput): Promise<void> {
    return floodScope.setFloodScopeKey(this.ctx, input);
  }

  /** Derive the 16-byte scope key for a public hashtag region (SHA-256("#name")[:16])
   *  and set it as the send-scope override. Equivalent to
   *  `setFloodScopeKey({ keyHex: deriveFloodScopeKey(region) })`. */
  async setFloodScopeRegion(region: string): Promise<void> {
    return floodScope.setFloodScopeRegion(this.ctx, region);
  }

  /** Persist the default flood scope (CMD_SET_DEFAULT_FLOOD_SCOPE). */
  async setDefaultFloodScope(name: string, keyHex: string): Promise<void> {
    return floodScope.setDefaultFloodScope(this.ctx, name, keyHex);
  }

  /** Clear the persisted default flood scope. */
  async clearDefaultFloodScope(): Promise<void> {
    return floodScope.clearDefaultFloodScope(this.ctx);
  }

  /** Read the persisted default flood scope, or null when none is set. */
  async getDefaultFloodScope(): Promise<floodScope.DefaultFloodScope | null> {
    return floodScope.getDefaultFloodScope(this.ctx);
  }

  /** Whether the radio reports an active connection to a node. */
  async hasConnection(destPublicKeyHex: string): Promise<boolean> {
    return misc.hasConnection(this.ctx, destPublicKeyHex);
  }

  /** The frequency ranges the radio is allowed to repeat on (region-dependent). */
  async getAllowedRepeatFreq(): Promise<misc.RepeatFreqRange[]> {
    return misc.getAllowedRepeatFreq(this.ctx);
  }

  // ---- Device admin / signing --------------------------------------------

  /** Export the device's 64-byte private key (hex). Rejects FeatureDisabledError
   *  on a firmware build with private-key export compiled out. */
  async exportPrivateKey(): Promise<string> {
    return deviceAdmin.exportPrivateKey(this.ctx);
  }

  /** Import a 64-byte private key (hex), replacing the device identity. Rejects
   *  ProtocolError on a bad key / FS error. */
  async importPrivateKey(privKeyHex: string): Promise<void> {
    return deviceAdmin.importPrivateKey(this.ctx, privKeyHex);
  }

  /** Set the BLE pairing PIN (0 disables it; otherwise a 6-digit number). */
  async setDevicePin(pin: number): Promise<void> {
    return deviceAdmin.setDevicePin(this.ctx, pin);
  }

  /** Wipe the device to factory state. The link drops mid-reset, so there is no
   *  reply to await (like reboot()). */
  async factoryReset(): Promise<void> {
    return deviceAdmin.factoryReset(this.ctx);
  }

  /** Sign arbitrary bytes with the device's ed25519 identity. Drives the
   *  CMD_SIGN_START → CMD_SIGN_DATA× → CMD_SIGN_FINISH state machine and
   *  returns the 64-byte signature (hex). */
  async signData(data: Buffer): Promise<string> {
    return signing.signData(this.ctx, data);
  }

  // ---- Path diagnostics --------------------------------------------------

  /** Discover the round-trip mesh path to a contact (floods a request, then
   *  awaits PUSH_PATH_DISCOVERY_RESPONSE). Rejects on dispatch error/timeout. */
  async sendPathDiscoveryReq(contactKey: string): Promise<pathDiagnostics.DiscoveredPath> {
    return pathDiagnostics.sendPathDiscoveryReq(this.ctx, contactKey);
  }

  /** The device's cached advert path for a contact, or null when none is cached. */
  async getAdvertPath(contactKey: string): Promise<pathDiagnostics.AdvertPath | null> {
    return pathDiagnostics.getAdvertPath(this.ctx, contactKey);
  }

  // ---- Raw / control / channel data --------------------------------------

  /** Send raw bytes DIRECT along a known path (CMD_SEND_RAW_DATA). */
  async sendRawData(opts: { pathHex: string; payload: Buffer }): Promise<void> {
    return rawData.sendRawData(this.ctx, opts);
  }

  /** Send a zero-hop control datagram (CMD_SEND_CONTROL_DATA). */
  async sendControlData(payload: Buffer): Promise<void> {
    return rawData.sendControlData(this.ctx, payload);
  }

  /** Broadcast a group-channel datagram (CMD_SEND_CHANNEL_DATA, flood). */
  async sendChannelData(opts: { channelIdx: number; dataType: number; payload: Buffer }): Promise<void> {
    return rawData.sendChannelData(this.ctx, opts);
  }

  /** Transmit a fully-formed mesh packet (CMD_SEND_RAW_PACKET). */
  async sendRawPacket(opts: { priority: number; packetHex: string }): Promise<void> {
    return rawData.sendRawPacket(this.ctx, opts);
  }

  // ---- Contact interop ---------------------------------------------------

  /** Re-broadcast a known contact's advert zero-hop (CMD_SHARE_CONTACT). */
  async shareContact(destPublicKeyHex: string): Promise<void> {
    return contactInterop.shareContact(this.ctx, destPublicKeyHex);
  }

  /** Export an advert blob for the device (no arg) or a known contact, or null
   *  when the contact isn't found. */
  async exportContact(destPublicKeyHex?: string): Promise<string | null> {
    return contactInterop.exportContact(this.ctx, destPublicKeyHex);
  }

  /** Import a contact from a serialized advert blob (CMD_IMPORT_CONTACT). */
  async importContact(blobHex: string): Promise<void> {
    return contactInterop.importContact(this.ctx, blobHex);
  }

  // ---- Repeater administration -------------------------------------------

  /** Request a status snapshot from a repeater/room/contact. The actual
   *  snapshot arrives later via PUSH_STATUS_RESPONSE → emit.repeaterStatus(). */
  async sendStatusReq(contactKey: string): Promise<{ ok: boolean; error?: string }> {
    return repeaterAdmin.sendStatusReq(this.ctx, contactKey);
  }

  /** Request a CayenneLPP telemetry blob from a contact. See sendStatusReq. */
  async sendTelemetryReq(contactKey: string): Promise<{ ok: boolean; error?: string }> {
    return repeaterAdmin.sendTelemetryReq(this.ctx, contactKey);
  }

  /** Login to a repeater. Returns the effective mode so the UI can label the
   *  toast (Direct / Flood / N-hop). */
  async repeaterLogin(
    contactKey: string,
    password: string,
  ): Promise<LoginSuccess & { mode: AdminMode; effective: 'direct' | 'flood' | 'path' }> {
    return repeaterAdmin.repeaterLogin(this.ctx, contactKey, password);
  }

  async repeaterLogout(contactKey: string): Promise<void> {
    return repeaterAdmin.repeaterLogout(this.ctx, contactKey);
  }

  /** Request the ACL list. Admin-only (firmware returns nothing if guest). */
  async repeaterRequestAcl(contactKey: string): Promise<AclEntry[]> {
    return repeaterAdmin.repeaterRequestAcl(this.ctx, contactKey);
  }

  async repeaterRequestNeighbours(
    contactKey: string,
    opts: { count?: number; offset?: number; orderBy?: number; prefixLen?: number } = {},
  ): Promise<NeighboursPage> {
    return repeaterAdmin.repeaterRequestNeighbours(this.ctx, contactKey, opts);
  }

  async repeaterRequestOwnerInfo(contactKey: string): Promise<OwnerInfo> {
    return repeaterAdmin.repeaterRequestOwnerInfo(this.ctx, contactKey);
  }

  /** Send a generic binary request to a contact and resolve the raw response
   *  body. `reqData` is [REQ_TYPE byte, ...params]. The ACL/neighbours/owner/
   *  avg-min-max helpers are thin wrappers over this. */
  async sendBinaryRequest(contactKey: string, reqData: Buffer, opts: { timeoutMs?: number } = {}): Promise<Buffer> {
    return repeaterAdmin.sendBinaryReq(this.ctx, contactKey, reqData, opts.timeoutMs);
  }

  /** Send a remote CLI command; the reply is routed back by sender prefix. */
  async repeaterSendCli(contactKey: string, command: string): Promise<string> {
    return repeaterAdmin.repeaterSendCli(this.ctx, contactKey, command);
  }

  /** CMD_SEND_TRACE_PATH — diagnostic trace along a known path. */
  async repeaterTracePath(opts: { tag: number; authCode: number; flags?: number; pathHex: string }): Promise<TraceData> {
    return repeaterAdmin.repeaterTracePath(this.ctx, opts);
  }

  /** CMD_GET_STATS — local stats for the directly-connected device. */
  async repeaterGetLocalStats(subtype: keyof typeof STATS_TYPE): Promise<LocalStats> {
    return repeaterAdmin.repeaterGetLocalStats(this.ctx, subtype);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function contactKindToAdvType(kind: ContactKind): number {
  switch (kind) {
    case 'repeater':
      return ADV_TYPE.REPEATER;
    case 'room':
      return ADV_TYPE.ROOM;
    case 'sensor':
      return ADV_TYPE.SENSOR;
    default:
      return ADV_TYPE.CHAT;
  }
}
