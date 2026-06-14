import { Buffer } from 'node:buffer';
import { CMD } from '../codes';

// CMD_SET_RADIO_PARAMS. firmware ver ≥ 9 accepts a trailing client_repeat byte;
// older firmware rejects the longer frame, so the caller must know the version.
export function encodeSetRadioParams(opts: {
  frequencyHz: number;
  bandwidthHz: number;
  spreadingFactor: number;
  codingRate: number;
  /** Repeat (firmware ver ≥ 9). When undefined, the byte is omitted. */
  clientRepeat?: boolean;
}): Buffer {
  const includeRepeat = opts.clientRepeat !== undefined;
  const out = Buffer.alloc(1 + 4 + 4 + 1 + 1 + (includeRepeat ? 1 : 0));
  out[0] = CMD.SET_RADIO_PARAMS;
  out.writeUInt32LE(opts.frequencyHz >>> 0, 1);
  out.writeUInt32LE(opts.bandwidthHz >>> 0, 5);
  out[9] = opts.spreadingFactor & 0xff;
  out[10] = opts.codingRate & 0xff;
  if (includeRepeat) out[11] = opts.clientRepeat ? 1 : 0;
  return out;
}

// CMD_SET_RADIO_TX_POWER: [0x0c][dBm u8]. Firmware clamps to the per-board max.
export function encodeSetRadioTxPower(dBm: number): Buffer {
  return Buffer.from([CMD.SET_RADIO_TX_POWER, dBm & 0xff]);
}
