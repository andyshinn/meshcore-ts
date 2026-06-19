import { describe, expect, it } from 'vitest';
import * as Ports from '../../src/ports';

describe('Ports namespace barrel', () => {
  it('exposes injection-contract values', () => {
    expect(Ports.noopLogger).toBeDefined();
    expect(Ports.Events).toBeTypeOf('function'); // MeshCoreEvents, aliased
  });

  it('does NOT include LoopbackTransport (that is a Transports adapter)', () => {
    expect(Object.keys(Ports)).not.toContain('LoopbackTransport');
    expect(Object.keys(Ports)).not.toContain('Loopback');
  });

  it('exposes contract types (compile-time)', () => {
    const t: Ports.Transport = {} as Ports.Transport;
    const l: Ports.Logger = Ports.noopLogger;
    const m: Ports.EventMap = {} as Ports.EventMap;
    expect(t).toBeDefined();
    expect(l).toBe(Ports.noopLogger);
    expect(m).toBeDefined();
  });

  it('exposes EventName constants equal to the raw event keys', () => {
    expect(Ports.EventName.RAW_PACKET).toBe('rawPacket');
    expect(Ports.EventName.CONTACTS_FULL).toBe('contactsFull');
    expect(Ports.EventName.DEVICE_CAPABILITIES).toBe('deviceCapabilities');
  });

  it('subscription accepts BOTH the constant and the raw string, typed identically', () => {
    const events = new Ports.Events();
    // Constant form — handler arg is fully typed.
    events.on(Ports.EventName.RAW_PACKET, (pkt) => void pkt.hex);
    // Raw-string form — equivalent, same typed handler.
    events.on('rawPacket', (pkt) => void pkt.hex);
    expect(events).toBeInstanceOf(Ports.Events);
  });
});
