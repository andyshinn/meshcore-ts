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
