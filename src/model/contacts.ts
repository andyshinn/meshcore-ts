import type { ContactKind, PathHashSize, TelemetryPerms } from './types';

/** A node we've heard an advert from. Superset of the on-radio contact list:
 *  `onRadio` marks whether it is currently committed to the radio's store. */
export interface DiscoveredContact {
  key: string; // `c:${publicKeyHex}`
  publicKeyHex: string;
  name: string;
  kind: ContactKind;
  hops?: number;
  outPathHex?: string;
  outPathHashSize?: PathHashSize;
  gpsLat?: number;
  gpsLon?: number;
  /** Last advert time stamped by the NODE's own clock, ms. Unreliable — a node
   *  with a wrong RTC can report a time in the future or far past. Shown as the
   *  secondary "advertised" timestamp, never used for the "last heard" sort. */
  lastAdvertMs?: number;
  /** Last time WE actually heard a live advert (our clock), ms. Advances on any
   *  live advert — a PUSH_ADVERT (0x80) or a PUSH_NEW_ADVERT (0x8a) — but never
   *  on a GET_CONTACTS resync or a PUSH_PATH_UPDATED, so committing a contact to
   *  the radio doesn't bump it. Undefined until first live advert. */
  lastHeardMs?: number;
  /** First time WE heard this pubkey (our clock), ms. Tracked app-side. */
  firstHeardMs: number;
  onRadio: boolean;
  favourite: boolean;
  /** Telemetry this contact may read from us (contact flags bits 1-3). */
  telemetryPerms: TelemetryPerms;
}

/** Contact flags bit 0: favourite (protected from overwrite-oldest). */
export const CONTACT_FLAG_FAVOURITE = 0x01;
const CONTACT_FLAG_TELEM_BASE = 0x02;
const CONTACT_FLAG_TELEM_LOC = 0x04;
const CONTACT_FLAG_TELEM_ENV = 0x08;
const CONTACT_FLAG_TELEM_MASK = CONTACT_FLAG_TELEM_BASE | CONTACT_FLAG_TELEM_LOC | CONTACT_FLAG_TELEM_ENV;

/** Read the telemetry permissions out of a firmware contact flags byte. The
 *  firmware reads them as `flags >> 1` against TELEM_PERM_BASE/LOCATION/
 *  ENVIRONMENT (0x01/0x02/0x04). */
export function telemetryPermsFromFlags(flags: number): TelemetryPerms {
  return {
    base: (flags & CONTACT_FLAG_TELEM_BASE) !== 0,
    loc: (flags & CONTACT_FLAG_TELEM_LOC) !== 0,
    env: (flags & CONTACT_FLAG_TELEM_ENV) !== 0,
  };
}

/** Write telemetry permissions into a contact flags byte, keeping every other
 *  bit (favourite, and any the firmware adds later) as it was. */
export function flagsWithTelemetryPerms(flags: number, perms: TelemetryPerms): number {
  const bits =
    (perms.base ? CONTACT_FLAG_TELEM_BASE : 0) |
    (perms.loc ? CONTACT_FLAG_TELEM_LOC : 0) |
    (perms.env ? CONTACT_FLAG_TELEM_ENV : 0);
  return ((flags & ~CONTACT_FLAG_TELEM_MASK) | bits) & 0xff;
}

/** Hops away, derived from a contact's stored out_path_len. This is the packed
 *  MeshCore path-length byte, NOT a raw byte count: bits 5-0 hold the hop count
 *  and bits 7-6 hold hashSize-1 (see firmware Packet::setPathHashSizeAndCount /
 *  getPathByteLen). The real path occupies hops × hashSize bytes. So a direct
 *  2-byte-mode contact stores 0x40 (hop count 0, hashSize 2) — its hop count is
 *  0, not 64. 0xFF (OUT_PATH_UNKNOWN) means no path established yet → flood. */
export function hopsFromOutPathLen(outPathLen: number): number | undefined {
  return outPathLen === 0xff ? undefined : outPathLen & 0x3f;
}

/** Bytes-per-hop for a contact's stored path, derived from the same packed
 *  out_path_len byte (bits 7-6 + 1). Lets consumers split a learned out_path
 *  into hops using the contact's OWN hash size rather than assuming the radio's
 *  current path-hash mode. 0xFF (OUT_PATH_UNKNOWN) → undefined (no path). */
export function hashSizeFromOutPathLen(outPathLen: number): PathHashSize | undefined {
  return outPathLen === 0xff ? undefined : (((outPathLen >> 6) + 1) as PathHashSize);
}

/** Map a MeshCore ADV_TYPE byte (1 chat, 2 repeater, 3 room, 4 sensor) to the
 *  app's ContactKind. Shared by the protocol contacts feature and the
 *  discovered-contact store so the mapping lives in exactly one place. */
export function advTypeToKind(type: number): ContactKind {
  switch (type) {
    case 2:
      return 'repeater';
    case 3:
      return 'room';
    case 4:
      return 'sensor';
    default:
      return 'chat';
  }
}

/** Inverse of {@link advTypeToKind}: map a ContactKind to the MeshCore ADV_TYPE
 *  byte used in CMD_ADD_UPDATE_CONTACT. Kept beside advTypeToKind so the two
 *  stay in lockstep (values mirror ADV_TYPE in protocol/codes). */
export function contactKindToAdvType(kind: ContactKind): number {
  switch (kind) {
    case 'repeater':
      return 2;
    case 'room':
      return 3;
    case 'sensor':
      return 4;
    default:
      return 1;
  }
}
