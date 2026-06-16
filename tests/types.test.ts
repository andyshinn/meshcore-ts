import { describe, expect, it } from 'vitest';
import {
  type Contact,
  DEFAULT_AUTO_ADD_CONFIG,
  DEFAULT_DEVICE_CAPABILITIES,
  DEFAULT_DEVICE_IDENTITY,
  DEFAULT_DEVICE_INFO,
  DEFAULT_GPS_CONFIG,
  DEFAULT_RADIO_SETTINGS,
  DEFAULT_SYNC_PROGRESS,
  DEFAULT_TELEMETRY_POLICY,
  hasValidFix,
} from '../src/index.js';

describe('DEFAULT_SYNC_PROGRESS', () => {
  it('has exactly the expected keys and values', () => {
    expect(DEFAULT_SYNC_PROGRESS).toEqual({
      phase: 'idle',
      channels: { done: 0, total: 0 },
      contacts: { done: 0, total: 0 },
    });
    expect(Object.keys(DEFAULT_SYNC_PROGRESS).sort()).toEqual(['channels', 'contacts', 'phase']);
  });
});

describe('DEFAULT_RADIO_SETTINGS', () => {
  it('has exactly the expected keys and values', () => {
    expect(DEFAULT_RADIO_SETTINGS).toEqual({
      frequencyHz: 910_525_000,
      bandwidthHz: 62_500,
      spreadingFactor: 7,
      codingRate: 5,
      txPowerDbm: 20,
      repeatMode: false,
      pathHashMode: 2,
    });
  });

  it('uses pathHashMode 2', () => {
    expect(DEFAULT_RADIO_SETTINGS.pathHashMode).toBe(2);
  });
});

describe('DEFAULT_DEVICE_IDENTITY', () => {
  it('has exactly the expected keys and values', () => {
    expect(DEFAULT_DEVICE_IDENTITY).toEqual({
      name: '',
      publicKeyHex: '',
      lat: null,
      lon: null,
      sharePositionInAdvert: true,
    });
  });
});

describe('DEFAULT_AUTO_ADD_CONFIG', () => {
  it('has exactly the expected keys and values', () => {
    expect(DEFAULT_AUTO_ADD_CONFIG).toEqual({
      mode: 'all',
      chat: true,
      repeater: true,
      room: true,
      sensor: true,
      overwriteOldest: true,
      maxHops: null,
    });
  });

  it('does not contain the dropped UI keys', () => {
    expect(DEFAULT_AUTO_ADD_CONFIG).not.toHaveProperty('pullToRefresh');
    expect(DEFAULT_AUTO_ADD_CONFIG).not.toHaveProperty('showPublicKeys');
    expect(Object.keys(DEFAULT_AUTO_ADD_CONFIG).sort()).toEqual([
      'chat',
      'maxHops',
      'mode',
      'overwriteOldest',
      'repeater',
      'room',
      'sensor',
    ]);
  });
});

describe('DEFAULT_TELEMETRY_POLICY', () => {
  it('has exactly the expected keys and values', () => {
    expect(DEFAULT_TELEMETRY_POLICY).toEqual({
      base: 1,
      loc: 1,
      env: 1,
      multiAcks: 1,
    });
  });
});

describe('DEFAULT_GPS_CONFIG', () => {
  it('has exactly the expected keys and values', () => {
    expect(DEFAULT_GPS_CONFIG).toEqual({
      enabled: false,
      intervalSec: 300,
    });
  });
});

describe('DEFAULT_DEVICE_INFO', () => {
  it('has exactly the expected keys and values', () => {
    expect(DEFAULT_DEVICE_INFO).toEqual({
      firmwareVerCode: 0,
      deviceModel: '',
      firmwareVersion: '',
      firmwareBuildDate: '',
      blePin: 0,
      maxContacts: 0,
      maxChannels: 0,
      channelsUsed: 0,
      contactsUsed: 0,
      storageUsedKb: 0,
      storageTotalKb: 0,
      batteryMv: 0,
    });
  });
});

describe('DEFAULT_DEVICE_CAPABILITIES', () => {
  it('has exactly the expected keys and values', () => {
    expect(DEFAULT_DEVICE_CAPABILITIES).toEqual({
      identityKeyIO: false,
      repeatMode: false,
    });
  });
});

describe('hasValidFix', () => {
  const base: Contact = {
    key: 'c:abcdef',
    publicKeyHex: 'abcdef',
    name: 'node',
    kind: 'chat',
  };

  it('returns false when coords are absent', () => {
    expect(hasValidFix(base)).toBe(false);
  });

  it('returns false for the 0/0 "no GPS" sentinel', () => {
    expect(hasValidFix({ ...base, gpsLat: 0, gpsLon: 0 })).toBe(false);
  });

  it('returns false for out-of-range latitude', () => {
    expect(hasValidFix({ ...base, gpsLat: 91, gpsLon: 10 })).toBe(false);
    expect(hasValidFix({ ...base, gpsLat: -91, gpsLon: 10 })).toBe(false);
  });

  it('returns false for out-of-range longitude', () => {
    expect(hasValidFix({ ...base, gpsLat: 10, gpsLon: 181 })).toBe(false);
    expect(hasValidFix({ ...base, gpsLat: 10, gpsLon: -181 })).toBe(false);
  });

  it('returns false when only one coord is present', () => {
    expect(hasValidFix({ ...base, gpsLat: 42 })).toBe(false);
    expect(hasValidFix({ ...base, gpsLon: 42 })).toBe(false);
  });

  it('returns true for a valid fix', () => {
    expect(hasValidFix({ ...base, gpsLat: 42.36, gpsLon: -71.06 })).toBe(true);
  });
});
