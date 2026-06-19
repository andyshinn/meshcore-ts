// Hardware transport adapters (the `Transports` namespace). Adapters take an
// already-constructed port/hooks object; this package imports no peer deps.

// Loopback is a dependency-free adapter — grouped with the adapters, not Ports.
export { LoopbackTransport as Loopback } from './ports/transport';
export type { BleHooks } from './transports/bleTransport';
export {
  BleTransport as Ble,
  createBleTransport as createBle,
  NORDIC_UART,
} from './transports/bleTransport';
export { encodeSerialFrame, SerialDeframer } from './transports/serialFraming';
export type { SerialPortLike } from './transports/serialTransport';
export { SerialTransport as Serial } from './transports/serialTransport';
export type { SocketLike, TcpTransportOptions } from './transports/tcpTransport';
export {
  createTcpTransport as createTcp,
  TcpTransport as Tcp,
} from './transports/tcpTransport';
