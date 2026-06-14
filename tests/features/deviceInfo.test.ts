import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { decodeDeviceInfo, encodeDeviceQuery } from '../../src/features/deviceInfo';

// De-framed RESP_DEVICE_INFO from a Heltec T114 running firmware v1.15.0
// (donor fixture connect-session.json → "deviceInfo"). 82 bytes: ver_code 0x0b,
// max_contacts 0xaf (count/2), max_channels 0x28, trailing client_repeat (0) +
// path_hash_mode (1) at offsets 80/81.
const DEVICE_INFO_HEX =
  '0d0baf280000000031392041707220323032360048656c7465632054313134000000000000000000000000000000000000000000000000000000000076312e31352e30000000000000000000000000000001';

describe('deviceInfo encode/decode', () => {
  it('encodeDeviceQuery defaults to protocol version 4', () => {
    expect(encodeDeviceQuery().toString('hex')).toBe('1604');
  });

  it('encodeDeviceQuery(3) matches the byte sequence seen on the wire', () => {
    // Cross-checked against coresense.log: PROXY_RX cmd=0x16 hex=1603
    expect(encodeDeviceQuery(3).toString('hex')).toBe('1603');
  });

  it('decodeDeviceInfo reads firmware version, doubled max-contacts, and max-channels', () => {
    const info = decodeDeviceInfo(Buffer.from(DEVICE_INFO_HEX, 'hex'));
    expect(info).not.toBeNull();
    expect(info?.firmwareVerCode).toBe(0x0b); // 11
    expect(info?.maxContacts).toBe(0xaf * 2); // firmware reports count/2 → 350
    expect(info?.maxChannels).toBe(0x28); // 40
    expect(info?.pathHashMode).toBe(1); // trailing byte
    expect(info?.clientRepeat).toBe(false);
  });

  it('decodeDeviceInfo returns null for a frame shorter than 4 bytes', () => {
    expect(decodeDeviceInfo(Buffer.from([0x0d, 0x0b]))).toBeNull();
  });
});
