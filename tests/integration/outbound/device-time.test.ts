import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Errors } from '../../../src/index.js';
import { deliver, makeSession } from '../../support/harness.js';

describe('device time round-trips', () => {
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
    vi.useRealTimers();
  });

  it('getDeviceTime sends [0x05] and resolves RESP_CURR_TIME', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();

    const p = session.getDeviceTime();
    await Promise.resolve();
    expect(Buffer.from(transport.sent[0]).toString('hex')).toBe('05');
    deliver(transport, Buffer.from([0x09, 0x04, 0x03, 0x02, 0x01])); // RESP_CURR_TIME
    await expect(p).resolves.toBe(0x01020304);
  });

  it('setDeviceTime resolves on RESP_OK', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();

    const p = session.setDeviceTime(1_700_000_000);
    await Promise.resolve();
    deliver(transport, Buffer.from([0x00])); // RESP_OK
    await expect(p).resolves.toBeUndefined();
  });

  it('setDeviceTime rejects with Errors.ProtocolError on RESP_ERR[ILLEGAL_ARG]', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();

    const p = session.setDeviceTime(1);
    await Promise.resolve();
    deliver(transport, Buffer.from([0x01, 0x06])); // RESP_ERR + ERR_CODE_ILLEGAL_ARG
    const err = await p.catch((e) => e);
    expect(err).toBeInstanceOf(Errors.ProtocolError);
    expect((err as Errors.ProtocolError).errorCode).toBe(0x06);
  });

  it('getDeviceTime rejects when the transport disconnects mid-request', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    // Drive the session 'connected' so the later 'disconnected' edge runs the
    // transport-disconnect cleanup (which only fires on a connected→disconnected
    // transition).
    transport.setState('connected');

    const p = session.getDeviceTime();
    await Promise.resolve();
    transport.setState('idle'); // disconnect edge → drains pendingTyped
    await expect(p).rejects.toThrow(/disconnected/i);
  });

  it('getDeviceTime rejects with Errors.ProtocolTimeoutError after the timeout elapses', async () => {
    vi.useFakeTimers();
    const { session } = makeSession();
    stop = () => session.stop();

    const p = session.getDeviceTime();
    const expectation = expect(p).rejects.toBeInstanceOf(Errors.ProtocolTimeoutError);
    await vi.advanceTimersByTimeAsync(5_000);
    await expectation;
  });
});
