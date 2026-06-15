import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { SerialTransport } from '../../src/transports/serialTransport';

// Minimal node-serialport stand-in: EventEmitter + write() + isOpen.
class FakeSerialPort extends EventEmitter {
  isOpen = false;
  writes: Uint8Array[] = [];
  write(bytes: Uint8Array): boolean {
    this.writes.push(bytes);
    return true;
  }
}

// device→host wire frame: [0x3e][len LE][payload]
function wire(payload: number[]): Uint8Array {
  return Uint8Array.from([0x3e, payload.length & 0xff, (payload.length >> 8) & 0xff, ...payload]);
}

describe('SerialTransport', () => {
  it('starts in "connecting" when the port is not yet open', () => {
    const t = new SerialTransport(new FakeSerialPort());
    expect(t.getState()).toBe('connecting');
  });

  it('starts in "connected" when the port is already open', () => {
    const port = new FakeSerialPort();
    port.isOpen = true;
    expect(new SerialTransport(port).getState()).toBe('connected');
  });

  it('emits "connected" on the next microtask when already open', async () => {
    const port = new FakeSerialPort();
    port.isOpen = true;
    const t = new SerialTransport(port);
    const states: string[] = [];
    t.onStateChange((s) => states.push(s));
    await Promise.resolve();
    expect(states).toEqual(['connected']);
  });

  it('maps open/close/error events to transport state', () => {
    const port = new FakeSerialPort();
    const t = new SerialTransport(port);
    const states: string[] = [];
    t.onStateChange((s) => states.push(s));
    port.emit('open');
    port.emit('error', new Error('boom'));
    port.emit('close');
    expect(states).toEqual(['connected', 'error', 'idle']);
    expect(t.getState()).toBe('idle');
  });

  it('de-frames inbound data into whole companion frames on onData', () => {
    const port = new FakeSerialPort();
    const t = new SerialTransport(port);
    const frames: number[][] = [];
    t.onData((f) => frames.push([...f]));
    port.emit('data', wire([1, 2, 3]));
    port.emit('data', Uint8Array.from([...wire([4]), 0x3e, 0x02, 0x00, 0x05])); // 2nd frame split
    port.emit('data', Uint8Array.from([0x06]));
    expect(frames).toEqual([[1, 2, 3], [4], [5, 6]]);
  });

  it('encodes outbound frames with the 0x3c header on send', async () => {
    const port = new FakeSerialPort();
    const t = new SerialTransport(port);
    await t.send(Uint8Array.from([0xaa, 0xbb]));
    expect([...port.writes[0]]).toEqual([0x3c, 0x02, 0x00, 0xaa, 0xbb]);
  });
});
