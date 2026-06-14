import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it } from 'vitest';
import { FeatureDisabledError, ProtocolError } from '../../../src/index.js';
import { deliver, makeSession } from '../../support/harness.js';

const KEY = 'ab'.repeat(64); // 64-byte ed25519 expanded private key
const RESP_OK = Buffer.from([0x00]);
const RESP_DISABLED = Buffer.from([0x0f]);
const lastSent = (t: { sent: Uint8Array[] }) => {
  const last = t.sent.at(-1);
  return last ? Buffer.from(last) : undefined;
};

describe('outbound device admin', () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  it('exportPrivateKey resolves with the 64-byte key from RESP_PRIVATE_KEY', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();

    const p = session.exportPrivateKey();
    expect(lastSent(transport)?.[0]).toBe(0x17); // CMD_EXPORT_PRIVATE_KEY (bare)
    expect(lastSent(transport)?.length).toBe(1);

    const reply = Buffer.concat([Buffer.from([0x0e]), Buffer.from(KEY, 'hex')]);
    deliver(transport, reply);
    expect(await p).toBe(KEY);
  });

  it('exportPrivateKey rejects FeatureDisabledError on RESP_DISABLED', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    const p = session.exportPrivateKey();
    deliver(transport, RESP_DISABLED);
    await expect(p).rejects.toBeInstanceOf(FeatureDisabledError);
  });

  it('importPrivateKey writes the 65-byte frame and resolves on RESP_OK', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    const p = session.importPrivateKey(KEY);
    const sent = lastSent(transport);
    expect(sent?.[0]).toBe(0x18); // CMD_IMPORT_PRIVATE_KEY
    expect(sent?.length).toBe(65);
    expect(sent?.subarray(1).toString('hex')).toBe(KEY);
    deliver(transport, RESP_OK);
    await expect(p).resolves.toBeUndefined();
  });

  it('importPrivateKey rejects ProtocolError on RESP_ERR', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    const p = session.importPrivateKey(KEY);
    deliver(transport, Buffer.from([0x01, 0x06])); // ERR + ILLEGAL_ARG
    await expect(p).rejects.toBeInstanceOf(ProtocolError);
  });

  it('setDevicePin writes [0x25][pin u32 LE] and resolves on RESP_OK', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    const p = session.setDevicePin(123456);
    expect(lastSent(transport)?.toString('hex')).toBe('2540e20100');
    deliver(transport, RESP_OK);
    await expect(p).resolves.toBeUndefined();
  });

  it('factoryReset writes [0x33]"reset" and is fire-and-forget', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    await session.factoryReset();
    expect(lastSent(transport)?.toString('hex')).toBe('337265736574');
  });
});
