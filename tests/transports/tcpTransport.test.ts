import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { SocketLike } from '../../src/transports/tcpTransport';
import { createTcpTransport, TcpTransport } from '../../src/transports/tcpTransport';

// Minimal node:net Socket stand-in driven by the createSocket seam: EventEmitter
// + write()/destroy(). destroy() emits 'close' like a real socket does.
class FakeSocket extends EventEmitter {
  writes: Uint8Array[] = [];
  destroyed = false;
  write(bytes: Uint8Array): boolean {
    this.writes.push(bytes);
    return true;
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }
}

// device→host wire frame: [0x3e][len LE][payload]
function wire(payload: number[]): Uint8Array {
  return Uint8Array.from([0x3e, payload.length & 0xff, (payload.length >> 8) & 0xff, ...payload]);
}

describe('TcpTransport (createSocket seam)', () => {
  it('starts in "idle" before connect()', () => {
    const t = new TcpTransport({ host: '127.0.0.1', port: 5000, createSocket: () => new FakeSocket() });
    expect(t.getState()).toBe('idle');
  });

  it('connect() resolves and drives connecting → connected', async () => {
    const socket = new FakeSocket();
    const t = new TcpTransport({ host: '127.0.0.1', port: 5000, createSocket: () => socket });
    const states: string[] = [];
    t.onStateChange((s) => states.push(s));

    const connected = t.connect();
    socket.emit('connect');
    await expect(connected).resolves.toBeUndefined();

    expect(states).toEqual(['connecting', 'connected']);
    expect(t.getState()).toBe('connected');
  });

  it('surfaces a framed inbound packet as one onData chunk', async () => {
    const socket = new FakeSocket();
    const t = new TcpTransport({ host: '127.0.0.1', port: 5000, createSocket: () => socket });
    const frames: number[][] = [];
    t.onData((f) => frames.push([...f]));

    const connected = t.connect();
    socket.emit('connect');
    await connected;

    socket.emit('data', wire([1, 2, 3]));
    socket.emit('data', Uint8Array.from([...wire([4]), 0x3e, 0x02, 0x00, 0x05])); // 2nd frame split
    socket.emit('data', Uint8Array.from([0x06]));

    expect(frames).toEqual([[1, 2, 3], [4], [5, 6]]);
  });

  it('send() writes a 0x3c-framed packet to the socket', async () => {
    const socket = new FakeSocket();
    const t = new TcpTransport({ host: '127.0.0.1', port: 5000, createSocket: () => socket });
    const connected = t.connect();
    socket.emit('connect');
    await connected;

    await t.send(Uint8Array.from([0xaa, 0xbb]));
    expect([...socket.writes[0]]).toEqual([0x3c, 0x02, 0x00, 0xaa, 0xbb]);
  });

  it('rejects connect() and goes to "error" when the connect times out', async () => {
    const socket = new FakeSocket(); // never emits 'connect'
    const t = new TcpTransport({
      host: '127.0.0.1',
      port: 5000,
      connectTimeoutMs: 15,
      createSocket: () => socket,
    });

    await expect(t.connect()).rejects.toThrow(/timed out/i);
    expect(t.getState()).toBe('error');
    expect(socket.destroyed).toBe(true);
  });

  it('rejects connect() and goes to "error" on socket error', async () => {
    const socket = new FakeSocket();
    const t = new TcpTransport({ host: '127.0.0.1', port: 5000, createSocket: () => socket });
    const connected = t.connect();
    socket.emit('error', new Error('ECONNREFUSED'));
    await expect(connected).rejects.toThrow(/ECONNREFUSED/);
    expect(t.getState()).toBe('error');
  });

  it('rejects a second connect() while already connected', async () => {
    const socket = new FakeSocket();
    const t = new TcpTransport({ host: '127.0.0.1', port: 5000, createSocket: () => socket });
    const first = t.connect();
    socket.emit('connect');
    await first;
    await expect(t.connect()).rejects.toThrow(/already connected/i);
  });

  it('maps a post-connect socket error to "error" state', async () => {
    const socket = new FakeSocket();
    const t = new TcpTransport({ host: '127.0.0.1', port: 5000, createSocket: () => socket });
    const connected = t.connect();
    socket.emit('connect');
    await connected;

    const states: string[] = [];
    t.onStateChange((s) => states.push(s));
    socket.emit('error', new Error('connection reset'));
    expect(t.getState()).toBe('error');
    expect(states).toEqual(['error']);
  });

  it('close() destroys the socket and returns to "idle"', async () => {
    const socket = new FakeSocket();
    const t = new TcpTransport({ host: '127.0.0.1', port: 5000, createSocket: () => socket });
    const connected = t.connect();
    socket.emit('connect');
    await connected;

    await t.close();
    expect(socket.destroyed).toBe(true);
    expect(t.getState()).toBe('idle');
  });

  it('createTcpTransport returns a connectable TcpTransport', () => {
    const t = createTcpTransport({ host: '127.0.0.1', port: 5000, createSocket: () => new FakeSocket() });
    expect(t).toBeInstanceOf(TcpTransport);
    expect(typeof t.connect).toBe('function');
    expect(typeof t.close).toBe('function');
  });

  it('default createSocket option type accepts a node:net Socket', () => {
    // Type-level guard: net.Socket must satisfy SocketLike.
    const factory: (h: string, p: number) => SocketLike = () => new net.Socket();
    expect(typeof factory).toBe('function');
  });
});

describe('TcpTransport (real localhost socket)', () => {
  let server: net.Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
  });

  it('connects over the default node:net socket and round-trips framed bytes', async () => {
    let serverReceived: Uint8Array | undefined;
    server = net.createServer((sock) => {
      sock.on('data', (chunk: Buffer) => {
        serverReceived = new Uint8Array(chunk);
      });
      // Greet the client with one framed inbound packet on connect.
      sock.write(Uint8Array.from(wire([0x10, 0x20])));
    });

    const port = await new Promise<number>((resolve) => {
      server?.listen(0, '127.0.0.1', () => {
        const addr = server?.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });

    const t = new TcpTransport({ host: '127.0.0.1', port });
    const frames: number[][] = [];
    t.onData((f) => frames.push([...f]));

    await t.connect();
    expect(t.getState()).toBe('connected');

    // Inbound: wait for the greeting frame to surface via onData.
    await new Promise<void>((resolve) => {
      if (frames.length > 0) return resolve();
      t.onData((f) => {
        frames.push([...f]);
        resolve();
      });
    });
    expect(frames[0]).toEqual([0x10, 0x20]);

    // Outbound: send() must land at the server as a 0x3c-framed packet.
    await t.send(Uint8Array.from([0xde, 0xad]));
    await new Promise<void>((resolve) => {
      const check = () => (serverReceived ? resolve() : setTimeout(check, 2));
      check();
    });
    expect([...(serverReceived as Uint8Array)]).toEqual([0x3c, 0x02, 0x00, 0xde, 0xad]);

    await t.close();
    expect(t.getState()).toBe('idle');
  });
});
