import type { TransportState } from '../model/types';
import type { Transport } from '../ports/transport';
import { encodeSerialFrame, SerialDeframer } from './serialFraming';

/**
 * Minimal structural view of a node-serialport-style handle. The user passes
 * their own already-constructed port; meshcore-ts never imports serialport.
 */
export interface SerialPortLike {
  write(bytes: Uint8Array): unknown; // node-serialport returns boolean; ignored
  readonly isOpen?: boolean;
  on(event: 'data', cb: (chunk: Uint8Array) => void): unknown;
  on(event: 'open' | 'close', cb: () => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
}

/**
 * Transport that frames the MeshCore serial protocol over a duck-typed port.
 * The user owns opening/closing the port; this only observes and frames it.
 */
export class SerialTransport implements Transport {
  private readonly port: SerialPortLike;
  private readonly deframer: SerialDeframer;
  private dataCb?: (chunk: Uint8Array) => void;
  private stateCb?: (s: TransportState) => void;
  private state: TransportState;

  constructor(port: SerialPortLike, opts?: { maxFrameBytes?: number }) {
    this.port = port;
    this.deframer = new SerialDeframer({ maxFrameBytes: opts?.maxFrameBytes });
    // No open-assumption: serialport opens asynchronously after construction.
    this.state = port.isOpen ? 'connected' : 'connecting';

    port.on('data', (chunk) => {
      for (const frame of this.deframer.push(chunk)) this.dataCb?.(frame);
    });
    port.on('open', () => this.setState('connected'));
    port.on('close', () => this.setState('idle'));
    port.on('error', () => this.setState('error'));

    // If already open, announce 'connected' after construction so onStateChange
    // subscribers still see it. onTransportState is edge-guarded, so this is a
    // no-op for a session that already saw getState() === 'connected'.
    if (this.state === 'connected') {
      queueMicrotask(() => this.stateCb?.('connected'));
    }
  }

  async send(bytes: Uint8Array): Promise<void> {
    this.port.write(encodeSerialFrame(bytes));
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
