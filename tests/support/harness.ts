import type { Buffer } from 'node:buffer';
import { LoopbackTransport, MeshCoreSession, type MeshCoreSessionOptions } from '../../src/index.js';

export function makeSession(opts?: Partial<MeshCoreSessionOptions>): {
  session: MeshCoreSession;
  transport: LoopbackTransport;
} {
  const transport = new LoopbackTransport();
  const session = new MeshCoreSession({ transport, ...opts });
  session.start();
  return { session, transport };
}

/** Deliver one inbound companion frame to the session. */
export function deliver(transport: LoopbackTransport, frame: Buffer | Uint8Array | string): void {
  if (typeof frame === 'string') transport.receiveHex(frame);
  else transport.receive(frame instanceof Uint8Array ? frame : Uint8Array.from(frame));
}
