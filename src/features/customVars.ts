import { Buffer } from 'node:buffer';
import { CMD, RESP } from '../protocol/codes';
import type { Feature } from './feature';

// CMD_GET_CUSTOM_VAR: variable-length key. Empty key returns the full set.
export function encodeGetCustomVar(key = ''): Buffer {
  const k = Buffer.from(key, 'utf8');
  const out = Buffer.alloc(1 + k.length);
  out[0] = CMD.GET_CUSTOM_VAR;
  k.copy(out, 1);
  return out;
}

// CMD_SET_CUSTOM_VAR: "key:value" UTF-8. Used for GPS enable / interval and
// other firmware tunables the user-facing UI may surface in the future.
export function encodeSetCustomVar(key: string, value: string | number | boolean): Buffer {
  const v = typeof value === 'boolean' ? (value ? '1' : '0') : String(value);
  const body = Buffer.from(`${key}:${v}`, 'utf8');
  const out = Buffer.alloc(1 + body.length);
  out[0] = CMD.SET_CUSTOM_VAR;
  body.copy(out, 1);
  return out;
}

// RESP_CUSTOM_VARS: comma-separated "key:value" pairs (firmware MyMesh.cpp).
// Example payload: "gps:1,gps_interval:60". For tolerance toward any legacy
// builds that emit newline or NUL separators we also split on those.
export function decodeCustomVars(frame: Buffer): Record<string, string> {
  if (frame.length < 2) return {};
  const text = frame.subarray(1).toString('utf8');
  const out: Record<string, string> = {};
  for (const entry of text.split(/[,\n\0]/)) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(':');
    if (colon === -1) continue;
    out[trimmed.slice(0, colon).trim()] = trimmed.slice(colon + 1).trim();
  }
  return out;
}

// RESP handler: fold the gps / gps_interval custom vars into GpsConfig + emit.
export const customVarsFeature: Feature = {
  handles: [RESP.CUSTOM_VARS],
  handle: (_code, frame, ctx) => {
    const kv = decodeCustomVars(frame);
    if (kv.gps === undefined && kv.gps_interval === undefined) return;
    const current = ctx.state.getGpsConfig();
    const next = {
      enabled: kv.gps !== undefined ? kv.gps === '1' || kv.gps === 'true' : current.enabled,
      intervalSec:
        kv.gps_interval !== undefined ? Number.parseInt(kv.gps_interval, 10) || current.intervalSec : current.intervalSec,
    };
    ctx.state.setGpsConfig(next);
    ctx.events.emit('gpsConfig', next);
  },
};
