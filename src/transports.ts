// Hardware transport adapters: @andyshinn/meshcore-ts/transports.
// Carries the optional peer deps (noble, serialport) — kept out of core.
export type { BleHooks } from './transports/bleTransport';
export { BleTransport, createBleTransport, NORDIC_UART } from './transports/bleTransport';
export { encodeSerialFrame, SerialDeframer } from './transports/serialFraming';
export type { SerialPortLike } from './transports/serialTransport';
export { SerialTransport } from './transports/serialTransport';
