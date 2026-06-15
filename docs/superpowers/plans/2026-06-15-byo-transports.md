# Bring-Your-Own Transports (Serial + BLE) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship optional `SerialTransport`, `createBleTransport`/`BleTransport`, and a pure serial framing codec under a `meshcore-ts/transports` subpath so users can wire their own `serialport`/`noble`/React Native BLE handle to a `MeshCoreSession` — with zero runtime or type dependencies on any device package.

**Architecture:** A pure, dependency-free framing codec (`encodeSerialFrame` + `SerialDeframer`) provides the MeshCore serial wire format `[type][len uint16 LE][payload]` (`0x3c` host→device, `0x3e` device→host). `SerialTransport` wraps a duck-typed `serialport`-shaped handle and the codec; BLE maps 1:1 to the existing `onData` contract via a bytes-only hooks factory plus a thin abstract-class wrapper. All new code lives in `src/transports/` and is exposed as a separate subpath export.

**Tech Stack:** TypeScript (ESM + CJS via tsup), vitest, biome. Node ≥20.

**Spec:** `docs/superpowers/specs/2026-06-15-byo-transports-design.md`

**Commit convention:** Every commit message in this plan must end with the trailer:
`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
(Commit commands below show the `-m` subject only for readability — append the trailer.)

**Branch note:** Multiple processes share the `extraction` branch. Commit frequently; if a `git commit` races, `git pull --rebase` and retry. Do **not** force-push.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/transports/serialFraming.ts` | Pure codec: `encodeSerialFrame()` + `SerialDeframer`. No I/O, no deps. |
| `src/transports/serialTransport.ts` | `SerialTransport` + `SerialPortLike` interface. Duck-typed serialport adapter. |
| `src/transports/bleTransport.ts` | `createBleTransport()` factory, abstract `BleTransport`, `NORDIC_UART` UUIDs, `BleHooks`. |
| `src/transports/index.ts` | Barrel for the `meshcore-ts/transports` subpath export. |
| `tests/transports/serialFraming.test.ts` | Codec unit tests. |
| `tests/transports/serialTransport.test.ts` | Serial adapter tests (fake port). |
| `tests/transports/bleTransport.test.ts` | BLE factory + abstract-class tests (fake hooks). |
| `tsup.config.ts` (modify) | Add `transports` entry. |
| `package.json` (modify) | Add `./transports` to `exports`. |
| `docs/src/content/docs/guides/transports.*` (modify/locate) | Add serialport / noble / RN BLE recipes. |

The transports are intentionally **not** re-exported from `src/index.ts` — they are an opt-in subpath only.

---

## Task 1: Serial frame encoder

**Files:**
- Create: `src/transports/serialFraming.ts`
- Test: `tests/transports/serialFraming.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/transports/serialFraming.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { encodeSerialFrame } from '../../src/transports/serialFraming';

describe('encodeSerialFrame', () => {
  it('wraps a payload as [0x3c][len uint16 LE][payload]', () => {
    const out = encodeSerialFrame(Uint8Array.from([0xaa, 0xbb, 0xcc]));
    expect([...out]).toEqual([0x3c, 0x03, 0x00, 0xaa, 0xbb, 0xcc]);
  });

  it('encodes the length little-endian for a multi-byte length', () => {
    const out = encodeSerialFrame(new Uint8Array(300)); // 300 = 0x012c
    expect([out[0], out[1], out[2]]).toEqual([0x3c, 0x2c, 0x01]);
    expect(out.length).toBe(303);
  });

  it('encodes an empty payload as a bare header', () => {
    expect([...encodeSerialFrame(new Uint8Array(0))]).toEqual([0x3c, 0x00, 0x00]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/transports/serialFraming.test.ts`
Expected: FAIL — cannot resolve `../../src/transports/serialFraming` / `encodeSerialFrame is not a function`.

- [ ] **Step 3: Write minimal implementation**

Create `src/transports/serialFraming.ts`:

```ts
// MeshCore companion serial/TCP framing. Each frame on the wire is:
//   [ type: 1 byte ][ length: uint16 LE ][ payload: <length> bytes ]
// type is 0x3c '<' (host→device) or 0x3e '>' (device→host); payload is one
// complete companion frame. Verified against meshcore-dev/meshcore.js
// (src/connection/serial_connection.js, src/constants.js).

const FRAME_TYPE_OUTGOING = 0x3c; // '<' host → device
const FRAME_TYPE_INCOMING = 0x3e; // '>' device → host
const HEADER_LENGTH = 3;
// Firmware MAX_FRAME_SIZE is 176 (BaseSerialInterface.h); 256 leaves headroom.
const DEFAULT_MAX_FRAME_BYTES = 256;

/** Wrap one companion frame as a host→device serial frame: [0x3c][len LE][payload]. */
export function encodeSerialFrame(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER_LENGTH + payload.length);
  out[0] = FRAME_TYPE_OUTGOING;
  out[1] = payload.length & 0xff;
  out[2] = (payload.length >> 8) & 0xff;
  out.set(payload, HEADER_LENGTH);
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/transports/serialFraming.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/transports/serialFraming.ts tests/transports/serialFraming.test.ts
git commit -m "feat(transports): serial frame encoder"
```

---

## Task 2: Serial stream de-framer

**Files:**
- Modify: `src/transports/serialFraming.ts`
- Test: `tests/transports/serialFraming.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `tests/transports/serialFraming.test.ts`:

```ts
import { SerialDeframer } from '../../src/transports/serialFraming';

// Build a device→host wire frame: [0x3e][len LE][payload].
function wire(payload: number[]): number[] {
  const len = payload.length;
  return [0x3e, len & 0xff, (len >> 8) & 0xff, ...payload];
}

describe('SerialDeframer', () => {
  it('decodes one complete frame in a single chunk', () => {
    const d = new SerialDeframer();
    const frames = d.push(Uint8Array.from(wire([1, 2, 3])));
    expect(frames.map((f) => [...f])).toEqual([[1, 2, 3]]);
  });

  it('decodes multiple frames coalesced in one chunk', () => {
    const d = new SerialDeframer();
    const frames = d.push(Uint8Array.from([...wire([1, 2]), ...wire([9])]));
    expect(frames.map((f) => [...f])).toEqual([[1, 2], [9]]);
  });

  it('reassembles a frame delivered one byte at a time', () => {
    const d = new SerialDeframer();
    const bytes = wire([7, 8, 9]);
    const collected: number[][] = [];
    for (const b of bytes) collected.push(...d.push(Uint8Array.from([b])).map((f) => [...f]));
    expect(collected).toEqual([[7, 8, 9]]);
  });

  it('holds a partial frame until the rest arrives', () => {
    const d = new SerialDeframer();
    const full = wire([1, 2, 3, 4]);
    expect(d.push(Uint8Array.from(full.slice(0, 4)))).toEqual([]); // header + 1 byte
    const frames = d.push(Uint8Array.from(full.slice(4)));
    expect(frames.map((f) => [...f])).toEqual([[1, 2, 3, 4]]);
  });

  it('resyncs past leading garbage', () => {
    const d = new SerialDeframer();
    const frames = d.push(Uint8Array.from([0x00, 0xff, 0x12, ...wire([5, 6])]));
    expect(frames.map((f) => [...f])).toEqual([[5, 6]]);
  });

  it('accepts the 0x3c type byte too (reference tolerance)', () => {
    const d = new SerialDeframer();
    const frames = d.push(Uint8Array.from([0x3c, 0x01, 0x00, 0x42]));
    expect(frames.map((f) => [...f])).toEqual([[0x42]]);
  });

  it('treats a zero-length header as garbage and resyncs', () => {
    const d = new SerialDeframer();
    // 0x3e,0x00,0x00 is dropped one byte at a time; a real frame follows.
    const frames = d.push(Uint8Array.from([0x3e, 0x00, 0x00, ...wire([1])]));
    expect(frames.map((f) => [...f])).toEqual([[1]]);
  });

  it('rejects an oversized length (> maxFrameBytes) and resyncs instead of buffering', () => {
    const d = new SerialDeframer({ maxFrameBytes: 8 });
    // Declares length 0xffff — must NOT wait for 65k bytes; drop and resync.
    const frames = d.push(Uint8Array.from([0x3e, 0xff, 0xff, ...wire([4, 5])]));
    expect(frames.map((f) => [...f])).toEqual([[4, 5]]);
  });

  it('decodes a max-size 176-byte frame', () => {
    const d = new SerialDeframer();
    const payload = Array.from({ length: 176 }, (_, i) => i & 0xff);
    const frames = d.push(Uint8Array.from(wire(payload)));
    expect(frames.length).toBe(1);
    expect(frames[0].length).toBe(176);
  });

  it('round-trips an encoded frame back through the de-framer', () => {
    const d = new SerialDeframer();
    const encoded = encodeSerialFrame(Uint8Array.from([0xde, 0xad, 0xbe, 0xef]));
    expect(d.push(encoded).map((f) => [...f])).toEqual([[0xde, 0xad, 0xbe, 0xef]]);
  });

  it('reset() drops any buffered partial frame', () => {
    const d = new SerialDeframer();
    d.push(Uint8Array.from([0x3e, 0x04, 0x00, 0x01])); // partial
    d.reset();
    const frames = d.push(Uint8Array.from(wire([2])));
    expect(frames.map((f) => [...f])).toEqual([[2]]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/transports/serialFraming.test.ts`
Expected: FAIL — `SerialDeframer is not a constructor`.

- [ ] **Step 3: Implement `SerialDeframer`**

Append to `src/transports/serialFraming.ts`:

```ts
/**
 * Resync-tolerant de-framer for the MeshCore serial byte stream. Feed it raw
 * bytes as they arrive; it returns zero or more complete companion-frame
 * payloads, buffering any partial tail. Never throws on malformed input — it
 * drops a byte and resyncs.
 */
export class SerialDeframer {
  private buffer = new Uint8Array(0);
  private readonly maxFrameBytes: number;

  constructor(opts?: { maxFrameBytes?: number }) {
    this.maxFrameBytes = opts?.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  }

  /** Discard any buffered partial frame. */
  reset(): void {
    this.buffer = new Uint8Array(0);
  }

  /** Append bytes and return every complete companion-frame payload now available. */
  push(bytes: Uint8Array): Uint8Array[] {
    const merged = new Uint8Array(this.buffer.length + bytes.length);
    merged.set(this.buffer, 0);
    merged.set(bytes, this.buffer.length);
    this.buffer = merged;

    const frames: Uint8Array[] = [];
    while (this.buffer.length >= HEADER_LENGTH) {
      const type = this.buffer[0];
      if (type !== FRAME_TYPE_OUTGOING && type !== FRAME_TYPE_INCOMING) {
        this.buffer = this.buffer.subarray(1); // spurious byte → resync
        continue;
      }
      const length = this.buffer[1] | (this.buffer[2] << 8); // uint16 LE
      if (length === 0 || length > this.maxFrameBytes) {
        this.buffer = this.buffer.subarray(1); // bad length → resync, never over-buffer
        continue;
      }
      const required = HEADER_LENGTH + length;
      if (this.buffer.length < required) break; // wait for more bytes
      frames.push(this.buffer.slice(HEADER_LENGTH, required)); // slice() copies → caller owns it
      this.buffer = this.buffer.subarray(required);
    }
    return frames;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/transports/serialFraming.test.ts`
Expected: PASS (all encoder + de-framer tests).

- [ ] **Step 5: Commit**

```bash
git add src/transports/serialFraming.ts tests/transports/serialFraming.test.ts
git commit -m "feat(transports): resync-tolerant serial de-framer"
```

---

## Task 3: SerialTransport (duck-typed serialport adapter)

**Files:**
- Create: `src/transports/serialTransport.ts`
- Test: `tests/transports/serialTransport.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/transports/serialTransport.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/transports/serialTransport.test.ts`
Expected: FAIL — cannot resolve `../../src/transports/serialTransport`.

- [ ] **Step 3: Write the implementation**

Create `src/transports/serialTransport.ts`:

```ts
import type { Transport } from '../ports/transport';
import type { TransportState } from '../types';
import { SerialDeframer, encodeSerialFrame } from './serialFraming';

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/transports/serialTransport.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/transports/serialTransport.ts tests/transports/serialTransport.test.ts
git commit -m "feat(transports): SerialTransport over a duck-typed port"
```

---

## Task 4: createBleTransport + Nordic UART constants

**Files:**
- Create: `src/transports/bleTransport.ts`
- Test: `tests/transports/bleTransport.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/transports/bleTransport.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createBleTransport, NORDIC_UART } from '../../src/transports/bleTransport';
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/transports/bleTransport.test.ts`
Expected: FAIL — cannot resolve `../../src/transports/bleTransport`.

- [ ] **Step 3: Write the implementation**

Create `src/transports/bleTransport.ts`:

```ts
import type { Transport } from '../ports/transport';
import type { TransportState } from '../types';

/** Nordic UART Service UUIDs used by the MeshCore companion BLE interface. */
export const NORDIC_UART = {
  service: '6E400001-B5A3-F393-E0A9-E50E24DCCA9E',
  rxWrite: '6E400002-B5A3-F393-E0A9-E50E24DCCA9E', // host → device
  txNotify: '6E400003-B5A3-F393-E0A9-E50E24DCCA9E', // device → host
} as const;

/** I/O hooks the caller binds to their BLE library (noble, react-native-ble-plx, …). */
export interface BleHooks {
  /** Write one companion frame to the RX characteristic. */
  write(bytes: Uint8Array): Promise<void> | void;
  /**
   * Register a notification handler for the TX characteristic. Each notification
   * delivered to `onBytes` is ONE complete companion frame (no framing on BLE).
   */
  subscribe(onBytes: (frame: Uint8Array) => void): void;
  /** Optional: map connect/disconnect to transport state. */
  watchState?(onState: (s: TransportState) => void): void;
}

/**
 * Build a Transport from BLE I/O hooks. BLE notifications are already whole
 * companion frames, so there is no framing here. The user owns the connection;
 * state defaults to 'connected' (you have characteristics to talk to) and
 * follows `watchState` thereafter.
 */
export function createBleTransport(hooks: BleHooks): Transport {
  let dataCb: ((chunk: Uint8Array) => void) | undefined;
  let stateCb: ((s: TransportState) => void) | undefined;
  let state: TransportState = 'connected';

  hooks.subscribe((frame) => dataCb?.(frame));
  hooks.watchState?.((s) => {
    state = s;
    stateCb?.(s);
  });

  return {
    async send(bytes: Uint8Array): Promise<void> {
      await hooks.write(bytes);
    },
    onData(cb: (chunk: Uint8Array) => void): void {
      dataCb = cb;
    },
    onStateChange(cb: (s: TransportState) => void): void {
      stateCb = cb;
    },
    getState(): TransportState {
      return state;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/transports/bleTransport.test.ts`
Expected: PASS (NORDIC_UART + createBleTransport tests).

- [ ] **Step 5: Commit**

```bash
git add src/transports/bleTransport.ts tests/transports/bleTransport.test.ts
git commit -m "feat(transports): createBleTransport + Nordic UART UUIDs"
```

---

## Task 5: Abstract BleTransport class

**Files:**
- Modify: `src/transports/bleTransport.ts`
- Test: `tests/transports/bleTransport.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `tests/transports/bleTransport.test.ts`:

```ts
import { BleTransport } from '../../src/transports/bleTransport';

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
```

(The `import type { TransportState }` from Task 4's test header is reused — `feed`/`flip` rely on it; no new import needed beyond `BleTransport`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/transports/bleTransport.test.ts`
Expected: FAIL — `BleTransport is not a constructor` / `is abstract`.

- [ ] **Step 3: Implement the abstract class**

Append to `src/transports/bleTransport.ts`:

```ts
/**
 * Inheritance-friendly wrapper over createBleTransport. Subclass implements
 * writeChunk() and calls the protected deliver()/setState() from its own BLE
 * event wiring. Bytes-only — do any base64 (e.g. react-native-ble-plx)
 * encoding inside the subclass.
 */
export abstract class BleTransport implements Transport {
  private readonly inner: Transport;
  // Assigned synchronously by createBleTransport's subscribe()/watchState() below.
  private deliverFn!: (frame: Uint8Array) => void;
  private stateFn!: (s: TransportState) => void;

  constructor() {
    this.inner = createBleTransport({
      write: (bytes) => this.writeChunk(bytes),
      subscribe: (onBytes) => {
        this.deliverFn = onBytes;
      },
      watchState: (onState) => {
        this.stateFn = onState;
      },
    });
  }

  /** Implement: write one companion frame to the RX characteristic. */
  protected abstract writeChunk(bytes: Uint8Array): Promise<void> | void;

  /** Call from your TX notification handler with one complete companion frame. */
  protected deliver(frame: Uint8Array): void {
    this.deliverFn(frame);
  }

  /** Call from your connect/disconnect handler. */
  protected setState(s: TransportState): void {
    this.stateFn(s);
  }

  send(bytes: Uint8Array): Promise<void> {
    return this.inner.send(bytes);
  }
  onData(cb: (chunk: Uint8Array) => void): void {
    this.inner.onData(cb);
  }
  onStateChange(cb: (s: TransportState) => void): void {
    this.inner.onStateChange(cb);
  }
  getState(): TransportState {
    return this.inner.getState();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/transports/bleTransport.test.ts`
Expected: PASS (factory + abstract-class tests).

- [ ] **Step 5: Commit**

```bash
git add src/transports/bleTransport.ts tests/transports/bleTransport.test.ts
git commit -m "feat(transports): abstract BleTransport wrapper"
```

---

## Task 6: Subpath barrel + build wiring

**Files:**
- Create: `src/transports/index.ts`
- Modify: `tsup.config.ts`
- Modify: `package.json`
- Test: `tests/transports/index.test.ts`

- [ ] **Step 1: Write the failing barrel test**

Create `tests/transports/index.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import * as transports from '../../src/transports/index';

describe('transports barrel', () => {
  it('re-exports the public transport surface', () => {
    expect(typeof transports.encodeSerialFrame).toBe('function');
    expect(typeof transports.SerialDeframer).toBe('function');
    expect(typeof transports.SerialTransport).toBe('function');
    expect(typeof transports.createBleTransport).toBe('function');
    expect(typeof transports.BleTransport).toBe('function');
    expect(transports.NORDIC_UART.service).toBe('6E400001-B5A3-F393-E0A9-E50E24DCCA9E');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/transports/index.test.ts`
Expected: FAIL — cannot resolve `../../src/transports/index`.

- [ ] **Step 3: Create the barrel**

Create `src/transports/index.ts`:

```ts
// Opt-in transport glue (serial + BLE). Imported via `@andyshinn/meshcore-ts/transports`.
// Deliberately NOT re-exported from the package root — keeps the core surface clean.
export * from './serialFraming';
export * from './serialTransport';
export * from './bleTransport';
```

- [ ] **Step 4: Run barrel test to verify it passes**

Run: `npx vitest run tests/transports/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the tsup entry**

Edit `tsup.config.ts` — change the `entry` line from:

```ts
  entry: ['src/index.ts'],
```

to:

```ts
  entry: { index: 'src/index.ts', transports: 'src/transports/index.ts' },
```

(Leave the rest of the config unchanged. Object entries pin the outputs to `dist/index.*` and `dist/transports.*`.)

- [ ] **Step 6: Add the package.json subpath export**

Edit `package.json` — change the `exports` block from:

```json
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  },
```

to:

```json
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    },
    "./transports": {
      "types": "./dist/transports.d.ts",
      "import": "./dist/transports.js",
      "require": "./dist/transports.cjs"
    }
  },
```

- [ ] **Step 7: Build and verify the subpath outputs exist**

Run: `npm run build`
Then: `ls dist/transports.js dist/transports.cjs dist/transports.d.ts`
Expected: all three files exist (build succeeds, no type errors).

- [ ] **Step 8: Typecheck, lint, and run the full suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: typecheck clean, biome reports no errors, all tests pass (existing + new transports tests).
If biome flags formatting, run `npm run format` and re-run lint.

- [ ] **Step 9: Commit**

```bash
git add src/transports/index.ts tsup.config.ts package.json tests/transports/index.test.ts
git commit -m "build(transports): expose meshcore-ts/transports subpath export"
```

---

## Task 7: Documentation recipes

**Files:**
- Locate/modify the transports guide under `docs/` (see Step 1).

- [ ] **Step 1: Locate the existing transports guide page**

Run: `ls docs/src/content/docs/guides/ 2>/dev/null; grep -rl "transport" docs/src/content 2>/dev/null`
Use the existing transports guide file (commit `94884b1` added guide pages including a transports page). If none exists, create `docs/src/content/docs/guides/transports.md` with frontmatter `---\ntitle: Transports\n---`.

- [ ] **Step 2: Add the three copy-paste recipes**

Append these sections to the transports guide. Use the package's published name `@andyshinn/meshcore-ts`:

````md
## Serial (node-serialport)

```ts
import { SerialPort } from 'serialport';
import { MeshCoreSession } from '@andyshinn/meshcore-ts';
import { SerialTransport } from '@andyshinn/meshcore-ts/transports';

const port = new SerialPort({ path: '/dev/ttyUSB0', baudRate: 115200 });
const session = new MeshCoreSession({ transport: new SerialTransport(port) });
session.start(); // SerialTransport observes open/close/error; it does not open the port
```

`SerialTransport` frames the MeshCore serial protocol for you. You own opening
and closing the port.

## BLE (noble)

```ts
import noble from '@abandonware/noble';
import { MeshCoreSession } from '@andyshinn/meshcore-ts';
import { createBleTransport, NORDIC_UART } from '@andyshinn/meshcore-ts/transports';

// After you have connected `peripheral` and discovered `rxChar`/`txChar`
// for NORDIC_UART.rxWrite / NORDIC_UART.txNotify:
const transport = createBleTransport({
  write: (bytes) => rxChar.writeAsync(Buffer.from(bytes), true),
  subscribe: (onBytes) => {
    txChar.on('data', (data: Buffer) => onBytes(new Uint8Array(data)));
    txChar.subscribe(() => {});
  },
  watchState: (onState) => peripheral.on('disconnect', () => onState('idle')),
});
const session = new MeshCoreSession({ transport });
session.start();
```

## BLE (React Native — react-native-ble-plx)

`react-native-ble-plx` deals in base64 strings, so decode/encode in your hooks:

```ts
import { Buffer } from 'buffer';
import { createBleTransport } from '@andyshinn/meshcore-ts/transports';

const transport = createBleTransport({
  write: (bytes) =>
    device.writeCharacteristicWithResponseForService(
      service, rxUuid, Buffer.from(bytes).toString('base64'),
    ).then(() => {}),
  subscribe: (onBytes) =>
    device.monitorCharacteristicForService(service, txUuid, (_err, ch) => {
      if (ch?.value) onBytes(new Uint8Array(Buffer.from(ch.value, 'base64')));
    }),
  watchState: (onState) =>
    device.onDisconnected(() => onState('idle')),
});
```
````

- [ ] **Step 3: Verify the docs build**

Run: `npm run docs:build`
Expected: the Starlight site builds without errors.
(If the docs workspace isn't installed, run `npm --prefix docs install` first.)

- [ ] **Step 4: Commit**

```bash
git add docs
git commit -m "docs(transports): serialport, noble, and RN BLE recipes"
```

---

## Done

All tasks complete when: `npm run typecheck && npm run lint && npm test && npm run build` all pass, and `@andyshinn/meshcore-ts/transports` exposes `encodeSerialFrame`, `SerialDeframer`, `SerialTransport`, `SerialPortLike`, `createBleTransport`, `BleTransport`, `BleHooks`, and `NORDIC_UART` — with no runtime or type dependency on `serialport`, `noble`, or any RN package.
