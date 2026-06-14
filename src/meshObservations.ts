// Side-channel buffer of recent flood receptions.
//
// Each PUSH_CODE_LOG_RX_DATA (0x88) frame whose mesh payload decodes to a
// GRP_TXT packet gets recorded here. Later, when the firmware drains the
// matching RESP_CHANNEL_MSG_RECV_V3 (0x11), `consumeMatching` returns every
// recorded observation that matches the channel hash + hop count — those
// observations become the Message's `meta.paths`.
//
// Why a side buffer instead of joining inline: the 0x88 and 0x11 frames
// arrive on different firmware code paths. 0x88 fires for every successful
// LoRa receive (including duplicates of the same flood); 0x11 fires once per
// decrypted message via the offline-queue drain. The two only loosely
// correlate by `channel_hash + hashCount`, plus arrival proximity.
//
// Refactored from module-level globals to a per-session class that OWNS the
// buffer. Pure: no events/state deps.

const TTL_MS = 60_000;
const CAP = 256;

export interface MeshObservation {
  recordedAt: number;
  /** First byte of sha256(channel.secret) — present on GRP_TXT/GRP_DATA in the
   *  payload's first byte. Used to filter matches to the right channel. */
  channelHash: number;
  hashSize: number;
  hashCount: number;
  pathHex: string;
  finalSnr: number;
  /** Hash of the encrypted payload bytes (everything after the channel_hash
   *  byte). Identical across multi-path receipts of the same message, so the
   *  lookup can also disambiguate when two channel msgs collide in the same
   *  window with the same hop count. */
  payloadFingerprint: string;
}

export class MeshObservations {
  private readonly buf: MeshObservation[] = [];

  private evict(now: number): void {
    while (this.buf.length > 0 && now - this.buf[0].recordedAt > TTL_MS) {
      this.buf.shift();
    }
    while (this.buf.length > CAP) {
      this.buf.shift();
    }
  }

  record(obs: MeshObservation): void {
    this.evict(obs.recordedAt);
    this.buf.push(obs);
  }

  /** Return (and remove) every observation matching `channelHash` and
   *  `hashCount`. When multiple distinct messages match (different
   *  `payloadFingerprint`), only the freshest fingerprint's group is returned —
   *  that's the cluster that most likely produced the channel msg the caller
   *  just received. */
  consumeMatching(channelHash: number, hashCount: number): MeshObservation[] {
    const now = Date.now();
    this.evict(now);
    const matches: MeshObservation[] = [];
    const keep: MeshObservation[] = [];
    for (const o of this.buf) {
      if (o.channelHash === channelHash && o.hashCount === hashCount) {
        matches.push(o);
      } else {
        keep.push(o);
      }
    }
    if (matches.length === 0) return [];
    // Pick the freshest fingerprint cluster (multiple GRP_TXT msgs on the same
    // channel with the same hop count is rare but possible inside the window).
    matches.sort((a, b) => b.recordedAt - a.recordedAt);
    const freshest = matches[0].payloadFingerprint;
    const taken: MeshObservation[] = [];
    for (const o of matches) {
      if (o.payloadFingerprint === freshest) taken.push(o);
      else keep.push(o);
    }
    this.buf.length = 0;
    this.buf.push(...keep);
    return taken;
  }

  size(): number {
    return this.buf.length;
  }

  clear(): void {
    this.buf.length = 0;
  }
}
