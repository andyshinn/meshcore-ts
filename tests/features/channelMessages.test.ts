import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { decodeChannelMsgV1, decodeChannelMsgV3, encodeSendChannelText } from '../../src/features/channelMessages';

const hex = (b: Buffer) => b.toString('hex');

describe('channelMessages: encodeSendChannelText', () => {
  it('lays out [cmd][flags][idx][ts u32 LE][text]', () => {
    const out = encodeSendChannelText({ channelIdx: 2, text: 'hi', timestampUnix: 1, flags: 0 });
    expect(hex(out)).toBe('030002010000006869');
  });
});

describe('channelMessages: decodeChannelMsgV3', () => {
  it('decodes snr/4, channel idx, timestamp, and splits the "name: " prefix', () => {
    const body = Buffer.from('Alice: hello', 'utf8');
    const frame = Buffer.alloc(11 + body.length);
    frame[0] = 0x11;
    frame.writeInt8(50, 1); // snr*4 = 50 → 12.5 dB
    frame[4] = 3; // channel idx
    frame[5] = 0xff; // path_len (direct)
    frame[6] = 0; // txt_type
    frame.writeUInt32LE(1_700_000_000, 7);
    body.copy(frame, 11);
    const msg = decodeChannelMsgV3(frame);
    expect(msg?.snrDb).toBe(12.5);
    expect(msg?.channelIdx).toBe(3);
    expect(msg?.pathLen).toBe(0xff);
    expect(msg?.timestampUnix).toBe(1_700_000_000);
    expect(msg?.body).toBe('Alice: hello');
    expect(msg?.senderName).toBe('Alice');
    expect(msg?.cleanBody).toBe('hello');
  });

  it('returns null below 12 bytes', () => {
    expect(decodeChannelMsgV3(Buffer.alloc(11))).toBeNull();
  });
});

describe('channelMessages: decodeChannelMsgV1 (legacy, no snr prefix)', () => {
  it('reports snrDb 0 and reads the older layout', () => {
    const body = Buffer.from('hi', 'utf8');
    const frame = Buffer.alloc(8 + body.length);
    frame[0] = 0x08;
    frame[1] = 1; // channel idx
    frame[2] = 2; // path_len
    frame[3] = 0; // txt_type
    frame.writeUInt32LE(42, 4);
    body.copy(frame, 8);
    const msg = decodeChannelMsgV1(frame);
    expect(msg?.snrDb).toBe(0);
    expect(msg?.channelIdx).toBe(1);
    expect(msg?.timestampUnix).toBe(42);
    expect(msg?.body).toBe('hi');
  });

  it('returns null below 8 bytes', () => {
    expect(decodeChannelMsgV1(Buffer.alloc(7))).toBeNull();
  });
});
