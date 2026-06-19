import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it } from 'vitest';
import { Errors } from '../../../src/index.js';
import { deliver, makeSession } from '../../support/harness.js';

const SIG = 'cd'.repeat(64);
const RESP_OK = Buffer.from([0x00]);
const lastSent = (t: { sent: Uint8Array[] }) => {
  const last = t.sent.at(-1);
  return last ? Buffer.from(last) : undefined;
};

// Yield to the event loop so a pending writeFrame lands in transport.sent before we
// inject the next reply. setTimeout(0) drains the full microtask chain that
// ctx.request → writeFrame → send schedules.
const flush = () => new Promise((r) => setTimeout(r, 0));

function signStartReply(maxLen: number): Buffer {
  const frame = Buffer.alloc(6);
  frame[0] = 0x13; // RESP_SIGN_START
  frame[1] = 0x00; // reserved
  frame.writeUInt32LE(maxLen, 2);
  return frame;
}

function signatureReply(sigHex: string): Buffer {
  return Buffer.concat([Buffer.from([0x14]), Buffer.from(sigHex, 'hex')]);
}

describe('outbound message signing', () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  it('drives START → DATA → FINISH and resolves with the signature', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    const data = Buffer.from([0x01, 0x02, 0x03]);

    const p = session.signData(data);
    await flush();
    expect(lastSent(transport)?.[0]).toBe(0x21); // CMD_SIGN_START
    deliver(transport, signStartReply(8192));

    await flush();
    expect(lastSent(transport)?.toString('hex')).toBe('22010203'); // CMD_SIGN_DATA[chunk]
    deliver(transport, RESP_OK);

    await flush();
    expect(lastSent(transport)?.[0]).toBe(0x23); // CMD_SIGN_FINISH
    deliver(transport, signatureReply(SIG));

    expect(await p).toBe(SIG);
  });

  it('splits data larger than the chunk size into multiple SIGN_DATA frames', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    const data = Buffer.alloc(200, 0xab); // 200 > 128 chunk → 128 + 72

    const p = session.signData(data);
    await flush();
    expect(lastSent(transport)?.[0]).toBe(0x21);
    deliver(transport, signStartReply(8192));

    await flush();
    const c1 = lastSent(transport);
    expect(c1?.[0]).toBe(0x22);
    expect(c1?.length).toBe(1 + 128);
    deliver(transport, RESP_OK);

    await flush();
    const c2 = lastSent(transport);
    expect(c2?.[0]).toBe(0x22);
    expect(c2?.length).toBe(1 + 72);
    deliver(transport, RESP_OK);

    await flush();
    expect(lastSent(transport)?.[0]).toBe(0x23); // FINISH
    deliver(transport, signatureReply(SIG));

    expect(await p).toBe(SIG);
  });

  it('signs empty data with no SIGN_DATA frames (START → FINISH)', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    const p = session.signData(Buffer.alloc(0));
    await flush();
    expect(lastSent(transport)?.[0]).toBe(0x21);
    deliver(transport, signStartReply(8192));

    await flush();
    expect(lastSent(transport)?.[0]).toBe(0x23); // straight to FINISH, no 0x22
    deliver(transport, signatureReply(SIG));

    expect(await p).toBe(SIG);
  });

  it('rejects without sending data when the payload exceeds the device max', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    const p = session.signData(Buffer.alloc(5));
    await flush();
    expect(lastSent(transport)?.[0]).toBe(0x21);
    const sentCount = transport.sent.length;
    deliver(transport, signStartReply(4)); // maxLen 4 < 5

    await expect(p).rejects.toThrow(/exceeds the device max/);
    expect(transport.sent.length).toBe(sentCount); // no CMD_SIGN_DATA written
  });

  it('rejects Errors.ProtocolError when a chunk is refused (RESP_ERR BAD_STATE)', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    const p = session.signData(Buffer.from([0xaa]));
    await flush();
    deliver(transport, signStartReply(8192));

    await flush();
    expect(lastSent(transport)?.[0]).toBe(0x22);
    deliver(transport, Buffer.from([0x01, 0x04])); // RESP_ERR + BAD_STATE

    await expect(p).rejects.toBeInstanceOf(Errors.ProtocolError);
  });
});
