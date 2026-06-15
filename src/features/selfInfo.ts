import { Buffer } from 'node:buffer';
import { CMD, RESP } from '../codes';
import type { Feature, FeatureContext } from '../feature';
import type { Owner } from '../types';

// RESP_SELF_INFO [0x05][adv_type u8][tx_power u8][max_tx_power u8]
//   [public_key 32B][...adv lat/lon + radio params, firmware-version-specific...]
//   [name, trailing printable ASCII]. We only surface the two fields the
//   identity card needs — the 32B pubkey at a fixed offset and the name via the
//   same trailing-printable scan parseNodeNameFromSelfInfo / decodeDeviceInfo use,
//   which is firmware-version tolerant.
export interface SelfInfo {
  name: string;
  publicKeyHex: string;
}

// CMD_APP_START payload (per src/main/bridge/identity.ts):
//   [0x01][version u8][6 reserved bytes][app name UTF-8]. Reply is RESP_SELF_INFO.
export function encodeAppStart(appName: string, version = 1): Buffer {
  const name = Buffer.from(appName, 'utf8');
  const out = Buffer.alloc(8 + name.length);
  out[0] = CMD.APP_START;
  out[1] = version;
  // bytes 2..7 stay zero
  name.copy(out, 8);
  return out;
}

export function decodeSelfInfo(frame: Buffer): SelfInfo | null {
  if (frame.length < 36 || frame[0] !== 0x05) return null;
  const publicKeyHex = frame.subarray(4, 36).toString('hex');
  let start = frame.length;
  while (start > 36) {
    const b = frame[start - 1];
    if (b >= 0x20 && b < 0x7f) start -= 1;
    else break;
  }
  const name = frame.subarray(start).toString('utf8').trim();
  return { name, publicKeyHex };
}

/** Decode RESP_SELF_INFO, publish the radio identity as the app Owner, and
 *  return the parsed SelfInfo. Shared by the feature handler and the on-demand
 *  getSelfInfo() getter (which consumes the frame via the typed-reply path, so
 *  it must invoke this explicitly). */
export function applySelfInfo(ctx: FeatureContext, frame: Buffer): SelfInfo | null {
  const parsed = decodeSelfInfo(frame);
  if (!parsed) return null;
  const owner: Owner = {
    name: parsed.name,
    publicKeyHex: parsed.publicKeyHex,
    // Codebase convention for pubkey prefixes is the first 12 hex chars
    // (6 bytes); the identity card shows fewer but stores the full key.
    publicKeyShort: parsed.publicKeyHex.slice(0, 12),
  };
  ctx.state.setOwner(owner);
  ctx.events.emit('owner', owner);
  ctx.log.debug(`self-info: "${owner.name}" (${owner.publicKeyShort})`);
  return parsed;
}

// RESP handler: surface the radio's identity as the app Owner.
export const selfInfoFeature: Feature = {
  handles: [RESP.SELF_INFO],
  handle: (_code, frame, ctx) => {
    applySelfInfo(ctx, frame);
  },
};
