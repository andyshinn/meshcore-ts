import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it } from 'vitest';
import type { Contact } from '../../../src/index.js';
import { deliver, makeSession } from '../../support/harness';

const PK = 'aa'.repeat(32);

// RESP_SENT (0x06): [code][flood u8][expected_ack u32 LE][est_timeout u32 LE].
function sentAck(ackHex: string): Buffer {
  const f = Buffer.alloc(10);
  f[0] = 0x06;
  f[1] = 1; // flood
  Buffer.from(ackHex, 'hex').copy(f, 2);
  f.writeUInt32LE(5000, 6);
  return f;
}
// PUSH_SEND_CONFIRMED (0x82): [code][ack_hash u32 LE][trip_time u32 LE].
function sendConfirmed(ackHex: string): Buffer {
  const f = Buffer.alloc(9);
  f[0] = 0x82;
  Buffer.from(ackHex, 'hex').copy(f, 1);
  f.writeUInt32LE(123, 5);
  return f;
}
// RESP_CONTACT_MSG_RECV_V3 (0x10): [code][snr*4 int8][2B rsv][6B sender prefix]
// [path_len][txt_type][ts u32 LE][body].
function contactMsgV3(prefixHex: string, body: string): Buffer {
  const text = Buffer.from(body, 'utf8');
  const f = Buffer.alloc(16 + text.length);
  f[0] = 0x10;
  f.writeInt8(40, 1); // snr*4 = 40 → 10 dB
  Buffer.from(prefixHex, 'hex').copy(f, 4);
  f[10] = 0xff; // path_len (direct)
  f[11] = 0; // txt_type PLAIN
  f.writeUInt32LE(1_700_000_000, 12);
  text.copy(f, 16);
  return f;
}
const RESP_ERR = Buffer.from([0x01, 0x02]); // RESP_ERR + NOT_FOUND

const contact = (pk: string, name: string): Contact => ({
  key: `c:${pk}`,
  publicKeyHex: pk,
  name,
  kind: 'chat',
});

describe('direct-message send / ack state machine', () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  it('flips sending→sent on RESP_SENT and sent→ack on SEND_CONFIRMED', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    session.state.upsertContact(contact(PK, 'Bob'));

    const states: Array<{ id: string; state: string }> = [];
    const onState = (id: string, state: string) => states.push({ id, state });
    session.events.on('messageState', onState);
    try {
      const r = await session.sendDmText(`c:${PK}`, 'hi', 'm1');
      expect(r.ok).toBe(true);

      deliver(transport, sentAck('11223344'));
      expect(states.at(-1)).toEqual({ id: 'm1', state: 'sent' });

      deliver(transport, sendConfirmed('11223344'));
      expect(states.at(-1)).toEqual({ id: 'm1', state: 'ack' });
    } finally {
      session.events.off('messageState', onState);
    }
  });

  it('pops the DM queue FIFO across two RESP_SENT frames', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    session.state.upsertContact(contact(PK, 'Bob'));

    const states: Array<{ id: string; state: string }> = [];
    const onState = (id: string, state: string) => states.push({ id, state });
    session.events.on('messageState', onState);
    try {
      await session.sendDmText(`c:${PK}`, 'one', 'a1');
      await session.sendDmText(`c:${PK}`, 'two', 'a2');
      // expected_ack 0 ⇒ no retained ack entry (keeps the singleton clean).
      deliver(transport, sentAck('00000000'));
      deliver(transport, sentAck('00000000'));
      expect(states).toEqual([
        { id: 'a1', state: 'sent' },
        { id: 'a2', state: 'sent' },
      ]);
    } finally {
      session.events.off('messageState', onState);
    }
  });

  it('synthesises a placeholder contact for a DM from an unknown sender', () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();

    const unknownPrefix = 'bbbbbbbbbbbb'; // 6 bytes, no matching contact
    deliver(transport, contactMsgV3(unknownPrefix, 'hello there'));

    const synth = session.state.getContacts().find((c) => c.key === `c:${unknownPrefix}`);
    expect(synth?.publicKeyHex).toBe(unknownPrefix);
    const rows = session.state.getMessagesForKey(`c:${unknownPrefix}`);
    expect(rows.at(-1)).toMatchObject({ body: 'hello there', state: 'received' });
  });

  it('fails the oldest in-flight DM on a bare RESP_ERR', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    session.state.upsertContact(contact(PK, 'Bob'));

    const states: Array<{ id: string; state: string }> = [];
    const onState = (id: string, state: string) => states.push({ id, state });
    session.events.on('messageState', onState);
    try {
      await session.sendDmText(`c:${PK}`, 'hi', 'e1');
      deliver(transport, RESP_ERR);
      expect(states.at(-1)).toEqual({ id: 'e1', state: 'failed' });
    } finally {
      session.events.off('messageState', onState);
    }
  });

  // The admin-hook seam: repeater-admin shares the RESP_SENT opcode and must get
  // first crack so admin tags don't pop the DM FIFO.
  // PORT NOTE: the donor injected a fake hook via the module-level
  // setAdminHooks(). This library wires the real repeater-admin hooks in
  // start(), so we exercise the seam authentically: an in-flight admin owner-info
  // request arms the admin RESP_SENT queue (onSentTag), which must consume the
  // next RESP_SENT ahead of the DM FIFO.
  it('lets the admin hook consume RESP_SENT ahead of the DM queue', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    session.state.upsertContact({ key: `c:${PK}`, publicKeyHex: PK, name: 'Repeater', kind: 'repeater' });

    const states: Array<{ id: string; state: string }> = [];
    const onState = (id: string, state: string) => states.push({ id, state });
    session.events.on('messageState', onState);
    try {
      // Arm a real admin owner-info request — registers an adminSentQueue entry
      // (onSentTag) that should claim the next RESP_SENT tag. We never await this
      // promise (it parks for a BINARY_RESPONSE that never comes); the seam is
      // observable from the RESP_SENT routing alone.
      const pending = session.repeaterRequestOwnerInfo(`c:${PK}`);
      pending.catch(() => {}); // swallow the eventual disconnect rejection
      // let the write + queue-push settle
      await Promise.resolve();
      await Promise.resolve();

      deliver(transport, sentAck('aabbccdd'));
      expect(states).toEqual([]); // DM FIFO NOT advanced — admin consumed the tag
    } finally {
      session.events.off('messageState', onState);
    }
  });
});
