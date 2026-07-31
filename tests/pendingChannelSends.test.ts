import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PendingChannelSends } from '../src/features/pendingChannelSends';
import type { MeshObservation } from '../src/model/meshObservations';
import { SessionState } from '../src/model/state/model';
import type { Message, MessagePath } from '../src/model/types';
import { MeshCoreEvents } from '../src/ports/events';
import { channelHashFor, channelSecretFor, encryptGrpTxt } from './support/grpTxt';

function obs(over: Partial<MeshObservation> = {}): MeshObservation {
  return {
    recordedAt: 1000,
    channelHash: 0x42,
    hashSize: 1,
    hashCount: 2,
    pathHex: 'aabb',
    finalSnr: -5,
    payloadFingerprint: 'fp-a',
    ...over,
  };
}

// ---- Tier-2 (decryptable) observation fixtures -------------------------

const SECRET = channelSecretFor('#relaytest');
const OTHER_SECRET = channelSecretFor('#somewhereelse');
const CH = channelHashFor(SECRET);

/** An observation carrying a real encrypted GRP_TXT body, the way session.ts
 *  records one. `channelHash` is always ours, so a `secretHex` override
 *  simulates a foreign channel whose hash byte collides with ours. */
function relayObs(over: { timestampUnix: number; body?: string; recordedAt?: number; secretHex?: string }): MeshObservation {
  const encryptedHex = encryptGrpTxt(over.secretHex ?? SECRET, {
    timestampUnix: over.timestampUnix,
    body: over.body ?? 'Me: hi',
  });
  return obs({
    channelHash: CH,
    recordedAt: over.recordedAt ?? 3000,
    encryptedHex,
    // Mirrors the session's fingerprint derivation so repeated hops of one
    // packet share a fingerprint.
    payloadFingerprint: createHash('sha1').update(Buffer.from(encryptedHex, 'hex')).digest('hex').slice(0, 16),
  });
}

function sentMessage(id: string): Message {
  return { id, key: 'ch:test', body: 'hi', ts: 500, state: 'sent' };
}

describe('PendingChannelSends.register / matchObservation', () => {
  it('matches an observation to a pending send by channelHash', () => {
    const sends = new PendingChannelSends();
    sends.register({ messageId: 'm1', channelHash: 0x42, sentAt: 900 });
    const match = sends.matchObservation(obs({ channelHash: 0x42 }));
    expect(match).toEqual({ messageId: 'm1' });
  });

  it('does not match a different channelHash', () => {
    const sends = new PendingChannelSends();
    sends.register({ messageId: 'm1', channelHash: 0x42, sentAt: 900 });
    expect(sends.matchObservation(obs({ channelHash: 0x99 }))).toBeNull();
  });

  // 0x88 is the RX log, so a zero-hop packet is another node's flood heard
  // directly off the air — not a repeater rebroadcast of ours.
  it('ignores zero-hop observations (hashCount === 0)', () => {
    const sends = new PendingChannelSends();
    sends.register({ messageId: 'm1', channelHash: 0x42, sentAt: 900 });
    expect(sends.matchObservation(obs({ channelHash: 0x42, hashCount: 0 }))).toBeNull();
  });

  it('locks onto the first fingerprint and rejects a different one', () => {
    const sends = new PendingChannelSends();
    sends.register({ messageId: 'm1', channelHash: 0x42, sentAt: 900 });
    // First observation locks fp-a.
    expect(sends.matchObservation(obs({ payloadFingerprint: 'fp-a' }))).toEqual({ messageId: 'm1' });
    // Same fingerprint still matches (another relay hop of the same send).
    expect(sends.matchObservation(obs({ payloadFingerprint: 'fp-a' }))).toEqual({ messageId: 'm1' });
    // A different fingerprint on the same channel is NOT attributed to us.
    expect(sends.matchObservation(obs({ payloadFingerprint: 'fp-b' }))).toBeNull();
  });

  it('evicts pending sends older than the 90s TTL', () => {
    const sends = new PendingChannelSends();
    sends.register({ messageId: 'm-old', channelHash: 0x42, sentAt: 0 });
    // A later register past TTL evicts the old one.
    sends.register({ messageId: 'm-new', channelHash: 0x42, sentAt: 91_000 });
    expect(sends.size()).toBe(1);
    // The new observation matches the surviving send.
    const match = sends.matchObservation(obs({ recordedAt: 91_000, channelHash: 0x42 }));
    expect(match).toEqual({ messageId: 'm-new' });
  });

  it('keeps a claimed send for the full 90s so late extra hops still attribute', () => {
    const sends = new PendingChannelSends();
    sends.register({ messageId: 'm1', channelHash: 0x42, sentAt: 0 });
    expect(sends.matchObservation(obs({ recordedAt: 1_000 }))).toEqual({ messageId: 'm1' });
    // A straggling hop of the same packet, well past the unclaimed window.
    expect(sends.matchObservation(obs({ recordedAt: 80_000 }))).toEqual({ messageId: 'm1' });
  });

  it('clear empties the pending buffer', () => {
    const sends = new PendingChannelSends();
    sends.register({ messageId: 'm1', channelHash: 0x42, sentAt: 900 });
    sends.clear();
    expect(sends.size()).toBe(0);
  });
});

// Regression suite for the misattribution bug: relays of a second send on the
// same channel were credited to an earlier send that was never heard, because
// the match scanned oldest-first and let any unclaimed entry claim any
// ciphertext. See tests below for each distinct failure mode.
describe('PendingChannelSends — two sends on one channel', () => {
  it('credits a relay to the send it belongs to when an earlier send went unheard', () => {
    const sends = new PendingChannelSends();
    sends.register({ messageId: 'm1', channelHash: 0x42, sentAt: 1_000 });
    sends.register({ messageId: 'm2', channelHash: 0x42, sentAt: 2_000 });

    // Nothing ever relayed m1. Both of these are hops of m2's packet.
    expect(sends.matchObservation(obs({ recordedAt: 3_000, payloadFingerprint: 'fp-m2' }))).toEqual({
      messageId: 'm2',
    });
    expect(sends.matchObservation(obs({ recordedAt: 3_100, payloadFingerprint: 'fp-m2' }))).toEqual({
      messageId: 'm2',
    });
  });

  it('still credits m1 for its own late relay after m2 has locked on', () => {
    const sends = new PendingChannelSends();
    sends.register({ messageId: 'm1', channelHash: 0x42, sentAt: 1_000 });
    sends.register({ messageId: 'm2', channelHash: 0x42, sentAt: 2_000 });

    expect(sends.matchObservation(obs({ recordedAt: 3_000, payloadFingerprint: 'fp-m2' }))).toEqual({
      messageId: 'm2',
    });
    // A third hop of m2 must keep going to m2, not drift to the unclaimed m1.
    expect(sends.matchObservation(obs({ recordedAt: 3_200, payloadFingerprint: 'fp-m2' }))).toEqual({
      messageId: 'm2',
    });
    // m1's own relay finally arrives — it belongs to m1, not m2.
    expect(sends.matchObservation(obs({ recordedAt: 3_300, payloadFingerprint: 'fp-m1' }))).toEqual({
      messageId: 'm1',
    });
  });

  it('does not match an observation recorded before the send went out', () => {
    const sends = new PendingChannelSends();
    sends.register({ messageId: 'm1', channelHash: 0x42, sentAt: 5_000 });
    expect(sends.matchObservation(obs({ recordedAt: 4_000 }))).toBeNull();
  });

  it('keeps an unclaimed send claimable seconds after it went out', () => {
    // Lower anchor on the unclaimed window: a one-way repeater relay can take
    // well over ten seconds, so a tight window would silently drop real hops.
    const sends = new PendingChannelSends();
    sends.register({ messageId: 'm1', channelHash: 0x42, sentAt: 1_000 });
    expect(sends.matchObservation(obs({ recordedAt: 16_000 }))).toEqual({ messageId: 'm1' });
  });

  it('evicts a stale entry that is not at the head of the buffer', () => {
    const sends = new PendingChannelSends();
    // Out-of-order sentAt: the head is the newest entry, so a head-only
    // while-loop stops on the first live entry and never reaches the stale one.
    sends.register({ messageId: 'm-late', channelHash: 0x42, sentAt: 100_000 });
    sends.register({ messageId: 'm-stale', channelHash: 0x42, sentAt: 1_000 });
    expect(sends.size()).toBe(2);

    // Deliberately inside the head's TTL — at 200_000 the old while-loop would
    // drain both entries and hide the bug.
    sends.matchObservation(obs({ recordedAt: 110_000, channelHash: 0x99 }));
    expect(sends.size()).toBe(1);
  });
});

describe('PendingChannelSends — plaintext-timestamp attribution', () => {
  const TS_M1 = 1_768_616_501;
  const TS_M2 = 1_768_616_502;

  it('attributes a relay to the send whose plaintext timestamp it carries', () => {
    const sends = new PendingChannelSends();
    sends.register({ messageId: 'm1', channelHash: CH, sentAt: 1_000, timestampUnix: TS_M1 });
    sends.register({ messageId: 'm2', channelHash: CH, sentAt: 2_000, timestampUnix: TS_M2 });

    expect(sends.matchObservation(relayObs({ timestampUnix: TS_M2 }), SECRET)).toEqual({ messageId: 'm2' });
  });

  it('distinguishes two sends with identical text by their timestamps', () => {
    // The trap a text-matching design falls into: same body twice, only the
    // second relayed. Only the timestamp tells them apart.
    const sends = new PendingChannelSends();
    sends.register({ messageId: 'm1', channelHash: CH, sentAt: 1_000, timestampUnix: TS_M1 });
    sends.register({ messageId: 'm2', channelHash: CH, sentAt: 2_000, timestampUnix: TS_M2 });

    const relay = relayObs({ timestampUnix: TS_M2, body: 'Me: on my way' });
    expect(sends.matchObservation(relay, SECRET)).toEqual({ messageId: 'm2' });
  });

  it("does not let a stranger's message poison a lone unclaimed send", () => {
    const sends = new PendingChannelSends();
    sends.register({ messageId: 'm1', channelHash: CH, sentAt: 1_000, timestampUnix: TS_M1 });

    // Someone else transmits on our channel inside our window.
    const stranger = relayObs({ timestampUnix: TS_M2, body: 'Bob: unrelated' });
    expect(sends.matchObservation(stranger, SECRET)).toBeNull();

    // The entry must survive unpoisoned so our own relay still lands.
    expect(sends.matchObservation(relayObs({ timestampUnix: TS_M1 }), SECRET)).toEqual({ messageId: 'm1' });
  });

  it('ignores a foreign-channel packet whose hash byte collides with ours', () => {
    const sends = new PendingChannelSends();
    sends.register({ messageId: 'm1', channelHash: CH, sentAt: 1_000, timestampUnix: TS_M1 });

    // Same channel_hash byte (1-in-256), different channel secret. Only the
    // MAC can tell this apart from one of ours.
    const foreign = relayObs({ timestampUnix: TS_M1, secretHex: OTHER_SECRET });
    expect(sends.matchObservation(foreign, SECRET)).toBeNull();

    expect(sends.matchObservation(relayObs({ timestampUnix: TS_M1 }), SECRET)).toEqual({ messageId: 'm1' });
  });

  it('attributes every hop of a timestamp-matched packet to the same send', () => {
    const sends = new PendingChannelSends();
    sends.register({ messageId: 'm1', channelHash: CH, sentAt: 1_000, timestampUnix: TS_M1 });

    expect(sends.matchObservation(relayObs({ timestampUnix: TS_M1, recordedAt: 3_000 }), SECRET)).toEqual({
      messageId: 'm1',
    });
    expect(sends.matchObservation(relayObs({ timestampUnix: TS_M1, recordedAt: 3_400 }), SECRET)).toEqual({
      messageId: 'm1',
    });
  });

  it('falls back to the heuristic for two sends sharing one timestamp', () => {
    // Two sends inside the same UNIX second are genuinely indistinguishable by
    // timestamp, so the heuristic still has to break the tie — newest first.
    const sends = new PendingChannelSends();
    sends.register({ messageId: 'm1', channelHash: CH, sentAt: 1_000, timestampUnix: TS_M1 });
    sends.register({ messageId: 'm2', channelHash: CH, sentAt: 1_400, timestampUnix: TS_M1 });
    expect(sends.matchObservation(relayObs({ timestampUnix: TS_M1 }), SECRET)).toEqual({ messageId: 'm2' });
  });

  it('falls back to the heuristic for a send registered without a timestamp', () => {
    // Consumers still on the pre-0.6.0 registerChannelSend signature keep the
    // old (weaker) behavior rather than losing relay chips entirely.
    const sends = new PendingChannelSends();
    sends.register({ messageId: 'm1', channelHash: CH, sentAt: 1_000 });
    expect(sends.matchObservation(relayObs({ timestampUnix: TS_M2 }), SECRET)).toEqual({ messageId: 'm1' });
  });

  it('falls back to the heuristic when the channel secret is unknown', () => {
    const sends = new PendingChannelSends();
    sends.register({ messageId: 'm1', channelHash: CH, sentAt: 1_000, timestampUnix: TS_M1 });
    expect(sends.matchObservation(relayObs({ timestampUnix: TS_M1 }))).toEqual({ messageId: 'm1' });
  });

  it('accepts the relay when only the second candidate secret verifies', () => {
    // Two configured channels can collide on the 1-byte hash. Stopping at the
    // first secret whose MAC fails would silently drop our own relay.
    const sends = new PendingChannelSends();
    sends.register({ messageId: 'm1', channelHash: CH, sentAt: 1_000, timestampUnix: TS_M1 });
    const relay = relayObs({ timestampUnix: TS_M1 });
    expect(sends.matchObservation(relay, [OTHER_SECRET, SECRET])).toEqual({ messageId: 'm1' });
  });

  it('rejects the packet when no candidate secret verifies', () => {
    const sends = new PendingChannelSends();
    sends.register({ messageId: 'm1', channelHash: CH, sentAt: 1_000, timestampUnix: TS_M1 });
    const foreign = relayObs({ timestampUnix: TS_M1, secretHex: channelSecretFor('#third') });
    expect(sends.matchObservation(foreign, [OTHER_SECRET, SECRET])).toBeNull();
  });
});

describe('PendingChannelSends — heuristic picks the newest send by sentAt', () => {
  it('prefers the later sentAt even when it was registered first', () => {
    // `sentAt` is caller-supplied, so registration order is not necessarily
    // send order. "Newest first" has to mean newest by sentAt, not by
    // position in the buffer.
    const sends = new PendingChannelSends();
    sends.register({ messageId: 'm-new', channelHash: 0x42, sentAt: 9_000 });
    sends.register({ messageId: 'm-old', channelHash: 0x42, sentAt: 5_000 });
    expect(sends.matchObservation(obs({ recordedAt: 10_000, payloadFingerprint: 'fp-x' }))).toEqual({
      messageId: 'm-new',
    });
  });
});

describe('PendingChannelSends.attributeObservation — colliding channel hashes', () => {
  // '#ch8' and '#ch14' really do collide on the 1-byte channel hash (0xfb).
  // With 16 channel slots configured there is a ~38% chance some pair does.
  const NAME_A = '#ch8';
  const NAME_B = '#ch14';
  const SECRET_A = channelSecretFor(NAME_A);
  const SECRET_B = channelSecretFor(NAME_B);
  const TS = 1_768_616_501;

  it('the two fixture channels share a channel hash byte', () => {
    expect(channelHashFor(SECRET_A)).toBe(channelHashFor(SECRET_B));
  });

  it('attributes a relay on the second channel even though the first is found first', () => {
    const sends = new PendingChannelSends();
    const state = new SessionState();
    const events = new MeshCoreEvents();
    // Order matters: A is what a first-match secret lookup returns, but the
    // send went out on B, so A's MAC will fail.
    state.setChannels([
      { key: `ch:${NAME_A}`, name: NAME_A, kind: 'hashtag', secretHex: SECRET_A },
      { key: `ch:${NAME_B}`, name: NAME_B, kind: 'hashtag', secretHex: SECRET_B },
    ]);
    const collidingHash = channelHashFor(SECRET_B);
    sends.register({ messageId: 'm1', channelHash: collidingHash, sentAt: 1_000, timestampUnix: TS });

    const heard: string[] = [];
    events.on('messagePathHeard', (p) => heard.push(p.id));

    const encryptedHex = encryptGrpTxt(SECRET_B, { timestampUnix: TS, body: 'Me: hi' });
    const relay = obs({
      channelHash: collidingHash,
      recordedAt: 3_000,
      encryptedHex,
      payloadFingerprint: createHash('sha1').update(Buffer.from(encryptedHex, 'hex')).digest('hex').slice(0, 16),
    });

    expect(sends.attributeObservation(relay, state, events)).toBe(true);
    expect(heard).toEqual(['m1']);
  });
});

describe('PendingChannelSends.attributeObservation', () => {
  it('emits messagePathHeard with the message id and observed path on a match', () => {
    const sends = new PendingChannelSends();
    const state = new SessionState();
    const events = new MeshCoreEvents();
    state.setOwner({ name: 'Me', publicKeyHex: 'aa'.repeat(32), publicKeyShort: 'aaaa' });
    sends.register({ messageId: 'm1', channelHash: 0x42, sentAt: 900 });

    const heard: Array<{ id: string; path: MessagePath }> = [];
    events.on('messagePathHeard', (p) => heard.push(p));

    const attributed = sends.attributeObservation(obs({ channelHash: 0x42 }), state, events);
    expect(attributed).toBe(true);

    // The event carries only the message id and the heard path — no lib state.
    expect(heard).toHaveLength(1);
    expect(Object.keys(heard[0]).sort()).toEqual(['id', 'path']);
    expect(heard[0].id).toBe('m1');
    expect(heard[0].path.id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('emits even when the matched message is unknown to the message store', () => {
    // The coresense case: a downstream app owns the message; the lib does not.
    // The relay must still surface as messagePathHeard.
    const sends = new PendingChannelSends();
    const state = new SessionState();
    const events = new MeshCoreEvents();
    sends.register({ messageId: 'ghost', channelHash: 0x42, sentAt: 900 });

    const heard: Array<{ id: string; path: MessagePath }> = [];
    events.on('messagePathHeard', (p) => heard.push(p));

    expect(sends.attributeObservation(obs({ channelHash: 0x42 }), state, events)).toBe(true);
    expect(heard).toHaveLength(1);
    expect(heard[0].id).toBe('ghost');
    expect(heard[0].path.id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('does not mutate the lib message store on a match', () => {
    // Decoupled from the store: even a message the lib happens to hold is left
    // untouched (no path appended, no sent → heard advance).
    const sends = new PendingChannelSends();
    const state = new SessionState();
    const events = new MeshCoreEvents();
    state.insertMessage(sentMessage('m1'));
    sends.register({ messageId: 'm1', channelHash: 0x42, sentAt: 900 });

    sends.attributeObservation(obs({ channelHash: 0x42 }), state, events);

    const msg = state.getMessagesForKey('ch:test')[0];
    expect(msg.state).toBe('sent');
    expect(msg.meta?.paths).toBeUndefined();
  });

  it('returns false (and emits nothing) when no pending send matches', () => {
    const sends = new PendingChannelSends();
    const state = new SessionState();
    const events = new MeshCoreEvents();
    let fired = false;
    events.on('messagePathHeard', () => {
      fired = true;
    });
    const attributed = sends.attributeObservation(obs({ channelHash: 0x42 }), state, events);
    expect(attributed).toBe(false);
    expect(fired).toBe(false);
  });
});
