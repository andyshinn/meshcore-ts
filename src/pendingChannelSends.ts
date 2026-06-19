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
// messages?". On the first match the entry locks in the observation's
// `payloadFingerprint` — subsequent observations on the same channel only count
// as relays of the same send if their fingerprint matches too. That prevents
// another user's send on the same channel inside our window from being
// mis-attributed.
//
// Loopback echoes (hashCount === 0) are explicitly ignored — those are our
// own original TX, not a repeater hop.
//
// Refactored from module-level globals to a per-session class that OWNS the
// pending buffer. The events port and session state are passed explicitly into
// `attributeObservation` (rather than imported as singletons) to keep this
// module free of import cycles.

import type { MeshObservation } from './model/meshObservations';
import { buildPath } from './model/paths';
import type { SessionState } from './model/state/model';
import type { MeshCoreEvents } from './ports/events';

const TTL_MS = 90_000;

export interface PendingSend {
  messageId: string;
  channelHash: number;
  sentAt: number;
  /** Set after the first matching observation. Empty until we lock onto a
   *  fingerprint. */
  fingerprint: string | null;
}

export class PendingChannelSends {
  private readonly pending: PendingSend[] = [];

  private evict(now: number): void {
    while (this.pending.length > 0 && now - this.pending[0].sentAt > TTL_MS) {
      this.pending.shift();
    }
  }

  register(params: { messageId: string; channelHash: number; sentAt: number }): void {
    this.evict(params.sentAt);
    this.pending.push({ ...params, fingerprint: null });
  }

  /** Returns the messageId this observation should be attributed to, or null if
   *  no pending send matches. Must be called for every recorded mesh
   *  observation. */
  matchObservation(obs: MeshObservation): { messageId: string } | null {
    if (obs.hashCount === 0) return null;
    this.evict(obs.recordedAt);
    for (const entry of this.pending) {
      if (entry.channelHash !== obs.channelHash) continue;
      if (entry.fingerprint === null) {
        entry.fingerprint = obs.payloadFingerprint;
        return { messageId: entry.messageId };
      }
      if (entry.fingerprint === obs.payloadFingerprint) {
        return { messageId: entry.messageId };
      }
    }
    return null;
  }

  /** Full pipeline: match observation → build path → append to message →
   *  broadcast on the bus. Returns true if attributed (so the caller can log /
   *  skip further work). */
  attributeObservation(obs: MeshObservation, state: SessionState, events: MeshCoreEvents): boolean {
    const match = this.matchObservation(obs);
    if (!match) return false;
    const owner = state.getOwner();
    // Repeater relays don't carry the original sender name in the 0x88 frame;
    // we synthesize the origin as our own radio so the path renders sink-side
    // correctly. The renderer's PathViewer treats the origin name as a label.
    const path = buildPath(obs.pathHex, obs.hashSize, obs.finalSnr, owner?.name ?? null, owner?.name);
    const nextState = state.appendMessagePath(match.messageId, path);
    if (!nextState) return false;
    events.emit('messagePathHeard', { id: match.messageId, path, state: nextState });
    return true;
  }

  size(): number {
    return this.pending.length;
  }

  clear(): void {
    this.pending.length = 0;
  }
}
