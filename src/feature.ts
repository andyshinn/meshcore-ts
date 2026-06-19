import type { Buffer } from 'node:buffer';
import type { SessionState } from './model/state/model';
import type { TransportState } from './model/types';
import type { MeshCoreEvents } from './ports/events';
import type { Logger } from './ports/logger';
import type { AdminSessionStore } from './session/adminSessions';
import type { SessionRuntime } from './session/runtime';

/** Contact-sync coordination signal emitted by the contacts feature while a
 *  GET_CONTACTS iteration streams in. The session forwards it to the
 *  handshake's progress + start/done waiters (see onContactsSync). This is an
 *  INTERNAL signal delivered via the {@link FeatureContext.contactsSync}
 *  callback — it is NOT a public event on {@link MeshCoreEvents}. */
export type ContactsSyncSignal =
  | { phase: 'start'; total: number | null }
  | { phase: 'progress'; done: number; total: number }
  | { phase: 'done'; done: number };

/** The controlled slice of a session a feature module may touch. Every shared
 *  capability is injected here per-session — the transport-facing helpers, the
 *  ports (events, log, admin) and model (state), plus the per-session mutable
 *  feature state in `rt`. Nothing is reached via module-level singletons. */
export interface FeatureContext {
  /** Write a raw companion frame to the radio. */
  writeFrame(frame: Buffer): Promise<void>;
  /** Send a frame and await its reply. With `expect`, resolves the next inbound
   *  frame whose code === expect (a typed GET reply). Without `expect`, awaits
   *  the next RESP_OK/RESP_ERR and rejects with ProtocolError on RESP_ERR. */
  request(frame: Buffer, opts?: { expect?: number; timeoutMs?: number }): Promise<Buffer>;
  /** Send a frame and await either its typed reply (code === expect) OR a
   *  RESP_ERR — for GETs that legitimately answer "not found" (e.g. no cached
   *  advert path). Resolves the typed frame, or null on RESP_ERR. The RESP_ERR
   *  is consumed via the shared ack FIFO so it can't be mistaken for a rejected
   *  DM send. Rejects on timeout / write failure / disconnect. `expect` must be
   *  a typed reply code, not RESP_OK/RESP_ERR. */
  requestOrNull(frame: Buffer, expect: number, timeoutMs?: number): Promise<Buffer | null>;
  /** Event bus the feature broadcasts on (was the module-level `emit`). */
  readonly events: MeshCoreEvents;
  /** In-memory session model the feature reads & mutates (was `stateHolder()`). */
  readonly state: SessionState;
  /** Structured logger (was `child('protocol')`). */
  readonly log: Logger;
  /** Repeater admin auth + pending-request store (was `adminSessions`). */
  readonly admin: AdminSessionStore;
  /** Per-session mutable feature state (replaces module-level let/const). */
  readonly rt: SessionRuntime;
  /** Current transport connection state (replaces transportManager.getState()). */
  getTransportState(): TransportState;
  /** INTERNAL contact-sync signal sink (was the module-level
   *  `emit.contactsSync`). The session implements this to drive the handshake's
   *  syncProgress + start/done waiters; it is NOT a public event. */
  contactsSync(signal: ContactsSyncSignal): void;
}

/** A protocol feature: owns the inbound wire codes it reacts to. Feature
 *  modules also export their own encode* / decode* functions and session-facing
 *  functions; those are wired explicitly by the session. */
export interface Feature {
  /** Inbound RESP_* / PUSH_* codes this feature decodes & reacts to. */
  readonly handles: readonly number[];
  /** React to an inbound frame whose code is one of `handles`. */
  handle(code: number, frame: Buffer, ctx: FeatureContext): void;
}
