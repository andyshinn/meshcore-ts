import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { RESP } from '../codes';
import { ProtocolError, ProtocolTimeoutError } from '../errors';
import type { ContactsSyncSignal, FeatureContext } from '../feature';
import { autoAddFeature } from '../features/autoAdd';
import { battStorageFeature, encodeGetBattAndStorage } from '../features/battStorage';
import * as channelMessages from '../features/channelMessages';
import * as channels from '../features/channels';
import { contactsFeature, encodeGetContacts, failPendingContactByKey, resetContactsIter } from '../features/contacts';
import { contactsFullFeature } from '../features/contactsFull';
import { customVarsFeature } from '../features/customVars';
import * as deviceAdmin from '../features/deviceAdmin';
import { deviceInfoFeature, encodeDeviceQuery } from '../features/deviceInfo';
import * as directMessages from '../features/directMessages';
import { drainFeature, resetDrain, scheduleDrain } from '../features/drain';
import * as pathDiagnostics from '../features/pathDiagnostics';
import * as rawData from '../features/rawData';
import * as repeaterAdmin from '../features/repeaterAdmin';
import { encodeAppStart, selfInfoFeature } from '../features/selfInfo';
import { parseCompanionFrame } from '../frame';
import { PAYLOAD_TYPE, parseMeshPacket } from '../meshPacket';
import { MeshCoreEvents } from '../ports/events';
import { type Logger, noopLogger } from '../ports/logger';
import type { Transport } from '../ports/transport';
import { FeatureRegistry } from '../registry';
import { SessionState } from '../state/model';
import type { RawPacket, SyncProgress, TransportState } from '../types';
import { DEFAULT_SYNC_PROGRESS } from '../types';
import { AdminSessionStore } from './adminSessions';
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
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
