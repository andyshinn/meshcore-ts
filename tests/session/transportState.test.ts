import { describe, expect, it } from 'vitest';
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
    session.stop();
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
    session.stop();
  });

  it('emits after the connect branch has run, not before', () => {
    const { session, transport } = makeSession();
    const phases: Array<SyncProgress['phase']> = [];
    session.events.on('transportState', () => phases.push(session.getSyncProgress().phase));

    transport.setState('connected');

    // The connect branch kicks off the handshake, whose first synchronous act is
    // to move sync progress to 'syncing'. A handler that ran first would see 'idle'.
    expect(phases).toEqual(['syncing']);
    session.stop();
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
    session.stop();
  });
});
