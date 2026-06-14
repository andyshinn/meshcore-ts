import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  decodeChannelDataRecv,
  decodeControlData,
  encodeSendChannelData,
  encodeSendControlData,
  encodeSendRawData,
  encodeSendRawPacket,
} from '../../src/features/rawData';

const hex = (b: Buffer) => b.toString('hex');

describe('rawData: encodeSendRawData', () => {
  it('is [0x19][path_len][path][payload]', () => {
    const out = encodeSendRawData({ pathHex: 'aabb', payload: Buffer.from([1, 2, 3, 4]) });
    expect(hex(out)).toBe('1902aabb01020304');
  });

  it('rejects a payload shorter than 4 bytes', () => {
    expect(() => encodeSendRawData({ pathHex: '', payload: Buffer.from([1, 2, 3]) })).toThrow(/4 bytes/);
  });

  it('rejects a path longer than 127 bytes (flood not supported)', () => {
    expect(() => encodeSendRawData({ pathHex: 'aa'.repeat(128), payload: Buffer.alloc(4) })).toThrow(/127/);
  });
});

describe('rawData: encodeSendControlData', () => {
  it('is [0x37][control_data]', () => {
    expect(hex(encodeSendControlData(Buffer.from([0x81, 0x22])))).toBe('378122');
  });

  it('rejects an empty payload', () => {
    expect(() => encodeSendControlData(Buffer.alloc(0))).toThrow(/empty/i);
  });

  it('rejects a first byte without the high bit set', () => {
    expect(() => encodeSendControlData(Buffer.from([0x01]))).toThrow(/high bit/i);
  });
});

describe('rawData: encodeSendChannelData', () => {
  it('floods with [0x3e][channel_idx][0xff][data_type u16 LE][payload]', () => {
    const out = encodeSendChannelData({
      channelIdx: 3,
      dataType: 0x1234,
      payload: Buffer.from([0xaa, 0xbb]),
    });
    expect(hex(out)).toBe('3e03ff3412aabb');
  });

  it('rejects the reserved data_type 0', () => {
    expect(() => encodeSendChannelData({ channelIdx: 0, dataType: 0, payload: Buffer.alloc(1) })).toThrow(/data_type/);
  });

  it('rejects a payload over the channel-data limit', () => {
    expect(() => encodeSendChannelData({ channelIdx: 0, dataType: 1, payload: Buffer.alloc(168) })).toThrow(/167/);
  });
});

describe('rawData: encodeSendRawPacket', () => {
  it('is [0x41][priority][packet]', () => {
    expect(hex(encodeSendRawPacket({ priority: 7, packetHex: 'aabbcc' }))).toBe('4107aabbcc');
  });

  it('rejects a packet shorter than 2 bytes', () => {
    expect(() => encodeSendRawPacket({ priority: 0, packetHex: 'aa' })).toThrow(/2 bytes/);
  });
});

describe('rawData: decodeChannelDataRecv', () => {
  it('reads snr, channel, path_len, data_type, and data', () => {
    const frame = Buffer.from([0x1b, 0x08, 0x00, 0x00, 0x03, 0xff, 0x34, 0x12, 0x02, 0xaa, 0xbb]);
    expect(decodeChannelDataRecv(frame)).toEqual({
      snrDb: 2,
      channelIdx: 3,
      pathLen: 0xff,
      dataType: 0x1234,
      dataHex: 'aabb',
    });
  });

  it('returns null below the header, or when data overruns the frame', () => {
    expect(decodeChannelDataRecv(Buffer.alloc(8))).toBeNull();
    // data_len claims 3 bytes but only 1 present
    expect(decodeChannelDataRecv(Buffer.from([0x1b, 0, 0, 0, 0, 0, 0, 0, 0x03, 0xaa]))).toBeNull();
  });
});

describe('rawData: decodeControlData', () => {
  it('reads snr, rssi, path_len, and payload', () => {
    const frame = Buffer.from([0x8e, 0xfc, 0xce, 0x02, 0xaa, 0xbb]); // snr*4=-4, rssi=-50
    expect(decodeControlData(frame)).toEqual({
      snrDb: -1,
      rssi: -50,
      pathLen: 2,
      payloadHex: 'aabb',
    });
  });

  it('returns null below the 4-byte header', () => {
    expect(decodeControlData(Buffer.from([0x8e, 0x00, 0x00]))).toBeNull();
  });
});
