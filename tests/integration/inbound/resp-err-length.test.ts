import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it } from 'vitest';
import { Errors } from '../../../src/index.js';
import { deliver, makeSession } from '../../support/harness.js';

// RESP_ERR (0x01) carries an optional firmware error byte at frame[1]. A bare,
// one-byte RESP_ERR (truncated / no error code) must degrade safely to
// Errors.ProtocolError(undefined) — the documented bare-RESP_ERR semantics — rather
// than reading past the frame. setDeviceTime awaits the RESP_OK/RESP_ERR ack
// channel and re-throws Errors.ProtocolError, so it surfaces the parsed errorCode.
describe('RESP_ERR frame-length handling on the ack path', () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  it('a bare (1-byte) RESP_ERR rejects with Errors.ProtocolError and errorCode undefined', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();

    const p = session.setDeviceTime(1000);
    await Promise.resolve(); // ack entry is registered synchronously; let writeFrame start
    deliver(transport, Buffer.from([0x01])); // bare RESP_ERR — no error-code byte

    await expect(p).rejects.toBeInstanceOf(Errors.ProtocolError);
    await expect(p).rejects.toMatchObject({ errorCode: undefined });
  });

  it('a 2-byte RESP_ERR surfaces its firmware error byte as errorCode', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();

    const p = session.setDeviceTime(1000);
    await Promise.resolve();
    deliver(transport, Buffer.from([0x01, 0x06])); // RESP_ERR + ERR_CODE_ILLEGAL_ARG (0x06)

    await expect(p).rejects.toBeInstanceOf(Errors.ProtocolError);
    await expect(p).rejects.toMatchObject({ errorCode: 0x06 });
  });
});
