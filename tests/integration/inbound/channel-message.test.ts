import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it } from 'vitest';
import type { Message } from '../../../src/index.js';
import { deliver, makeSession } from '../../support/harness';

// RESP_CHANNEL_MSG_RECV_V3 (0x11): [0x11][snr*4 int8][2B rsv][idx][path_len]
// [txt_type][ts u32 LE][body]. path_len 0xFF = direct (no mesh observation).
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

describe('inbound channel-message pipeline', () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  it('routes a received channel frame to state + storage + bus event', () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    session.markChannelPresent({ key: 'ch:General', name: 'General', kind: 'public', idx: 0 });

    const emitted: Array<{ key: string; messages: Message[] }> = [];
    session.events.on('messages', (key: string, messages: Message[]) => emitted.push({ key, messages }));

    deliver(transport, channelMsgV3(0, 1_700_000_000, 'Alice: hi'));

    expect(emitted.at(-1)?.key).toBe('ch:General');
    const rows = session.state.getMessagesForKey('ch:General');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'ch:General', body: 'hi', state: 'received' });
  });

  it('drops a channel frame for an unknown slot', () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    deliver(transport, channelMsgV3(3, 1_700_000_001, 'Bob: yo'));
    expect(session.state.getRecentMessages()).toHaveLength(0);
  });
});
