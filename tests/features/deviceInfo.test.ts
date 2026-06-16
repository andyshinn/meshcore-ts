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

  it('decodeDeviceInfo reads the fixed-offset metadata fields', () => {
    const info = decodeDeviceInfo(Buffer.from(DEVICE_INFO_HEX, 'hex'));
    expect(info?.blePin).toBe(0); // bytes 4..7 are zero → unset / random
    expect(info?.firmwareBuildDate).toBe('19 Apr 2026'); // bytes 8..19
    expect(info?.deviceModel).toBe('Heltec T114'); // bytes 20..59 (manufacturer/model)
    expect(info?.firmwareVersion).toBe('v1.15.0'); // bytes 60..79
  });

  it('decodeDeviceInfo leaves fixed-offset fields absent on a short (v3) frame', () => {
    // [code][ver=0x0b][max_contacts/2=0xaf][max_channels=0x28] — no metadata block.
    const info = decodeDeviceInfo(Buffer.from([0x0d, 0x0b, 0xaf, 0x28]));
    expect(info).not.toBeNull();
    expect(info?.firmwareVerCode).toBe(0x0b);
    expect(info?.maxContacts).toBe(0xaf * 2);
    expect(info?.maxChannels).toBe(0x28);
    expect(info?.blePin).toBeUndefined();
    expect(info?.firmwareBuildDate).toBeUndefined();
    expect(info?.firmwareVersion).toBeUndefined();
    expect(info?.deviceModel).toBe('');
    expect(info?.clientRepeat).toBeUndefined();
    expect(info?.pathHashMode).toBeUndefined();
  });

  it('decodeDeviceInfo returns null for a frame shorter than 4 bytes', () => {
    expect(decodeDeviceInfo(Buffer.from([0x0d, 0x0b]))).toBeNull();
  });
});
