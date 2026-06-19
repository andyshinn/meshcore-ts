import { describe, expect, it } from 'vitest';
import * as transports from '../../src/transports.js';

describe('transports barrel', () => {
  it('re-exports the public transport surface', () => {
    expect(typeof transports.encodeSerialFrame).toBe('function');
    expect(typeof transports.SerialDeframer).toBe('function');
    expect(typeof transports.Serial).toBe('function');
    expect(typeof transports.createBle).toBe('function');
    expect(typeof transports.Ble).toBe('function');
    expect(transports.NORDIC_UART.service).toBe('6E400001-B5A3-F393-E0A9-E50E24DCCA9E');
  });
});
