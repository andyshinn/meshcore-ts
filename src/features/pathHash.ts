import { Buffer } from 'node:buffer';
import { CMD } from '../codes';

// CMD_SET_PATH_HASH_MODE: [0x3d][0x00][mode u8]. The 0x00 is a required
// discriminator byte — firmware MyMesh.cpp:1431 gates the handler on
// `cmd_frame[1] == 0 && len >= 3`. mode is 0/1/2 (1/2/3 bytes per hop hash).
// Persists across reboots on the radio side. (Firmware sends
// `_prefs.path_hash_mode + 1` bytes per hop — see MyMesh.cpp:487.)
export function encodeSetPathHashMode(mode: number): Buffer {
  const m = mode & 0x03;
  return Buffer.from([CMD.SET_PATH_HASH_MODE, 0x00, m]);
}

/** Convert our per-hop byte size (1|2|3) to the firmware's mode byte (0|1|2). */
export function pathHashSizeToMode(size: 1 | 2 | 3): 0 | 1 | 2 {
  return (size - 1) as 0 | 1 | 2;
}
/** Inverse of pathHashSizeToMode. */
export function pathHashModeToSize(mode: number): 1 | 2 | 3 {
  const m = Math.max(0, Math.min(2, mode));
  return (m + 1) as 1 | 2 | 3;
}
