import { describe, expect, it } from 'vitest';
import type { ContactRecord, ContactSource } from '../../src/model/contactTypes';

describe('model/contactTypes', () => {
  it('exposes ContactRecord shape and ContactSource union', () => {
    const source: ContactSource = 'advert';
    const record: ContactRecord = {
      publicKeyHex: 'ab',
      type: 0,
      flags: 0,
      outPathLen: 0,
      outPathHex: '',
      name: 'n',
      lastAdvertUnix: 0,
      gpsLat: 0,
      gpsLon: 0,
      lastmod: 0,
    };
    expect(record.publicKeyHex).toBe('ab');
    expect(source).toBe('advert');
  });
});
