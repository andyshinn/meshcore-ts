# On-air packet feed + decoder — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a public `rawPacket` event and a standalone `decodeOnAirPacket(hex)` tagged-union decoder to `@andyshinn/meshcore-ts`, so a downstream renderer's packet inspector can run on the library without tapping frames itself.

**Architecture:** Two decoupled additions. (1) The session emits a new `rawPacket` event from `ingest()` for both mesh sources, carrying the inner on-air hex plus snr/rssi. (2) A new pure module `src/onAirPackets.ts` exposes `decodeOnAirPacket(input)`, which calls the existing `parseMeshPacket` for the header/path, then structurally cracks the payload into a discriminated union. No decryption, no encode, no new runtime dependencies.

**Tech Stack:** TypeScript (ESM), vitest (tests in `tests/`), biome (lint/format), `node:buffer`. Reuses `parseMeshPacket` ([src/meshPacket.ts](../../../src/meshPacket.ts)) and `parseAdvert` ([src/advert.ts](../../../src/advert.ts)).

**Reference spec:** [docs/superpowers/specs/2026-06-16-on-air-packet-decoder-design.md](../specs/2026-06-16-on-air-packet-decoder-design.md)

**Conventions confirmed from the codebase:**
- All hex is **lowercase** (`Buffer.toString('hex')`).
- `parseMeshPacket` does NOT throw; returns `null` on malformed/0xFF-sentinel input. `0x84`/raw frames typically return `null` (the `0xFF` sentinel sits where `path_len` belongs).
- Route types with a 4-byte transport-codes block are `TRANSPORT_FLOOD` (0x00) and `TRANSPORT_DIRECT` (0x03) only.
- Test vectors below are **full on-air packets** (header byte included) extracted from `michaelhart/meshcore-decoder` test fixtures, re-expressed in lowercase.

---

## Task 1: The `rawPacket` event

**Files:**
- Test: `tests/session/rawPacket.test.ts` (create)
- Modify: `src/ports/events.ts` (add to `MeshCoreEventMap`)
- Modify: `src/session/session.ts` (emit in `ingest()`)

- [ ] **Step 1: Write the failing test**

Create `tests/session/rawPacket.test.ts`:

```ts
import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { deliver, makeSession } from '../support/harness';

describe('rawPacket event', () => {
  it('emits for a PUSH_LOG_RX_DATA (0x88) frame with inner mesh hex and snr/rssi', () => {
    const { session, transport } = makeSession();
    const seen: Array<{ hex: string; source: string; snr: number; rssi: number }> = [];
    session.events.on('rawPacket', (p) => seen.push(p));

    // [0x88][snr*4 = 12 → 3][rssi 0xb0 → -80][mesh deadbeef]
    deliver(transport, Buffer.from([0x88, 12, 0xb0, 0xde, 0xad, 0xbe, 0xef]));

    expect(seen).toEqual([{ hex: 'deadbeef', source: 'log_rx', snr: 3, rssi: -80 }]);
    session.stop();
  });

  it('emits for a PUSH_RAW_DATA (0x84) frame, skipping the 0xFF reserved byte', () => {
    const { session, transport } = makeSession();
    const seen: Array<{ hex: string; source: string; snr: number; rssi: number }> = [];
    session.events.on('rawPacket', (p) => seen.push(p));

    // [0x84][snr*4 = 0xf8 → -2][rssi 0xa5 → -91][0xFF reserved][mesh 010203]
    deliver(transport, Buffer.from([0x84, 0xf8, 0xa5, 0xff, 0x01, 0x02, 0x03]));

    expect(seen).toEqual([{ hex: '010203', source: 'raw', snr: -2, rssi: -91 }]);
    session.stop();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/session/rawPacket.test.ts`
Expected: FAIL — `seen` stays `[]` because no `rawPacket` is emitted, so `toEqual` fails on both cases.

- [ ] **Step 3: Add `rawPacket` to the event map**

In `src/ports/events.ts`, inside `MeshCoreEventMap`, add the line directly under `transportState`:

```ts
  transportState: (s: TransportState) => void;
  rawPacket: (pkt: { hex: string; source: 'raw' | 'log_rx'; snr: number; rssi: number }) => void;
```

- [ ] **Step 4: Emit the event in `ingest()`**

In `src/session/session.ts`, find the `if (parsed.kind === 'mesh') {` block in `ingest()` and insert the emit as the first statement inside it (before the `PUSH_CODE_LOG_RX_DATA` comment):

```ts
    if (parsed.kind === 'mesh') {
      // Surface the raw on-air bytes to consumers (e.g. a packet inspector)
      // before the internal observation tee. Fires for both sources; only
      // log_rx (0x88) bytes are reliably structurally decodable downstream.
      this.events.emit('rawPacket', {
        hex: parsed.meshHex,
        source: parsed.source,
        snr: parsed.snr,
        rssi: parsed.rssi,
      });
      // PUSH_CODE_LOG_RX_DATA (0x88) carries the raw on-air mesh packet,
```

Leave the rest of the block (the `if (parsed.source === 'log_rx')` observation tee and the trailing `return;`) unchanged.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/session/rawPacket.test.ts`
Expected: PASS (2 passing).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/ports/events.ts src/session/session.ts tests/session/rawPacket.test.ts
git commit -m "feat(session): emit public rawPacket event for on-air frames"
```

---

## Task 2: `onAirPackets.ts` scaffold — types, dispatcher, raw fallback

**Files:**
- Create: `src/onAirPackets.ts`
- Test: `tests/onAirPackets.core.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/onAirPackets.core.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { decodeOnAirPacket } from '../src/onAirPackets';

describe('decodeOnAirPacket — core', () => {
  it('returns a null header + raw fallback for bytes that are not a mesh packet', () => {
    // Single byte: parseMeshPacket requires >= 2 bytes.
    const pkt = decodeOnAirPacket('26');
    expect(pkt.header).toBeNull();
    expect(pkt.payloadTypeName).toBe('UNKNOWN');
    expect(pkt.payload).toEqual({ kind: 'raw', payloadType: null, payloadHex: '26' });
  });

  it('decodes the header but raw-falls-back for an unhandled payload type (GRP_DATA)', () => {
    // header 0x19 → route FLOOD(1), payloadType GRP_DATA(6); path_len 0x00; payload aabb
    const pkt = decodeOnAirPacket('1900aabb');
    expect(pkt.header).not.toBeNull();
    expect(pkt.header?.payloadType).toBe(0x06);
    expect(pkt.payloadTypeName).toBe('GRP_DATA');
    expect(pkt.payload).toEqual({ kind: 'raw', payloadType: 0x06, payloadHex: 'aabb' });
  });

  it('accepts raw bytes as well as a hex string', () => {
    const pkt = decodeOnAirPacket(Uint8Array.from([0x19, 0x00, 0xaa, 0xbb]));
    expect(pkt.payloadTypeName).toBe('GRP_DATA');
    expect(pkt.payload).toEqual({ kind: 'raw', payloadType: 0x06, payloadHex: 'aabb' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/onAirPackets.core.test.ts`
Expected: FAIL — cannot resolve `'../src/onAirPackets'` (module does not exist).

- [ ] **Step 3: Create the module**

Create `src/onAirPackets.ts`:

```ts
import { Buffer } from 'node:buffer';
import type { Advert } from './advert';
import { type MeshPacketHeader, PAYLOAD_TYPE, parseMeshPacket } from './meshPacket';

/** A structurally-decoded MeshCore on-air packet. `header` is null when the
 *  input bytes do not parse as a mesh packet (e.g. a 0x84 sentinel frame or a
 *  truncated buffer); in that case `payload` is the `raw` fallback variant. */
export interface OnAirPacket {
  header: MeshPacketHeader | null;
  /** Enum key for `header.payloadType` (e.g. 'GRP_TXT'); 'UNKNOWN' if absent. */
  payloadTypeName: string;
  payload: OnAirPayload;
}

/** Structural (never decrypted) view of an on-air payload, discriminated on
 *  `kind`. Cipher bodies are reported only as a length (`cipherLen`). */
export type OnAirPayload =
  | { kind: 'advert'; advert: Advert }
  | { kind: 'txtMsg'; destHash: string; srcHash: string; macHex: string; cipherLen: number }
  | { kind: 'grpTxt'; channelHash: string; macHex: string; cipherLen: number }
  | { kind: 'req'; destHash: string; srcHash: string; macHex: string; cipherLen: number }
  | { kind: 'response'; destHash: string; srcHash: string; macHex: string; cipherLen: number }
  | { kind: 'anonReq'; destHash: string; senderPubKeyHex: string; macHex: string; cipherLen: number }
  | { kind: 'ack'; checksumHex: string }
  | { kind: 'path'; pathLen: number; hashSize: number; pathHashesHex: string; extraType: number; extraHex: string }
  | { kind: 'trace'; tag: number; authCode: number; flags: number; hopCount: number; pathHashesHex: string; snr: number[] }
  | { kind: 'controlDiscoverReq'; prefixOnly: boolean; typeFilter: number; tag: number; since: number }
  | { kind: 'controlDiscoverResp'; nodeType: number; snr: number; tag: number; publicKeyHex: string }
  | { kind: 'controlOther'; rawFlags: number; payloadHex: string }
  | { kind: 'raw'; payloadType: number | null; payloadHex: string };

// Reverse lookup: payloadType number → enum key name, for display.
const PAYLOAD_TYPE_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(PAYLOAD_TYPE).map(([name, value]) => [value, name]),
);

/** Decode a full on-air mesh packet (header + path + payload) into a tagged
 *  union. Total — never throws; unparseable or unsupported input yields the
 *  `raw` fallback variant. Accepts a hex string or raw bytes. */
export function decodeOnAirPacket(input: string | Uint8Array): OnAirPacket {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'hex') : Buffer.from(input);
  const header = parseMeshPacket(bytes);
  if (!header) {
    return {
      header: null,
      payloadTypeName: 'UNKNOWN',
      payload: { kind: 'raw', payloadType: null, payloadHex: bytes.toString('hex') },
    };
  }
  return {
    header,
    payloadTypeName: PAYLOAD_TYPE_NAMES[header.payloadType] ?? 'UNKNOWN',
    payload: decodePayload(header),
  };
}

function decodePayload(header: MeshPacketHeader): OnAirPayload {
  const payload = header.payload;
  switch (header.payloadType) {
    // Payload-type cases are inserted above this line by later tasks.
    default:
      break;
  }
  return { kind: 'raw', payloadType: header.payloadType, payloadHex: payload.toString('hex') };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/onAirPackets.core.test.ts`
Expected: PASS (3 passing).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/onAirPackets.ts tests/onAirPackets.core.test.ts
git commit -m "feat(onAir): decodeOnAirPacket scaffold with raw fallback"
```

---

## Task 3: ADVERT variant

**Files:**
- Modify: `src/onAirPackets.ts` (add `ADVERT` case)
- Test: `tests/onAirPackets.advert.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/onAirPackets.advert.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { decodeOnAirPacket } from '../src/onAirPackets';

// Full advert packet (header 0x11 → FLOOD/ADVERT, empty path) from
// meshcore-decoder's packet-structure fixtures.
const ADVERT_HEX =
  '11007e7662676f7f0850a8a355baafbfc1eb7b4174c340442d7d7161c9474a2c94006ce7cf682e58408dd8fcc51906eca98ebf94a037886bdade7ecd09fd92b839491df3809c9454f5286d1d3370ac31a34593d569e9a042a3b41fd331dffb7e18599ce1e60992a076d50238c5b8f85757375354522f50756765744d65736820436f75676172';

describe('decodeOnAirPacket — advert', () => {
  it('wraps parseAdvert as the advert variant', () => {
    const pkt = decodeOnAirPacket(ADVERT_HEX);
    expect(pkt.payloadTypeName).toBe('ADVERT');
    if (pkt.payload.kind !== 'advert') throw new Error('expected advert');
    const a = pkt.payload.advert;
    expect(a.publicKeyHex).toBe('7e7662676f7f0850a8a355baafbfc1eb7b4174c340442d7d7161c9474a2c9400');
    expect(a.timestampUnix).toBe(1758455660);
    expect(a.appData.type).toBe(2); // repeater
    expect(a.appData.name).toBe('WW7STR/PugetMesh Cougar');
    expect(a.appData.latlon?.lat).toBeCloseTo(47.543968, 5);
    expect(a.appData.latlon?.lon).toBeCloseTo(-122.108616, 5);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/onAirPackets.advert.test.ts`
Expected: FAIL — `pkt.payload.kind` is `'raw'`, so the `expected advert` throw fires.

- [ ] **Step 3a: Import `parseAdvert`**

In `src/onAirPackets.ts`, change the advert import so the value (not just the type) is imported — it is used for the first time in this task:

```ts
import type { Advert } from './advert';
```

becomes:

```ts
import { type Advert, parseAdvert } from './advert';
```

- [ ] **Step 3b: Add the ADVERT case**

In `src/onAirPackets.ts`, replace the anchor:

```ts
    // Payload-type cases are inserted above this line by later tasks.
    default:
```

with:

```ts
    case PAYLOAD_TYPE.ADVERT: {
      const advert = parseAdvert(payload);
      if (advert) return { kind: 'advert', advert };
      break;
    }
    // Payload-type cases are inserted above this line by later tasks.
    default:
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/onAirPackets.advert.test.ts`
Expected: PASS (1 passing).

- [ ] **Step 5: Commit**

```bash
git add src/onAirPackets.ts tests/onAirPackets.advert.test.ts
git commit -m "feat(onAir): decode ADVERT payloads via parseAdvert"
```

---

## Task 4: TXT_MSG and GRP_TXT variants

**Files:**
- Modify: `src/onAirPackets.ts` (add `TXT_MSG`, `GRP_TXT` cases)
- Test: `tests/onAirPackets.messages.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/onAirPackets.messages.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { decodeOnAirPacket } from '../src/onAirPackets';

describe('decodeOnAirPacket — text + group messages', () => {
  it('decodes a TXT_MSG into dest/src hash + mac + cipher length', () => {
    // header 0x09 → FLOOD/TXT_MSG; path_len 0x04 (path 6f17c47e); payload follows.
    const pkt = decodeOnAirPacket('09046f17c47ed00a13e16ab5b94b1cc2d1a5059c6e5a6253c60d');
    expect(pkt.payloadTypeName).toBe('TXT_MSG');
    expect(pkt.payload).toEqual({
      kind: 'txtMsg',
      destHash: 'd0',
      srcHash: '0a',
      macHex: '13e1',
      cipherLen: 16,
    });
  });

  it('decodes a GRP_TXT into channel hash + mac + cipher length', () => {
    // header 0x15 → FLOOD/GRP_TXT; path_len 0x00; payload follows.
    const pkt = decodeOnAirPacket(
      '150011c3c1354d619bae9590e4d177db7eeaf982f5bdcf78005d75157d9535fa90178f785d',
    );
    expect(pkt.payloadTypeName).toBe('GRP_TXT');
    expect(pkt.payload).toEqual({
      kind: 'grpTxt',
      channelHash: '11',
      macHex: 'c3c1',
      cipherLen: 32,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/onAirPackets.messages.test.ts`
Expected: FAIL — both decode to the `raw` variant, not `txtMsg`/`grpTxt`.

- [ ] **Step 3: Add the TXT_MSG and GRP_TXT cases**

In `src/onAirPackets.ts`, replace the anchor:

```ts
    // Payload-type cases are inserted above this line by later tasks.
    default:
```

with:

```ts
    case PAYLOAD_TYPE.TXT_MSG: {
      if (payload.length < 4) break;
      return {
        kind: 'txtMsg',
        destHash: payload.subarray(0, 1).toString('hex'),
        srcHash: payload.subarray(1, 2).toString('hex'),
        macHex: payload.subarray(2, 4).toString('hex'),
        cipherLen: payload.length - 4,
      };
    }
    case PAYLOAD_TYPE.GRP_TXT: {
      if (payload.length < 3) break;
      return {
        kind: 'grpTxt',
        channelHash: payload.subarray(0, 1).toString('hex'),
        macHex: payload.subarray(1, 3).toString('hex'),
        cipherLen: payload.length - 3,
      };
    }
    // Payload-type cases are inserted above this line by later tasks.
    default:
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/onAirPackets.messages.test.ts`
Expected: PASS (2 passing).

- [ ] **Step 5: Commit**

```bash
git add src/onAirPackets.ts tests/onAirPackets.messages.test.ts
git commit -m "feat(onAir): decode TXT_MSG and GRP_TXT structural fields"
```

---

## Task 5: REQ, RESPONSE, ANON_REQ variants

**Files:**
- Modify: `src/onAirPackets.ts` (add `REQ`/`RESPONSE`/`ANON_REQ` cases)
- Test: `tests/onAirPackets.requests.test.ts` (create)

Note: the request/response **type** lives inside the encrypted ciphertext and is NOT available on-air — only the dest/src hashes, MAC, and cipher length are decoded.

- [ ] **Step 1: Write the failing test**

Create `tests/onAirPackets.requests.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { decodeOnAirPacket } from '../src/onAirPackets';

describe('decodeOnAirPacket — request / response / anon', () => {
  it('decodes a REQ into dest/src hash + mac + cipher length', () => {
    // header 0x02 → DIRECT/REQ; path_len 0x00.
    const pkt = decodeOnAirPacket('0200d1deb01b2f8b72dd363aa4ef07e0bda2266a8979');
    expect(pkt.payloadTypeName).toBe('REQ');
    expect(pkt.payload).toEqual({
      kind: 'req',
      destHash: 'd1',
      srcHash: 'de',
      macHex: 'b01b',
      cipherLen: 16,
    });
  });

  it('decodes a RESPONSE into dest/src hash + mac + cipher length', () => {
    // header 0x06 → DIRECT/RESPONSE; path_len 0x00.
    const pkt = decodeOnAirPacket('0600de1fdfcad56e6c38b756fee81c24199c6043ac5b');
    expect(pkt.payloadTypeName).toBe('RESPONSE');
    expect(pkt.payload).toEqual({
      kind: 'response',
      destHash: 'de',
      srcHash: '1f',
      macHex: 'dfca',
      cipherLen: 16,
    });
  });

  it('decodes an ANON_REQ into dest hash + sender pubkey + mac + cipher length', () => {
    // header 0x1e → DIRECT/ANON_REQ; path_len 0x01 (path 5f).
    const pkt = decodeOnAirPacket(
      '1e015f5754af4e36fb37d58be06a87aa8f97c23d0a1f42ec66eced68875175540404a496141b071d2809885de13090a8f813b9151927',
    );
    expect(pkt.payloadTypeName).toBe('ANON_REQ');
    expect(pkt.payload).toEqual({
      kind: 'anonReq',
      destHash: '57',
      senderPubKeyHex: '54af4e36fb37d58be06a87aa8f97c23d0a1f42ec66eced68875175540404a496',
      macHex: '141b',
      cipherLen: 16,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/onAirPackets.requests.test.ts`
Expected: FAIL — all three decode to the `raw` variant.

- [ ] **Step 3: Add the REQ / RESPONSE / ANON_REQ cases**

In `src/onAirPackets.ts`, replace the anchor:

```ts
    // Payload-type cases are inserted above this line by later tasks.
    default:
```

with:

```ts
    case PAYLOAD_TYPE.REQ:
    case PAYLOAD_TYPE.RESPONSE: {
      if (payload.length < 4) break;
      const fields = {
        destHash: payload.subarray(0, 1).toString('hex'),
        srcHash: payload.subarray(1, 2).toString('hex'),
        macHex: payload.subarray(2, 4).toString('hex'),
        cipherLen: payload.length - 4,
      };
      return header.payloadType === PAYLOAD_TYPE.REQ
        ? { kind: 'req', ...fields }
        : { kind: 'response', ...fields };
    }
    case PAYLOAD_TYPE.ANON_REQ: {
      if (payload.length < 35) break;
      return {
        kind: 'anonReq',
        destHash: payload.subarray(0, 1).toString('hex'),
        senderPubKeyHex: payload.subarray(1, 33).toString('hex'),
        macHex: payload.subarray(33, 35).toString('hex'),
        cipherLen: payload.length - 35,
      };
    }
    // Payload-type cases are inserted above this line by later tasks.
    default:
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/onAirPackets.requests.test.ts`
Expected: PASS (3 passing).

- [ ] **Step 5: Commit**

```bash
git add src/onAirPackets.ts tests/onAirPackets.requests.test.ts
git commit -m "feat(onAir): decode REQ, RESPONSE, ANON_REQ structural fields"
```

---

## Task 6: ACK and PATH variants

**Files:**
- Modify: `src/onAirPackets.ts` (add `ACK`, `PATH` cases)
- Test: `tests/onAirPackets.ackPath.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/onAirPackets.ackPath.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { decodeOnAirPacket } from '../src/onAirPackets';

describe('decodeOnAirPacket — ack + path', () => {
  it('decodes an ACK checksum as raw wire-order hex (4 bytes)', () => {
    // header 0x0d → FLOOD/ACK; path_len 0x04 (path b891647e); payload bb40ba70.
    const pkt = decodeOnAirPacket('0d04b891647ebb40ba70');
    expect(pkt.payloadTypeName).toBe('ACK');
    expect(pkt.payload).toEqual({ kind: 'ack', checksumHex: 'bb40ba70' });
  });

  it('decodes a PATH payload into its own path hashes + extra type/data', () => {
    // header 0x21 → FLOOD/PATH; path_len 0x05 (path f464c77e41); payload follows.
    const pkt = decodeOnAirPacket('2105f464c77e411279399efe1942b8a3ffa10f54d9c602ff2c8cf4');
    expect(pkt.payloadTypeName).toBe('PATH');
    expect(pkt.payload).toEqual({
      kind: 'path',
      pathLen: 18,
      hashSize: 1,
      pathHashesHex: '79399efe1942b8a3ffa10f54d9c602ff2c8c',
      extraType: 244,
      extraHex: '',
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/onAirPackets.ackPath.test.ts`
Expected: FAIL — both decode to the `raw` variant.

- [ ] **Step 3: Add the ACK and PATH cases**

In `src/onAirPackets.ts`, replace the anchor:

```ts
    // Payload-type cases are inserted above this line by later tasks.
    default:
```

with:

```ts
    case PAYLOAD_TYPE.ACK: {
      if (payload.length < 4) break;
      return { kind: 'ack', checksumHex: payload.subarray(0, 4).toString('hex') };
    }
    case PAYLOAD_TYPE.PATH: {
      if (payload.length < 2) break;
      const pathLenByte = payload[0];
      const pathLen = pathLenByte & 0x3f;
      const hashSize = (pathLenByte >> 6) + 1;
      const pathByteLen = pathLen * hashSize;
      // Need the path hashes plus the 1-byte extraType that follows them.
      if (payload.length < 1 + pathByteLen + 1) break;
      return {
        kind: 'path',
        pathLen,
        hashSize,
        pathHashesHex: payload.subarray(1, 1 + pathByteLen).toString('hex'),
        extraType: payload[1 + pathByteLen],
        extraHex: payload.subarray(1 + pathByteLen + 1).toString('hex'),
      };
    }
    // Payload-type cases are inserted above this line by later tasks.
    default:
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/onAirPackets.ackPath.test.ts`
Expected: PASS (2 passing).

- [ ] **Step 5: Commit**

```bash
git add src/onAirPackets.ts tests/onAirPackets.ackPath.test.ts
git commit -m "feat(onAir): decode ACK checksum and PATH payloads"
```

---

## Task 7: TRACE variant (+ SNR from header path)

**Files:**
- Modify: `src/onAirPackets.ts` (add `TRACE` case + `snrFromPathHex` helper)
- Test: `tests/onAirPackets.trace.test.ts` (create)

Note: a trace packet's per-hop SNR values live in the **header path field** (reinterpreted), not in the trace payload. `header.pathHex` carries them; each byte is a signed int8 divided by 4.

- [ ] **Step 1: Write the failing test**

Create `tests/onAirPackets.trace.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { decodeOnAirPacket } from '../src/onAirPackets';

describe('decodeOnAirPacket — trace', () => {
  it('decodes a single-hop trace (tag LE u32, flags 0 → 1-byte hashes)', () => {
    // header 0x26 → DIRECT/TRACE; path_len 0x01 (path 30 → snr 12); payload follows.
    const pkt = decodeOnAirPacket('260130a24d89bd0000000000fb');
    expect(pkt.payloadTypeName).toBe('TRACE');
    expect(pkt.payload).toEqual({
      kind: 'trace',
      tag: 3179892130, // 0xbd894da2, little-endian
      authCode: 0,
      flags: 0,
      hopCount: 1,
      pathHashesHex: 'fb',
      snr: [12],
    });
  });

  it('decodes a trace with flags 1 → 2-byte hashes', () => {
    // header 0x26 → DIRECT/TRACE; path_len 0x01 (path 30 → snr 12); payload follows.
    const pkt = decodeOnAirPacket('260130040302010a0b0c0d01aabbccdd');
    expect(pkt.payload).toEqual({
      kind: 'trace',
      tag: 16909060, // 0x01020304
      authCode: 218893066, // 0x0d0c0b0a
      flags: 1,
      hopCount: 2,
      pathHashesHex: 'aabbccdd',
      snr: [12],
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/onAirPackets.trace.test.ts`
Expected: FAIL — both decode to the `raw` variant.

- [ ] **Step 3: Add the TRACE case**

In `src/onAirPackets.ts`, replace the anchor:

```ts
    // Payload-type cases are inserted above this line by later tasks.
    default:
```

with:

```ts
    case PAYLOAD_TYPE.TRACE: {
      if (payload.length < 9) break;
      const flags = payload[8];
      const hashSize = 1 << (flags & 0x03);
      const hashes = payload.subarray(9);
      return {
        kind: 'trace',
        tag: payload.readUInt32LE(0),
        authCode: payload.readUInt32LE(4),
        flags,
        hopCount: Math.floor(hashes.length / hashSize),
        pathHashesHex: hashes.toString('hex'),
        snr: snrFromPathHex(header.pathHex),
      };
    }
    // Payload-type cases are inserted above this line by later tasks.
    default:
```

- [ ] **Step 4: Add the `snrFromPathHex` helper**

In `src/onAirPackets.ts`, append this function at the end of the file (after the closing `}` of `decodePayload`):

```ts
/** Each on-air path byte in a TRACE packet is a per-hop SNR sample: a signed
 *  int8 scaled by 1/4 (dB). Returns one value per byte of `pathHex`. */
function snrFromPathHex(pathHex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < pathHex.length; i += 2) {
    const byte = Number.parseInt(pathHex.slice(i, i + 2), 16);
    out.push((byte > 127 ? byte - 256 : byte) / 4);
  }
  return out;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/onAirPackets.trace.test.ts`
Expected: PASS (2 passing).

- [ ] **Step 6: Commit**

```bash
git add src/onAirPackets.ts tests/onAirPackets.trace.test.ts
git commit -m "feat(onAir): decode TRACE tag/hops and per-hop SNR from path"
```

---

## Task 8: CONTROL variant (discover req + resp)

**Files:**
- Modify: `src/onAirPackets.ts` (add `CONTROL` case)
- Test: `tests/onAirPackets.control.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/onAirPackets.control.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { decodeOnAirPacket } from '../src/onAirPackets';

describe('decodeOnAirPacket — control', () => {
  it('decodes a NodeDiscoverResp (subType 0x90)', () => {
    // header 0x2e → DIRECT/CONTROL; path_len 0x00; payload starts 0x92.
    const pkt = decodeOnAirPacket(
      '2e0092dc35333e5b4fbb374d26e77a3af0a0e3d34a7174131bbebf2341ee948b6f4b13cf800c928f',
    );
    expect(pkt.payloadTypeName).toBe('CONTROL');
    expect(pkt.payload).toEqual({
      kind: 'controlDiscoverResp',
      nodeType: 2, // repeater (rawFlags 0x92 & 0x0f)
      snr: -9, // 0xdc as int8 = -36, /4
      tag: 1530802997, // 0x5b3e3335
      publicKeyHex: '4fbb374d26e77a3af0a0e3d34a7174131bbebf2341ee948b6f4b13cf800c928f',
    });
  });

  it('decodes a NodeDiscoverReq (subType 0x80) with an absent "since" field', () => {
    // header 0x2e → DIRECT/CONTROL; path_len 0x00; payload starts 0x80.
    const pkt = decodeOnAirPacket('2e0080040102030400000000');
    expect(pkt.payload).toEqual({
      kind: 'controlDiscoverReq',
      prefixOnly: false, // rawFlags 0x80 & 0x01
      typeFilter: 4, // repeater bit
      tag: 67305985, // 0x04030201
      since: 0,
    });
  });

  it('falls back to controlOther for an unrecognised sub-type', () => {
    // header 0x2e → CONTROL; payload 0x00 → subType 0x00 (neither 0x80 nor 0x90).
    const pkt = decodeOnAirPacket('2e0000');
    expect(pkt.payload).toEqual({ kind: 'controlOther', rawFlags: 0, payloadHex: '00' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/onAirPackets.control.test.ts`
Expected: FAIL — all three decode to the `raw` variant.

- [ ] **Step 3: Add the CONTROL case**

In `src/onAirPackets.ts`, replace the anchor:

```ts
    // Payload-type cases are inserted above this line by later tasks.
    default:
```

with:

```ts
    case PAYLOAD_TYPE.CONTROL: {
      if (payload.length < 1) break;
      const rawFlags = payload[0];
      const subType = rawFlags & 0xf0;
      if (subType === 0x80 && payload.length >= 6) {
        return {
          kind: 'controlDiscoverReq',
          prefixOnly: (rawFlags & 0x01) !== 0,
          typeFilter: payload[1],
          tag: payload.readUInt32LE(2),
          since: payload.length >= 10 ? payload.readUInt32LE(6) : 0,
        };
      }
      if (subType === 0x90 && payload.length >= 6) {
        return {
          kind: 'controlDiscoverResp',
          nodeType: rawFlags & 0x0f,
          snr: payload.readInt8(1) / 4,
          tag: payload.readUInt32LE(2),
          publicKeyHex: payload.subarray(6).toString('hex'),
        };
      }
      return { kind: 'controlOther', rawFlags, payloadHex: payload.toString('hex') };
    }
    // Payload-type cases are inserted above this line by later tasks.
    default:
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/onAirPackets.control.test.ts`
Expected: PASS (3 passing).

- [ ] **Step 5: Commit**

```bash
git add src/onAirPackets.ts tests/onAirPackets.control.test.ts
git commit -m "feat(onAir): decode CONTROL discover req/resp payloads"
```

---

## Task 9: Export + full verification

**Files:**
- Modify: `src/index.ts` (export the module)

- [ ] **Step 1: Export `onAirPackets` from the package entry point**

In `src/index.ts`, add this line immediately after `export * from './meshPacket';`:

```ts
export * from './onAirPackets';
```

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: all tests pass, including the existing suite plus the 8 new `onAirPackets.*` files and `session/rawPacket.test.ts`.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Lint (auto-fix import order/formatting if flagged)**

Run: `npm run lint`
If biome reports fixable issues (e.g. import ordering in `src/onAirPackets.ts`), run `npm run format` then re-run `npm run lint`.
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat(onAir): export decodeOnAirPacket from package entry point"
```

---

## Self-review notes

**Spec coverage** (against [the spec](../specs/2026-06-16-on-air-packet-decoder-design.md)):
- §1 rawPacket event (both sources, inner mesh hex, snr/rssi) → Task 1.
- §2 `decodeOnAirPacket(string | Uint8Array)`, total, never throws → Task 2.
- §3 full payload table: ADVERT (T3), TXT_MSG/GRP_TXT (T4), REQ/RESPONSE/ANON_REQ (T5), ACK/PATH (T6), TRACE (T7), CONTROL (T8), `raw` fallback (T2).
- §4 0x84 subtlety → covered by the `header: null` raw fallback (Task 2 core test) and the Task 1 raw-source emission test.
- §5 testing + exports + zero-deps → per-variant TDD throughout; export in Task 9; no new dependencies introduced.

**Known intentional limitations encoded in the plan:**
- REQ/RESPONSE "type" is not decoded (encrypted) — documented in Task 5.
- `raw` fallback uses `payloadType: number | null` (null only when the header itself failed to parse).

**Type consistency:** `OnAirPayload` is defined in full in Task 2; every later task only adds a `case` that returns one of those pre-declared variants. `decodePayload(header)` keeps a stable signature across all tasks (uses `header.payloadType`, `header.payload`, and `header.pathHex`).
