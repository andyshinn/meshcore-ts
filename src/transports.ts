// Hardware transport adapters: @andyshinn/meshcore-ts/transports.
// Carries the optional peer deps (noble, serialport) — kept out of core.
export { createBleTransport, BleTransport, NORDIC_UART } from './transports/bleTransport';
export type { BleHooks } from './transports/bleTransport';
export { SerialTransport } from './transports/serialTransport';
export type { SerialPortLike } from './transports/serialTransport';
export { SerialDeframer, encodeSerialFrame } from './transports/serialFraming';
