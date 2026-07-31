// Side-channel buffer of recent OUTGOING channel sends.
//
// When the user transmits a channel message, every repeater in earshot that
// rebroadcasts it will also be heard by our own radio — each rebroadcast
// fires a PUSH_CODE_LOG_RX_DATA (0x88) frame. The firmware dedupes its own
// previously-transmitted packet, so we never see a matching
// RESP_CHANNEL_MSG_RECV_V3 for it; the only signal that someone heard us is
// the 0x88 frame itself.
//
// This module remembers our recent sends keyed by channelHash and lets the
// RX-side code ask "is this incoming observation a relay of one of my outgoing
// messages?".
//
// ---- How a match is decided --------------------------------------------
//
// Attribution must answer a question about *identity*, and channelHash alone
// cannot: it is one byte shared by every message on the channel, ours and
// everyone else's. Two strategies run in order.
//
// 1. Plaintext timestamp (authoritative). Every GRP_TXT packet carries the
//    originating node's UNIX timestamp inside the ciphertext, and we know the
//    timestamp we put in our own send. When the observation can be decrypted
//    with the channel secret, comparing that timestamp is a 32-bit identity
//    check, and the 2-byte MAC additionally proves the packet really is on our
//    channel rather than a foreign one whose hash byte happens to collide.
//    A clean decrypt is therefore conclusive in *both* directions: it can
//    attribute the relay, and it can rule the packet out entirely.
//
// 2. Fingerprint heuristic (fallback). Used when we hold no secret for the
//    channel, the observation carries no ciphertext, or the send was
//    registered without a timestamp. Entries already locked onto a ciphertext
//    are matched first, so a stale unclaimed entry can never shadow a
//    correctly-locked newer one; only then may an unclaimed entry claim a new
//    ciphertext — the one with the newest `sentAt`, and never for an
//    observation that predates it.
//
// The ordering matters and the *fallback* is genuinely a guess: two sends on
// one channel where only the second is relayed are indistinguishable without
// the timestamp. Newest-first is the better guess, not a correct answer —
// which is why registering a timestamp is strongly preferred.
//
// Matching on the timestamp rather than on the decrypted text is deliberate:
// the same body sent twice produces two identical texts, and a text match
// would credit both to whichever send came first — reintroducing exactly the
// misattribution this module exists to prevent.
//
// Zero-hop observations (hashCount === 0) are ignored: 0x88 is the RX log, so
// a zero-hop packet is another node's flood that reached us directly off the
// air rather than via a repeater. It is somebody else's transmission, not a
// rebroadcast of ours, and never evidence that we were heard.
//
// Refactored from module-level globals to a per-session class that OWNS the
// pending buffer. The events port and session state are passed explicitly into
// `attributeObservation` (rather than imported as singletons) to keep this
// module free of import cycles.

import { Buffer } from 'node:buffer';
import type { MeshObservation } from '../model/meshObservations';
import { buildPath, channelHashOf } from '../model/paths';
import type { SessionState } from '../model/state/model';
import type { MeshCoreEvents } from '../ports/events';
import { decryptGrpTxt } from '../protocol/channelCrypto';

/** How long a send whose relay we have already heard keeps accepting further
 *  hops of that same packet. Flood rebroadcasts trickle in over a long tail,
 *  and once the ciphertext is locked in a late hop can be matched with
 *  certainty, so this stays generous. */
const CLAIMED_TTL_MS = 90_000;

/** How long a send nobody has relayed yet stays eligible to claim a
 *  ciphertext. Deliberately shorter than CLAIMED_TTL_MS: an unclaimed entry is
 *  the dangerous one — under the fingerprint fallback it will claim whatever
 *  lands next — so it must not linger for the full retention window.
 *
 *  It cannot be tightened much further, though. This budgets a ONE-WAY relay,
 *  and directMessages' PER_ATTEMPT_TIMEOUT_MS allows 30s for a three-hop
 *  ROUND trip, so a single relayed hop can easily exceed ten seconds. A window
 *  shorter than that would silently drop path chips for messages that
 *  genuinely were heard. */
const UNCLAIMED_TTL_MS = 30_000;

export interface PendingSend {
  messageId: string;
  channelHash: number;
  sentAt: number;
  /** UNIX seconds written into the packet we transmitted. When present (and
   *  the channel secret is known) this is the authoritative match key. */
  timestampUnix?: number;
  /** Set after the first matching observation. Null until we lock onto a
   *  ciphertext. */
  fingerprint: string | null;
}

export class PendingChannelSends {
  private readonly pending: PendingSend[] = [];

  /** Drop entries past their TTL. Scans the whole buffer rather than shifting
   *  from the head: `sentAt` is caller-supplied and entries carry different
   *  TTLs depending on whether they are claimed, so the array is not ordered
   *  by expiry and a head-only loop would stop at the first live entry and
   *  strand everything behind it. */
  private evict(now: number): void {
    for (let i = this.pending.length - 1; i >= 0; i -= 1) {
      const entry = this.pending[i];
      const ttl = entry.fingerprint === null ? UNCLAIMED_TTL_MS : CLAIMED_TTL_MS;
      if (now - entry.sentAt > ttl) this.pending.splice(i, 1);
    }
  }

  register(params: { messageId: string; channelHash: number; sentAt: number; timestampUnix?: number }): void {
    this.evict(params.sentAt);
    this.pending.push({ ...params, fingerprint: null });
  }

  /** Returns the messageId this observation should be attributed to, or null if
   *  no pending send matches. Must be called for every recorded mesh
   *  observation.
   *
   *  `channelSecrets` holds every secret a channel with `obs.channelHash`
   *  could be using. The channel hash is a single byte, so two configured
   *  channels collide on it about once in 256 — pass all of them and let the
   *  MAC pick. Supplying secrets enables the authoritative timestamp match
   *  described at the top of this file; omitting them falls back to the
   *  fingerprint heuristic. */
  matchObservation(obs: MeshObservation, channelSecrets?: string | readonly string[] | null): { messageId: string } | null {
    if (obs.hashCount === 0) return null;
    this.evict(obs.recordedAt);

    const candidates = this.pending.filter((entry) => entry.channelHash === obs.channelHash);
    if (candidates.length === 0) return null;

    const secrets = typeof channelSecrets === 'string' ? [channelSecrets] : (channelSecrets ?? []);
    let pool = candidates;
    if (secrets.length > 0 && obs.encryptedHex) {
      const encrypted = Buffer.from(obs.encryptedHex, 'hex');
      // First secret whose MAC verifies identifies the channel. Trying only one
      // would drop our own relay whenever a different configured channel
      // happened to be checked first.
      let plain = null;
      for (const secret of secrets) {
        plain = decryptGrpTxt(secret, encrypted);
        if (plain) break;
      }
      // No secret verified: this packet is not on any channel we can read, just
      // a colliding channel-hash byte. It must not claim an entry, and — just
      // as importantly — must not poison one by locking a stranger's ciphertext
      // onto it.
      if (!plain) return null;

      const sameTs = candidates.filter((entry) => entry.timestampUnix === plain.timestampUnix);
      if (sameTs.length === 1) {
        const entry = sameTs[0];
        entry.fingerprint ??= obs.payloadFingerprint;
        return { messageId: entry.messageId };
      }
      // Either several of our sends share this timestamp (two transmits inside
      // one second), or none do. In the first case the timestamp cannot break
      // the tie and the heuristic must; in the second, every entry that
      // carries a timestamp is provably not this packet, leaving only the
      // untimestamped ones ambiguous.
      pool = sameTs.length > 1 ? sameTs : candidates.filter((entry) => entry.timestampUnix === undefined);
      if (pool.length === 0) return null;
    }

    // An entry already locked onto this exact ciphertext owns it outright —
    // checked before any claiming so an older unclaimed entry cannot shadow it.
    for (const entry of pool) {
      if (entry.fingerprint === obs.payloadFingerprint) return { messageId: entry.messageId };
    }
    // Otherwise the newest unclaimed send that could causally have produced it
    // takes it. An observation recorded before the send went out cannot be a
    // relay of that send.
    //
    // "Newest" means newest by `sentAt`, not last in the buffer: `sentAt` is
    // caller-supplied, so registration order need not be send order. Ties fall
    // to the later registration.
    let newest: PendingSend | null = null;
    for (const entry of pool) {
      if (entry.fingerprint !== null) continue;
      if (obs.recordedAt < entry.sentAt) continue;
      if (newest === null || entry.sentAt >= newest.sentAt) newest = entry;
    }
    if (newest) {
      newest.fingerprint = obs.payloadFingerprint;
      return { messageId: newest.messageId };
    }
    return null;
  }

  /** Match observation → build path → broadcast on the bus. Returns true if the
   *  observation was attributed to a pending send (so the caller can log / skip
   *  further work).
   *
   *  Intentionally does NOT touch the message store: the emit fires on a match
   *  alone, regardless of whether the library happens to hold the message. This
   *  keeps the library stateless about message ownership — consumers correlate
   *  the emitted `id` to their own message and own its state. `state` is read
   *  for the owner name used to label the synthesized path origin, and for the
   *  channel secret that enables timestamp-accurate attribution. */
  attributeObservation(obs: MeshObservation, state: SessionState, events: MeshCoreEvents): boolean {
    const match = this.matchObservation(obs, secretsForChannelHash(state, obs.channelHash));
    if (!match) return false;
    const owner = state.getOwner();
    // Repeater relays don't carry the original sender name in the 0x88 frame;
    // we synthesize the origin as our own radio so the path renders sink-side
    // correctly. The renderer's PathViewer treats the origin name as a label.
    const path = buildPath(obs.pathHex, obs.hashSize, obs.finalSnr, owner?.name ?? null, owner?.name);
    events.emit('messagePathHeard', { id: match.messageId, path });
    return true;
  }

  size(): number {
    return this.pending.length;
  }

  clear(): void {
    this.pending.length = 0;
  }
}

/** Secrets of every known channel whose hash byte is `channelHash`.
 *
 *  Returns all of them, not the first: the hash is a single byte, so two
 *  configured channels collide on it roughly once in 256 (about a 38% chance
 *  that some pair does, across a full 16 slots). Returning only the first would
 *  hand the match a secret whose MAC cannot verify and silently drop a relay of
 *  our own send on the other channel. The MAC picks the right one. */
function secretsForChannelHash(state: SessionState, channelHash: number): string[] {
  const secrets: string[] = [];
  for (const channel of state.getChannels()) {
    if (channel.secretHex && channelHashOf(channel) === channelHash) secrets.push(channel.secretHex);
  }
  return secrets;
}
