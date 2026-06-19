import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it } from 'vitest';
import { Errors, type Models } from '../../../src/index.js';
import { deliver, makeSession } from '../../support/harness.js';

const PK = 'aa'.repeat(32);
const PREFIX = 'aa'.repeat(6); // first 6 bytes of the pubkey
const flush = () => new Promise((r) => setTimeout(r, 0));
const lastSent = (t: { sent: Uint8Array[] }) => {
  const last = t.sent.at(-1);
  return last ? Buffer.from(last) : undefined;
};

const seedContact = (session: ReturnType<typeof makeSession>['session']): void => {
  session.state.upsertContact({
    key: `c:${PK}`,
    publicKeyHex: PK,
    name: 'Repeater',
    kind: 'repeater',
  } satisfies Models.Contact);
};

// RESP_SENT [0x06][flood][tag u32][est_timeout u32] (10B).
function respSent(): Buffer {
  const f = Buffer.alloc(10);
  f[0] = 0x06;
  f[1] = 1; // flood
  f.writeUInt32LE(0x1234, 2);
  f.writeUInt32LE(5000, 6);
  return f;
}

describe('outbound path diagnostics', () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  it('sendPathDiscoveryReq dispatches, then resolves with the discovered paths', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    seedContact(session);

    const p = session.sendPathDiscoveryReq(`c:${PK}`);
    await flush();
    expect(lastSent(transport)?.[0]).toBe(0x34); // CMD_SEND_PATH_DISCOVERY_REQ
    expect(lastSent(transport)?.[1]).toBe(0x00); // reserved byte

    deliver(transport, respSent()); // dispatch confirmed
    await flush();

    const push = Buffer.concat([
      Buffer.from([0x8d, 0x00]), // code + reserved
      Buffer.from(PREFIX, 'hex'), // 6B prefix
      Buffer.from([0x02]),
      Buffer.from('1122', 'hex'), // out_path
      Buffer.from([0x01]),
      Buffer.from('33', 'hex'), // in_path
    ]);
    deliver(transport, push);

    expect(await p).toEqual({
      pubKeyPrefixHex: PREFIX,
      outHops: 2,
      outPathHex: '1122',
      inHops: 1,
      inPathHex: '33',
    });
  });

  it('sendPathDiscoveryReq rejects Errors.ProtocolError when the radio refuses dispatch', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    seedContact(session);
    const p = session.sendPathDiscoveryReq(`c:${PK}`);
    await flush();
    deliver(transport, Buffer.from([0x01, 0x02])); // RESP_ERR NOT_FOUND
    await expect(p).rejects.toBeInstanceOf(Errors.ProtocolError);
  });

  it('a superseding discovery for the same contact survives the older one failing', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    seedContact(session);
    // Request A, then request B for the same contact: B supersedes A.
    const pA = session.sendPathDiscoveryReq(`c:${PK}`).catch((e) => `A:${(e as Error).message}`);
    await flush();
    const pB = session.sendPathDiscoveryReq(`c:${PK}`);
    expect(await pA).toMatch(/superseded/);

    // A's dispatch now fails (RESP_ERR routes to A's older ack) — must NOT reject B.
    let bSettled = false;
    pB.then(
      () => {
        bSettled = true;
      },
      () => {
        bSettled = true;
      },
    );
    deliver(transport, Buffer.from([0x01, 0x02])); // RESP_ERR for A
    await flush();
    expect(bSettled).toBe(false);

    // B completes normally: its dispatch confirms, then the discovery push lands.
    deliver(transport, respSent());
    await flush();
    const push = Buffer.concat([
      Buffer.from([0x8d, 0x00]),
      Buffer.from(PREFIX, 'hex'),
      Buffer.from([0x00]), // out_path_len 0
      Buffer.from([0x00]), // in_path_len 0
    ]);
    deliver(transport, push);
    expect(await pB).toMatchObject({ pubKeyPrefixHex: PREFIX });
  });

  it('getAdvertPath returns the cached path on RESP_ADVERT_PATH', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    seedContact(session);
    const p = session.getAdvertPath(`c:${PK}`);
    await flush();
    expect(lastSent(transport)?.[0]).toBe(0x2a); // CMD_GET_ADVERT_PATH

    const reply = Buffer.concat([
      Buffer.from([0x16]),
      (() => {
        const b = Buffer.alloc(4);
        b.writeUInt32LE(1000, 0);
        return b;
      })(),
      Buffer.from([0x02]),
      Buffer.from('aabb', 'hex'),
    ]);
    deliver(transport, reply);
    expect(await p).toEqual({ recvTimestampUnix: 1000, hops: 2, pathHex: 'aabb' });
  });

  it('getAdvertPath returns null on RESP_ERR (no cached path)', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    seedContact(session);
    const p = session.getAdvertPath(`c:${PK}`);
    await flush();
    deliver(transport, Buffer.from([0x01, 0x02])); // RESP_ERR NOT_FOUND
    expect(await p).toBeNull();
  });
});
