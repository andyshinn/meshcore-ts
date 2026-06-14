import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it } from 'vitest';
import type { Channel } from '../../../src/index.js';
import { makeSession } from '../../support/harness.js';

const channel: Channel = {
  key: 'ch:Outbound',
  name: 'Outbound',
  kind: 'public',
  idx: 5,
  secretHex: '00112233445566778899aabbccddeeff',
};

describe('outbound channel send', () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  it('encodes the channel-text frame and writes it to the transport', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    session.state.setChannels([channel]);

    const result = await session.sendChannelText('ch:Outbound', 'hi there');
    expect(result.ok).toBe(true);

    expect(transport.sent).toHaveLength(1);
    const frame = Buffer.from(transport.sent[0]);
    expect(frame[0]).toBe(0x03); // SEND_CHAN_TXT_MSG
    expect(frame[1]).toBe(0); // flags
    expect(frame[2]).toBe(5); // channel idx
    // bytes 3..6 are the LE timestamp (non-deterministic); body follows at 7.
    expect(frame.subarray(7).toString('utf8')).toBe('hi there');
  });

  it('fails cleanly when the channel slot is unknown', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    session.state.setChannels([{ ...channel, key: 'ch:NoSlot', idx: undefined }]);
    const result = await session.sendChannelText('ch:NoSlot', 'hi');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no slot index/i);
    expect(transport.sent).toHaveLength(0);
  });
});
