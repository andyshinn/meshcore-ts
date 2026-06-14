import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { decodeBattAndStorage, encodeGetBattAndStorage } from '../../src/features/battStorage';

describe('battStorage encode/decode', () => {
  it('encodeGetBattAndStorage is the bare opcode', () => {
    expect(encodeGetBattAndStorage().toString('hex')).toBe('14');
  });

  it('decodeBattAndStorage reads batt mv (u16) and storage kb (u32 ×2)', () => {
    const frame = Buffer.from([0x0c, 0x10, 0x0e, 0x00, 0x01, 0x00, 0x00, 0x00, 0x10, 0x00, 0x00]);
    const b = decodeBattAndStorage(frame);
    expect(b).toEqual({ batteryMv: 3600, storageUsedKb: 256, storageTotalKb: 4096 });
  });

  it('decodeBattAndStorage returns null for a short frame', () => {
    expect(decodeBattAndStorage(Buffer.from([0x0c, 0x10, 0x0e]))).toBeNull();
  });
});
