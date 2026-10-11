import { Buffer } from 'node:buffer';
import { CMD, RESP } from '../protocol/codes';
import type { Feature, FeatureContext } from './feature';

// CMD_GET_CUSTOM_VARS: [0x28]. The firmware ignores anything after the opcode
// and always answers with every setting its sensor manager exposes. `key` is
// still appended for compatibility with callers that pass one.
export function encodeGetCustomVar(key = ''): Buffer {
  const k = Buffer.from(key, 'utf8');
  const out = Buffer.alloc(1 + k.length);
  out[0] = CMD.GET_CUSTOM_VAR;
  k.copy(out, 1);
  return out;
}

// CMD_SET_CUSTOM_VAR: "key:value" UTF-8. The firmware splits on the FIRST ':',
// so a key must not contain one (the value may). Used for GPS enable /
// interval and any other sensor setting the firmware exposes.
export function encodeSetCustomVar(key: string, value: string | number | boolean): Buffer {
  const v = typeof value === 'boolean' ? (value ? '1' : '0') : String(value);
  const body = Buffer.from(`${key}:${v}`, 'utf8');
  const out = Buffer.alloc(1 + body.length);
  out[0] = CMD.SET_CUSTOM_VAR;
  body.copy(out, 1);
  return out;
}

// RESP_CUSTOM_VARS: comma-separated "key:value" pairs (firmware MyMesh.cpp).
// Example payload: "gps:1". The reply is EMPTY (just the code byte) on a radio
// whose sensor manager exposes no settings, e.g. no GPS hardware. `gps_interval`
// is write-only: the firmware accepts it but never reports it. For tolerance
// toward any legacy builds that emit newline or NUL separators we also split
// on those.
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

/** Decode RESP_CUSTOM_VARS, emit `customVars` (always — `{}` is the answer
 *  from a radio with no settings, distinct from no answer at all), then fold
 *  any gps / gps_interval value into GpsConfig and emit `gpsConfig`. Shared by
 *  the feature handler and requestCustomVars(), which consumes the frame via
 *  the typed-reply path and so must invoke this itself. */
export function applyCustomVars(ctx: FeatureContext, frame: Buffer): Record<string, string> {
  const kv = decodeCustomVars(frame);
  ctx.events.emit('customVars', { ...kv });
  foldGpsVars(ctx, kv);
  return kv;
}

/** Fold gps / gps_interval values (as reported, or as just written) into
 *  GpsConfig and emit `gpsConfig`. No-op when neither key is present. */
export function foldGpsVars(ctx: FeatureContext, kv: Record<string, string>): void {
  if (kv.gps === undefined && kv.gps_interval === undefined) return;
  const current = ctx.state.getGpsConfig();
  // The firmware reads gps_interval with atoi and uses 1s for 0.
  const interval = kv.gps_interval !== undefined ? Number.parseInt(kv.gps_interval, 10) : Number.NaN;
  const next = {
    enabled: kv.gps !== undefined ? kv.gps !== '0' : current.enabled,
    intervalSec: Number.isNaN(interval) ? current.intervalSec : Math.max(1, interval),
  };
  ctx.state.setGpsConfig(next);
  ctx.events.emit('gpsConfig', next);
}

// RESP handler: an unsolicited (or late) RESP_CUSTOM_VARS.
export const customVarsFeature: Feature = {
  handles: [RESP.CUSTOM_VARS],
  handle: (_code, frame, ctx) => {
    applyCustomVars(ctx, frame);
  },
};
