import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoopbackTransport } from '../../src/ports/transport';
import { MeshCoreSession } from '../../src/session/session';

// Build a minimal RESP_SELF_INFO companion frame:
//   [0x05][adv_type][tx_power][max_tx_power][public_key 32B][name…]
// decodeSelfInfo reads the pubkey at bytes 4..36 and scans the trailing
// printable ASCII for the name.
function selfInfoFrame(pubKeyHex: string, name: string): Uint8Array {
  const head = Buffer.from([0x05, 0x00, 0x00, 0x00]);
  const pub = Buffer.from(pubKeyHex, 'hex');
  const nameBytes = Buffer.from(name, 'utf8');
  return Uint8Array.from(Buffer.concat([head, pub, nameBytes]));
}

// RESP_OK is code 0x00.
const RESP_OK = Uint8Array.from([0x00]);

describe('MeshCoreSession core', () => {
  let transport: LoopbackTransport;
  let session: MeshCoreSession;

  beforeEach(() => {
    transport = new LoopbackTransport();
    session = new MeshCoreSession({ transport });
    session.start();
  });

  afterEach(() => {
    session.stop();
  });

  it('runs the handshake DEVICE_QUERY → APP_START → GET_CONTACTS on connect', async () => {
    transport.setState('connected');
    // handshake awaits WRITE_GAP_MS between writes; let the microtask + timer
    // queue flush enough to capture the first three frames.
    await vi.waitFor(() => {
      expect(transport.sent.length).toBeGreaterThanOrEqual(3);
    });
    const prefixes = transport.sent.slice(0, 3).map((f) => Buffer.from(f).toString('hex'));
    // DEVICE_QUERY = 0x16, APP_START = 0x01, GET_CONTACTS = 0x04.
    expect(prefixes[0].startsWith('16')).toBe(true);
    expect(prefixes[1].startsWith('01')).toBe(true);
    expect(prefixes[2].startsWith('04')).toBe(true);
  });

  it('ingests RESP_SELF_INFO → emits owner and sets state owner', () => {
    const pub = 'ab'.repeat(32);
    const owners: Array<{ name: string; publicKeyHex: string } | null> = [];
    session.events.on('owner', (o) => owners.push(o));

    transport.receive(selfInfoFrame(pub, 'TestNode'));

    expect(owners.length).toBe(1);
    expect(owners[0]?.name).toBe('TestNode');
    expect(owners[0]?.publicKeyHex).toBe(pub);
    const owner = session.state.getOwner();
    expect(owner?.name).toBe('TestNode');
    expect(owner?.publicKeyHex).toBe(pub);
  });

  it('treats an unsolicited RESP_OK with no pending ack as a harmless no-op', () => {
    // No writer has armed an ack waiter, so the FIFO is empty — resolveNextAck
    // returns false and nothing throws.
    expect(() => transport.receive(RESP_OK)).not.toThrow();
    expect(() => transport.receive(RESP_OK)).not.toThrow();
  });

  it('drops unparseable inbound chunks without throwing', () => {
    expect(() => transport.receive(Uint8Array.from([]))).not.toThrow();
  });

  it('clears syncProgress and fails in-flight awaiters on disconnect', async () => {
    transport.setState('connected');
    // Let the handshake arm its waiters + start emitting progress.
    await vi.waitFor(() => {
      expect(session.getSyncProgress().phase).toBe('syncing');
    });

    // Disconnect: clears syncProgress back to the idle default and resolves any
    // in-flight ack/typed awaiters without throwing.
    expect(() => transport.setState('idle')).not.toThrow();
    const progress = session.getSyncProgress();
    expect(progress.phase).toBe('idle');
    expect(progress.channels).toEqual({ done: 0, total: 0 });
    expect(progress.contacts).toEqual({ done: 0, total: 0 });
  });
});
