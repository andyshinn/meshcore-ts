import { Buffer } from 'node:buffer';
import type { TransportState } from '../model/types';

/** Byte-stream port to the radio. The library injects an implementation (BLE, serial, etc.). */
export interface Transport {
  /** Write one complete companion frame to the radio. */
  send(bytes: Uint8Array): Promise<void>;
  /** Each chunk is ONE complete companion frame (a BLE notification payload). */
  onData(cb: (chunk: Uint8Array) => void): void;
  onStateChange(cb: (s: TransportState) => void): void;
  getState(): TransportState;
}

/**
 * In-memory Transport for tests and examples. Captures everything sent and lets a
 * driver push inbound frames / state transitions into the session under test.
 */
export class LoopbackTransport implements Transport {
  /** Outbound frames captured for assertions (in send order). */
  readonly sent: Uint8Array[] = [];
  private dataCb?: (chunk: Uint8Array) => void;
  private stateCb?: (s: TransportState) => void;
  private state: TransportState = 'idle';

  async send(bytes: Uint8Array): Promise<void> {
    this.sent.push(bytes);
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

  // ---- test/driver helpers ----

  /** Transition state and notify the subscriber. */
  setState(s: TransportState): void {
    this.state = s;
    this.stateCb?.(s);
  }

  /** Deliver one inbound companion frame to the session. */
  receive(frame: Uint8Array): void {
    this.dataCb?.(frame);
  }

  /** Convenience: deliver an inbound frame from a hex string. */
  receiveHex(hex: string): void {
    this.receive(Uint8Array.from(Buffer.from(hex, 'hex')));
  }

  /** Last sent frame as hex (or undefined). */
  lastSentHex(): string | undefined {
    const last = this.sent.at(-1);
    return last ? Buffer.from(last).toString('hex') : undefined;
  }
}
