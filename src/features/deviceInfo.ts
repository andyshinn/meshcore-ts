import type { Buffer } from 'node:buffer';
import { BufferWriter } from '../buffer';
import { APP_PROTOCOL_VERSION, CMD, RESP } from '../codes';
import type { Feature } from '../feature';
import { pathHashModeToSize } from './pathHash';

// RESP_DEVICE_INFO. Reply to CMD_DEVICE_QUERY. The firmware writes a fixed
// layout (MeshCore companion_radio MyMesh.cpp, CMD_DEVICE_QUERY handler):
//   [1]      firmware_ver_code
//   [2]      max_contacts / 2          [3]  max_group_channels
//   [4..7]   ble_pin (uint32 LE)
//   [8..19]  firmware build date       (C-string, e.g. "19 Apr 2026")
//   [20..59] manufacturer / model      (C-string, board.getManufacturerName())
//   [60..79] firmware version          (C-string, e.g. "v1.15.0")
//   [80]     client_repeat (v9+)       [81] path_hash_mode (v10+)
// Older firmware emits a shorter frame, so fixed-offset readers fall back to
// undefined / '' when the frame doesn't reach the field. Named `DeviceInfoFrame`
// to distinguish the parsed wire reply from the app's `DeviceInfo` state type.
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
  /** Manufacturer / board model string at offset 20..59 (e.g. "Heltec T114").
   *  Empty when the frame is too short to contain it. */
  deviceModel: string;
  /** BLE pairing PIN (uint32 LE at 4..7); 0 = unset / random per session.
   *  Undefined when the frame predates this field. */
  blePin?: number;
  /** Firmware build date string at 8..19 (e.g. "19 Apr 2026"). */
  firmwareBuildDate?: string;
  /** Human-readable firmware version at 60..79 (e.g. "v1.15.0"). Distinct from
   *  `firmwareVerCode`, the numeric capability byte. */
  firmwareVersion?: string;
}

/** Read a fixed-width null-padded ASCII field as a trimmed string. Returns up to
 *  the first NUL (the firmware null-terminates via strzcpy / memset+strcpy). */
function readFixedCString(frame: Buffer, start: number, len: number): string {
  const slice = frame.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return (nul === -1 ? slice : slice.subarray(0, nul)).toString('utf8').trim();
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
  // Fixed-offset string/pin fields; require the whole field to be present.
  const blePin = frame.length >= 8 ? frame.readUInt32LE(4) : undefined;
  const firmwareBuildDate = frame.length >= 20 ? readFixedCString(frame, 8, 12) : undefined;
  const deviceModel = frame.length >= 60 ? readFixedCString(frame, 20, 40) : '';
  const firmwareVersion = frame.length >= 80 ? readFixedCString(frame, 60, 20) : undefined;
  const clientRepeat = frame.length > 80 ? frame[80] !== 0 : undefined;
  const pathHashMode = frame.length > 81 ? frame[81] : undefined;
  return {
    firmwareVerCode,
    maxContacts,
    maxChannels,
    clientRepeat,
    pathHashMode,
    deviceModel,
    blePin,
    firmwareBuildDate,
    firmwareVersion,
  };
}

// RESP/PUSH handler: fold firmware version + capacity counts into device info,
// derive capability flags, and sync the radio's path-hash mode into RadioSettings.
export const deviceInfoFeature: Feature = {
  handles: [RESP.DEVICE_INFO],
  handle: (_code, frame, ctx) => {
    const parsed = decodeDeviceInfo(frame);
    if (!parsed) return;
    const prev = ctx.state.getDeviceInfo();
    const next = {
      ...prev,
      firmwareVerCode: parsed.firmwareVerCode,
      maxContacts: parsed.maxContacts,
      maxChannels: parsed.maxChannels,
      // Empty string / undefined means a short frame didn't carry the field —
      // keep whatever we already knew rather than clobbering it. blePin uses ??
      // because 0 is a valid value ("unset / random pin").
      deviceModel: parsed.deviceModel || prev.deviceModel,
      firmwareVersion: parsed.firmwareVersion || prev.firmwareVersion,
      firmwareBuildDate: parsed.firmwareBuildDate || prev.firmwareBuildDate,
      blePin: parsed.blePin ?? prev.blePin,
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
