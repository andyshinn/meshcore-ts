// Public entry point for @andyshinn/meshcore-ts.
// Three essentials are top-level; everything else is grouped by area namespace.
import { version } from '../package.json';

export const VERSION: string = version;

/** Feature framework contracts + the feature types surfaced by session methods. */
export * as Features from './features';
/** Domain data model: contacts, channels, messages, device/radio settings, defaults. */
export * as Models from './model';
/** Error classes consumers catch (`instanceof Errors.ProtocolError`). */
export * as Errors from './model/errors';
/** Contracts you implement/inject: Transport, Logger, EventMap. */
export * as Ports from './ports';
/** Wire codec for building/parsing companion + on-air frames (power users). */
export * as Protocol from './protocol';
// Session orchestrator + its constructor options.
export type { MeshCoreSessionOptions } from './session/session';
export { MeshCoreSession } from './session/session';
/** Hardware transport adapters this library ships (Serial, Ble, Loopback). */
export * as Transports from './transports';
