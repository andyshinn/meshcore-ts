import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { CMD } from '../../src/codes';
import { LoopbackTransport, MeshCoreSession } from '../../src/index.js';
import { makeSession } from '../support/harness';

// Yield microtasks until `predicate()` is true or we hit the cap. Keeps tests
// decoupled from the exact internal microtask depth of withSyncLock/request.
async function flushUntil(predicate: () => boolean, maxTicks = 100): Promise<void> {
  for (let i = 0; i < maxTicks && !predicate(); i += 1) {
    await Promise.resolve();
  }
}

// ---- Frame builders --------------------------------------------------------

/** Build a minimal RESP_SELF_INFO frame (0x05).
 *  Layout: [0x05][adv_type u8][tx_power u8][max_tx_power u8][pubkey 32B][name UTF-8]
 *  decodeSelfInfo scans backwards from end for printable ASCII to extract name. */
function buildSelfInfoFrame(name: string, pkHex: string): Buffer {
  const nameBytes = Buffer.from(name, 'utf8');
  const f = Buffer.alloc(4 + 32 + nameBytes.length);
  f[0] = 0x05;
  // bytes 1..3: adv_type, tx_power, max_tx_power — left as 0
  Buffer.from(pkHex, 'hex').copy(f, 4);
  nameBytes.copy(f, 36);
  return f;
}

/** Build a RESP_CONTACT frame that matches decodeContact's expected layout.
 *  Layout (148 bytes total):
 *   [0]      code = 0x03 (RESP.CONTACT)
 *   [1..32]  pubkey 32B
 *   [33]     type
 *   [34]     flags
 *   [35]     outPathLen
 *   [36..99] outPath 64B (padded)
 *   [100..131] name 32B (null-padded)
 *   [132..135] lastAdvertUnix u32LE
 *   [136..139] gpsLat i32LE (* 1_000_000)
 *   [140..143] gpsLon i32LE (* 1_000_000)
 *   [144..147] lastmod u32LE
 */
function buildContactFrame(opts: { name: string; pkHex: string; type?: number }): Buffer {
  const f = Buffer.alloc(148);
  f[0] = 0x03; // RESP.CONTACT
  Buffer.from(opts.pkHex, 'hex').copy(f, 1);
  f[33] = opts.type ?? 0x00; // ADV_TYPE.CHAT
  f[34] = 0; // flags
  f[35] = 0; // outPathLen = 0 (flood)
  // path bytes [36..99] stay zero
  Buffer.from(opts.name, 'utf8').copy(f, 100); // name up to 32 bytes
  // lastAdvertUnix, gpsLat, gpsLon, lastmod all zero
  return f;
}

/** Build a RESP_CHANNEL_INFO frame.
 *  Layout (50 bytes): [0x12][idx][name 32B null-padded][key 16B] */
function buildChannelInfoFrame(idx: number, name: string, keyHex: string): Buffer {
  const f = Buffer.alloc(50);
  f[0] = 0x12;
  f[1] = idx;
  Buffer.from(name, 'utf8').copy(f, 2);
  Buffer.from(keyHex, 'hex').copy(f, 34);
  return f;
}

// ============================================================================
// (a) serialization test
// ============================================================================

describe('session: withSyncLock serialization', () => {
  it('runs getSelfInfo calls one at a time (second waits for first)', async () => {
    const { session, transport } = makeSession();
    const order: string[] = [];

    const p1 = session.getSelfInfo().then((r) => order.push(`done:${r.name}`));
    const p2 = session.getSelfInfo().then((r) => order.push(`done:${r.name}`));

    const appStarts = () => transport.sent.filter((b) => b[0] === 0x01).length;

    // Wait until the first APP_START is on the wire (p2 is still waiting in the lock)
    await flushUntil(() => appStarts() >= 1);
    expect(appStarts()).toBe(1);

    // Deliver the reply for p1
    transport.receive(buildSelfInfoFrame('first', 'aa'.repeat(32)));

    // Wait until p1 resolves → releases lock → p2 fires its APP_START
    await flushUntil(() => appStarts() >= 2);
    expect(appStarts()).toBe(2);

    // Deliver the reply for p2
    transport.receive(buildSelfInfoFrame('second', 'bb'.repeat(32)));

    await Promise.all([p1, p2]);
    expect(order).toEqual(['done:first', 'done:second']);
  });
});

// ============================================================================
// (b) getChannel / getChannels
// ============================================================================

describe('session: getChannel / getChannels (active re-fetch)', () => {
  it('getChannel resolves a present slot and updates state', async () => {
    const { session, transport } = makeSession();
    const p = session.getChannel(0);
    // Wait until withSyncLock's microtask fires and requestOrNull registers its waiter
    await flushUntil(() => transport.sent.some((b) => b[0] === CMD.GET_CHANNEL));
    transport.receive(buildChannelInfoFrame(0, 'Public', 'cc'.repeat(16)));
    const ch = await p;
    expect(ch?.name).toBe('Public');
    expect(transport.sent.some((b) => b[0] === CMD.GET_CHANNEL && b[1] === 0)).toBe(true);
  });

  it('getChannel returns null for an empty slot (RESP_ERR)', async () => {
    const { session, transport } = makeSession();
    const p = session.getChannel(5);
    // Wait until withSyncLock's microtask fires and requestOrNull registers its waiters
    await flushUntil(() => transport.sent.some((b) => b[0] === CMD.GET_CHANNEL));
    // Simulate RESP_ERR (0x01 = RESP.ERR, followed by error code) — resolves via ack FIFO → null
    transport.receive(Buffer.from([0x01, 0x00]));
    const ch = await p;
    expect(ch).toBeNull();
  });

  it('getChannels enumerates all slots and returns present channels', async () => {
    const present = new Map<number, Buffer>([
      [0, buildChannelInfoFrame(0, 'Public', 'cc'.repeat(16))],
      [3, buildChannelInfoFrame(3, '#region', 'dd'.repeat(16))],
    ]);

    class Responder extends LoopbackTransport {
      override async send(bytes: Uint8Array): Promise<void> {
        await super.send(bytes);
        const buf = Buffer.from(bytes);
        if (buf[0] === CMD.GET_CHANNEL) {
          const reply = present.get(buf[1]);
          if (reply) {
            // Deliver on next microtask so the waiter is registered first
            queueMicrotask(() => this.receive(reply));
          } else {
            // RESP_ERR for empty slots — consumed by the ack FIFO → null
            queueMicrotask(() => this.receive(Buffer.from([0x01, 0x02])));
          }
        }
      }
    }

    const transport = new Responder();
    const session = new MeshCoreSession({ transport });
    session.start();

    const result = await session.getChannels();
    expect(result.map((c) => c.name).sort()).toEqual(['#region', 'Public'].sort());
  });
});

// ============================================================================
// (c) getContacts
// ============================================================================

describe('session: getContacts (active re-fetch)', () => {
  it('re-issues GET_CONTACTS and resolves the contact list', async () => {
    const { session, transport } = makeSession();

    const p = session.getContacts();

    // Wait until withSyncLock's microtask fires, arming the waiters and writing GET_CONTACTS
    await flushUntil(() => transport.sent.some((b) => b[0] === CMD.GET_CONTACTS));

    // RESP_CONTACTS_START [0x02][count u32LE]
    const start = Buffer.alloc(5);
    start[0] = 0x02;
    start.writeUInt32LE(1, 1);
    transport.receive(start);

    // RESP_CONTACT — must be exactly 148 bytes matching decodeContact layout
    const contact = buildContactFrame({ name: 'Alice', pkHex: 'ab'.repeat(32) });
    transport.receive(contact);

    // RESP_END_OF_CONTACTS [0x04][most_recent_lastmod u32LE]
    const eoc = Buffer.alloc(5);
    eoc[0] = 0x04;
    transport.receive(eoc);

    const contacts = await p;

    expect(transport.sent.some((b) => b[0] === CMD.GET_CONTACTS)).toBe(true);
    expect(contacts.some((c) => c.name === 'Alice')).toBe(true);
  });
});
