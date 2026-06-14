import { describe, expect, it } from 'vitest';
import type { MeshObservation } from '../src/meshObservations';
import { PendingChannelSends } from '../src/pendingChannelSends';
import { MeshCoreEvents } from '../src/ports/events';
import { SessionState } from '../src/state/model';
import type { Message, MessagePath } from '../src/types';

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
  it('appends a path to the message and emits messagePathHeard', () => {
    const sends = new PendingChannelSends();
    const state = new SessionState();
    const events = new MeshCoreEvents();
    state.setOwner({ name: 'Me', publicKeyHex: 'aa'.repeat(32), publicKeyShort: 'aaaa' });
    state.insertMessage(sentMessage('m1'));
    sends.register({ messageId: 'm1', channelHash: 0x42, sentAt: 900 });

    const heard: Array<{ id: string; path: MessagePath; state: string }> = [];
    events.on('messagePathHeard', (p) => heard.push(p));

    const attributed = sends.attributeObservation(obs({ channelHash: 0x42 }), state, events);
    expect(attributed).toBe(true);

    // The message gained a path and advanced sent → heard.
    const msg = state.getMessagesForKey('ch:test')[0];
    expect(msg.state).toBe('heard');
    expect(msg.meta?.paths).toHaveLength(1);

    // The event fired with the message id, path, and new state.
    expect(heard).toHaveLength(1);
    expect(heard[0].id).toBe('m1');
    expect(heard[0].state).toBe('heard');
    expect(heard[0].path.id).toMatch(/^[0-9a-f]{16}$/);
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

  it('returns false when the matched message is unknown to state', () => {
    const sends = new PendingChannelSends();
    const state = new SessionState();
    const events = new MeshCoreEvents();
    // Registered, but no message inserted → appendMessagePath returns null.
    sends.register({ messageId: 'ghost', channelHash: 0x42, sentAt: 900 });
    let fired = false;
    events.on('messagePathHeard', () => {
      fired = true;
    });
    expect(sends.attributeObservation(obs({ channelHash: 0x42 }), state, events)).toBe(false);
    expect(fired).toBe(false);
  });
});
