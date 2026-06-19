import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { channelHashOf } from '../../src/model/paths';
import type { Channel, Message } from '../../src/model/types';
import { LoopbackTransport } from '../../src/ports/transport';
import { MeshCoreSession } from '../../src/session/session';

// A known channel with an explicit slot index so sendChannelText can address it.
const channel: Channel = {
  key: 'ch:Outbound',
  name: 'Outbound',
  kind: 'public',
  idx: 5,
  secretHex: '00112233445566778899aabbccddeeff',
};

// RESP_OK is a bare 0x00 frame.
const RESP_OK = Uint8Array.from([0x00]);

/** Build a PUSH_CODE_LOG_RX_DATA (0x88) frame carrying a GRP_TXT mesh packet
 *  with the given channel-hash byte and a single-hop path. Layout:
 *    [0x88][snr*4 i8][rssi i8][header][path_len][path 1B][channel_hash][cipher…]
 *  header = (GRP_TXT=0x05 << 2) | FLOOD(0x01); path_len = 1 (hashCount=1,
 *  hashSize=1). hashCount must be ≥1 so the pending-send matcher accepts it. */
function logRxGrpTxtFrame(channelHash: number): Uint8Array {
  const header = (0x05 << 2) | 0x01; // GRP_TXT, FLOOD route
  const pathLen = 0x01; // hashCount=1, hashSize=1
  const pathByte = 0xaa; // one repeater hop prefix
  const cipher = Buffer.from('deadbeef', 'hex'); // opaque encrypted body
  const mesh = Buffer.concat([Buffer.from([header, pathLen, pathByte, channelHash]), cipher]);
  const frame = Buffer.concat([Buffer.from([0x88, 16, -40 & 0xff]), mesh]);
  return Uint8Array.from(frame);
}

describe('MeshCoreSession command surface', () => {
  let transport: LoopbackTransport;
  let session: MeshCoreSession;

  beforeEach(() => {
    transport = new LoopbackTransport();
    session = new MeshCoreSession({ transport });
    session.start();
    transport.setState('connected');
    // Drain the handshake's burst of writes so per-test assertions on
    // `transport.sent` start from a clean slate.
    transport.sent.length = 0;
  });

  afterEach(() => {
    session.stop();
  });

  describe('sendChannelText', () => {
    it('writes the 0x03 channel-text frame for a known channel and returns ok', async () => {
      session.state.setChannels([channel]);

      const result = await session.sendChannelText('ch:Outbound', 'hi there');

      expect(result.ok).toBe(true);
      expect(transport.sent).toHaveLength(1);
      const frame = Buffer.from(transport.sent[0]);
      expect(frame[0]).toBe(0x03); // CMD_SEND_CHAN_TXT_MSG
      expect(frame[1]).toBe(0); // flags
      expect(frame[2]).toBe(5); // channel idx
      // bytes 3..6 are the LE timestamp (non-deterministic); body follows at 7.
      expect(frame.subarray(7).toString('utf8')).toBe('hi there');
      // The returned channelHash matches the channel's derived hash byte.
      expect(result.channelHash).toBe(channelHashOf(channel));
    });

    it('fails cleanly when the channel slot is unknown', async () => {
      session.state.setChannels([{ ...channel, key: 'ch:NoSlot', idx: undefined }]);

      const result = await session.sendChannelText('ch:NoSlot', 'hi');

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/no slot index/i);
      expect(transport.sent).toHaveLength(0);
    });
  });

  describe('setPathHashMode', () => {
    it('writes the SET_PATH_HASH_MODE frame and updates radioSettings', async () => {
      const seen: number[] = [];
      session.events.on('radioSettings', (s) => seen.push(s.pathHashMode));

      await session.setPathHashMode(3);

      expect(transport.sent).toHaveLength(1);
      const frame = Buffer.from(transport.sent[0]);
      // CMD_SET_PATH_HASH_MODE [0x3d][0x00][mode] — size 3 → mode byte 2.
      expect([...frame]).toEqual([0x3d, 0x00, 0x02]);
      expect(session.state.getRadioSettings().pathHashMode).toBe(3);
      expect(seen).toEqual([3]);
    });
  });

  describe('setChannel', () => {
    it('resolves true once the radio acks the write with RESP_OK', async () => {
      const promise = session.setChannel(5, 'Outbound', channel.secretHex as string);
      // setChannel awaits the shared RESP_OK/ERR ack FIFO; feed the ack.
      await vi.waitFor(() => expect(transport.sent).toHaveLength(1));
      const frame = Buffer.from(transport.sent[0]);
      expect(frame[0]).toBe(0x20); // CMD_SET_CHANNEL
      expect(frame[1]).toBe(5); // idx
      transport.receive(RESP_OK);
      await expect(promise).resolves.toBe(true);
    });
  });

  describe('reboot / sendSelfAdvert', () => {
    it('reboot writes the CMD_REBOOT frame', async () => {
      const result = await session.reboot();
      expect(result.ok).toBe(true);
      expect(transport.sent).toHaveLength(1);
      const frame = Buffer.from(transport.sent[0]);
      // CMD_REBOOT [0x13]"reboot".
      expect(frame[0]).toBe(0x13);
      expect(frame.subarray(1).toString('utf8')).toBe('reboot');
    });

    it('sendSelfAdvert writes a flood self-advert by default', async () => {
      const result = await session.sendSelfAdvert();
      expect(result.ok).toBe(true);
      expect(transport.sent).toHaveLength(1);
      // CMD_SEND_SELF_ADVERT [0x07][1] = flood.
      expect([...Buffer.from(transport.sent[0])]).toEqual([0x07, 0x01]);
    });

    it('sendSelfAdvert(false) writes a zero-hop self-advert', async () => {
      await session.sendSelfAdvert(false);
      expect([...Buffer.from(transport.sent[0])]).toEqual([0x07, 0x00]);
    });
  });

  describe('registerChannelSend + 0x88 relay attribution', () => {
    it('emits messagePathHeard when a heard relay matches a registered send', () => {
      // Seed a sent channel message the relay can be attributed back to.
      const messageId = 'chmsg-test-1';
      const message: Message = {
        id: messageId,
        key: channel.key,
        ts: Date.now(),
        body: 'hello channel',
        state: 'sent',
      };
      session.state.insertMessage(message);

      const channelHash = channelHashOf(channel);
      expect(channelHash).not.toBeNull();
      session.registerChannelSend({ messageId, channelHash: channelHash as number });

      const heard: Array<{ id: string; state: string }> = [];
      session.events.on('messagePathHeard', (p) => heard.push({ id: p.id, state: p.state }));

      // A repeater relays our send — the radio surfaces it as a 0x88 log_rx frame
      // whose GRP_TXT payload carries the same channel-hash byte.
      transport.receive(logRxGrpTxtFrame(channelHash as number));

      expect(heard).toHaveLength(1);
      expect(heard[0].id).toBe(messageId);
      // A 'sent' message advances to 'heard' on the first relay observation.
      expect(heard[0].state).toBe('heard');
    });
  });
});
