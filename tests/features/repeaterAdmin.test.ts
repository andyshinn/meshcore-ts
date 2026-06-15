import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { PUSH, TXT_TYPE } from '../../src/codes';
import type { FeatureContext } from '../../src/feature';
import { createChannelsRuntime } from '../../src/features/channels';
import { createContactsIterRuntime } from '../../src/features/contacts';
import { createDeviceAdminRuntime } from '../../src/features/deviceAdmin';
import { createDmRuntime, directMessagesFeature } from '../../src/features/directMessages';
import { createDrainRuntime } from '../../src/features/drain';
import { createPathDiagRuntime } from '../../src/features/pathDiagnostics';
import {
  createAdminCorrRuntime,
  registerAdminHooks,
  repeaterAdminFeature,
  repeaterLogin,
  repeaterSendCli,
  resetAdmin,
  sendBinaryReq,
} from '../../src/features/repeaterAdmin';
import { MeshObservations } from '../../src/meshObservations';
import { PendingChannelSends } from '../../src/pendingChannelSends';
import { MeshCoreEvents } from '../../src/ports/events';
import { noopLogger } from '../../src/ports/logger';
import { AdminSessionStore } from '../../src/session/adminSessions';
import { SessionState } from '../../src/state/model';
import type { Contact } from '../../src/types';

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

  it('uses anon (mesh) login + flood effective when not preferDirect and no path', async () => {
    const { ctx, state, writes } = makeCtx();
    addContact(state);

    const p = repeaterLogin(ctx, `c:${PK}`, 'pw');
    // CMD_SEND_ANON_REQ (not CMD_SEND_LOGIN) is written.
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).not.toBe(0x1a);
    expect(writes[0][0]).toBe(0x39); // CMD_SEND_ANON_REQ

    repeaterAdminFeature.handle(PUSH.LOGIN_SUCCESS, loginSuccessFrame(PREFIX, 0, 0, 0), ctx);
    const result = await p;
    expect(result.mode).toBe('remote');
    expect(result.effective).toBe('flood');
  });

  it('reports effective=path when the contact has a known out_path', async () => {
    const { ctx, state } = makeCtx();
    addContact(state, { outPathHex: '0102' });
    const p = repeaterLogin(ctx, `c:${PK}`, 'pw');
    repeaterAdminFeature.handle(PUSH.LOGIN_SUCCESS, loginSuccessFrame(PREFIX, 0, 0, 0), ctx);
    const result = await p;
    expect(result.effective).toBe('path');
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
    // Park an admin-sent awaiter (as writeAdminAndAwaitTag would).
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
});
