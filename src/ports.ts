// Injection contracts the consumer implements/provides (the `Ports` namespace).
// LoopbackTransport is an adapter and lives in `Transports`, not here.
export {
  EventName,
  type MeshCoreEventMap as EventMap,
  MeshCoreEvents as Events,
} from './ports/events';
export { type Logger, noopLogger } from './ports/logger';
export type { Transport } from './ports/transport';
