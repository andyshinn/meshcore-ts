import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { AdminSessionStore } from '../../src/features/adminSessions';
import { createChannelsRuntime } from '../../src/features/channels';
import { createContactsIterRuntime } from '../../src/features/contacts';
import { createDeviceAdminRuntime } from '../../src/features/deviceAdmin';
import { createDmRuntime, directMessagesFeature, resetDmState } from '../../src/features/directMessages';
import { createDrainRuntime } from '../../src/features/drain';
import type { FeatureContext } from '../../src/features/feature';
import { createPathDiagRuntime } from '../../src/features/pathDiagnostics';
import { PendingChannelSends } from '../../src/features/pendingChannelSends';
import {
  buildAnonReplyPath,
  createAdminCorrRuntime,
  registerAdminHooks,
  repeaterAdminFeature,
  repeaterLogin,
  repeaterRequestAvgMinMax,
  repeaterRequestOwnerInfo,
  repeaterSendCli,
  resetAdmin,
  sendAnonReq,
  sendBinaryReq,
  sendTelemetryReq,
} from '../../src/features/repeaterAdmin';
import { MeshObservations } from '../../src/model/meshObservations';
import { SessionState } from '../../src/model/state/model';
import type { Contact } from '../../src/model/types';
import { MeshCoreEvents } from '../../src/ports/events';
import { noopLogger } from '../../src/ports/logger';
import { PUSH, TXT_TYPE } from '../../src/protocol/codes';

// A full per-session ctx: real MeshCoreEvents + SessionState + AdminSessionStore
// + rt (with adminCorr under test plus the sibling rt factories), capturing writes.
function makeCtx(): {
  ctx: FeatureContext;
  state: SessionState;
  events: MeshCoreEvents;
  admin: AdminSessionStore;
  writes: Buffer[];
} {
  const state = new SessionState();
  const events = new MeshCoreEvents();
  const admin = new AdminSessionStore();
  const writes: Buffer[] = [];
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
    admin,
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
  return { ctx, state, events, admin, writes };
}

// 32-byte (64 hex) public key; first 6 bytes (12 hex) are the prefix.
const PK = 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';
const PREFIX = 'aabbccddeeff';
const tick = () => new Promise((r) => setTimeout(r, 0));

// RESP_SENT: [0x06][flood][expected_ack u32 LE][est u32 LE].
function sentTag(tagHex: string): Buffer {
  const f = Buffer.alloc(10);
  f[0] = 0x06;
  Buffer.from(tagHex, 'hex').copy(f, 2);
  return f;
}
// PUSH_BINARY_RESPONSE: [0x8c][0][tag u32][body…].
function binaryResp(tagHex: string, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([PUSH.BINARY_RESPONSE, 0x00]), Buffer.from(tagHex, 'hex'), body]);
}

function addContact(state: SessionState, overrides: Partial<Contact> = {}): Contact {
  const contact: Contact = {
    key: `c:${PK}`,
    publicKeyHex: PK,
    name: 'Repeater',
    kind: 'repeater',
    ...overrides,
  };
  state.upsertContact(contact);
  return contact;
}

// PUSH_LOGIN_SUCCESS v6+ frame: [0x85][perms u8][6B prefix][tag u32 LE][acl u8][fw u8].
function loginSuccessFrame(prefixHex: string, perms: number, acl: number, fw: number): Buffer {
  const frame = Buffer.alloc(15);
  frame[0] = PUSH.LOGIN_SUCCESS;
  frame[1] = perms;
  Buffer.from(prefixHex, 'hex').copy(frame, 2);
  frame.writeUInt32LE(0x11223344, 8);
  frame[12] = acl;
  frame[13] = fw;
  return frame;
}

// PUSH_LOGIN_FAIL frame: [0x86][0 reserved][6B prefix].
function loginFailFrame(prefixHex: string): Buffer {
  const frame = Buffer.alloc(8);
  frame[0] = PUSH.LOGIN_FAIL;
  Buffer.from(prefixHex, 'hex').copy(frame, 2);
  return frame;
}

// RESP_CONTACT_MSG_RECV_V3 with txt_type=CLI_DATA.
function cliReplyFrame(senderPrefixHex: string, body: string): Buffer {
  const text = Buffer.from(body, 'utf8');
  const frame = Buffer.alloc(16 + text.length);
  frame[0] = 0x10; // RESP_CONTACT_MSG_RECV_V3
  Buffer.from(senderPrefixHex, 'hex').copy(frame, 4);
  frame[10] = 0xff;
  frame[11] = TXT_TYPE.CLI_DATA;
  frame.writeUInt32LE(1, 12);
  text.copy(frame, 16);
  return frame;
}

describe('repeaterAdmin: createAdminCorrRuntime', () => {
  it('starts with empty queues and no pending stats', () => {
    const corr = createAdminCorrRuntime();
    expect(corr.adminSentQueue).toEqual([]);
    expect(corr.pendingCli.size).toBe(0);
    expect(corr.pendingLocalStats).toBeNull();
  });
});

describe('repeaterAdmin: login round-trip', () => {
  it('writes a direct CMD_SEND_LOGIN, then PUSH_LOGIN_SUCCESS resolves + sets the session', async () => {
    const { ctx, state, admin, writes } = makeCtx();
    addContact(state, { preferDirect: true });

    const p = repeaterLogin(ctx, `c:${PK}`, 'secret');
    // The login frame is written (CMD_SEND_LOGIN = 0x1a) carrying the full pubkey.
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe(0x1a);
    expect(writes[0].subarray(1, 33).toString('hex')).toBe(PK);

    // Firmware answers with PUSH_LOGIN_SUCCESS keyed on the pubkey prefix.
    repeaterAdminFeature.handle(PUSH.LOGIN_SUCCESS, loginSuccessFrame(PREFIX, 1, 1, 7), ctx);

    const result = await p;
    expect(result.mode).toBe('local');
    expect(result.effective).toBe('direct');
    expect(result.isAdmin).toBe(true);
    expect(result.permissions).toBe(1);

    const session = admin.getSession(`c:${PK}`);
    expect(session).not.toBeNull();
    expect(session?.role).toBe('admin');
    expect(session?.mode).toBe('local');
    expect(session?.publicKeyHex).toBe(PK);
    expect(session?.firmwareVerLevel).toBe(7);
  });

  it('uses CMD_SEND_LOGIN (0x1a) for a mesh login + flood effective when not preferDirect and no path', async () => {
    const { ctx, state, writes } = makeCtx();
    addContact(state);

    const p = repeaterLogin(ctx, `c:${PK}`, 'pw');
    // CMD_SEND_LOGIN (0x1a) — the radio floods when out_path is unknown. Body is
    // [0x1a][32B pubkey][ascii password].
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe(0x1a);
    expect(writes[0].subarray(1, 33).toString('hex')).toBe(PK);
    expect(writes[0].subarray(33).toString('utf8')).toBe('pw');

    repeaterAdminFeature.handle(PUSH.LOGIN_SUCCESS, loginSuccessFrame(PREFIX, 0, 0, 0), ctx);
    const result = await p;
    expect(result.mode).toBe('remote');
    expect(result.effective).toBe('flood');
  });

  it('guest login (empty password) writes [0x1a][32B pubkey] with no password bytes and resolves as guest', async () => {
    const { ctx, state, admin, writes } = makeCtx();
    addContact(state);

    const p = repeaterLogin(ctx, `c:${PK}`, '');
    // Guest bootstrap: CMD_SEND_LOGIN with an empty password → no trailing bytes.
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe(0x1a);
    expect(writes[0].subarray(1, 33).toString('hex')).toBe(PK);
    expect(writes[0]).toHaveLength(1 + 32);

    // Repeater admits the guest: perms=0, acl=PERM_ACL_GUEST(0) → not admin.
    repeaterAdminFeature.handle(PUSH.LOGIN_SUCCESS, loginSuccessFrame(PREFIX, 0, 0, 0), ctx);
    const result = await p;
    expect(result.isAdmin).toBe(false);
    expect(admin.getSession(`c:${PK}`)?.role).toBe('guest');
  });

  it('reports effective=path when the contact has a known multi-hop out_path', async () => {
    const { ctx, state } = makeCtx();
    addContact(state, { outPathHex: '0102', hops: 2 });
    const p = repeaterLogin(ctx, `c:${PK}`, 'pw');
    repeaterAdminFeature.handle(PUSH.LOGIN_SUCCESS, loginSuccessFrame(PREFIX, 0, 0, 0), ctx);
    const result = await p;
    expect(result.effective).toBe('path');
  });

  it('reports effective=direct for a known 0-hop route (hops === 0)', async () => {
    // A known route with 0 hops is a direct neighbour, not a flood (matches
    // meshcore_py, where out_path_len 0 is direct and only -1/0xFF is flood).
    const { ctx, state } = makeCtx();
    addContact(state, { hops: 0 });
    const p = repeaterLogin(ctx, `c:${PK}`, 'pw');
    repeaterAdminFeature.handle(PUSH.LOGIN_SUCCESS, loginSuccessFrame(PREFIX, 0, 0, 0), ctx);
    const result = await p;
    expect(result.effective).toBe('direct');
  });

  it('reports effective=flood only when the out_path is unknown (hops === undefined)', async () => {
    const { ctx, state } = makeCtx();
    addContact(state, { hops: undefined });
    const p = repeaterLogin(ctx, `c:${PK}`, 'pw');
    repeaterAdminFeature.handle(PUSH.LOGIN_SUCCESS, loginSuccessFrame(PREFIX, 0, 0, 0), ctx);
    const result = await p;
    expect(result.effective).toBe('flood');
  });

  it('PUSH_LOGIN_FAIL rejects the login awaiter', async () => {
    const { ctx, state } = makeCtx();
    addContact(state, { preferDirect: true });
    const p = repeaterLogin(ctx, `c:${PK}`, 'wrong');
    repeaterAdminFeature.handle(PUSH.LOGIN_FAIL, loginFailFrame(PREFIX), ctx);
    await expect(p).rejects.toThrow(/login rejected/);
  });
});

describe('repeaterAdmin: CLI command + onCliReply correlation', () => {
  it('registerAdminHooks + onCliReply resolves the pending CLI awaiter by sender prefix', async () => {
    const { ctx, state, writes } = makeCtx();
    addContact(state);
    // Wire the directMessages hooks against this session's adminCorr queues.
    registerAdminHooks(ctx);

    const p = repeaterSendCli(ctx, `c:${PK}`, 'setperm aa 1');
    // The CLI send is parked on adminCorr.pendingCli keyed by the 6B prefix,
    // a DM-text frame is written, and the synthetic id is on the DM FIFO.
    expect(ctx.rt.adminCorr.pendingCli.has(PREFIX)).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe(0x02); // CMD_SEND_TXT_MSG
    expect(writes[0][1]).toBe(TXT_TYPE.CLI_DATA);
    expect(ctx.rt.dm.dmSendQueue).toHaveLength(1);

    // The reply arrives on the DM opcode; directMessages routes it via onCliReply.
    directMessagesFeature.handle(0x10, cliReplyFrame(PREFIX, 'PERM SET'), ctx);

    await expect(p).resolves.toBe('PERM SET');
    expect(ctx.rt.adminCorr.pendingCli.has(PREFIX)).toBe(false);
  });

  it('onSentTag consumes the RESP_SENT tag ahead of the DM FIFO', () => {
    const { ctx } = makeCtx();
    registerAdminHooks(ctx);
    // Park an admin-sent awaiter (as sendBinaryReq does before its write).
    let resolvedTag: string | null = null;
    ctx.rt.adminCorr.adminSentQueue.push({
      resolve: (t) => {
        resolvedTag = t;
      },
      reject: () => {},
      timer: setTimeout(() => {}, 0),
    });
    // RESP_SENT with expected_ack — the admin hook claims it.
    const sent = Buffer.alloc(10);
    sent[0] = 0x06;
    Buffer.from('deadbeef', 'hex').copy(sent, 2);
    directMessagesFeature.handle(0x06, sent, ctx);
    expect(resolvedTag).toBe('deadbeef');
    expect(ctx.rt.adminCorr.adminSentQueue).toHaveLength(0);
  });
});

describe('repeaterAdmin: sendBinaryReq (generic)', () => {
  it('writes CMD_SEND_BINARY_REQ and resolves the tagged response body', async () => {
    const { ctx, state, writes } = makeCtx();
    addContact(state);
    registerAdminHooks(ctx);

    const reqData = Buffer.from([0x05, 0x00, 0x00]); // arbitrary REQ_TYPE + params
    const p = sendBinaryReq(ctx, `c:${PK}`, reqData);

    // CMD_SEND_BINARY_REQ = [0x32][32B pubkey][reqData]
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe(0x32);
    expect(writes[0].subarray(1, 33).toString('hex')).toBe(PK);
    expect(writes[0].subarray(33).toString('hex')).toBe('050000');

    // RESP_SENT echoes the tag; the admin hook claims it ahead of the DM FIFO.
    const sent = Buffer.alloc(10);
    sent[0] = 0x06;
    Buffer.from('cafebabe', 'hex').copy(sent, 2);
    directMessagesFeature.handle(0x06, sent, ctx);

    // PUSH_BINARY_RESPONSE = [0x8c][reserved][tag u32][body...]
    const resp = Buffer.alloc(6 + 2);
    resp[0] = PUSH.BINARY_RESPONSE;
    Buffer.from('cafebabe', 'hex').copy(resp, 2);
    resp[6] = 0xab;
    resp[7] = 0xcd;
    repeaterAdminFeature.handle(PUSH.BINARY_RESPONSE, resp, ctx);

    await expect(p.then((b) => b.toString('hex'))).resolves.toBe('abcd');
  });
});

describe('repeaterAdmin: buildAnonReplyPath', () => {
  it('flood contact (no out_path) → zero-hop reply-path [0x00]', () => {
    const { replyPath, isFlood } = buildAnonReplyPath({});
    expect(isFlood).toBe(true);
    expect(replyPath.toString('hex')).toBe('00');
  });

  it('1-byte-hash path reverses hop order; length byte packs hop count', () => {
    // out_path aa bb cc (3 one-byte hops) → reversed route cc bb aa;
    // packed byte = ((1-1)<<6) | 3 = 0x03
    const { replyPath, isFlood } = buildAnonReplyPath({ outPathHex: 'aabbcc' });
    expect(isFlood).toBe(false);
    expect(replyPath.toString('hex')).toBe('03ccbbaa');
  });

  it('multi-byte-hash path reverses by HOP not by byte; packs hashSize into bits 7-6', () => {
    // 2 hops × 2 bytes: [1122][3344] → reversed route [3344][1122]
    // packed byte = ((2-1)<<6) | 2 = 0x42
    const { replyPath } = buildAnonReplyPath({ outPathHex: '11223344', outPathHashSize: 2 });
    expect(replyPath.toString('hex')).toBe('4233441122');
  });
});

describe('repeaterAdmin: sendAnonReq', () => {
  it('known-path contact: writes [0x39][32B][anonType][packed][reversed] and resolves the tagged body; no path mutation', async () => {
    const { ctx, state, writes } = makeCtx();
    addContact(state, { outPathHex: 'aabbcc' });
    registerAdminHooks(ctx);

    const p = sendAnonReq(ctx, `c:${PK}`, 0x02);
    // The only write is the anon frame — no zero-hop add-update for a pathed contact.
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe(0x39);
    expect(writes[0].subarray(1, 33).toString('hex')).toBe(PK);
    // [anonType=02][packed=03][reversed cc bb aa]
    expect(writes[0].subarray(33).toString('hex')).toBe('0203ccbbaa');

    directMessagesFeature.handle(0x06, sentTag('cafebabe'), ctx);
    repeaterAdminFeature.handle(PUSH.BINARY_RESPONSE, binaryResp('cafebabe', Buffer.from([0xde, 0xad])), ctx);
    await expect(p.then((b) => b.toString('hex'))).resolves.toBe('dead');
    // Pathed contact is never reset to flood.
    expect(writes.some((w) => w[0] === 0x0d)).toBe(false);
  });

  it('flood contact: zero-hop dance — add-update(empty) → anon([type][0x00]) → reset to OUT_PATH_UNKNOWN', async () => {
    const { ctx, state, writes } = makeCtx();
    addContact(state); // no out_path → flood
    registerAdminHooks(ctx);

    const p = sendAnonReq(ctx, `c:${PK}`, 0x02);
    await tick(); // let the awaited zero-hop write + queue-push settle

    // 1st write: CMD_ADD_UPDATE_CONTACT with a zero-hop (empty) path — byte 35 = 0.
    expect(writes[0][0]).toBe(0x09);
    expect(writes[0][35]).toBe(0x00);
    // 2nd write: the anon frame with a zero-hop reply-path [anonType=02][0x00].
    expect(writes[1][0]).toBe(0x39);
    expect(writes[1].subarray(1, 33).toString('hex')).toBe(PK);
    expect(writes[1].subarray(33).toString('hex')).toBe('0200');

    directMessagesFeature.handle(0x06, sentTag('11223344'), ctx);
    repeaterAdminFeature.handle(PUSH.BINARY_RESPONSE, binaryResp('11223344', Buffer.from([0x01, 0x02])), ctx);
    await expect(p.then((b) => b.toString('hex'))).resolves.toBe('0102');
    await tick();

    // The flood contact is restored to OUT_PATH_UNKNOWN via CMD_RESET_PATH — no
    // leaked zero-hop path.
    const reset = writes.find((w) => w[0] === 0x0d);
    expect(reset).toBeDefined();
    expect(reset?.subarray(1, 33).toString('hex')).toBe(PK);
  });

  it('flood contact: resets the path even when RESP_SENT never arrives (write-only, no leak)', async () => {
    const { ctx, state, writes } = makeCtx();
    addContact(state);
    registerAdminHooks(ctx);

    const p = sendAnonReq(ctx, `c:${PK}`, 0x02);
    p.catch(() => {}); // will reject on resetAdmin
    await tick();
    expect(writes[0][0]).toBe(0x09); // zero-hop set happened

    resetAdmin(ctx, 'disconnected'); // fail the in-flight RESP_SENT awaiter
    await expect(p).rejects.toThrow('disconnected');
    await tick();
    // finally-net restored the flood path.
    expect(writes.some((w) => w[0] === 0x0d)).toBe(true);
  });
});

describe('repeaterAdmin: repeaterRequestOwnerInfo (anon OWNER)', () => {
  it('uses CMD_SEND_ANON_REQ with OWNER (0x02) and parses [now][name\\nowner]', async () => {
    const { ctx, state, writes } = makeCtx();
    addContact(state, { outPathHex: '01' }); // pathed → skip zero-hop dance
    registerAdminHooks(ctx);

    const p = repeaterRequestOwnerInfo(ctx, `c:${PK}`);
    expect(writes[0][0]).toBe(0x39);
    expect(writes[0][33]).toBe(0x02); // anonType = OWNER

    directMessagesFeature.handle(0x06, sentTag('aabbccdd'), ctx);
    const body = Buffer.concat([Buffer.alloc(4), Buffer.from('Node A\nowner notes\0', 'utf8')]);
    body.writeUInt32LE(1700, 0);
    repeaterAdminFeature.handle(PUSH.BINARY_RESPONSE, binaryResp('aabbccdd', body), ctx);

    await expect(p).resolves.toEqual({ firmwareVersion: '', nodeName: 'Node A', ownerInfo: 'owner notes' });
  });
});

describe('repeaterAdmin: sendTelemetryReq (binary req)', () => {
  it('sends CMD_SEND_BINARY_REQ [0x03] and surfaces the tagged LPP as repeaterTelemetry', async () => {
    const { ctx, state, events, writes } = makeCtx();
    addContact(state, { outPathHex: '01' });
    registerAdminHooks(ctx);
    const seen: Array<{ contactKey: string; fields: unknown[] }> = [];
    events.on('repeaterTelemetry', (s) => seen.push(s as { contactKey: string; fields: unknown[] }));

    const res = await sendTelemetryReq(ctx, `c:${PK}`);
    expect(res).toEqual({ ok: true });
    // frame = [0x32][32B pubkey][0x03]
    expect(writes[0][0]).toBe(0x32);
    expect(writes[0].subarray(1, 33).toString('hex')).toBe(PK);
    expect(writes[0].subarray(33).toString('hex')).toBe('03');

    directMessagesFeature.handle(0x06, sentTag('deadbeef'), ctx);
    // tagged LPP: ch0 voltage 4.20 V
    repeaterAdminFeature.handle(PUSH.BINARY_RESPONSE, binaryResp('deadbeef', Buffer.from([0x00, 0x74, 0x01, 0xa4])), ctx);
    await tick();

    expect(seen.at(-1)?.contactKey).toBe(`c:${PK}`);
    expect(seen.at(-1)?.fields.length).toBeGreaterThan(0);
  });

  it('returns { ok:false } for an unknown contact without writing', async () => {
    const { ctx, writes } = makeCtx();
    const res = await sendTelemetryReq(ctx, 'c:nope');
    expect(res.ok).toBe(false);
    expect(writes).toHaveLength(0);
  });
});

describe('repeaterAdmin: resetAdmin', () => {
  it('rejects pending CLI + admin-sent awaiters and clears sessions', async () => {
    const { ctx, state, admin } = makeCtx();
    addContact(state);
    registerAdminHooks(ctx);

    // A pending CLI awaiter.
    const cli = repeaterSendCli(ctx, `c:${PK}`, 'reboot');
    expect(ctx.rt.adminCorr.pendingCli.has(PREFIX)).toBe(true);

    // A live login session to confirm reset() drops it.
    admin.setSession({
      contactKey: `c:${PK}`,
      publicKeyHex: PK,
      mode: 'local',
      role: 'admin',
      permissionsBits: 1,
      aclPermissionsBits: 1,
      firmwareVerLevel: 7,
      loggedInAt: Date.now(),
    });

    resetAdmin(ctx, 'disconnected');

    await expect(cli).rejects.toThrow('disconnected');
    expect(ctx.rt.adminCorr.pendingCli.size).toBe(0);
    expect(admin.getSession(`c:${PK}`)).toBeNull();
  });

  it('rejects a pending local-stats awaiter', async () => {
    const { ctx } = makeCtx();
    ctx.rt.adminCorr.pendingLocalStats = {
      resolve: () => {},
      reject: () => {},
      timer: setTimeout(() => {}, 0),
    };
    // Wrap reject in a promise to assert it fires.
    const seen = new Promise<string>((resolve) => {
      const corr = ctx.rt.adminCorr.pendingLocalStats;
      if (corr) corr.reject = (e) => resolve(e.message);
    });
    resetAdmin(ctx, 'stopped');
    expect(ctx.rt.adminCorr.pendingLocalStats).toBeNull();
    await expect(seen).resolves.toBe('stopped');
  });

  it('rejects an in-flight sendBinaryReq awaiter', async () => {
    const { ctx, state } = makeCtx();
    addContact(state);
    registerAdminHooks(ctx);
    const p = sendBinaryReq(ctx, `c:${PK}`, Buffer.from([0x05, 0, 0]));
    // entry is parked on adminSentQueue
    expect(ctx.rt.adminCorr.adminSentQueue.length).toBeGreaterThan(0);
    resetAdmin(ctx, 'disconnected');
    await expect(p).rejects.toThrow('disconnected');
  });
});

describe('repeaterAdmin: repeaterRequestAvgMinMax', () => {
  it('builds the 11-byte request and parses the response', async () => {
    const { ctx, state, writes } = makeCtx();
    addContact(state);
    registerAdminHooks(ctx);

    const p = repeaterRequestAvgMinMax(ctx, `c:${PK}`, { startSecsAgo: 3600, endSecsAgo: 0 });

    // reqData = [0x04][start u32 LE][end u32 LE][0][0]; framed as CMD_SEND_BINARY_REQ.
    const reqData = writes[0].subarray(33);
    expect(reqData).toHaveLength(11);
    expect(reqData[0]).toBe(0x04);
    expect(reqData.readUInt32LE(1)).toBe(3600);
    expect(reqData.readUInt32LE(5)).toBe(0);
    expect(reqData[9]).toBe(0);
    expect(reqData[10]).toBe(0);

    // Tag echo, then a tagged response: now=42 + one temperature entry.
    const sent = Buffer.alloc(10);
    sent[0] = 0x06;
    Buffer.from('11223344', 'hex').copy(sent, 2);
    directMessagesFeature.handle(0x06, sent, ctx);

    const respBody = Buffer.alloc(4 + 2 + 6);
    respBody.writeUInt32LE(42, 0);
    respBody[4] = 1;
    respBody[5] = 0x67;
    respBody.writeInt16BE(200, 6);
    respBody.writeInt16BE(255, 8);
    respBody.writeInt16BE(225, 10);
    const resp = Buffer.alloc(6 + respBody.length);
    resp[0] = PUSH.BINARY_RESPONSE;
    Buffer.from('11223344', 'hex').copy(resp, 2);
    respBody.copy(resp, 6);
    repeaterAdminFeature.handle(PUSH.BINARY_RESPONSE, resp, ctx);

    const res = await p;
    expect(res.nowUnix).toBe(42);
    expect(res.series[0]).toMatchObject({ channel: 1, name: 'Temperature', min: 20, max: 25.5, avg: 22.5 });
  });
});

describe('repeaterAdmin: repeaterSendCli options — timeout + abort', () => {
  it('honours a per-call timeoutMs and clears the pendingCli slot', async () => {
    const { ctx, state } = makeCtx();
    addContact(state);
    registerAdminHooks(ctx);

    const p = repeaterSendCli(ctx, `c:${PK}`, 'ver', { timeoutMs: 10 });
    await expect(p).rejects.toThrow(/timed out after 10ms/);
    expect(ctx.rt.adminCorr.pendingCli.has(PREFIX)).toBe(false);
  });

  it('leaves the DM FIFO entry in place after a timeout', async () => {
    const { ctx, state } = makeCtx();
    addContact(state);
    registerAdminHooks(ctx);

    const p = repeaterSendCli(ctx, `c:${PK}`, 'ver', { timeoutMs: 10 });
    await expect(p).rejects.toThrow(/timed out/);
    // A RESP_SENT may still be in flight; popping the entry here would
    // mis-attribute the next real DM's 'sent' event.
    expect(ctx.rt.dm.dmSendQueue).toHaveLength(1);
    resetDmState(ctx, 'cleanup');
  });

  it('rejects immediately on an already-aborted signal, writing nothing', async () => {
    const { ctx, state, writes } = makeCtx();
    addContact(state);
    registerAdminHooks(ctx);

    const ac = new AbortController();
    ac.abort();
    await expect(repeaterSendCli(ctx, `c:${PK}`, 'ver', { signal: ac.signal })).rejects.toThrow();
    expect(writes).toHaveLength(0);
    expect(ctx.rt.dm.dmSendQueue).toHaveLength(0);
    expect(ctx.rt.adminCorr.pendingCli.has(PREFIX)).toBe(false);
  });

  it('rejects with signal.reason when aborted after the send', async () => {
    const { ctx, state } = makeCtx();
    addContact(state);
    registerAdminHooks(ctx);

    const ac = new AbortController();
    const reason = new Error('repeater switched');
    const p = repeaterSendCli(ctx, `c:${PK}`, 'ver', { signal: ac.signal });
    await tick();
    expect(ctx.rt.adminCorr.pendingCli.has(PREFIX)).toBe(true);

    ac.abort(reason);

    await expect(p).rejects.toBe(reason);
    // Awaiter dropped so the next command can use the slot; FIFO untouched.
    expect(ctx.rt.adminCorr.pendingCli.has(PREFIX)).toBe(false);
    expect(ctx.rt.dm.dmSendQueue).toHaveLength(1);
    resetDmState(ctx, 'cleanup');
  });

  it('defaults to a 30s reply wait when no timeoutMs is given', async () => {
    const { ctx, state } = makeCtx();
    addContact(state);
    registerAdminHooks(ctx);

    const p = repeaterSendCli(ctx, `c:${PK}`, 'ver');
    await tick();
    expect(ctx.rt.adminCorr.pendingCli.has(PREFIX)).toBe(true);
    // Settle it so the 30s timer doesn't hold the suite open.
    directMessagesFeature.handle(0x10, cliReplyFrame(PREFIX, 'v1.2.3'), ctx);
    await expect(p).resolves.toBe('v1.2.3');
  });

  it('rejects the promise (not just throws) when the write fails', async () => {
    const { ctx, state } = makeCtx();
    addContact(state);
    registerAdminHooks(ctx);
    ctx.writeFrame = async () => {
      throw new Error('transport down');
    };

    await expect(repeaterSendCli(ctx, `c:${PK}`, 'ver')).rejects.toThrow(/transport down/);
    expect(ctx.rt.dm.dmSendQueue).toHaveLength(0);
    expect(ctx.rt.adminCorr.pendingCli.has(PREFIX)).toBe(false);
  });
});

describe('repeaterAdmin: repeaterSendCli expectReply:false', () => {
  it('registers no pendingCli awaiter and still writes the CLI_DATA DM', async () => {
    const { ctx, state, writes } = makeCtx();
    addContact(state);
    registerAdminHooks(ctx);

    const p = repeaterSendCli(ctx, `c:${PK}`, 'reboot', { expectReply: false });
    await tick();

    expect(ctx.rt.adminCorr.pendingCli.size).toBe(0);
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe(0x02); // CMD_SEND_TXT_MSG
    expect(writes[0][1]).toBe(TXT_TYPE.CLI_DATA);
    expect(writes[0].subarray(13).toString('utf8')).toBe('reboot');
    expect(ctx.rt.dm.dmSendQueue).toHaveLength(1);

    directMessagesFeature.handle(0x06, sentTag('00000000'), ctx);
    await expect(p).resolves.toBe('');
  });

  it('does not consume the pendingCli slot a concurrent command needs', async () => {
    const { ctx, state } = makeCtx();
    addContact(state);
    registerAdminHooks(ctx);

    const fire = repeaterSendCli(ctx, `c:${PK}`, 'clkreboot', { expectReply: false });
    const ask = repeaterSendCli(ctx, `c:${PK}`, 'ver');
    await tick();

    expect(ctx.rt.adminCorr.pendingCli.has(PREFIX)).toBe(true);

    directMessagesFeature.handle(0x06, sentTag('00000000'), ctx); // pops the fire-and-forget
    await expect(fire).resolves.toBe('');

    directMessagesFeature.handle(0x10, cliReplyFrame(PREFIX, 'v1.2.3'), ctx);
    await expect(ask).resolves.toBe('v1.2.3');
  });

  it('rejects when the send is never confirmed within the timeout', async () => {
    const { ctx, state } = makeCtx();
    addContact(state);
    registerAdminHooks(ctx);

    const p = repeaterSendCli(ctx, `c:${PK}`, 'poweroff', { expectReply: false, timeoutMs: 10 });
    await expect(p).rejects.toThrow(/send was not confirmed after 10ms/);
    expect(ctx.rt.adminCorr.pendingCli.size).toBe(0);
    resetDmState(ctx, 'cleanup');
  });

  it('is abortable before the send is confirmed', async () => {
    const { ctx, state } = makeCtx();
    addContact(state);
    registerAdminHooks(ctx);

    const ac = new AbortController();
    const reason = new Error('user cancelled');
    const p = repeaterSendCli(ctx, `c:${PK}`, 'start ota', { expectReply: false, signal: ac.signal });
    await tick();
    ac.abort(reason);

    await expect(p).rejects.toBe(reason);
    resetDmState(ctx, 'cleanup');
  });

  it('reports on cliSendState even after the promise has already resolved', async () => {
    const { ctx, state, events } = makeCtx();
    addContact(state);
    registerAdminHooks(ctx);
    const seen: Array<{ id: string; contactKey: string; state: string }> = [];
    events.on('cliSendState', (e) => seen.push({ id: e.id, contactKey: e.contactKey, state: e.state }));

    const p = repeaterSendCli(ctx, `c:${PK}`, 'reboot', { expectReply: false });
    await tick();
    directMessagesFeature.handle(0x06, sentTag('deadbeef'), ctx);
    await expect(p).resolves.toBe('');

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ contactKey: `c:${PK}`, state: 'sent' });
    expect(seen[0].id.startsWith('cli-')).toBe(true);

    // A late ACK still reports — the stronger signal arrives after the resolve.
    directMessagesFeature.handle(
      0x82,
      Buffer.concat([Buffer.from([0x82]), Buffer.from('deadbeef', 'hex'), Buffer.alloc(4)]),
      ctx,
    );
    expect(seen.map((s) => s.state)).toEqual(['sent', 'ack']);
  });
});
