import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { parseCompanionFrame } from '../src/protocol/frame';

describe('parseCompanionFrame', () => {
  it('decodes a PUSH_LOG_RX_DATA (0x88) frame as a log_rx mesh packet', () => {
    // [0x88][snr*4 i8][rssi i8][mesh…]  snr = 12/4 = 3, rssi = -80
    const frame = Buffer.from([0x88, 12, 0xb0, 0xde, 0xad, 0xbe, 0xef]);
    const parsed = parseCompanionFrame(frame);
    expect(parsed).not.toBeNull();
    if (parsed?.kind !== 'mesh') throw new Error('expected mesh');
    expect(parsed.source).toBe('log_rx');
    expect(parsed.snr).toBe(3);
    expect(parsed.rssi).toBe(-80);
    expect([...parsed.meshBytes]).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(parsed.meshHex).toBe('deadbeef');
  });

  it('decodes a PUSH_RAW_DATA (0x84) frame, skipping the 0xFF reserved byte', () => {
    // [0x84][snr*4 i8][rssi i8][0xFF reserved][mesh…]  snr = -8/4 = -2
    const frame = Buffer.from([0x84, 0xf8, 0xa5, 0xff, 0x01, 0x02, 0x03]);
    const parsed = parseCompanionFrame(frame);
    expect(parsed).not.toBeNull();
    if (parsed?.kind !== 'mesh') throw new Error('expected mesh');
    expect(parsed.source).toBe('raw');
    expect(parsed.snr).toBe(-2);
    expect(parsed.rssi).toBe(-91); // 0xa5 as int8
    expect([...parsed.meshBytes]).toEqual([0x01, 0x02, 0x03]);
    expect(parsed.meshHex).toBe('010203');
  });

  it('decodes a known companion response (0x0d RESP_DEVICE_INFO)', () => {
    const frame = Buffer.from([0x0d, 0xaa, 0xbb, 0xcc]);
    const parsed = parseCompanionFrame(frame);
    expect(parsed).not.toBeNull();
    if (parsed?.kind !== 'companion') throw new Error('expected companion');
    expect(parsed.code).toBe(0x0d);
    expect(parsed.codeName).toBe('RESP_DEVICE_INFO');
    expect([...parsed.payloadBytes]).toEqual([0xaa, 0xbb, 0xcc]);
    expect(parsed.payloadHex).toBe('aabbcc');
  });

  it('labels an unknown code with a frame 0x.. fallback name', () => {
    const frame = Buffer.from([0x3a, 0x99]);
    const parsed = parseCompanionFrame(frame);
    expect(parsed).not.toBeNull();
    if (parsed?.kind !== 'companion') throw new Error('expected companion');
    expect(parsed.code).toBe(0x3a);
    expect(parsed.codeName).toBe('frame 0x3a');
    expect([...parsed.payloadBytes]).toEqual([0x99]);
  });

  it('returns null for an empty buffer', () => {
    expect(parseCompanionFrame(Buffer.alloc(0))).toBeNull();
  });
});
