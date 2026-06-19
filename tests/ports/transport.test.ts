import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { type Models, Transports } from '../../src/index.js';

describe('LoopbackTransport', () => {
  describe('send', () => {
    it('captures outbound frames in send order', async () => {
      const t = new Transports.Loopback();
      const a = Uint8Array.from([1, 2, 3]);
      const b = Uint8Array.from([4, 5]);

      await t.send(a);
      await t.send(b);

      expect(t.sent).toEqual([a, b]);
    });

    it('exposes the last sent frame as hex', async () => {
      const t = new Transports.Loopback();
      expect(t.lastSentHex()).toBeUndefined();

      await t.send(Uint8Array.from([0xde, 0xad]));
      await t.send(Uint8Array.from([0xbe, 0xef]));

      expect(t.lastSentHex()).toBe('beef');
    });
  });

  describe('onData / receive', () => {
    it('delivers an inbound frame to the onData callback', () => {
      const t = new Transports.Loopback();
      const received: Uint8Array[] = [];
      t.onData((chunk) => received.push(chunk));

      const frame = Uint8Array.from([9, 8, 7]);
      t.receive(frame);

      expect(received).toEqual([frame]);
    });

    it('delivers an inbound frame parsed from a hex string', () => {
      const t = new Transports.Loopback();
      const received: Uint8Array[] = [];
      t.onData((chunk) => received.push(chunk));

      t.receiveHex('00ff10');

      expect(received).toEqual([Uint8Array.from(Buffer.from('00ff10', 'hex'))]);
    });

    it('does not throw when no onData subscriber is set', () => {
      const t = new Transports.Loopback();
      expect(() => t.receive(Uint8Array.from([1]))).not.toThrow();
      expect(() => t.receiveHex('01')).not.toThrow();
    });
  });

  describe('state', () => {
    it('starts in the idle state', () => {
      const t = new Transports.Loopback();
      expect(t.getState()).toBe('idle');
    });

    it('setState updates getState and fires onStateChange', () => {
      const t = new Transports.Loopback();
      const seen: Models.TransportState[] = [];
      t.onStateChange((s) => seen.push(s));

      t.setState('connecting');
      t.setState('connected');

      expect(t.getState()).toBe('connected');
      expect(seen).toEqual(['connecting', 'connected']);
    });

    it('does not throw when no onStateChange subscriber is set', () => {
      const t = new Transports.Loopback();
      expect(() => t.setState('error')).not.toThrow();
      expect(t.getState()).toBe('error');
    });
  });
});
