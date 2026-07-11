import type { ContactKind, PathHashSize } from './types';

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
  /** Last time WE actually heard a live advert (our clock), ms. Set only on a
   *  real PUSH_NEW_ADVERT, never on a GET_CONTACTS resync — so committing a
   *  contact to the radio doesn't bump it. Undefined until first live advert. */
  lastHeardMs?: number;
  /** First time WE heard this pubkey (our clock), ms. Tracked app-side. */
  firstHeardMs: number;
  onRadio: boolean;
  favourite: boolean;
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
