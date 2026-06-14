import type { Buffer } from 'node:buffer';
import { BufferWriter } from '../buffer';
import { APP_PROTOCOL_VERSION, CMD, RESP } from '../codes';
import type { Feature } from '../feature';
import { pathHashModeToSize } from './pathHash';

// RESP_DEVICE_INFO. The official client treats most of the payload as
// firmware-version-specific metadata; we only need the few fields we surface
// in the UI. Bytes past `firmware_ver_code` evolve across firmware revisions,
// so optional readers fall back to undefined when the frame is too short.
// Named `DeviceInfoFrame` to distinguish the parsed wire reply from the app's
// `DeviceInfo` state type in shared/types.ts.
export interface DeviceInfoFrame {
  /** Firmware capability level: 1=v1.x, ..., 9 adds client_repeat,
   *  10 adds path_hash_mode in the device info reply. */
  firmwareVerCode: number;
  /** Firmware reports max_contacts as count/2 (legacy encoding). */
  maxContacts: number;
  maxChannels: number;
  /** Repeat mode echo when firmware >= 9; undefined otherwise. */
  clientRepeat?: boolean;
  /** Path hash mode echo (0|1|2 -> 1|2|3 bytes per hop) when firmware >= 10. */
  pathHashMode?: number;
  /** Best-effort device model string scanned from the trailing printable bytes.
   *  May be empty when the firmware doesn't emit one. */
  deviceModel: string;
}

// CMD_DEVICE_QUERY: [0x16][app_protocol_version u8]. Firmware reads byte [1]
// into app_target_ver, which gates V3-style response frames. Reply is
// RESP_DEVICE_INFO (0x0d) with firmware version + capacity counts.
export function encodeDeviceQuery(version = APP_PROTOCOL_VERSION): Buffer {
  return new BufferWriter()
    .writeByte(CMD.DEVICE_QUERY)
    .writeByte(version & 0xff)
    .toBuffer();
}

export function decodeDeviceInfo(frame: Buffer): DeviceInfoFrame | null {
  if (frame.length < 4) return null;
  const firmwareVerCode = frame[1];
  const maxContacts = frame[2] * 2;
  const maxChannels = frame[3];
  const clientRepeat = frame.length > 80 ? frame[80] !== 0 : undefined;
  const pathHashMode = frame.length > 81 ? frame[81] : undefined;
  let start = frame.length;
  while (start > 4) {
    const b = frame[start - 1];
    if (b >= 0x20 && b < 0x7f) start -= 1;
    else break;
  }
  const deviceModel = frame.subarray(start).toString('utf8').trim();
  return {
    firmwareVerCode,
    maxContacts,
    maxChannels,
    clientRepeat,
    pathHashMode,
    deviceModel,
  };
}

// RESP/PUSH handler: fold firmware version + capacity counts into device info,
// derive capability flags, and sync the radio's path-hash mode into RadioSettings.
export const deviceInfoFeature: Feature = {
  handles: [RESP.DEVICE_INFO],
  handle: (_code, frame, ctx) => {
    const parsed = decodeDeviceInfo(frame);
    if (!parsed) return;
    const next = {
      ...ctx.state.getDeviceInfo(),
      firmwareVerCode: parsed.firmwareVerCode,
      maxContacts: parsed.maxContacts,
      maxChannels: parsed.maxChannels,
      deviceModel: parsed.deviceModel || ctx.state.getDeviceInfo().deviceModel,
    };
    ctx.state.setDeviceInfo(next);
    ctx.events.emit('deviceInfo', next);
    // Capabilities follow firmware version codes verbatim — see the
    // meshcore_protocol.dart firmware-version gates. We treat ver >= 9 as
    // unlocking the repeat-mode byte; >= 25 (anecdotal, fw 1.7.0) gates the
    // CLI export/import private-key flow. We pick the conservative cutoff
    // and refine when we learn the actual ver_code that fw 1.7.0 reports.
    const caps = {
      repeatMode: parsed.firmwareVerCode >= 9,
      identityKeyIO: parsed.firmwareVerCode >= 25,
    };
    ctx.state.setDeviceCapabilities(caps);
    ctx.events.emit('deviceCapabilities', caps);
    // Sync the radio's actual path-hash mode into RadioSettings. Firmware
    // >= 10 echoes it in DEVICE_INFO; for older firmware leave whatever the
    // app has stored. The radio is the source of truth when it answers.
    if (parsed.pathHashMode !== undefined) {
      const radioSize = pathHashModeToSize(parsed.pathHashMode);
      const currentRadio = ctx.state.getRadioSettings();
      if (currentRadio.pathHashMode !== radioSize) {
        const nextRadio = { ...currentRadio, pathHashMode: radioSize };
        ctx.state.setRadioSettings(nextRadio);
        ctx.events.emit('radioSettings', nextRadio);
      }
    }
  },
};
