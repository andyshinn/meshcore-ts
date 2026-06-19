import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { createChannelsRuntime } from '../../src/features/channels';
import { createContactsIterRuntime } from '../../src/features/contacts';
import { createDeviceAdminRuntime } from '../../src/features/deviceAdmin';
import {
  createDmRuntime,
  decodeContactMsgV1,
  decodeContactMsgV3,
  decodeSendConfirmed,
  decodeSentAck,
  directMessagesFeature,
  encodeSendDmText,
  failOldestDmSend,
  resetDmState,
  sendDmText,
  setAdminHooks,
} from '../../src/features/directMessages';
import { createDrainRuntime } from '../../src/features/drain';
import type { FeatureContext } from '../../src/features/feature';
import { createPathDiagRuntime } from '../../src/features/pathDiagnostics';
import { PendingChannelSends } from '../../src/features/pendingChannelSends';
import { createAdminCorrRuntime } from '../../src/features/repeaterAdmin';
import { MeshObservations } from '../../src/model/meshObservations';
import { SessionState } from '../../src/model/state/model';
import type { Contact } from '../../src/model/types';
import { MeshCoreEvents } from '../../src/ports/events';
import { noopLogger } from '../../src/ports/logger';
import { TXT_TYPE } from '../../src/protocol/codes';

// ---- Pure codec tests (ported verbatim from the donor) -----------------

describe('directMessages: encodeSendDmText', () => {
  it('lays out [cmd][txt_type][attempt][ts u32 LE][6B pubkey prefix][text]', () => {
    const out = encodeSendDmText({
      destPublicKeyHex: 'aabbccddeeff00112233445566778899',
      text: 'hi',
      timestampUnix: 1,
    });
    expect(out[0]).toBe(0x02); // SEND_TXT_MSG
    expect(out[1]).toBe(0); // PLAIN
    expect(out[2]).toBe(0); // attempt
    expect(out.readUInt32LE(3)).toBe(1); // timestamp
    expect(out.subarray(7, 13).toString('hex')).toBe('aabbccddeeff'); // first 6 bytes
    expect(out.subarray(13).toString('utf8')).toBe('hi');
  });

  it('rejects a public key shorter than 6 bytes', () => {
    expect(() => encodeSendDmText({ destPublicKeyHex: 'aabb', text: 'x' })).toThrow(/≥6 bytes/);
  });
});

describe('directMessages: decodeContactMsgV3', () => {
  it('reads the 6-byte sender prefix and body (no name prefix)', () => {
    const body = Buffer.from('ping', 'utf8');
    const frame = Buffer.alloc(16 + body.length);
    frame[0] = 0x10;
    frame.writeInt8(-4, 1); // snr*4 = -4 → -1 dB
    Buffer.from('aabbccddeeff', 'hex').copy(frame, 4); // sender prefix
    frame[10] = 0xff; // path_len
    frame[11] = 0; // txt_type
    frame.writeUInt32LE(99, 12);
    body.copy(frame, 16);
    const msg = decodeContactMsgV3(frame);
    expect(msg?.snrDb).toBe(-1);
    expect(msg?.senderPubKeyPrefixHex).toBe('aabbccddeeff');
    expect(msg?.timestampUnix).toBe(99);
    expect(msg?.body).toBe('ping');
  });
});

describe('directMessages: decodeContactMsgV1 (legacy, no snr prefix)', () => {
  it('reads the 6-byte sender prefix and body, snrDb 0', () => {
    const body = Buffer.from('hey', 'utf8');
    const frame = Buffer.alloc(13 + body.length);
    frame[0] = 0x07;
    Buffer.from('aabbccddeeff', 'hex').copy(frame, 1); // sender prefix
    frame[7] = 3; // path_len
    frame[8] = 0; // txt_type
    frame.writeUInt32LE(123, 9);
    body.copy(frame, 13);
    const msg = decodeContactMsgV1(frame);
    expect(msg?.snrDb).toBe(0);
    expect(msg?.senderPubKeyPrefixHex).toBe('aabbccddeeff');
    expect(msg?.pathLen).toBe(3);
    expect(msg?.timestampUnix).toBe(123);
    expect(msg?.body).toBe('hey');
  });

  it('returns null below 13 bytes', () => {
    expect(decodeContactMsgV1(Buffer.alloc(12))).toBeNull();
  });
});

describe('directMessages: decodeSentAck / decodeSendConfirmed', () => {
  it('decodeSentAck reads flood flag, expected ack, and est timeout', () => {
    const frame = Buffer.alloc(10);
    frame[0] = 0x06;
    frame[1] = 1; // flood
    Buffer.from('deadbeef', 'hex').copy(frame, 2); // expected ack
    frame.writeUInt32LE(1500, 6); // est timeout ms
    const ack = decodeSentAck(frame);
    expect(ack?.flood).toBe(true);
    expect(ack?.expectedAckHex).toBe('deadbeef');
    expect(ack?.estTimeoutMs).toBe(1500);
  });

  it('decodeSendConfirmed reads ack hash and trip time', () => {
    const frame = Buffer.alloc(9);
    frame[0] = 0x82;
    Buffer.from('cafebabe', 'hex').copy(frame, 1);
    frame.writeUInt32LE(321, 5);
    const c = decodeSendConfirmed(frame);
    expect(c?.ackHex).toBe('cafebabe');
    expect(c?.tripTimeMs).toBe(321);
  });
});

// ---- Real-ctx harness for the send/ack FIFO + handle path --------------

// A full per-session ctx: real MeshCoreEvents + SessionState + rt (with the
// DM runtime under test plus the sibling rt factories), capturing writes.
function makeCtx(): {
  ctx: FeatureContext;
  state: SessionState;
  events: MeshCoreEvents;
  writes: Buffer[];
  messageStates: Array<{ id: string; state: string }>;
} {
  const state = new SessionState();
  const events = new MeshCoreEvents();
  const writes: Buffer[] = [];
  const messageStates: Array<{ id: string; state: string }> = [];
  events.on('messageState', (id, st) => messageStates.push({ id, state: st }));
  const ctx: FeatureContext = {
    writeFrame: async (frame: Buffer) => {
      writes.push(frame);
    },
    request: async () => {
      throw new Error('request not used in these tests');
    },
    requestOrNull: async () => null,
    events,
    state,
    log: noopLogger,
    admin: {} as FeatureContext['admin'],
    rt: {
      meshObs: new MeshObservations(),
      pendingChannelSends: new PendingChannelSends(),
      deviceAdmin: createDeviceAdminRuntime(),
      drain: createDrainRuntime(),
      channels: createChannelsRuntime(),
      contactsIter: createContactsIterRuntime(),
      pathDisc: createPathDiagRuntime(),
      dm: createDmRuntime(),
      adminCorr: createAdminCorrRuntime(),
    },
    getTransportState: () => 'connected',
    contactsSync: () => {},
  };
  return { ctx, state, events, writes, messageStates };
}

const PK = 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';

function addContact(state: SessionState, overrides: Partial<Contact> = {}): Contact {
  const contact: Contact = {
    key: `c:${PK}`,
    publicKeyHex: PK,
    name: 'Bob',
    kind: 'chat',
    ...overrides,
  };
  state.upsertContact(contact);
  return contact;
}

// RESP_SENT frame helper.
function sentFrame(expectedAckHex: string, flood = false, estTimeoutMs = 1000): Buffer {
  const frame = Buffer.alloc(10);
  frame[0] = 0x06;
  frame[1] = flood ? 1 : 0;
  Buffer.from(expectedAckHex, 'hex').copy(frame, 2);
  frame.writeUInt32LE(estTimeoutMs, 6);
  return frame;
}

// PUSH_SEND_CONFIRMED frame helper.
function confirmedFrame(ackHex: string, tripTimeMs = 100): Buffer {
  const frame = Buffer.alloc(9);
  frame[0] = 0x82;
  Buffer.from(ackHex, 'hex').copy(frame, 1);
  frame.writeUInt32LE(tripTimeMs, 5);
  return frame;
}

describe('directMessages: sendDmText (FIFO enqueue + write)', () => {
  it('enqueues the message id on ctx.rt.dm.dmSendQueue and writes the frame', async () => {
    const { ctx, state, writes } = makeCtx();
    addContact(state);
    const r = await sendDmText(ctx, `c:${PK}`, 'hello', 'm1');
    expect(r.ok).toBe(true);
    expect(ctx.rt.dm.dmSendQueue).toEqual(['m1']);
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe(0x02);
  });

  it('rejects an unknown contact without enqueuing', async () => {
    const { ctx } = makeCtx();
    const r = await sendDmText(ctx, 'c:nope', 'hi', 'm1');
    expect(r.ok).toBe(false);
    expect(ctx.rt.dm.dmSendQueue).toHaveLength(0);
  });

  it('pops the entry back off the FIFO when the write fails', async () => {
    const { ctx, state } = makeCtx();
    addContact(state);
    ctx.writeFrame = async () => {
      throw new Error('boom');
    };
    const r = await sendDmText(ctx, `c:${PK}`, 'hi', 'm1');
    expect(r.ok).toBe(false);
    expect(ctx.rt.dm.dmSendQueue).toHaveLength(0);
  });
});

describe('directMessages: RESP_SENT → sending→sent + expected-ack registration', () => {
  it('pops the oldest FIFO id, flips it to sent, and registers the expected ack', () => {
    const { ctx, state, messageStates } = makeCtx();
    addContact(state);
    state.insertMessage({ id: 'm1', key: `c:${PK}`, body: 'hi', ts: 1, state: 'sending' });
    ctx.rt.dm.dmSendQueue.push('m1');

    directMessagesFeature.handle(0x06, sentFrame('deadbeef'), ctx);

    expect(ctx.rt.dm.dmSendQueue).toHaveLength(0); // shifted
    expect(messageStates).toContainEqual({ id: 'm1', state: 'sent' });
    expect(ctx.rt.dm.pendingDmAcks.has('deadbeef')).toBe(true);
    expect(ctx.rt.dm.pendingDmAcks.get('deadbeef')?.messageId).toBe('m1');
    // Drain the retention timer so the test doesn't leak.
    resetDmState(ctx, 'cleanup');
  });

  it('does NOT register an expected ack when expected_ack is 00000000', () => {
    const { ctx, state } = makeCtx();
    addContact(state);
    state.insertMessage({ id: 'm1', key: `c:${PK}`, body: 'hi', ts: 1, state: 'sending' });
    ctx.rt.dm.dmSendQueue.push('m1');
    directMessagesFeature.handle(0x06, sentFrame('00000000'), ctx);
    expect(ctx.rt.dm.pendingDmAcks.size).toBe(0);
  });

  it('is a harmless no-op for a RESP_SENT with no queued DM (channel echo)', () => {
    const { ctx, messageStates } = makeCtx();
    directMessagesFeature.handle(0x06, sentFrame('deadbeef'), ctx);
    expect(messageStates).toHaveLength(0);
    expect(ctx.rt.dm.pendingDmAcks.size).toBe(0);
  });

  it('preserves FIFO ordering across two in-flight DMs', () => {
    const { ctx, state, messageStates } = makeCtx();
    addContact(state);
    state.insertMessage({ id: 'm1', key: `c:${PK}`, body: 'a', ts: 1, state: 'sending' });
    state.insertMessage({ id: 'm2', key: `c:${PK}`, body: 'b', ts: 2, state: 'sending' });
    ctx.rt.dm.dmSendQueue.push('m1', 'm2');
    directMessagesFeature.handle(0x06, sentFrame('aaaa0001'), ctx); // first RESP_SENT → m1
    directMessagesFeature.handle(0x06, sentFrame('aaaa0002'), ctx); // second → m2
    expect(messageStates).toEqual([
      { id: 'm1', state: 'sent' },
      { id: 'm2', state: 'sent' },
    ]);
    expect(ctx.rt.dm.pendingDmAcks.get('aaaa0001')?.messageId).toBe('m1');
    expect(ctx.rt.dm.pendingDmAcks.get('aaaa0002')?.messageId).toBe('m2');
    resetDmState(ctx, 'cleanup');
  });
});

describe('directMessages: PUSH_SEND_CONFIRMED → sent→ack lookup/clear', () => {
  it('flips the correlated message to ack and clears the pending entry', () => {
    const { ctx, state, messageStates } = makeCtx();
    addContact(state);
    state.insertMessage({ id: 'm1', key: `c:${PK}`, body: 'hi', ts: 1, state: 'sending' });
    ctx.rt.dm.dmSendQueue.push('m1');
    directMessagesFeature.handle(0x06, sentFrame('deadbeef'), ctx);
    directMessagesFeature.handle(0x82, confirmedFrame('deadbeef'), ctx);
    expect(messageStates).toContainEqual({ id: 'm1', state: 'ack' });
    expect(ctx.rt.dm.pendingDmAcks.has('deadbeef')).toBe(false);
  });

  it('is a no-op for an unknown ack hash', () => {
    const { ctx, messageStates } = makeCtx();
    directMessagesFeature.handle(0x82, confirmedFrame('00000000'), ctx);
    expect(messageStates).toHaveLength(0);
  });
});

describe('directMessages: admin-hook interception order', () => {
  it('RESP_SENT consults onSentTag FIRST and returns without touching the DM FIFO when it consumes the tag', () => {
    const { ctx, state, messageStates } = makeCtx();
    addContact(state);
    state.insertMessage({ id: 'm1', key: `c:${PK}`, body: 'hi', ts: 1, state: 'sending' });
    ctx.rt.dm.dmSendQueue.push('m1');
    const seen: string[] = [];
    setAdminHooks(ctx, {
      onSentTag: (tag) => {
        seen.push(tag);
        return true; // admin consumes it
      },
    });
    directMessagesFeature.handle(0x06, sentFrame('deadbeef'), ctx);
    expect(seen).toEqual(['deadbeef']);
    // FIFO untouched, no DM state machine ran.
    expect(ctx.rt.dm.dmSendQueue).toEqual(['m1']);
    expect(messageStates).toHaveLength(0);
    expect(ctx.rt.dm.pendingDmAcks.size).toBe(0);
  });

  it('RESP_SENT proceeds to the DM FIFO when onSentTag returns false (does not consume)', () => {
    const { ctx, state, messageStates } = makeCtx();
    addContact(state);
    state.insertMessage({ id: 'm1', key: `c:${PK}`, body: 'hi', ts: 1, state: 'sending' });
    ctx.rt.dm.dmSendQueue.push('m1');
    setAdminHooks(ctx, { onSentTag: () => false });
    directMessagesFeature.handle(0x06, sentFrame('deadbeef'), ctx);
    expect(ctx.rt.dm.dmSendQueue).toHaveLength(0);
    expect(messageStates).toContainEqual({ id: 'm1', state: 'sent' });
    resetDmState(ctx, 'cleanup');
  });

  it('inbound CLI_DATA consults onCliReply and skips the message store when consumed', () => {
    const { ctx, state } = makeCtx();
    const seen: Array<{ prefix: string; body: string }> = [];
    setAdminHooks(ctx, {
      onCliReply: (prefix, body) => {
        seen.push({ prefix, body });
        return true;
      },
    });
    // RESP_CONTACT_MSG_RECV_V3 with txt_type=CLI_DATA(1).
    const body = Buffer.from('OK', 'utf8');
    const frame = Buffer.alloc(16 + body.length);
    frame[0] = 0x10;
    Buffer.from('aabbccddeeff', 'hex').copy(frame, 4);
    frame[10] = 0xff;
    frame[11] = 1; // CLI_DATA
    frame.writeUInt32LE(1, 12);
    body.copy(frame, 16);
    directMessagesFeature.handle(0x10, frame, ctx);
    expect(seen).toEqual([{ prefix: 'aabbccddeeff', body: 'OK' }]);
    // No message stored, no placeholder contact synthesised.
    expect(state.getMessagesForKey('c:aabbccddeeff')).toHaveLength(0);
    expect(state.getContacts()).toHaveLength(0);
  });
});

describe('directMessages: inbound RESP_CONTACT_MSG_RECV placeholder synthesis', () => {
  it('synthesises a placeholder contact for an unknown sender and stores the message', () => {
    const { ctx, state } = makeCtx();
    const body = Buffer.from('ping', 'utf8');
    const frame = Buffer.alloc(16 + body.length);
    frame[0] = 0x10;
    Buffer.from('aabbccddeeff', 'hex').copy(frame, 4); // unknown sender prefix
    frame[10] = 0xff;
    frame[11] = 0; // PLAIN
    frame.writeUInt32LE(99, 12);
    body.copy(frame, 16);
    directMessagesFeature.handle(0x10, frame, ctx);

    const contact = state.getContacts().find((c) => c.key === 'c:aabbccddeeff');
    expect(contact).toBeDefined();
    expect(contact?.name).toBe('(aabbccddeeff)');
    expect(contact?.kind).toBe('chat');
    const messages = state.getMessagesForKey('c:aabbccddeeff');
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toBe('ping');
    expect(messages[0].state).toBe('received');
  });

  it('routes the message to an existing contact matched by pubkey prefix', () => {
    const { ctx, state } = makeCtx();
    addContact(state); // PK starts aabbccddeeff...
    const body = Buffer.from('yo', 'utf8');
    const frame = Buffer.alloc(16 + body.length);
    frame[0] = 0x10;
    Buffer.from('aabbccddeeff', 'hex').copy(frame, 4);
    frame[10] = 0xff;
    frame[11] = 0;
    frame.writeUInt32LE(5, 12);
    body.copy(frame, 16);
    directMessagesFeature.handle(0x10, frame, ctx);
    // No new placeholder; only the existing contact.
    expect(state.getContacts()).toHaveLength(1);
    expect(state.getMessagesForKey(`c:${PK}`)).toHaveLength(1);
  });
});

describe('directMessages: failOldestDmSend / resetDmState', () => {
  it('failOldestDmSend fails the oldest queued id and flips it to failed', () => {
    const { ctx, messageStates } = makeCtx();
    ctx.rt.dm.dmSendQueue.push('m1', 'm2');
    failOldestDmSend(ctx, 'RESP_ERR');
    expect(ctx.rt.dm.dmSendQueue).toEqual(['m2']);
    expect(messageStates).toContainEqual({ id: 'm1', state: 'failed' });
  });

  it('failOldestDmSend is a no-op when the FIFO is empty', () => {
    const { ctx, messageStates } = makeCtx();
    failOldestDmSend(ctx, 'RESP_ERR');
    expect(messageStates).toHaveLength(0);
  });

  it('resetDmState fails every queued DM and clears pending acks', () => {
    const { ctx, state, messageStates } = makeCtx();
    addContact(state);
    ctx.rt.dm.dmSendQueue.push('m1', 'm2');
    directMessagesFeature.handle(0x06, sentFrame('aaaa0001'), ctx); // m1 → sent + pending ack
    expect(ctx.rt.dm.pendingDmAcks.size).toBe(1);
    resetDmState(ctx, 'disconnected');
    expect(ctx.rt.dm.dmSendQueue).toHaveLength(0);
    expect(ctx.rt.dm.pendingDmAcks.size).toBe(0);
    expect(messageStates.filter((s) => s.state === 'failed').map((s) => s.id)).toContain('m2');
  });
});

// ---- FIX A: SIGNED_PLAIN (txt_type=2) message decoding -----------------

describe('directMessages: decodeContactMsgV3 SIGNED_PLAIN (Fix A)', () => {
  it('strips the 4-byte sender_prefix from the body and exposes it as senderPrefixExtraHex (V3)', () => {
    // V3 signed frame layout:
    //   [0]=0x10 [1]=snr*4 [2..3]=rsv [4..9]=from-prefix [10]=path_len
    //   [11]=txt_type(2) [12..15]=timestamp [16..19]=sender_prefix(4B) [20..]=text
    const senderExtra = Buffer.from('deadbeef', 'hex'); // 4B extra sender prefix
    const text = Buffer.from('hello signed', 'utf8');
    const frame = Buffer.alloc(16 + 4 + text.length);
    frame[0] = 0x10;
    frame.writeInt8(8, 1); // snr*4 = 8 → 2 dB
    Buffer.from('aabbccddeeff', 'hex').copy(frame, 4); // from-prefix
    frame[10] = 0xff; // path_len
    frame[11] = TXT_TYPE.SIGNED_PLAIN; // txt_type = 2
    frame.writeUInt32LE(42, 12); // timestamp
    senderExtra.copy(frame, 16); // 4-byte sender prefix extra
    text.copy(frame, 20); // actual text starts at 20
    const msg = decodeContactMsgV3(frame);
    expect(msg?.txtType).toBe(TXT_TYPE.SIGNED_PLAIN);
    expect(msg?.body).toBe('hello signed'); // clean text, no garbage bytes
    expect(msg?.senderPrefixExtraHex).toBe('deadbeef');
  });

  it('leaves senderPrefixExtraHex undefined for PLAIN messages (V3)', () => {
    const text = Buffer.from('plain msg', 'utf8');
    const frame = Buffer.alloc(16 + text.length);
    frame[0] = 0x10;
    Buffer.from('aabbccddeeff', 'hex').copy(frame, 4);
    frame[10] = 0xff;
    frame[11] = TXT_TYPE.PLAIN; // txt_type = 0
    frame.writeUInt32LE(1, 12);
    text.copy(frame, 16);
    const msg = decodeContactMsgV3(frame);
    expect(msg?.body).toBe('plain msg');
    expect(msg?.senderPrefixExtraHex).toBeUndefined();
  });
});

describe('directMessages: decodeContactMsgV1 SIGNED_PLAIN (Fix A)', () => {
  it('strips the 4-byte sender_prefix from the body and exposes it as senderPrefixExtraHex (V1)', () => {
    // V1 signed frame layout:
    //   [0]=0x07 [1..6]=from-prefix [7]=path_len [8]=txt_type(2)
    //   [9..12]=timestamp [13..16]=sender_prefix(4B) [17..]=text
    const senderExtra = Buffer.from('cafebabe', 'hex');
    const text = Buffer.from('v1 signed', 'utf8');
    const frame = Buffer.alloc(13 + 4 + text.length);
    frame[0] = 0x07;
    Buffer.from('aabbccddeeff', 'hex').copy(frame, 1);
    frame[7] = 3; // path_len
    frame[8] = TXT_TYPE.SIGNED_PLAIN; // txt_type = 2
    frame.writeUInt32LE(77, 9); // timestamp
    senderExtra.copy(frame, 13); // 4-byte sender prefix extra
    text.copy(frame, 17); // actual text starts at 17
    const msg = decodeContactMsgV1(frame);
    expect(msg?.txtType).toBe(TXT_TYPE.SIGNED_PLAIN);
    expect(msg?.body).toBe('v1 signed');
    expect(msg?.senderPrefixExtraHex).toBe('cafebabe');
  });

  it('leaves senderPrefixExtraHex undefined for PLAIN messages (V1)', () => {
    const text = Buffer.from('plain v1', 'utf8');
    const frame = Buffer.alloc(13 + text.length);
    frame[0] = 0x07;
    Buffer.from('aabbccddeeff', 'hex').copy(frame, 1);
    frame[7] = 0;
    frame[8] = TXT_TYPE.PLAIN;
    frame.writeUInt32LE(1, 9);
    text.copy(frame, 13);
    const msg = decodeContactMsgV1(frame);
    expect(msg?.body).toBe('plain v1');
    expect(msg?.senderPrefixExtraHex).toBeUndefined();
  });
});

// ---- FIX C: decodeSentAck flood flag robustness (Fix C) ----------------

describe('directMessages: decodeSentAck flood flag non-zero (Fix C)', () => {
  it('treats any non-zero flood byte as flood=true, not just 1', () => {
    const frame = Buffer.alloc(10);
    frame[0] = 0x06;
    frame[1] = 2; // firmware may write values other than 1
    Buffer.from('deadbeef', 'hex').copy(frame, 2);
    frame.writeUInt32LE(1000, 6);
    const ack = decodeSentAck(frame);
    expect(ack?.flood).toBe(true);
  });

  it('treats flood byte 0 as flood=false', () => {
    const frame = Buffer.alloc(10);
    frame[0] = 0x06;
    frame[1] = 0;
    Buffer.from('deadbeef', 'hex').copy(frame, 2);
    frame.writeUInt32LE(1000, 6);
    const ack = decodeSentAck(frame);
    expect(ack?.flood).toBe(false);
  });
});
