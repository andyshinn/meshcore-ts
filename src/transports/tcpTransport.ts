import * as net from 'node:net';
import type { TransportState } from '../model/types';
import type { Transport } from '../ports/transport';
import { encodeSerialFrame, SerialDeframer } from './serialFraming';

/**
 * Minimal structural view of a node:net Socket — satisfied by a real
 * `net.Socket` and by test fakes. Mirrors the duck-typed `SerialPortLike`:
 * we only touch the few members the transport actually uses.
 */
export interface SocketLike {
  write(bytes: Uint8Array): unknown; // net.Socket returns boolean; ignored
  destroy(): unknown;
  readonly destroyed?: boolean;
  on(event: 'connect' | 'close', cb: () => void): unknown;
  on(event: 'data', cb: (chunk: Uint8Array) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
}

export interface TcpTransportOptions {
  /** Host to dial. */
  host: string;
  /** TCP port to dial. */
  port: number;
  /** Reject connect() if no 'connect' arrives within this many ms. Default 10000. */
  connectTimeoutMs?: number;
  /** Max companion-frame payload size for the de-framer. Default 256. */
  maxFrameBytes?: number;
  /**
   * Test seam: build the socket. Defaults to `net.createConnection`, which both
   * creates the socket and starts dialing — so connect() just waits for events.
   */
  createSocket?: (host: string, port: number) => SocketLike;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10000;

/**
 * Complete, batteries-included TCP transport for the MeshCore companion
 * protocol. Unlike Serial/BLE (which are bring-your-own-driver adapters), TCP's
 * only driver is the `node:net` builtin, so this transport owns its socket and
 * its connect/close lifecycle. The wire framing is identical to serial
 * (`[0x3c]`/`[0x3e][uint16 LE length][payload]`), so it reuses
 * `SerialDeframer` + `encodeSerialFrame` rather than reimplementing framing.
 */
export class TcpTransport implements Transport {
  private readonly host: string;
  private readonly port: number;
  private readonly connectTimeoutMs: number;
  private readonly createSocket: (host: string, port: number) => SocketLike;
  private readonly deframer: SerialDeframer;
  private socket?: SocketLike;
  private dataCb?: (chunk: Uint8Array) => void;
  private stateCb?: (s: TransportState) => void;
  private state: TransportState = 'idle';

  constructor(opts: TcpTransportOptions) {
    this.host = opts.host;
    this.port = opts.port;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.createSocket = opts.createSocket ?? ((host, port) => net.createConnection({ host, port }));
    this.deframer = new SerialDeframer({ maxFrameBytes: opts.maxFrameBytes });
  }

  /**
   * Dial host:port. Resolves on the socket's 'connect' event, rejects on a
   * socket 'error' or if no connection completes within connectTimeoutMs.
   */
  connect(): Promise<void> {
    if (this.socket) {
      return Promise.reject(new Error('TcpTransport.connect: already connected'));
    }
    this.setState('connecting');
    const socket = this.createSocket(this.host, this.port);
    this.socket = socket;

    socket.on('data', (chunk) => {
      for (const frame of this.deframer.push(chunk)) this.dataCb?.(frame);
    });
    // A close we didn't ask for (remote hang-up) drops us back to idle, but a
    // failed connect already set 'error' — don't clobber that terminal state.
    socket.on('close', () => {
      if (this.state !== 'error') this.setState('idle');
    });

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.setState('error');
        socket.destroy();
        reject(new Error(`TcpTransport: connect to ${this.host}:${this.port} timed out after ${this.connectTimeoutMs}ms`));
      }, this.connectTimeoutMs);

      socket.on('connect', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.setState('connected');
        resolve();
      });
      socket.on('error', (err) => {
        if (settled) {
          this.setState('error'); // post-connect runtime error
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.setState('error');
        reject(err);
      });
    });
  }

  /** Destroy the socket and return to idle. Safe to call when never connected. */
  async close(): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      if (this.state !== 'error') this.setState('idle');
      return;
    }
    await new Promise<void>((resolve) => {
      socket.on('close', () => resolve());
      socket.destroy();
    });
  }

  async send(bytes: Uint8Array): Promise<void> {
    if (!this.socket) throw new Error('TcpTransport.send: not connected');
    this.socket.write(encodeSerialFrame(bytes));
  }

  onData(cb: (chunk: Uint8Array) => void): void {
    this.dataCb = cb;
  }

  onStateChange(cb: (s: TransportState) => void): void {
    this.stateCb = cb;
  }

  getState(): TransportState {
    return this.state;
  }

  private setState(s: TransportState): void {
    this.state = s;
    this.stateCb?.(s);
  }
}

/** Factory mirroring createBleTransport — returns a ready-to-connect TcpTransport. */
export function createTcpTransport(opts: TcpTransportOptions): TcpTransport {
  return new TcpTransport(opts);
}
