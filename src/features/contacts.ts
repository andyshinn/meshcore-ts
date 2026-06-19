import { Buffer } from 'node:buffer';
import { advTypeToKind, hopsFromOutPathLen } from '../contacts/discovered';
import type { Feature, FeatureContext } from '../feature';
import { ADV_TYPE, CMD, PUSH, RESP } from '../protocol/codes';
import { parsePublicKey } from '../protocol/pubkey';
import type { Contact } from '../types';

// ---- Wire types --------------------------------------------------------

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

// CMD_ADD_UPDATE_CONTACT serialises a complete contact record (see
// encodeAddUpdateContact). The firmware *replaces* every field rather than
// merging, so callers must echo the current type/flags/name etc. when only
// changing one field.
export interface UpdateContactInput {
  publicKeyHex: string;
  advType: number;
  flags: number;
  /** Hex string of the out_path bytes (length <= 64). Empty = flood. */
  outPathHex: string;
  /** UTF-8 name; truncated to 31 bytes (leaving room for the null terminator). */
  name: string;
  /** Wall-clock unix seconds for the firmware's `timestamp` slot. Falls back
   *  to `Math.floor(Date.now()/1000)` when unset. */
  timestampUnix?: number;
  /** Optional GPS + last-advert tail. Either ALL provided or ALL omitted. */
  gpsLat?: number;
  gpsLon?: number;
  lastAdvertUnix?: number;
}

// ---- Encoders ----------------------------------------------------------

// CMD_GET_CONTACTS: enumerate the radio's contact store. Replies are
//   RESP_CONTACTS_START [code][count u32 LE]
//   RESP_CONTACT × N (per writeContactRespFrame)
//   RESP_END_OF_CONTACTS [code][most_recent_lastmod u32 LE]
// Optional `since` parameter filters to contacts modified after that lastmod
// (used for incremental sync; omit for a full enumeration).
export function encodeGetContacts(since?: number): Buffer {
  if (since === undefined) return Buffer.from([CMD.GET_CONTACTS]);
  const out = Buffer.alloc(5);
  out[0] = CMD.GET_CONTACTS;
  out.writeUInt32LE(since >>> 0, 1);
  return out;
}

// CMD_ADD_UPDATE_CONTACT: serialise a complete contact record back to the radio
// so it overwrites the existing entry. Layout mirrors RESP_CONTACT (see
// decodeContact) with the leading cmd byte. The 12-byte GPS + last-advert tail
// is all-present or all-absent (issue #427 in zjs81/meshcore-open).
export function encodeAddUpdateContact(input: UpdateContactInput): Buffer {
  const pubkey = parsePublicKey(input.publicKeyHex, 'update contact');
  const path = Buffer.from(input.outPathHex, 'hex');
  if (path.length > 64) {
    throw new Error(`out_path is ${path.length}B, max 64`);
  }
  const name = Buffer.from(input.name, 'utf8').subarray(0, 31);

  const hasTail = input.gpsLat !== undefined && input.gpsLon !== undefined && input.lastAdvertUnix !== undefined;
  const total = hasTail ? 148 : 136;
  const out = Buffer.alloc(total);
  out[0] = CMD.ADD_UPDATE_CONTACT;
  pubkey.copy(out, 1, 0, 32);
  out[33] = input.advType & 0xff;
  out[34] = input.flags & 0xff;
  out[35] = path.length & 0xff;
  path.copy(out, 36); // remainder of the 64B region stays zero-padded
  name.copy(out, 100);
  const ts = input.timestampUnix ?? Math.floor(Date.now() / 1000);
  out.writeUInt32LE(ts >>> 0, 132);
  if (hasTail) {
    out.writeInt32LE(Math.round((input.gpsLat ?? 0) * 1_000_000), 136);
    out.writeInt32LE(Math.round((input.gpsLon ?? 0) * 1_000_000), 140);
    out.writeUInt32LE((input.lastAdvertUnix ?? 0) >>> 0, 144);
  }
  return out;
}

// CMD_RESET_PATH: [0x0d][32B pubkey]. Drops the contact's out_path → flood.
export function encodeResetPath(destPublicKeyHex: string): Buffer {
  const pubkey = parsePublicKey(destPublicKeyHex, 'reset path');
  const out = Buffer.alloc(1 + 32);
  out[0] = CMD.RESET_PATH;
  pubkey.copy(out, 1, 0, 32);
  return out;
}

// CMD_REMOVE_CONTACT: [0x0f][32B pubkey]. Deletes the contact from the radio's
// on-device store. Replies RESP_OK / RESP_ERR.
export function encodeRemoveContact(destPublicKeyHex: string): Buffer {
  const pubkey = parsePublicKey(destPublicKeyHex, 'remove contact');
  const out = Buffer.alloc(1 + 32);
  out[0] = CMD.REMOVE_CONTACT;
  pubkey.copy(out, 1, 0, 32);
  return out;
}

// CMD_GET_CONTACT_BY_KEY: [0x1e][32B pubkey]. Replies RESP_CONTACT (the full
// 148B contact frame) if the radio has it, else RESP_ERR (NOT_FOUND).
export function encodeGetContactByKey(destPublicKeyHex: string): Buffer {
  const pubkey = parsePublicKey(destPublicKeyHex, 'get contact');
  const out = Buffer.alloc(1 + 32);
  out[0] = CMD.GET_CONTACT_BY_KEY;
  pubkey.copy(out, 1, 0, 32);
  return out;
}

// ---- Decoders ----------------------------------------------------------

const CONTACT_FRAME_LEN = 1 + 32 + 1 + 1 + 1 + 64 + 32 + 4 + 4 + 4 + 4; // 148

export function decodeContact(frame: Buffer): ContactRecord | null {
  if (frame.length < CONTACT_FRAME_LEN) return null;
  const publicKeyHex = frame.subarray(1, 33).toString('hex');
  const type = frame[33];
  const flags = frame[34];
  const outPathLen = frame[35];
  // 0xFF means flood/unknown — no path bytes. Clamp corrupt values (65..254) to
  // the 64-byte region so we never read past frame[99].
  const outPathHex = outPathLen === 0xff ? '' : frame.subarray(36, 36 + Math.min(outPathLen, 64)).toString('hex');
  const nameRegion = frame.subarray(100, 132);
  const firstNull = nameRegion.indexOf(0);
  const nameBytes = firstNull === -1 ? nameRegion : nameRegion.subarray(0, firstNull);
  return {
    publicKeyHex,
    type,
    flags,
    outPathLen,
    outPathHex,
    name: nameBytes.toString('utf8'),
    lastAdvertUnix: frame.readUInt32LE(132),
    gpsLat: frame.readInt32LE(136) / 1_000_000,
    gpsLon: frame.readInt32LE(140) / 1_000_000,
    lastmod: frame.readUInt32LE(144),
  };
}

// RESP_CONTACTS_START [0x02][count u32 LE]
export function decodeContactsStart(frame: Buffer): number | null {
  if (frame.length < 5) return null;
  return frame.readUInt32LE(1);
}

// RESP_END_OF_CONTACTS [0x04][most_recent_lastmod u32 LE]
export function decodeEndOfContacts(frame: Buffer): number | null {
  if (frame.length < 5) return null;
  return frame.readUInt32LE(1);
}

// PUSH_CODE_CONTACT_DELETED [0x8f][32B pubkey] — firmware evicted a contact
// (overwrite-oldest). Returns the lowercase hex public key, or null if short.
export function decodeContactDeleted(frame: Buffer): string | null {
  if (frame.length < 1 + 32) return null;
  return frame.subarray(1, 33).toString('hex');
}

// PUSH_ADVERT [0x80][pubkey 32B] — a KNOWN contact re-advertised (the firmware
// sends the 148B PUSH_NEW_ADVERT only for newly-discovered contacts). Returns
// the lowercase hex public key, or null if short.
export function decodeAdvert(frame: Buffer): string | null {
  if (frame.length < 1 + 32) return null;
  return frame.subarray(1, 33).toString('hex');
}

// ---- Per-session feature state -----------------------------------------

const GET_CONTACT_BY_KEY_TIMEOUT_MS = 5_000;

export interface PendingContactByKey {
  publicKeyHex: string;
  resolve: (record: ContactRecord | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Per-session contacts iterator + resync + getContactByKey correlation state
 *  (was the module-level iterTotal/iterCount/syncSeen/resyncTimer/
 *  pendingContactByKey). The handshake's progress + waiters are driven by the
 *  emitted `contactsSync` signal, NOT by these directly (see onContactsSync). */
export interface ContactsIterRuntime {
  iterTotal: number;
  iterCount: number;
  syncSeen: string[];
  resyncTimer: ReturnType<typeof setTimeout> | null;
  pendingContactByKey: PendingContactByKey[];
  /** Per-pubkey debounce timers for scheduled single-contact refreshes. Keyed
   *  by publicKeyHex. Prevents a burst of PUSH_ADVERT / PUSH_PATH_UPDATED for
   *  the same contact from spamming CMD_GET_CONTACT_BY_KEY. */
  refreshTimers: Map<string, ReturnType<typeof setTimeout>>;
}

export function createContactsIterRuntime(): ContactsIterRuntime {
  return {
    iterTotal: 0,
    iterCount: 0,
    syncSeen: [],
    resyncTimer: null,
    pendingContactByKey: [],
    refreshTimers: new Map(),
  };
}

// ---- Ingest / app-logic ------------------------------------------------

/** Push the full discovered pool to the renderer. */
export function emitDiscovered(ctx: FeatureContext): void {
  ctx.events.emit('discovered', ctx.state.discovered.list(ctx.state.getRadioSettings().pathHashMode));
}

/** Whether the firmware would auto-store an advert of this ADV_TYPE, given the
 *  current auto-add config. Used to decide whether to re-sync after a
 *  not-on-radio advert. */
export function shouldAutoAdd(ctx: FeatureContext, advType: number): boolean {
  const cfg = ctx.state.getAutoAddConfig();
  if (cfg.mode === 'all') return true;
  switch (advType) {
    case ADV_TYPE.REPEATER:
      return cfg.repeater;
    case ADV_TYPE.ROOM:
      return cfg.room;
    case ADV_TYPE.SENSOR:
      return cfg.sensor;
    default:
      return cfg.chat;
  }
}

/** Debounced full re-sync (CMD_GET_CONTACTS) after an auto-addable advert. */
export function scheduleContactsResync(ctx: FeatureContext): void {
  if (ctx.rt.contactsIter.resyncTimer) return;
  ctx.rt.contactsIter.resyncTimer = setTimeout(() => {
    ctx.rt.contactsIter.resyncTimer = null;
    void ctx.writeFrame(encodeGetContacts()).catch((err) => {
      ctx.log.warn(`contacts re-sync failed: ${(err as Error).message}`);
    });
  }, 1500);
}

/** Debounced single-contact refresh (CMD_GET_CONTACT_BY_KEY) after a
 *  PUSH_ADVERT or PUSH_PATH_UPDATED for a known contact. The firmware updates
 *  its in-memory record (name/gps/flags on advert; out_path on path-updated)
 *  but only pushes the 32-byte pubkey, so we re-fetch the full record and
 *  ingest it so the updated fields are visible without waiting for a full sync.
 *
 *  Non-blocking: the fetch is fire-and-forget (no await in the frame handler).
 *  De-duplicated: a per-pubkey debounce timer ensures a burst of pushes for
 *  the same contact fires only one request. A second pending lookup for the
 *  same pubkey is also suppressed when one is already in flight. */
export function scheduleContactRefresh(ctx: FeatureContext, publicKeyHex: string): void {
  // If there's already a pending in-flight lookup for this pubkey, skip — the
  // arriving RESP_CONTACT will be consumed by resolvePendingContactByKey and
  // then ingested below.
  if (ctx.rt.contactsIter.pendingContactByKey.some((e) => e.publicKeyHex === publicKeyHex)) return;
  // Debounce: if a refresh is already scheduled for this pubkey, let it fire.
  if (ctx.rt.contactsIter.refreshTimers.has(publicKeyHex)) return;
  const timer = setTimeout(() => {
    ctx.rt.contactsIter.refreshTimers.delete(publicKeyHex);
    // Fire-and-forget: fetch the single contact and ingest the updated record.
    getContactByKey(ctx, publicKeyHex)
      .then((record) => {
        if (record) {
          ingestContact(ctx, record, 'sync');
          ctx.log.debug(`refreshed contact ${publicKeyHex.slice(0, 12)} after push`);
        }
      })
      .catch((err) => {
        ctx.log.warn(`contact refresh failed for ${publicKeyHex.slice(0, 12)}: ${(err as Error).message}`);
      });
  }, 50);
  ctx.rt.contactsIter.refreshTimers.set(publicKeyHex, timer);
}

/** Upsert a contact from a RESP_CONTACT / PUSH_NEW_ADVERT frame. When the
 *  contact matches an existing placeholder (`c:<6-byte-prefix>`), the
 *  placeholder is removed; messages already keyed to the placeholder stay
 *  there (cheap to leave — future cleanup can migrate them). */
export function upsertOnRadioContact(ctx: FeatureContext, record: ContactRecord): void {
  const fullKey = `c:${record.publicKeyHex}`;
  const prefix6 = record.publicKeyHex.slice(0, 12);
  const existing = ctx.state.getContacts().find((c) => c.key === fullKey);
  // The radio re-pushes the full contact record on every advert; preserve
  // local-only fields the firmware doesn't know about.
  const hashSize = ctx.state.getRadioSettings().pathHashMode;
  const advertOutPathHex = record.outPathLen === 0xff ? '' : record.outPathHex;
  // Don't let a stray advert that reports "no path" wipe a path the user
  // just set manually — the firmware can occasionally re-emit a contact
  // entry with path_len=0 right after we write CMD_ADD_UPDATE_CONTACT (the
  // advert was generated mid-flight). Only allow overwrites when the advert
  // carries a non-empty path, OR when the existing entry wasn't manually
  // set. Auto-learned paths (pathManual=false) still defer to firmware.
  const newOutPathHex =
    advertOutPathHex.length === 0 && existing?.pathManual === true ? (existing.outPathHex ?? '') : advertOutPathHex;
  const pathChanged = (existing?.outPathHex ?? '') !== newOutPathHex;

  const contact: Contact = {
    key: fullKey,
    publicKeyHex: record.publicKeyHex,
    name: record.name || record.publicKeyHex.slice(0, 12),
    kind: advTypeToKind(record.type),
    lastSeenMs: record.lastAdvertUnix > 0 ? record.lastAdvertUnix * 1000 : existing?.lastSeenMs,
    hops: hopsFromOutPathLen(record.outPathLen),
    favourite: (record.flags & 0x01) !== 0,
    outPathHex: newOutPathHex || undefined,
    outPathHashSize: newOutPathHex ? hashSize : existing?.outPathHashSize,
    preferDirect: existing?.preferDirect,
    // If the radio's view of the path drifted away from a path the user set
    // by hand, drop the manual flag — the firmware is the source of truth.
    pathManual: pathChanged ? false : existing?.pathManual,
    pathLearnedAt: pathChanged && newOutPathHex ? Date.now() : existing?.pathLearnedAt,
    // Adverts carry the radio's last GPS fix. 0/0 is the firmware default for
    // radios without a GPS module — treat as "no fix" and fall back to the
    // last known position instead of nuking it.
    gpsLat: record.gpsLat !== 0 || record.gpsLon !== 0 ? record.gpsLat : existing?.gpsLat,
    gpsLon: record.gpsLat !== 0 || record.gpsLon !== 0 ? record.gpsLon : existing?.gpsLon,
  };
  ctx.state.upsertContact(contact);

  // Reconcile a synth placeholder we created for a prior incoming DM whose
  // sender we hadn't seen an advert for yet.
  const placeholderKey = `c:${prefix6}`;
  if (placeholderKey !== fullKey && ctx.state.getContacts().some((c) => c.key === placeholderKey)) {
    ctx.state.removeContact(placeholderKey);
    ctx.log.debug(`reconciled placeholder ${placeholderKey} → ${fullKey}`);
  }

  ctx.events.emit('contacts', ctx.state.getContacts());
}

/** Where an ingested contact was heard: `'sync'` (RESP_CONTACT during the
 *  GET_CONTACTS handshake — always on-radio) or `'advert'` (live PUSH_NEW_ADVERT
 *  — on-radio only if already in the store). */
export type ContactSource = 'sync' | 'advert';

/** Upsert a contact heard from RESP_CONTACT (sync, on-radio) or
 *  PUSH_NEW_ADVERT (live advert — on-radio only if already in the store).
 *  Always records into the discovered pool with an app-tracked first-heard. */
export function ingestContact(ctx: FeatureContext, record: ContactRecord, source: ContactSource): void {
  const fullKey = `c:${record.publicKeyHex}`;
  const alreadyOnRadio = ctx.state.getContacts().some((c) => c.key === fullKey);
  const onRadio = source === 'sync' ? true : alreadyOnRadio;

  // First-ever sighting: no row in the discovered pool yet (checked before
  // the upsert below). Only a live advert is a "discovery" — a GET_CONTACTS
  // sync is just the device listing what it already stores.
  const isNewDiscovery = source === 'advert' && ctx.state.discovered.get(record.publicKeyHex) === null;

  ctx.state.discovered.upsert(record, {
    onRadio,
    nowMs: Date.now(),
    heardLive: source === 'advert',
  });

  if (onRadio) {
    upsertOnRadioContact(ctx, record);
  }
  emitDiscovered(ctx);

  if (isNewDiscovery) {
    ctx.events.emit('contactDiscovered', {
      key: fullKey,
      name: record.name || record.publicKeyHex.slice(0, 12),
      kind: advTypeToKind(record.type),
    });
  }

  if (source === 'advert' && !onRadio && shouldAutoAdd(ctx, record.type)) {
    scheduleContactsResync(ctx);
  }

  // Single chokepoint for both sync (RESP_CONTACT) and advert ingestion — one
  // emit surfaces the raw decoded record to consumers that persist it.
  ctx.events.emit('contactObserved', record, source);
}

// ---- Inbound feature ---------------------------------------------------

/** Clear the iterator counters + any pending resync (called on disconnect). */
export function resetContactsIter(ctx: FeatureContext): void {
  ctx.rt.contactsIter.iterTotal = 0;
  ctx.rt.contactsIter.iterCount = 0;
  ctx.rt.contactsIter.syncSeen = [];
  if (ctx.rt.contactsIter.resyncTimer) {
    clearTimeout(ctx.rt.contactsIter.resyncTimer);
    ctx.rt.contactsIter.resyncTimer = null;
  }
  while (ctx.rt.contactsIter.pendingContactByKey.length > 0) {
    const entry = ctx.rt.contactsIter.pendingContactByKey.shift();
    if (entry) {
      clearTimeout(entry.timer);
      entry.resolve(null);
    }
  }
  for (const timer of ctx.rt.contactsIter.refreshTimers.values()) {
    clearTimeout(timer);
  }
  ctx.rt.contactsIter.refreshTimers.clear();
}

// ---- getContactByKey correlation ---------------------------------------

function removePendingContactByKey(ctx: FeatureContext, entry: PendingContactByKey): void {
  const i = ctx.rt.contactsIter.pendingContactByKey.indexOf(entry);
  if (i !== -1) ctx.rt.contactsIter.pendingContactByKey.splice(i, 1);
}

/** Resolve a pending getContactByKey whose pubkey matches this RESP_CONTACT
 *  record, so a solicited reply isn't folded into the bulk-sync iterator.
 *  Returns true when the frame was consumed as a getContactByKey reply. */
function resolvePendingContactByKey(ctx: FeatureContext, record: ContactRecord): boolean {
  const i = ctx.rt.contactsIter.pendingContactByKey.findIndex((e) => e.publicKeyHex === record.publicKeyHex);
  if (i === -1) return false;
  const [entry] = ctx.rt.contactsIter.pendingContactByKey.splice(i, 1);
  clearTimeout(entry.timer);
  entry.resolve(record);
  return true;
}

/** Resolve the oldest pending getContactByKey with null. A RESP_ERR (NOT_FOUND)
 *  with no queued ack routes here from onPacket tier-3, before failOldestDmSend.
 *  Returns true when a lookup was waiting. */
export function failPendingContactByKey(ctx: FeatureContext): boolean {
  const entry = ctx.rt.contactsIter.pendingContactByKey.shift();
  if (!entry) return false;
  clearTimeout(entry.timer);
  entry.resolve(null);
  return true;
}

/** Look up a single contact on the radio by public key (CMD_GET_CONTACT_BY_KEY).
 *  Resolves the contact record, or null when the radio doesn't have it. */
export function getContactByKey(ctx: FeatureContext, destPublicKeyHex: string): Promise<ContactRecord | null> {
  const frame = encodeGetContactByKey(destPublicKeyHex);
  // encodeGetContactByKey already validated the key; normalise to lowercase hex
  // for the pending-lookup match (record.publicKeyHex is lowercase from decode).
  const publicKeyHex = parsePublicKey(destPublicKeyHex, 'get contact').toString('hex');
  return new Promise<ContactRecord | null>((resolve, reject) => {
    const entry: PendingContactByKey = {
      publicKeyHex,
      resolve,
      timer: setTimeout(() => {
        removePendingContactByKey(ctx, entry);
        resolve(null);
      }, GET_CONTACT_BY_KEY_TIMEOUT_MS),
    };
    ctx.rt.contactsIter.pendingContactByKey.push(entry);
    ctx.writeFrame(frame).catch((err) => {
      removePendingContactByKey(ctx, entry);
      clearTimeout(entry.timer);
      reject(err as Error);
    });
  });
}

export const contactsFeature: Feature = {
  handles: [RESP.CONTACTS_START, RESP.CONTACT, RESP.END_OF_CONTACTS, PUSH.NEW_ADVERT, PUSH.ADVERT, PUSH.CONTACT_DELETED],
  handle: (code, frame, ctx) => {
    if (code === RESP.CONTACTS_START) {
      const total = decodeContactsStart(frame);
      if (total !== null) {
        ctx.rt.contactsIter.iterTotal = total;
        ctx.rt.contactsIter.iterCount = 0;
        ctx.rt.contactsIter.syncSeen = [];
        ctx.log.debug(`contacts iterator starting: total=${total}`);
      }
      ctx.contactsSync({ phase: 'start', total });
      return;
    }
    if (code === RESP.CONTACT) {
      const record = decodeContact(frame);
      // A solicited getContactByKey reply is consumed here, not folded into the
      // bulk-sync iterator (RESP_CONTACT is shared between the two).
      if (record && resolvePendingContactByKey(ctx, record)) return;
      if (record) {
        ctx.rt.contactsIter.syncSeen.push(record.publicKeyHex);
        ingestContact(ctx, record, 'sync');
        ctx.rt.contactsIter.iterCount += 1;
        // Self-heal if the radio's CONTACTS_START total was optimistic (or
        // never arrived): never let `done` exceed `total`, which would render
        // as e.g. "41/40" in the footer.
        if (ctx.rt.contactsIter.iterCount > ctx.rt.contactsIter.iterTotal) {
          ctx.rt.contactsIter.iterTotal = ctx.rt.contactsIter.iterCount;
        }
        ctx.contactsSync({
          phase: 'progress',
          done: ctx.rt.contactsIter.iterCount,
          total: ctx.rt.contactsIter.iterTotal,
        });
      }
      return;
    }
    if (code === RESP.END_OF_CONTACTS) {
      const mostRecent = decodeEndOfContacts(frame);
      ctx.log.debug(
        `contacts iterator done: ${ctx.rt.contactsIter.iterCount}/${ctx.rt.contactsIter.iterTotal} most_recent_lastmod=${mostRecent}`,
      );
      const seen = ctx.rt.contactsIter.syncSeen;
      ctx.state.discovered.reconcileOnRadio(seen);
      const seenSet = new Set(seen.map((pk) => `c:${pk}`));
      for (const c of ctx.state.getContacts()) {
        if (!seenSet.has(c.key) && c.publicKeyHex.length >= 64) {
          ctx.state.removeContact(c.key);
        }
      }
      ctx.rt.contactsIter.syncSeen = [];
      ctx.events.emit('contacts', ctx.state.getContacts());
      emitDiscovered(ctx);
      // Snap contact total to the actual delivered count so the bar reads N/N
      // even if the radio's CONTACTS_START total was optimistic.
      const done = ctx.rt.contactsIter.iterCount;
      ctx.rt.contactsIter.iterTotal = 0;
      ctx.rt.contactsIter.iterCount = 0;
      ctx.contactsSync({ phase: 'done', done });
      return;
    }
    if (code === PUSH.NEW_ADVERT) {
      const record = decodeContact(frame);
      if (record) {
        ingestContact(ctx, record, 'advert');
        ctx.log.debug(`new advert: "${record.name}" (${record.publicKeyHex.slice(0, 12)})`);
      }
      return;
    }
    if (code === PUSH.ADVERT) {
      // A known contact re-advertised — touch its last-seen so the UI reflects
      // liveness. The bare push carries only the pubkey (no timestamp), so we
      // record the moment we heard it.
      // Then schedule a non-blocking re-fetch of the full contact record so any
      // firmware-side updates (name, GPS, flags) become visible without waiting
      // for the next full GET_CONTACTS sync.
      const pubkeyHex = decodeAdvert(frame);
      if (pubkeyHex) {
        const existing = ctx.state.getContacts().find((c) => c.key === `c:${pubkeyHex}`);
        if (existing) {
          ctx.state.upsertContact({ ...existing, lastSeenMs: Date.now() });
          ctx.events.emit('contacts', ctx.state.getContacts());
          ctx.log.trace(`re-advert: touched ${pubkeyHex.slice(0, 12)}`);
          scheduleContactRefresh(ctx, pubkeyHex);
        }
      }
      return;
    }
    // PUSH.CONTACT_DELETED — firmware evicted a contact (overwrite-oldest).
    const pubkey = decodeContactDeleted(frame);
    if (pubkey) {
      // Resolve a display name before dropping the contact, for the toast.
      const name =
        ctx.state.getContacts().find((c) => c.key === `c:${pubkey}`)?.name ??
        ctx.state.discovered.get(pubkey)?.name ??
        pubkey.slice(0, 12);
      ctx.state.discovered.setOnRadio(pubkey, false);
      ctx.state.removeContact(`c:${pubkey}`);
      ctx.events.emit('contacts', ctx.state.getContacts());
      emitDiscovered(ctx);
      ctx.events.emit('contactEvicted', name);
      ctx.log.info(`contact evicted by radio: ${name} ${pubkey.slice(0, 12)}`);
    }
  },
};
