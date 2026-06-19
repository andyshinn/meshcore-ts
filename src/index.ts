// Public entry point for @andyshinn/meshcore-ts (core surface).
import { version } from '../package.json';

export const VERSION: string = version;

export type { ContactRecord, ContactSource } from './model/contactTypes';
// Errors consumers catch.
export {
  ContactTableFullError,
  FeatureDisabledError,
  ProtocolError,
  ProtocolTimeoutError,
  UnknownContactError,
} from './model/errors';
// Domain types consumers touch.
export type { Contact, TransportState } from './model/types';
// Event map for typing session.on(...) handlers.
export type { MeshCoreEventMap } from './ports/events';
// Structured-logging port (passed via MeshCoreSessionOptions.logger).
export type { Logger } from './ports/logger';
export type { Transport } from './ports/transport';
// Transport contract + the dependency-free in-memory transport.
export { LoopbackTransport } from './ports/transport';
export type { MeshCoreSessionOptions } from './session/session';
// Session orchestrator + its constructor options.
export { MeshCoreSession } from './session/session';
