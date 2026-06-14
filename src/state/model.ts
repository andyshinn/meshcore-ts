import type { DiscoveredContact } from '../contacts/discovered';
import type {
  AutoAddConfig,
  Channel,
  Contact,
  DeviceCapabilities,
  DeviceIdentity,
  DeviceInfo,
  GpsConfig,
  Message,
  MessagePath,
  MessageState,
  Owner,
  PathHashSize,
  RadioSettings,
  TelemetryPolicy,
} from '../types';
import {
  DEFAULT_AUTO_ADD_CONFIG,
  DEFAULT_DEVICE_CAPABILITIES,
  DEFAULT_DEVICE_IDENTITY,
  DEFAULT_DEVICE_INFO,
  DEFAULT_GPS_CONFIG,
  DEFAULT_RADIO_SETTINGS,
  DEFAULT_TELEMETRY_POLICY,
} from '../types';
import { type DiscoveredRow, DiscoveredStore, type DiscoveredUpsertRecord } from './discoveredStore';

// Message state precedence — a merge only ever moves a message forward. Equal
// rank keeps the existing state (incoming must strictly out-rank to win).
const STATE_RANK: Record<MessageState, number> = {
  sending: 0,
  sent: 1,
  received: 1,
  heard: 2,
  ack: 3,
  failed: 0,
};

/** Pure in-memory session state. Holds the collections, scalars, discovered
 *  pool, and message log for one connected device. It has NO dependency on the
 *  events port and NEVER persists — features mutate this and emit separately. */
export class SessionState {
  private channels: Channel[] = [];
  private contacts: Contact[] = [];
  private owner: Owner | null = null;
  private radioSettings: RadioSettings = { ...DEFAULT_RADIO_SETTINGS };
  private deviceInfo: DeviceInfo = { ...DEFAULT_DEVICE_INFO };
  private deviceIdentity: DeviceIdentity = { ...DEFAULT_DEVICE_IDENTITY };
  private deviceCapabilities: DeviceCapabilities = { ...DEFAULT_DEVICE_CAPABILITIES };
  private autoAddConfig: AutoAddConfig = { ...DEFAULT_AUTO_ADD_CONFIG };
  private telemetryPolicy: TelemetryPolicy = { ...DEFAULT_TELEMETRY_POLICY };
  private gpsConfig: GpsConfig = { ...DEFAULT_GPS_CONFIG };

  /** The discovered-contact pool. Exposed directly so callers can reach the
   *  full store API; the named delegate methods below cover the common path. */
  readonly discovered = new DiscoveredStore();

  private messages = new Map<string, Message>();

  // ----- Channels -----

  getChannels(): Channel[] {
    return this.channels;
  }
  setChannels(next: Channel[]): void {
    this.channels = next;
  }
  upsertChannel(channel: Channel): void {
    const idx = this.channels.findIndex((c) => c.key === channel.key);
    this.channels = idx === -1 ? [...this.channels, channel] : this.channels.map((c, i) => (i === idx ? channel : c));
  }
  removeChannel(key: string): void {
    this.channels = this.channels.filter((c) => c.key !== key);
  }

  // ----- Contacts -----

  getContacts(): Contact[] {
    return this.contacts;
  }
  setContacts(next: Contact[]): void {
    this.contacts = next;
  }
  upsertContact(contact: Contact): void {
    const idx = this.contacts.findIndex((c) => c.key === contact.key);
    this.contacts = idx === -1 ? [...this.contacts, contact] : this.contacts.map((c, i) => (i === idx ? contact : c));
  }
  removeContact(key: string): void {
    this.contacts = this.contacts.filter((c) => c.key !== key);
  }

  // ----- Scalars -----

  getOwner(): Owner | null {
    return this.owner;
  }
  setOwner(next: Owner | null): void {
    this.owner = next;
  }

  getRadioSettings(): RadioSettings {
    return this.radioSettings;
  }
  setRadioSettings(next: RadioSettings): void {
    this.radioSettings = next;
  }

  getDeviceInfo(): DeviceInfo {
    return this.deviceInfo;
  }
  setDeviceInfo(next: DeviceInfo): void {
    this.deviceInfo = next;
  }

  getDeviceIdentity(): DeviceIdentity {
    return this.deviceIdentity;
  }
  setDeviceIdentity(next: DeviceIdentity): void {
    this.deviceIdentity = next;
  }

  getDeviceCapabilities(): DeviceCapabilities {
    return this.deviceCapabilities;
  }
  setDeviceCapabilities(next: DeviceCapabilities): void {
    this.deviceCapabilities = next;
  }

  getAutoAddConfig(): AutoAddConfig {
    return this.autoAddConfig;
  }
  setAutoAddConfig(next: AutoAddConfig): void {
    this.autoAddConfig = next;
  }

  getTelemetryPolicy(): TelemetryPolicy {
    return this.telemetryPolicy;
  }
  setTelemetryPolicy(next: TelemetryPolicy): void {
    this.telemetryPolicy = next;
  }

  getGpsConfig(): GpsConfig {
    return this.gpsConfig;
  }
  setGpsConfig(next: GpsConfig): void {
    this.gpsConfig = next;
  }

  // ----- Discovered pool (delegates to the DiscoveredStore) -----

  listDiscovered(hashSize: PathHashSize): DiscoveredContact[] {
    return this.discovered.list(hashSize);
  }
  getDiscovered(pubkey: string): DiscoveredRow | null {
    return this.discovered.get(pubkey);
  }
  upsertDiscovered(record: DiscoveredUpsertRecord, opts: { onRadio: boolean; nowMs: number; heardLive: boolean }): void {
    this.discovered.upsert(record, opts);
  }
  setDiscoveredOnRadio(pubkey: string, onRadio: boolean): void {
    this.discovered.setOnRadio(pubkey, onRadio);
  }
  setDiscoveredFavourite(pubkey: string, favourite: boolean): void {
    this.discovered.setFavourite(pubkey, favourite);
  }
  reconcileDiscoveredOnRadio(onRadioPubkeys: string[]): void {
    this.discovered.reconcileOnRadio(onRadioPubkeys);
  }

  // ----- Messages -----

  /** Most-recent `limit` messages across all keys, presented ts ascending. */
  getRecentMessages(limit = 500): Message[] {
    return [...this.messages.values()]
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit)
      .reverse();
  }

  /** Messages for one key, ts ascending. `before` selects strictly-older
   *  messages; `limit` caps to the newest `limit` of the window. */
  getMessagesForKey(key: string, opts: { limit?: number; before?: number } = {}): Message[] {
    const limit = opts.limit ?? 200;
    let rows = [...this.messages.values()].filter((m) => m.key === key);
    if (opts.before !== undefined) rows = rows.filter((m) => m.ts < (opts.before as number));
    return rows
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit)
      .reverse();
  }

  /** Insert or replace a message by id (no merge). */
  insertMessage(message: Message): void {
    this.messages.set(message.id, message);
  }

  /** Insert a new Message, or merge into the existing row when the id collides
   *  (channel-msg ids are deterministic by ts + body so multi-path receipts hit
   *  the same row). Merge rules:
   *    - paths are unioned by MessagePath.id (keep existing first, then add new)
   *    - timesHeard increments by 1
   *    - ts keeps the earliest receipt
   *    - state only moves forward, never backward */
  upsertMessage(message: Message): void {
    const existing = this.messages.get(message.id);
    if (!existing) {
      const meta = message.meta ? { ...message.meta } : undefined;
      if (meta?.paths && meta.paths.length > 0 && meta.timesHeard == null) {
        meta.timesHeard = 1;
      }
      this.messages.set(message.id, { ...message, meta });
      return;
    }

    const existingPaths = existing.meta?.paths ?? [];
    const incomingPaths = message.meta?.paths ?? [];
    const byId = new Map<string, MessagePath>();
    for (const p of existingPaths) byId.set(p.id, p);
    for (const p of incomingPaths) if (!byId.has(p.id)) byId.set(p.id, p);
    const mergedPaths = [...byId.values()];

    const nextState = STATE_RANK[message.state] > STATE_RANK[existing.state] ? message.state : existing.state;

    const merged: Message = {
      ...existing,
      ts: Math.min(existing.ts, message.ts),
      state: nextState,
      meta: {
        ...existing.meta,
        ...message.meta,
        paths: mergedPaths.length > 0 ? mergedPaths : undefined,
        timesHeard: (existing.meta?.timesHeard ?? 1) + 1,
      },
    };
    this.messages.set(merged.id, merged);
  }

  setMessageState(id: string, state: MessageState): void {
    const existing = this.messages.get(id);
    if (existing) this.messages.set(id, { ...existing, state });
  }

  /** Append a newly-heard relay path to an outgoing channel message. Dedupes by
   *  MessagePath.id, bumps timesHeard, and (when the message is still 'sent')
   *  advances it to 'heard'. Returns the post-update state, or null if unknown. */
  appendMessagePath(id: string, path: MessagePath): MessageState | null {
    const existing = this.messages.get(id);
    if (!existing) return null;
    const existingPaths = existing.meta?.paths ?? [];
    if (existingPaths.some((p) => p.id === path.id)) {
      return existing.state;
    }
    const nextState: MessageState = existing.state === 'sent' ? 'heard' : existing.state;
    const merged: Message = {
      ...existing,
      state: nextState,
      meta: {
        ...existing.meta,
        paths: [...existingPaths, path],
        timesHeard: (existing.meta?.timesHeard ?? 0) + 1,
      },
    };
    this.messages.set(merged.id, merged);
    return nextState;
  }
}
