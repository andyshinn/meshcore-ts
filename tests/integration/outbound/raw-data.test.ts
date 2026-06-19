import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it } from 'vitest';
import { Errors } from '../../../src/index.js';
import { deliver, makeSession } from '../../support/harness.js';

const RESP_OK = Buffer.from([0x00]);
const RESP_ERR = Buffer.from([0x01, 0x03]); // ERR + TABLE_FULL
const lastSentHex = (t: { sent: Uint8Array[] }) => {
  const last = t.sent.at(-1);
  return last ? Buffer.from(last).toString('hex') : undefined;
};

describe('outbound raw / control / channel data', () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  it('sendRawData writes [0x19][path_len][path][payload] and resolves on RESP_OK', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    const p = session.sendRawData({
      pathHex: 'aabb',
      payload: Buffer.from([1, 2, 3, 4]),
    });
    expect(lastSentHex(transport)).toBe('1902aabb01020304');
    deliver(transport, RESP_OK);
    await expect(p).resolves.toBeUndefined();
  });

  it('sendControlData writes [0x37][data] and rejects Errors.ProtocolError on RESP_ERR', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    const p = session.sendControlData(Buffer.from([0x81, 0x22]));
    expect(lastSentHex(transport)).toBe('378122');
    deliver(transport, RESP_ERR);
    await expect(p).rejects.toBeInstanceOf(Errors.ProtocolError);
  });

  it('sendChannelData writes the flood frame and resolves on RESP_OK', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    const p = session.sendChannelData({
      channelIdx: 3,
      dataType: 0x1234,
      payload: Buffer.from([0xaa, 0xbb]),
    });
    expect(lastSentHex(transport)).toBe('3e03ff3412aabb');
    deliver(transport, RESP_OK);
    await expect(p).resolves.toBeUndefined();
  });

  it('sendRawPacket writes [0x41][priority][packet] and resolves on RESP_OK', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    const p = session.sendRawPacket({ priority: 7, packetHex: 'aabbcc' });
    expect(lastSentHex(transport)).toBe('4107aabbcc');
    deliver(transport, RESP_OK);
    await expect(p).resolves.toBeUndefined();
  });

  it('routes inbound control/channel datagrams to their handler without error', () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    // RESP_CHANNEL_DATA_RECV [0x1b][snr][rsv][rsv][ch][path][type LE][len][data]
    const chanData = Buffer.from([0x1b, 0x08, 0x00, 0x00, 0x03, 0xff, 0x34, 0x12, 0x02, 0xaa, 0xbb]);
    // PUSH_CONTROL_DATA [0x8e][snr][rssi][path_len][payload]
    const controlData = Buffer.from([0x8e, 0xfc, 0xce, 0x02, 0xaa, 0xbb]);
    expect(() => deliver(transport, chanData)).not.toThrow();
    expect(() => deliver(transport, controlData)).not.toThrow();
  });
});
