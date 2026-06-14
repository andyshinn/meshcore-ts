import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it } from 'vitest';
import { deliver, makeSession } from '../../support/harness.js';

const RESP_OK = Buffer.from([0x00]);
const RESP_ERR = Buffer.from([0x01, 0x06]); // ERR + ILLEGAL_ARG
const lastSent = (t: { sent: Uint8Array[] }) => {
  const last = t.sent.at(-1);
  return last ? Buffer.from(last) : undefined;
};

// RESP_TUNING_PARAMS: [0x17][rx×1000 u32 LE][airtime×1000 u32 LE].
function respTuning(rxMilli: number, afMilli: number): Buffer {
  const f = Buffer.alloc(9);
  f[0] = 0x17;
  f.writeUInt32LE(rxMilli, 1);
  f.writeUInt32LE(afMilli, 5);
  return f;
}

describe('outbound radio tuning', () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  it('getTuningParams writes GET and resolves the decoded RESP_TUNING_PARAMS', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();

    const p = session.getTuningParams();
    expect(lastSent(transport)?.[0]).toBe(0x2b); // CMD_GET_TUNING_PARAMS
    deliver(transport, respTuning(12500, 2345));
    expect(await p).toEqual({ rxDelayBase: 12.5, airtimeFactor: 2.345 });
  });

  it('setTuningParams writes the 9-byte SET frame and resolves on RESP_OK', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();

    const p = session.setTuningParams({ rxDelayBase: 10, airtimeFactor: 1 });
    const frame = lastSent(transport);
    expect(frame?.toString('hex')).toBe('1510270000e8030000');
    deliver(transport, RESP_OK);
    await expect(p).resolves.toBeUndefined();
  });

  it('setTuningParams rejects on RESP_ERR', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();

    const p = session.setTuningParams({ rxDelayBase: 99, airtimeFactor: 99 });
    deliver(transport, RESP_ERR);
    await expect(p).rejects.toThrow();
  });
});
