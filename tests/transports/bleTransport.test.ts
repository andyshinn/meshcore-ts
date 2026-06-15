import { describe, expect, it } from 'vitest';
import { BleTransport, createBleTransport, NORDIC_UART } from '../../src/transports/bleTransport';
import type { TransportState } from '../../src/types';

describe('NORDIC_UART', () => {
  it('exposes the companion BLE service + characteristic UUIDs', () => {
    expect(NORDIC_UART.service).toBe('6E400001-B5A3-F393-E0A9-E50E24DCCA9E');
    expect(NORDIC_UART.rxWrite).toBe('6E400002-B5A3-F393-E0A9-E50E24DCCA9E');
    expect(NORDIC_UART.txNotify).toBe('6E400003-B5A3-F393-E0A9-E50E24DCCA9E');
  });
});

describe('createBleTransport', () => {
  it('delivers each subscribed notification to onData unframed', () => {
    let emit: ((f: Uint8Array) => void) | undefined;
    const t = createBleTransport({
      write: () => {},
      subscribe: (onBytes) => {
        emit = onBytes;
      },
    });
    const frames: number[][] = [];
    t.onData((f) => frames.push([...f]));
    emit?.(Uint8Array.from([1, 2, 3]));
    emit?.(Uint8Array.from([9]));
    expect(frames).toEqual([[1, 2, 3], [9]]);
  });

  it('forwards send() to the write hook', async () => {
    const writes: number[][] = [];
    const t = createBleTransport({
      write: (b) => {
        writes.push([...b]);
      },
      subscribe: () => {},
    });
    await t.send(Uint8Array.from([0xaa]));
    expect(writes).toEqual([[0xaa]]);
  });

  it('defaults to "connected" and tracks watchState transitions', () => {
    let push: ((s: TransportState) => void) | undefined;
    const t = createBleTransport({
      write: () => {},
      subscribe: () => {},
      watchState: (onState) => {
        push = onState;
      },
    });
    expect(t.getState()).toBe('connected');
    const states: string[] = [];
    t.onStateChange((s) => states.push(s));
    push?.('idle');
    expect(states).toEqual(['idle']);
    expect(t.getState()).toBe('idle');
  });
});

// Subclass that records writes and exposes the protected hooks for the test.
class FakeBleTransport extends BleTransport {
  writes: number[][] = [];
  protected writeChunk(bytes: Uint8Array): void {
    this.writes.push([...bytes]);
  }
  // expose protected helpers to the test
  feed(frame: Uint8Array): void {
    this.deliver(frame);
  }
  flip(s: TransportState): void {
    this.setState(s);
  }
}

describe('BleTransport (abstract base)', () => {
  it('routes deliver() to onData and writeChunk() from send()', async () => {
    const t = new FakeBleTransport();
    const frames: number[][] = [];
    t.onData((f) => frames.push([...f]));
    t.feed(Uint8Array.from([7, 8]));
    await t.send(Uint8Array.from([0x01]));
    expect(frames).toEqual([[7, 8]]);
    expect(t.writes).toEqual([[0x01]]);
  });

  it('routes setState() to onStateChange and getState()', () => {
    const t = new FakeBleTransport();
    const states: string[] = [];
    t.onStateChange((s) => states.push(s));
    t.flip('idle');
    expect(states).toEqual(['idle']);
    expect(t.getState()).toBe('idle');
  });
});
