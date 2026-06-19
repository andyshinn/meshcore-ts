import { describe, expect, it } from 'vitest';
import { PendingChannelSends } from '../src/features/pendingChannelSends';
import type { MeshObservation } from '../src/model/meshObservations';
import { SessionState } from '../src/model/state/model';
import type { Message, MessagePath } from '../src/model/types';
import { MeshCoreEvents } from '../src/ports/events';

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

  it('ignores loopback echoes (hashCount === 0)', () => {
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

  it('clear empties the pending buffer', () => {
    const sends = new PendingChannelSends();
    sends.register({ messageId: 'm1', channelHash: 0x42, sentAt: 900 });
    sends.clear();
    expect(sends.size()).toBe(0);
  });
});

describe('PendingChannelSends.attributeObservation', () => {
  it('emits messagePathHeard with the messageId and observed path on a match', () => {
    const sends = new PendingChannelSends();
    const state = new SessionState();
    const events = new MeshCoreEvents();
    state.setOwner({ name: 'Me', publicKeyHex: 'aa'.repeat(32), publicKeyShort: 'aaaa' });
    sends.register({ messageId: 'm1', channelHash: 0x42, sentAt: 900 });

    const heard: Array<{ messageId: string; path: MessagePath }> = [];
    events.on('messagePathHeard', (p) => heard.push(p));

    const attributed = sends.attributeObservation(obs({ channelHash: 0x42 }), state, events);
    expect(attributed).toBe(true);

    // The event carries only the message id and the heard path — no lib state.
    expect(heard).toHaveLength(1);
    expect(Object.keys(heard[0]).sort()).toEqual(['messageId', 'path']);
    expect(heard[0].messageId).toBe('m1');
    expect(heard[0].path.id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('emits even when the matched message is unknown to the message store', () => {
    // The coresense case: a downstream app owns the message; the lib does not.
    // The relay must still surface as messagePathHeard.
    const sends = new PendingChannelSends();
    const state = new SessionState();
    const events = new MeshCoreEvents();
    sends.register({ messageId: 'ghost', channelHash: 0x42, sentAt: 900 });

    const heard: Array<{ messageId: string; path: MessagePath }> = [];
    events.on('messagePathHeard', (p) => heard.push(p));

    expect(sends.attributeObservation(obs({ channelHash: 0x42 }), state, events)).toBe(true);
    expect(heard).toHaveLength(1);
    expect(heard[0].messageId).toBe('ghost');
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
