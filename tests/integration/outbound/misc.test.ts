import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it } from 'vitest';
import { deliver, makeSession } from '../../support/harness.js';

const PK = 'aa'.repeat(32);
const RESP_OK = Buffer.from([0x00]);
const RESP_ERR = Buffer.from([0x01, 0x02]); // ERR + NOT_FOUND
const lastSent = (t: { sent: Uint8Array[] }) => {
  const last = t.sent.at(-1);
  return last ? Buffer.from(last) : undefined;
};

describe('outbound misc queries', () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  it('hasConnection maps RESP_OK→true and RESP_ERR→false', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();

    const p1 = session.hasConnection(PK);
    expect(lastSent(transport)?.[0]).toBe(0x1c); // CMD_HAS_CONNECTION
    deliver(transport, RESP_OK);
    expect(await p1).toBe(true);

    const p2 = session.hasConnection(PK);
    deliver(transport, RESP_ERR);
    expect(await p2).toBe(false);
  });

  it('getAllowedRepeatFreq decodes the frequency ranges', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();

    const p = session.getAllowedRepeatFreq();
    expect(lastSent(transport)?.[0]).toBe(0x3c); // CMD_GET_ALLOWED_REPEAT_FREQ
    const frame = Buffer.alloc(9);
    frame[0] = 0x1a;
    frame.writeUInt32LE(902_000_000, 1);
    frame.writeUInt32LE(928_000_000, 5);
    deliver(transport, frame);
    expect(await p).toEqual([{ lowerHz: 902_000_000, upperHz: 928_000_000 }]);
  });
});
