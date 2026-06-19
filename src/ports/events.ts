import { EventEmitter } from 'node:events';
import type { DiscoveredContact } from '../model/contacts';
import type { ContactRecord, ContactSource } from '../model/contactTypes';
import type {
  AutoAddConfig,
  Channel,
  Contact,
  ContactKind,
  DeviceCapabilities,
  DeviceIdentity,
  DeviceInfo,
  GpsConfig,
  Message,
  MessagePath,
  MessageState,
  Owner,
  PathLearnedEvent,
  RadioSettings,
  RepeaterStatusSnapshot,
  RepeaterTelemetrySnapshot,
  SyncProgress,
  TelemetryPolicy,
  TransportState,
} from '../model/types';
import type { MeshSource } from '../protocol/frame';

/**
 * Strongly-typed map of every event the library emits. The session owns a
 * `MeshCoreEvents` instance and exposes it as `session.events`.
 *
 * Note: there is intentionally NO generic `error` event here — the donor app's
 * `errorMessage` channel was dropped during extraction. Specific recoverable
 * conditions are surfaced as their own dedicated events instead (e.g.
 * {@link MeshCoreEventMap.contactsFull}), which adapters may map onto their own
 * error/toast channel.
 */
export interface MeshCoreEventMap {
  transportState: (s: TransportState) => void;
  rawPacket: (pkt: { hex: string; source: MeshSource; snr: number; rssi: number }) => void;
  channels: (channels: Channel[]) => void;
  channelPresence: (keys: string[]) => void;
  syncProgress: (progress: SyncProgress) => void;
  contacts: (contacts: Contact[]) => void;
  discovered: (rows: DiscoveredContact[]) => void;
  contactEvicted: (name: string) => void;
  /** The radio's contact store is full — a new advert could not be auto-added
   *  (overwrite-oldest off, or all slots favourited). Informational/recoverable:
   *  the user must remove or favourite contacts to make room. Adapters may bridge
   *  this onto their own error/toast channel. */
  contactsFull: () => void;
  contactDiscovered: (c: { key: string; name: string; kind: ContactKind }) => void;
  /** Fires whenever a contact record is ingested (sync or advert), exposing the
   *  raw decoded record so consumers can persist it themselves. */
  contactObserved: (record: ContactRecord, source: ContactSource) => void;
  messages: (key: string, messages: Message[]) => void;
  /** A single inserted/updated message — a delta companion to `messages`. */
  messageUpserted: (message: Message) => void;
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
}

/** The shape `node:events` expects for any registered listener. */
type RawListener = (...args: unknown[]) => void;

/**
 * Typed wrapper around `node:events` EventEmitter. Public method signatures are
 * fully typed against {@link MeshCoreEventMap}; the untyped `node:events` boundary
 * is bridged with a single localized cast in each method.
 */
export class MeshCoreEvents {
  private readonly emitter = new EventEmitter();

  constructor() {
    // The session and any number of consumers may subscribe; disable the
    // default 10-listener warning rather than leak a tuning knob.
    this.emitter.setMaxListeners(0);
  }

  on<K extends keyof MeshCoreEventMap>(event: K, listener: MeshCoreEventMap[K]): this {
    this.emitter.on(event as string, listener as RawListener);
    return this;
  }

  off<K extends keyof MeshCoreEventMap>(event: K, listener: MeshCoreEventMap[K]): this {
    this.emitter.off(event as string, listener as RawListener);
    return this;
  }

  once<K extends keyof MeshCoreEventMap>(event: K, listener: MeshCoreEventMap[K]): this {
    this.emitter.once(event as string, listener as RawListener);
    return this;
  }

  emit<K extends keyof MeshCoreEventMap>(event: K, ...args: Parameters<MeshCoreEventMap[K]>): void {
    this.emitter.emit(event as string, ...args);
  }

  removeAllListeners(): this {
    this.emitter.removeAllListeners();
    return this;
  }
}
