import { Buffer } from 'node:buffer';
import connectSession from '../fixtures/frames/connect-session.json' with { type: 'json' };

const FRAMES: Record<string, { hex: string }> = connectSession;

/** The full de-framed companion-frame hex for a named fixture. */
export function frameHex(name: string): string {
  const entry = FRAMES[name];
  if (!entry) throw new Error(`unknown frame fixture: ${name}`);
  return entry.hex;
}

/** The named fixture as a Buffer (first byte = frame code). */
export function frameBuf(name: string): Buffer {
  return Buffer.from(frameHex(name), 'hex');
}
