import { advTypeToKind, type DiscoveredContact, hopsFromOutPathLen } from '../contacts';
import type { PathHashSize } from '../types';

/** Snake_case row shape mirroring the donor sqlite `discovered_contacts` table.
 *  Kept identical so the (later-ported) contacts feature can reference
 *  `row.out_path_len` etc. unchanged. `on_radio` and `favourite` are 0/1 ints,
 *  matching the donor column representation. Block-related fields are dropped. */
export interface DiscoveredRow {
  pubkey: string;
  name: string;
  type: number;
  flags: number;
  out_path_len: number;
  out_path_hex: string;
  last_advert_unix: number;
  gps_lat: number;
  gps_lon: number;
  lastmod: number;
  first_heard_ms: number;
  last_heard_ms: number;
  on_radio: number;
  favourite: number;
}

/** Decoded advert/contact record fed into the discovered pool. Mirrors the
 *  donor protocol layer's `ContactRecord` field shape (self-contained so this
 *  module doesn't depend on the later contacts feature port). */
export interface DiscoveredUpsertRecord {
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

function rowToDiscovered(row: DiscoveredRow, hashSize: PathHashSize): DiscoveredContact {
  const hasFix = row.gps_lat !== 0 || row.gps_lon !== 0;
  const hasPath = row.out_path_len !== 0xff && row.out_path_len > 0;
  return {
    key: `c:${row.pubkey}`,
    publicKeyHex: row.pubkey,
    name: row.name || row.pubkey.slice(0, 12),
    kind: advTypeToKind(row.type),
    hops: hopsFromOutPathLen(row.out_path_len),
    outPathHex: hasPath ? row.out_path_hex : undefined,
    outPathHashSize: hasPath ? hashSize : undefined,
    gpsLat: hasFix ? row.gps_lat : undefined,
    gpsLon: hasFix ? row.gps_lon : undefined,
    lastAdvertMs: row.last_advert_unix > 0 ? row.last_advert_unix * 1000 : undefined,
    lastHeardMs: row.last_heard_ms > 0 ? row.last_heard_ms : undefined,
    firstHeardMs: row.first_heard_ms,
    onRadio: row.on_radio !== 0,
    favourite: row.favourite !== 0,
  };
}

/** In-memory replacement for the donor's sqlite `discoveredStore`. Backed by a
 *  `Map<pubkey, DiscoveredRow>`; reproduces the donor query/merge semantics
 *  exactly, minus all persistence and block-rule logic. */
export class DiscoveredStore {
  private rows = new Map<string, DiscoveredRow>();

  /** Upsert from a decoded advert/contact frame. Stamps `first_heard_ms` on the
   *  first sighting; preserves it (and the existing favourite flag) on later
   *  adverts. `onRadio` is set by the caller per context.
   *
   *  `heardLive` distinguishes a real PUSH_NEW_ADVERT (we actually heard the
   *  node) from a GET_CONTACTS resync (the device listing what it stores).
   *  `last_heard_ms` is our-clock and only advances on a live advert — it never
   *  moves on a resync (committing a contact to the radio can't bump it). */
  upsert(record: DiscoveredUpsertRecord, opts: { onRadio: boolean; nowMs: number; heardLive: boolean }): void {
    const heardMs = opts.heardLive ? opts.nowMs : 0;
    const incomingFavourite = record.flags & 0x01 ? 1 : 0;
    const existing = this.rows.get(record.publicKeyHex);
    if (!existing) {
      this.rows.set(record.publicKeyHex, {
        pubkey: record.publicKeyHex,
        name: record.name,
        type: record.type,
        flags: record.flags,
        out_path_len: record.outPathLen,
        out_path_hex: record.outPathHex,
        last_advert_unix: record.lastAdvertUnix,
        gps_lat: record.gpsLat,
        gps_lon: record.gpsLon,
        lastmod: record.lastmod,
        first_heard_ms: opts.nowMs,
        last_heard_ms: heardMs,
        on_radio: opts.onRadio ? 1 : 0,
        favourite: incomingFavourite,
      });
      return;
    }
    // Preserve favourite + first_heard_ms; refresh advert fields. Keep flags
    // bit 0 consistent with the preserved favourite so a re-advert can't drop
    // a favourite. last_heard_ms uses MAX so a resync (heardMs=0) never lowers it.
    this.rows.set(record.publicKeyHex, {
      ...existing,
      name: record.name,
      type: record.type,
      flags: (record.flags & ~1) | existing.favourite,
      out_path_len: record.outPathLen,
      out_path_hex: record.outPathHex,
      last_advert_unix: record.lastAdvertUnix,
      gps_lat: record.gpsLat,
      gps_lon: record.gpsLon,
      lastmod: record.lastmod,
      last_heard_ms: Math.max(existing.last_heard_ms, heardMs),
      on_radio: opts.onRadio ? 1 : 0,
    });
  }

  /** Projected list ordered by `last_advert_unix` descending. `hashSize` is the
   *  radio's current path-hash mode, used to split learned out-paths. */
  list(hashSize: PathHashSize): DiscoveredContact[] {
    return [...this.rows.values()]
      .sort((a, b) => b.last_advert_unix - a.last_advert_unix)
      .map((r) => rowToDiscovered(r, hashSize));
  }

  get(pubkey: string): DiscoveredRow | null {
    return this.rows.get(pubkey) ?? null;
  }

  setOnRadio(pubkey: string, onRadio: boolean): void {
    const row = this.rows.get(pubkey);
    if (row) row.on_radio = onRadio ? 1 : 0;
  }

  /** Mark on_radio for exactly the given set (used after a full GET_CONTACTS
   *  sync): rows in the set → 1, everything else → 0. */
  reconcileOnRadio(onRadioPubkeys: string[]): void {
    const onRadio = new Set(onRadioPubkeys);
    for (const row of this.rows.values()) {
      row.on_radio = onRadio.has(row.pubkey) ? 1 : 0;
    }
  }

  setFavourite(pubkey: string, favourite: boolean): void {
    const row = this.rows.get(pubkey);
    if (!row) return;
    const bit = favourite ? 1 : 0;
    row.favourite = bit;
    row.flags = (row.flags & ~1) | bit;
  }

  remove(pubkey: string): void {
    this.rows.delete(pubkey);
  }

  /** Drop discovered-only rows, keeping anything currently on the radio. */
  clearDiscoveredOnly(): void {
    for (const [pubkey, row] of this.rows) {
      if (row.on_radio === 0) this.rows.delete(pubkey);
    }
  }
}
