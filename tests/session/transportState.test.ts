import { EventEmitter } from 'node:events';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { MeshCoreSession, Transports } from '../../src/index.js';
import type { SyncProgress, TransportState } from '../../src/model/types';
import { makeSession } from '../support/harness';

// Regression: `transportState` is declared in MeshCoreEventMap and documented,
// but the session never forwarded it to the event bus. Consumers cannot work
// around that — Transport.onStateChange is a single-slot setter that the
// session claims in start(), so subscribing directly is not an option.
describe('transportState event', () => {
  it('re-emits every transport state change on the session event bus', () => {
    const { session, transport } = makeSession();
    const seen: TransportState[] = [];
    session.events.on('transportState', (s) => seen.push(s));

    transport.setState('connecting');
    transport.setState('connected');
    transport.setState('idle');

    expect(seen).toEqual(['connecting', 'connected', 'idle']);
  });

  it('emits for transitions that drive neither the connect nor the disconnect branch', () => {
    const { session, transport } = makeSession();
    const seen: TransportState[] = [];
    session.events.on('transportState', (s) => seen.push(s));

    // Never connected, so `connected` stays false throughout and both branches
    // of onTransportState are skipped — the emit must still fire.
    transport.setState('scanning');
    transport.setState('connecting');
    transport.setState('error');

    expect(seen).toEqual(['scanning', 'connecting', 'error']);
  });

  it('emits after the connect branch has run, not before', () => {
    const { session, transport } = makeSession();
    const phases: Array<SyncProgress['phase']> = [];
    session.events.on('transportState', () => phases.push(session.getSyncProgress().phase));

    transport.setState('connected');

    // The connect branch kicks off the handshake, whose first synchronous act is
    // to move sync progress to 'syncing'. A handler that ran first would see 'idle'.
    expect(phases).toEqual(['syncing']);
  });

  it('emits after the disconnect teardown has run, not before', () => {
    const { session, transport } = makeSession();
    transport.setState('connected');

    const order: string[] = [];
    const phases: Array<SyncProgress['phase']> = [];
    session.events.on('syncProgress', () => order.push('syncProgress'));
    session.events.on('transportState', () => {
      order.push('transportState');
      phases.push(session.getSyncProgress().phase);
    });

    transport.setState('idle');

    // The disconnect branch resets sync progress (and tears down awaiters,
    // presence and the correlation buffers) before the state is broadcast, so a
    // consumer never observes half-torn-down session state.
    expect(order).toEqual(['syncProgress', 'transportState']);
    expect(phases).toEqual(['idle']);
  });
});

// CMD_DEVICE_QUERY. The handshake sends exactly one; the liveness poll sends
// one per tick — so counting them tells both apart from a doubled run.
const CMD_DEVICE_QUERY = 0x16;
const LIVENESS_POLL_MS = 60_000;

const deviceQueries = (transport: Transports.Loopback): number =>
  transport.sent.filter((f) => f[0] === CMD_DEVICE_QUERY).length;

/**
 * A session started against a transport that is ALREADY connected — the
 * `start()` branch that used to set `connected` and call the handshake inline.
 * `makeSession` cannot express this: it owns the transport and starts the
 * session in one go. Setting the state before `start()` only moves the
 * transport's own field, since nothing has subscribed to it yet. Teardown is
 * registered here exactly as the harness would.
 */
function startOnConnectedTransport(): {
  session: MeshCoreSession;
  transport: Transports.Loopback;
  seen: TransportState[];
} {
  const transport = new Transports.Loopback();
  transport.setState('connected');
  const session = new MeshCoreSession({ transport });
  const seen: TransportState[] = [];
  session.events.on('transportState', (s) => seen.push(s));
  session.start();
  onTestFinished(() => session.stop());
  return { session, transport, seen };
}

// Second half of the same gap: `start()` short-circuited an already-connected
// transport straight into the handshake, so the connect branch's other work —
// the `transportState` broadcast above all, but also the presence clear and the
// liveness poll — never happened on that path. Real transports mostly dodge it
// (SerialTransport re-announces an open port on a microtask), but a consumer
// that subscribed before start() still deserves the event either way.
describe('transportState on a session started already connected', () => {
  it('emits connected when the transport was connected before start()', () => {
    const { seen } = startOnConnectedTransport();

    expect(seen).toEqual(['connected']);
  });

  it('runs the handshake exactly once, not once per code path', async () => {
    const { transport } = startOnConnectedTransport();

    await vi.waitFor(() => {
      expect(transport.sent.length).toBeGreaterThanOrEqual(3);
    });

    // DEVICE_QUERY opens the handshake; two of them means two handshakes.
    expect(deviceQueries(transport)).toBe(1);
    expect(transport.sent[0]?.[0]).toBe(CMD_DEVICE_QUERY);
  });

  it('arms the liveness poll exactly once', async () => {
    vi.useFakeTimers();
    try {
      const { transport } = startOnConnectedTransport();
      await vi.advanceTimersByTimeAsync(0);
      expect(deviceQueries(transport)).toBe(1); // the handshake's

      await vi.advanceTimersByTimeAsync(LIVENESS_POLL_MS);

      // One tick, one DEVICE_QUERY. A second armed interval would add two.
      expect(deviceQueries(transport)).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a transport re-announcing the connected state it is already in', () => {
    const { transport, seen } = startOnConnectedTransport();

    // What SerialTransport's deferred announcement looks like from here.
    transport.setState('connected');

    expect(seen).toEqual(['connected']);
    expect(deviceQueries(transport)).toBe(1);
  });

  it('delivers one connected event for an already-open SerialTransport', async () => {
    // The real shape of the case above: the port is open before the session
    // exists, so start() broadcasts, and the transport's own microtask
    // announcement lands afterwards. The consumer must see one event, not two —
    // handlers like the examples' do real work (and call stop()) on each.
    class FakeSerialPort extends EventEmitter {
      isOpen = true;
      write(): boolean {
        return true;
      }
    }
    const session = new MeshCoreSession({ transport: new Transports.Serial(new FakeSerialPort()) });
    onTestFinished(() => session.stop());
    const seen: TransportState[] = [];
    session.events.on('transportState', (s) => seen.push(s));

    session.start();
    await Promise.resolve();

    expect(seen).toEqual(['connected']);
  });
});
