import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { MeshCoreSession, Transports } from '../../src/index.js';

/** Opcodes actually written to the transport, in send order. The handshake
 *  writes frames of its own, so every assertion below names the opcode it wants
 *  rather than counting frames — a count alone is satisfied by the handshake. */
const opcodes = (t: Transports.Loopback): number[] => Array.from(t.sent, (f) => f[0] as number);

const CMD_SET_ADVERT_NAME = 0x08;
const CMD_SET_ADVERT_LATLON = 0x0e;
const CMD_REBOOT = 0x13;
const CMD_GET_CUSTOM_VAR = 0x28;
const CMD_DEVICE_QUERY = 0x16;
const RESP_OK = '00';
const LIVENESS_POLL_MS = 60_000;

/** The handshake opens with exactly one DEVICE_QUERY and the liveness poll adds
 *  one per tick, so counting them tells a doubled connect branch from a clean one. */
const deviceQueries = (t: Transports.Loopback): number => t.sent.filter((f) => f[0] === CMD_DEVICE_QUERY).length;

/**
 * A session started against a transport that is ALREADY connected and that
 * never announces the connect itself. That is the BLE shape: createBleTransport
 * initialises `state` to 'connected' and its `watchState` hook is optional, so a
 * consumer that omits it gets no announcement at all and the deferred drive in
 * `start()` is the only thing that ever moves the session's edge latch.
 */
function startAlreadyConnected(): { session: MeshCoreSession; transport: Transports.Loopback } {
  const transport = new Transports.Loopback();
  transport.setState('connected');
  const session = new MeshCoreSession({ transport });
  session.start();
  onTestFinished(() => session.stop());
  return { session, transport };
}

// Regression: start() used to set `connected` synchronously. Deferring the
// already-connected drive to a microtask left the latch false for one tick, and
// eleven public commands gated on that latch — so `start()` followed by an
// awaited command in the SAME TICK returned early without ever writing a frame.
// start() is synchronous and non-awaitable, so that is the natural call shape.
describe('commands issued in the same tick as start()', () => {
  it('writes setAdvertName to the transport', async () => {
    const { session, transport } = startAlreadyConnected();

    const pending = session.setAdvertName('node-1');
    // The frame must already be on the wire before anything acks it; the ack
    // only unblocks the awaiter.
    await Promise.resolve();
    expect(opcodes(transport)).toContain(CMD_SET_ADVERT_NAME);

    transport.receiveHex(RESP_OK);
    expect(await pending).toBe(true);
  });

  it('writes setAdvertLatLon to the transport', async () => {
    const { session, transport } = startAlreadyConnected();

    const pending = session.setAdvertLatLon(37.7749, -122.4194);
    await Promise.resolve();
    expect(opcodes(transport)).toContain(CMD_SET_ADVERT_LATLON);

    transport.receiveHex(RESP_OK);
    expect(await pending).toBe(true);
  });

  it('writes reboot to the transport', async () => {
    const { session, transport } = startAlreadyConnected();

    // No ack to wait on — CMD_REBOOT gets no reply, the link just drops.
    expect(await session.reboot()).toEqual({ ok: true });
    expect(opcodes(transport)).toContain(CMD_REBOOT);
  });

  it('writes requestCustomVars to the transport', async () => {
    const { session, transport } = startAlreadyConnected();

    await session.requestCustomVars('gps');

    expect(opcodes(transport)).toContain(CMD_GET_CUSTOM_VAR);
  });

  it('does not drive a second handshake or liveness poll', async () => {
    vi.useFakeTimers();
    try {
      const { session, transport } = startAlreadyConnected();

      const pending = session.setAdvertName('node-1');
      await vi.advanceTimersByTimeAsync(0);
      transport.receiveHex(RESP_OK);
      await pending;

      // The command reads the transport directly; it must not touch the edge
      // latch that keeps the connect branch to one run. Two DEVICE_QUERYs here
      // would mean two handshakes.
      expect(deviceQueries(transport)).toBe(1);

      await vi.advanceTimersByTimeAsync(LIVENESS_POLL_MS);

      // One poll tick, one DEVICE_QUERY. A second armed interval would add two.
      expect(deviceQueries(transport)).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still refuses commands before start()', async () => {
    const transport = new Transports.Loopback();
    transport.setState('connected');
    const session = new MeshCoreSession({ transport });

    // Connected transport, unstarted session: nothing is wired up to route the
    // reply, so the gate must still hold.
    expect(await session.setAdvertName('node-1')).toBe(false);
    expect(opcodes(transport)).not.toContain(CMD_SET_ADVERT_NAME);
  });

  it('still refuses commands after stop()', async () => {
    const { session, transport } = startAlreadyConnected();
    await Promise.resolve();
    session.stop();

    expect(await session.setAdvertName('node-1')).toBe(false);
    expect(opcodes(transport)).not.toContain(CMD_SET_ADVERT_NAME);
  });

  it('still refuses commands on a transport that is not connected', async () => {
    const transport = new Transports.Loopback();
    const session = new MeshCoreSession({ transport });
    session.start();
    onTestFinished(() => session.stop());

    expect(await session.setAdvertName('node-1')).toBe(false);
    expect(opcodes(transport)).not.toContain(CMD_SET_ADVERT_NAME);
  });
});

// Regression: stop() started clearing `connected`, so a later transport
// 'disconnected' no longer matched onTransportState's wasConnected edge and the
// disconnect branch never ran — leaving sync progress latched and every
// in-flight awaiter queued for a reply that can no longer arrive.
// `session.stop()` then `port.close()` is the shipped teardown order in the
// examples, so this is the documented path.
describe('stop() tears the connection down', () => {
  it('leaves sync progress idle rather than latched at syncing', () => {
    const transport = new Transports.Loopback();
    const session = new MeshCoreSession({ transport });
    session.start();
    transport.setState('connected');
    expect(session.getSyncProgress().phase).toBe('syncing');

    session.stop();

    expect(session.getSyncProgress().phase).toBe('idle');
  });

  it('leaves sync progress idle after a post-stop transport state change too', () => {
    const transport = new Transports.Loopback();
    const session = new MeshCoreSession({ transport });
    session.start();
    transport.setState('connected');

    session.stop();
    // What `port.close()` looks like from here. With the edge already forgotten
    // this drives neither branch, so the teardown has to have happened in stop().
    transport.setState('idle');

    expect(session.getSyncProgress().phase).toBe('idle');
  });

  it('fails in-flight typed awaiters promptly instead of riding the request timeout', async () => {
    const transport = new Transports.Loopback();
    const session = new MeshCoreSession({ transport });
    session.start();
    transport.setState('connected');

    vi.useFakeTimers();
    try {
      const pending = session.getAllowedRepeatFreq();
      session.stop();

      // Timers frozen: REQUEST_TIMEOUT_MS cannot fire, so this can only reject
      // because the teardown failed it. Before the fix it rode the full 5s and
      // rejected with the watchdog's message instead.
      await expect(pending).rejects.toThrow(/session stopped/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails in-flight ack awaiters instead of leaving callers hung', async () => {
    vi.useFakeTimers();
    try {
      const transport = new Transports.Loopback();
      const session = new MeshCoreSession({ transport });
      session.start();
      transport.setState('connected');

      const pending = session.setAdvertName('node-1');
      await vi.advanceTimersByTimeAsync(0);
      expect(opcodes(transport)).toContain(CMD_SET_ADVERT_NAME);

      session.stop();

      // Timers are frozen from here on, so SET_CHANNEL_TIMEOUT_MS can never
      // expire: the only thing that can settle this is the teardown resolving
      // the ack FIFO. A setter left waiting on a RESP_OK the stopped session
      // will never route just hangs.
      expect(await pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not tear down a session that was never connected', () => {
    const transport = new Transports.Loopback();
    const session = new MeshCoreSession({ transport });
    session.start();
    const seen: string[] = [];
    session.events.on('syncProgress', () => seen.push('syncProgress'));

    session.stop();

    // Nothing to unwind, so no spurious broadcast to consumers.
    expect(seen).toEqual([]);
  });
});
