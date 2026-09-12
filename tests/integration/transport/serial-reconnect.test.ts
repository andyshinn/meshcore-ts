import { EventEmitter } from 'node:events';
import { describe, expect, it, onTestFinished } from 'vitest';
import { MeshCoreSession } from '../../../src/index.js';
import { SerialTransport } from '../../../src/transports/serialTransport.js';
import { frameBuf } from '../../support/frames.js';

// Minimal node-serialport stand-in: EventEmitter + write() + isOpen.
class FakeSerialPort extends EventEmitter {
  isOpen = false;
  writes: Uint8Array[] = [];
  write(bytes: Uint8Array): boolean {
    this.writes.push(bytes);
    return true;
  }
}

/** device→host wire frame: [0x3e][len LE][payload] */
function wire(payload: Uint8Array): Uint8Array {
  return Uint8Array.from([0x3e, payload.length & 0xff, (payload.length >> 8) & 0xff, ...payload]);
}

function startSession(port: FakeSerialPort): MeshCoreSession {
  const session = new MeshCoreSession({ transport: new SerialTransport(port) });
  session.start();
  onTestFinished(() => session.stop());
  return session;
}

const OWNER_KEY = '1a3d3c6a09f057457bcf0ae5403e5c60072919d193ed8caff58501b7590dd5d5';

// The consumer owns the SerialPort and may close and reopen the SAME object.
// The transport's deframer outlives that, so a partial frame buffered at close
// time used to survive into the next open — and because the de-framer only
// resyncs on an INVALID header, a partial frame's valid header meant it was
// never resynced away: it spliced the reconnect's first bytes into itself,
// fabricating one bogus frame and swallowing the real frames behind it.
describe('serial reconnect on the same port object', () => {
  it('folds RESP_SELF_INFO after a reopen that followed a partial frame', async () => {
    const port = new FakeSerialPort();
    port.isOpen = true;
    const session = startSession(port);
    await Promise.resolve();

    // 5 bytes of a frame that claims 16 payload bytes: buffered, not resynced.
    port.emit('data', Uint8Array.from([0x3e, 0x10, 0x00, 0xaa, 0xbb]));
    port.emit('close');
    port.isOpen = true;
    port.emit('open');

    port.emit('data', wire(Uint8Array.from(frameBuf('selfInfo'))));
    await Promise.resolve();

    expect(session.state.getOwner()?.publicKeyHex).toBe(OWNER_KEY);
  });

  it('matches the control run with no partial frame before the close', async () => {
    const port = new FakeSerialPort();
    port.isOpen = true;
    const session = startSession(port);
    await Promise.resolve();

    port.emit('close');
    port.isOpen = true;
    port.emit('open');

    port.emit('data', wire(Uint8Array.from(frameBuf('selfInfo'))));
    await Promise.resolve();

    expect(session.state.getOwner()?.publicKeyHex).toBe(OWNER_KEY);
  });
});
