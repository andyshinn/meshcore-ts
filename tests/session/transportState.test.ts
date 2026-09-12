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

  it('does not collapse a state a transport reports twice in a row', () => {
    const { session, transport } = makeSession();
    const seen: TransportState[] = [];
    session.events.on('transportState', (s) => seen.push(s));

    // SerialTransport calls setState('error') on every port 'error' event, so a
    // port erroring twice is two 'error's, not one — and a reconnect loop that
    // gives up and retries repeats 'connecting' the same way. This channel is
    // documented (src/ports/events.ts) as un-de-duplicated: each of these is a
    // distinct thing that happened, and a consumer counting retries or
    // surfacing errors needs all of them.
    transport.setState('connecting');
    transport.setState('error');
    transport.setState('error');
    transport.setState('connecting');
    transport.setState('connecting');

    expect(seen).toEqual(['connecting', 'error', 'error', 'connecting', 'connecting']);
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

/** Where the consumer attaches its `transportState` handler. Both points are in
 *  the same tick as `start()`, and both must receive the event. */
type Subscribe = 'before' | 'after';

/**
 * A session started against a transport that is ALREADY connected — the
 * `start()` branch that used to set `connected` and call the handshake inline.
 * `makeSession` cannot express this: it owns the transport and starts the
 * session in one go. Setting the state before `start()` only moves the
 * transport's own field, since nothing has subscribed to it yet. Teardown is
 * registered here exactly as the harness would.
 */
function startOnConnectedTransport(subscribe: Subscribe = 'before'): {
  session: MeshCoreSession;
  transport: Transports.Loopback;
  seen: TransportState[];
} {
  const transport = new Transports.Loopback();
  transport.setState('connected');
  const session = new MeshCoreSession({ transport });
  const seen: TransportState[] = [];
  const listen = (): void => void session.events.on('transportState', (s) => seen.push(s));
  if (subscribe === 'before') listen();
  session.start();
  if (subscribe === 'after') listen();
  onTestFinished(() => session.stop());
  return { session, transport, seen };
}

/** A node-serialport-shaped handle for a port the caller already opened. */
class OpenFakeSerialPort extends EventEmitter {
  isOpen = true;
  write(): boolean {
    return true;
  }
}

/** The real-world shape of the case above: a SerialTransport handed a port that
 *  is already open, so the transport announces 'connected' itself — on a
 *  microtask it queues when it is CONSTRUCTED, i.e. before `start()` runs. */
function startOnOpenSerialPort(subscribe: Subscribe): {
  session: MeshCoreSession;
  seen: TransportState[];
} {
  const transport = new Transports.Serial(new OpenFakeSerialPort());
  const session = new MeshCoreSession({ transport });
  onTestFinished(() => session.stop());
  const seen: TransportState[] = [];
  const listen = (): void => void session.events.on('transportState', (s) => seen.push(s));
  if (subscribe === 'before') listen();
  session.start();
  if (subscribe === 'after') listen();
  return { session, seen };
}

// Second half of the same gap: `start()` short-circuited an already-connected
// transport straight into the handshake, so the connect branch's other work —
// the `transportState` broadcast above all, but also the presence clear and the
// liveness poll — never happened on that path.
describe('transportState on a session started already connected', () => {
  it('emits connected when the transport was connected before start()', async () => {
    const { seen } = startOnConnectedTransport();

    // Deferred by one microtask, which is what lets a handler attached later in
    // this same tick (the test below) see it too.
    await Promise.resolve();

    expect(seen).toEqual(['connected']);
  });

  it('delivers connected to a consumer that subscribes after start()', async () => {
    const { seen } = startOnConnectedTransport('after');

    await Promise.resolve();

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

  it('lets a transport announcing the connect itself win the race', async () => {
    const { transport, seen } = startOnConnectedTransport();

    // What a transport's own announcement looks like from here; it beats the
    // deferred drive in start(), which then finds `connected` set and stands
    // down. Either path, one connect — never both.
    transport.setState('connected');
    await Promise.resolve();

    expect(seen).toEqual(['connected']);
    expect(deviceQueries(transport)).toBe(1);
  });

  it('delivers one connected event for an already-open SerialTransport', async () => {
    // Handlers like the examples' do real work (and call stop()) on connect, so
    // the transport's announcement and start()'s drive must not both land.
    const { seen } = startOnOpenSerialPort('before');

    await Promise.resolve();

    expect(seen).toEqual(['connected']);
  });

  it('delivers connected to a late subscriber on an already-open SerialTransport', async () => {
    // Regression: subscribing after start() is ordinary usage (construct,
    // start, then wire handlers), and on this transport the only 'connected'
    // that consumer can ever see is the deferred one. A broadcast from inside
    // start() misses it entirely, and suppressing the transport's own
    // announcement as a "duplicate" of that leaves it with nothing at all.
    const { seen } = startOnOpenSerialPort('after');

    await Promise.resolve();

    expect(seen).toEqual(['connected']);
  });

  it('stands down if the transport dropped before the deferred drive runs', async () => {
    const { transport, seen } = startOnConnectedTransport();

    transport.setState('idle');
    await Promise.resolve();

    // The connect start() saw is gone by the time the drive runs. Firing it
    // anyway would announce a connection that no longer exists and arm a
    // liveness poll against a dead link.
    expect(seen).toEqual(['idle']);
    expect(deviceQueries(transport)).toBe(0);
  });

  it('stands down if the session is stopped before the deferred drive runs', async () => {
    const { session, transport, seen } = startOnConnectedTransport();

    session.stop();
    await Promise.resolve();

    // start() then stop() inside one tick: the drive must not connect a session
    // the caller has already torn down, leaving a handshake in flight and a
    // liveness interval armed past stop().
    expect(seen).toEqual([]);
    expect(deviceQueries(transport)).toBe(0);
  });

  it('re-runs the connect branch on a start() after stop()', async () => {
    const { session, transport } = startOnConnectedTransport();
    await Promise.resolve();
    expect(deviceQueries(transport)).toBe(1);

    session.stop();
    const seen: TransportState[] = [];
    session.events.on('transportState', (s) => seen.push(s));

    session.start();
    await Promise.resolve();

    // stop() forgets the connected edge, so restarting against a transport that
    // never dropped is a real connect again — handshake re-run, liveness
    // re-armed, 'connected' re-broadcast. Latching `connected` across the stop
    // made the second start() a silent no-op.
    expect(seen).toEqual(['connected']);
    expect(deviceQueries(transport)).toBe(2);
  });
});
