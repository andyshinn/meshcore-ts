import { Buffer } from 'node:buffer';
import { AdminSessionStore } from '../../src/features/adminSessions';
import { createChannelsRuntime } from '../../src/features/channels';
import { createContactsIterRuntime } from '../../src/features/contacts';
import { createDeviceAdminRuntime } from '../../src/features/deviceAdmin';
import { createDmRuntime } from '../../src/features/directMessages';
import { createDrainRuntime } from '../../src/features/drain';
import type { FeatureContext } from '../../src/features/feature';
import { createPathDiagRuntime } from '../../src/features/pathDiagnostics';
import { PendingChannelSends } from '../../src/features/pendingChannelSends';
import { createAdminCorrRuntime } from '../../src/features/repeaterAdmin';
import { createReplyOrderRuntime } from '../../src/features/replyOrder';
import { MeshObservations } from '../../src/model/meshObservations';
import { SessionState } from '../../src/model/state/model';
import type { Contact } from '../../src/model/types';
import { MeshCoreEvents } from '../../src/ports/events';
import { noopLogger } from '../../src/ports/logger';

/** 32-byte (64 hex) fixture pubkey; the first 6 bytes (12 hex) are the prefix. */
export const PK = 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';

export interface FeatureCtxHarness {
  ctx: FeatureContext;
  state: SessionState;
  events: MeshCoreEvents;
  admin: AdminSessionStore;
  writes: Buffer[];
}

/**
 * A full per-session ctx: real MeshCoreEvents + SessionState + AdminSessionStore
 * + rt (every sibling rt factory), capturing writes.
 *
 * `admin` is a real AdminSessionStore unless one is supplied — features that
 * never read `ctx.admin` are unaffected by the difference.
 */
export function makeFeatureCtx(opts: { admin?: AdminSessionStore } = {}): FeatureCtxHarness {
  const state = new SessionState();
  const events = new MeshCoreEvents();
  const admin = opts.admin ?? new AdminSessionStore();
  const writes: Buffer[] = [];
  const ctx: FeatureContext = {
    writeFrame: async (frame: Buffer) => {
      writes.push(frame);
    },
    // As if the radio answered RESP_OK.
    writeAckSink: async (frame: Buffer, onAck?: (ack: { ok: boolean }) => void) => {
      writes.push(frame);
      onAck?.({ ok: true });
    },
    writeExpectingReply: async (frame: Buffer) => {
      writes.push(frame);
    },
    // A bare-ack request (no `expect`) writes and resolves as if the radio
    // answered RESP_OK; typed requests aren't modelled here.
    request: async (frame: Buffer, opts?: { expect?: number }) => {
      if (opts?.expect !== undefined) throw new Error('typed request not modelled in these tests');
      writes.push(frame);
      return Buffer.alloc(0);
    },
    requestOrNull: async () => null,
    requestOrError: async () => {
      throw new Error('requestOrError not used in these tests');
    },
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
      replyOrder: createReplyOrderRuntime(),
    },
    getTransportState: () => 'connected',
    contactsSync: () => {},
  };
  return { ctx, state, events, admin, writes };
}

/** Upsert the fixture contact (a chat peer) into `state` and return it. */
export function addContact(state: SessionState, overrides: Partial<Contact> = {}): Contact {
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
