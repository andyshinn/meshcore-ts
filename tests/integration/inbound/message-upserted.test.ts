import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it } from 'vitest';
import type { Message } from '../../../src/model/types.js';
import { deliver, makeSession } from '../../support/harness';

// RESP_CHANNEL_MSG_RECV_V3 (0x11): [0x11][snr*4 int8][2B rsv][idx][path_len]
// [txt_type][ts u32 LE][body]. path_len 0xFF = direct.
function channelMsgV3(idx: number, ts: number, body: string): Buffer {
  const text = Buffer.from(body, 'utf8');
  const frame = Buffer.alloc(11 + text.length);
  frame[0] = 0x11;
  frame.writeInt8(48, 1); // snr*4 = 48 → 12 dB
  frame[4] = idx;
  frame[5] = 0xff; // direct
  frame[6] = 0; // txt_type
  frame.writeUInt32LE(ts, 7);
  text.copy(frame, 11);
  return frame;
}

// RESP_CONTACT_MSG_RECV_V3 (0x10): [code][snr*4 int8][2B rsv][6B sender prefix]
// [path_len][txt_type][ts u32 LE][body].
function contactMsgV3(prefixHex: string, body: string): Buffer {
  const text = Buffer.from(body, 'utf8');
  const f = Buffer.alloc(16 + text.length);
  f[0] = 0x10;
  f.writeInt8(40, 1); // snr*4 = 40 → 10 dB
  Buffer.from(prefixHex, 'hex').copy(f, 4);
  f[10] = 0xff; // path_len (direct)
  f[11] = 0; // txt_type PLAIN
  f.writeUInt32LE(1_700_000_000, 12);
  text.copy(f, 16);
  return f;
}

describe('inbound messageUpserted bus event', () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  it('fires once for an inbound channel message', () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    session.markChannelPresent({ key: 'ch:General', name: 'General', kind: 'public', idx: 0 });

    const upserted: Message[] = [];
    session.events.on('messageUpserted', (m: Message) => upserted.push(m));

    deliver(transport, channelMsgV3(0, 1_700_000_000, 'Alice: hi'));

    expect(upserted).toHaveLength(1);
    expect(upserted[0]).toMatchObject({ key: 'ch:General', body: 'hi', state: 'received' });
  });

  it('fires once for an inbound direct message', () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();

    const upserted: Message[] = [];
    session.events.on('messageUpserted', (m: Message) => upserted.push(m));

    // Unknown sender prefix → the DM pipeline synthesises a contact and inserts
    // the message, the single chokepoint that should emit messageUpserted.
    deliver(transport, contactMsgV3('bbbbbbbbbbbb', 'hello there'));

    expect(upserted).toHaveLength(1);
    expect(upserted[0]).toMatchObject({ key: 'c:bbbbbbbbbbbb', body: 'hello there', state: 'received' });
  });
});
