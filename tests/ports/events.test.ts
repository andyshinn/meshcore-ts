import { describe, expect, it, vi } from 'vitest';
import type { Contact, Message } from '../../src/index.js';
import { MeshCoreEvents } from '../../src/index.js';

const contact = (key: string): Contact => ({
  key,
  publicKeyHex: key,
  name: key,
  kind: 'chat',
});

describe('MeshCoreEvents', () => {
  it('delivers typed args from emit to an on listener', () => {
    const events = new MeshCoreEvents();
    const received: Contact[][] = [];
    events.on('contacts', (contacts) => received.push(contacts));

    const payload = [contact('a'), contact('b')];
    events.emit('contacts', payload);

    expect(received).toEqual([payload]);
  });

  it('delivers all args for multi-arg events', () => {
    const events = new MeshCoreEvents();
    const seen: Array<{ key: string; messages: Message[] }> = [];
    events.on('messages', (key, messages) => seen.push({ key, messages }));

    const messages: Message[] = [];
    events.emit('messages', 'c:abc', messages);

    expect(seen).toEqual([{ key: 'c:abc', messages }]);
  });

  it('off removes a previously registered listener', () => {
    const events = new MeshCoreEvents();
    const listener = vi.fn();
    events.on('contactEvicted', listener);

    events.emit('contactEvicted', 'one');
    events.off('contactEvicted', listener);
    events.emit('contactEvicted', 'two');

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('one');
  });

  it('once fires its listener exactly once', () => {
    const events = new MeshCoreEvents();
    const listener = vi.fn();
    events.once('transportState', listener);

    events.emit('transportState', 'connecting');
    events.emit('transportState', 'connected');

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('connecting');
  });

  it('removeAllListeners clears every subscription', () => {
    const events = new MeshCoreEvents();
    const a = vi.fn();
    const b = vi.fn();
    events.on('contacts', a);
    events.on('contactEvicted', b);

    events.removeAllListeners();

    events.emit('contacts', []);
    events.emit('contactEvicted', 'x');

    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  it('on returns this for chaining', () => {
    const events = new MeshCoreEvents();
    expect(events.on('contacts', () => {})).toBe(events);
    expect(events.off('contacts', () => {})).toBe(events);
    expect(events.once('contacts', () => {})).toBe(events);
    expect(events.removeAllListeners()).toBe(events);
  });
});
