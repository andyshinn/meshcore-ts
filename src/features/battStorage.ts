import type { Buffer } from 'node:buffer';
import { BufferReader, BufferWriter } from '../protocol/buffer';
import { CMD, RESP } from '../protocol/codes';
import type { Feature } from './feature';

export interface BattAndStorage {
  batteryMv: number;
  storageUsedKb: number;
  storageTotalKb: number;
}

// CMD_GET_BATT_AND_STORAGE: [0x14]. Replies RESP_BATT_AND_STORAGE.
export function encodeGetBattAndStorage(): Buffer {
  return new BufferWriter().writeByte(CMD.GET_BATT_AND_STORAGE).toBuffer();
}

// RESP_BATT_AND_STORAGE: [0x0c][batt_mv u16 LE][used_kb u32 LE][total_kb u32 LE].
export function decodeBattAndStorage(frame: Buffer): BattAndStorage | null {
  const r = new BufferReader(frame);
  r.readByte(); // code
  if (r.remaining < 10) return null;
  return {
    batteryMv: r.readUInt16LE(),
    storageUsedKb: r.readUInt32LE(),
    storageTotalKb: r.readUInt32LE(),
  };
}

// PUSH/RESP handler: fold battery + storage into device info and emit.
export const battStorageFeature: Feature = {
  handles: [RESP.BATT_AND_STORAGE],
  handle: (_code, frame, ctx) => {
    const parsed = decodeBattAndStorage(frame);
    if (!parsed) return;
    const next = {
      ...ctx.state.getDeviceInfo(),
      batteryMv: parsed.batteryMv,
      storageUsedKb: parsed.storageUsedKb,
      storageTotalKb: parsed.storageTotalKb,
    };
    ctx.state.setDeviceInfo(next);
    ctx.events.emit('deviceInfo', next);
  },
};
