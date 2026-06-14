import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it } from 'vitest';
import { deliver, makeSession } from '../../support/harness.js';

const RESP_OK = Buffer.from([0x00]);
const lastSent = (t: { sent: Uint8Array[] }) => {
  const last = t.sent.at(-1);
  return last ? Buffer.from(last) : undefined;
};

function respDefaultScope(name: string, keyByte: number): Buffer {
  const f = Buffer.alloc(48);
  f[0] = 0x1c;
  Buffer.from(name, 'utf8').copy(f, 1);
  Buffer.alloc(16, keyByte).copy(f, 32);
  return f;
}

describe('outbound flood scope', () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  it('setFloodScopeKey writes [0x36][0x00][16B key] and resolves on RESP_OK', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();

    const p = session.setFloodScopeKey({ keyHex: 'aa'.repeat(16) });
    expect(lastSent(transport)?.toString('hex')).toBe(`3600${'aa'.repeat(16)}`);
    deliver(transport, RESP_OK);
    await expect(p).resolves.toBeUndefined();
  });

  it('getDefaultFloodScope decodes the 48-byte set form', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();

    const p = session.getDefaultFloodScope();
    expect(lastSent(transport)?.[0]).toBe(0x40); // CMD_GET_DEFAULT_FLOOD_SCOPE
    deliver(transport, respDefaultScope('General', 0xcd));
    expect(await p).toEqual({ name: 'General', keyHex: 'cd'.repeat(16) });
  });

  it('getDefaultFloodScope resolves null on the 1-byte no-scope reply', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();

    const p = session.getDefaultFloodScope();
    deliver(transport, Buffer.from([0x1c]));
    expect(await p).toBeNull();
  });
});
