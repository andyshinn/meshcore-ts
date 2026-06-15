import { Buffer } from 'node:buffer';
import { PUSH, REQ_TYPE, RESP, STATS_TYPE, TXT_TYPE } from '../codes';
import type { Feature, FeatureContext } from '../feature';
import {
  type AclEntry,
  type AvgMinMaxResult,
  buildAnonLogin,
  buildGetStats,
  buildLogout,
  buildSendBinaryReq,
  buildSendLogin,
  buildSendStatusReq,
  buildSendTelemetryReq,
  buildSendTracePath,
  type LocalStats,
  type LoginSuccess,
  type NeighboursPage,
  type OwnerInfo,
  parseAclList,
  parseAvgMinMax,
  parseBinaryResponse,
  parseLocalStats,
  parseLoginFail,
  parseLoginSuccess,
  parseNeighbours,
  parseOwnerInfo,
  parseRawData,
  parseStatusResponse,
  parseTelemetryResponse,
  parseTraceData,
  type TraceData,
} from '../repeater';
import type { AdminMode, AdminRole } from '../session/adminSessions';
import * as directMessages from './directMessages';

const ADMIN_SENT_TIMEOUT_MS = 5_000;
const ADMIN_REPLY_TIMEOUT_MS = 20_000;
const CLI_REPLY_TIMEOUT_MS = 30_000;

// ---- Admin-coordination state ------------------------------------------

// FIFO of admin sends still awaiting their RESP_SENT tag echo. Admin writes are
// serialised, so the oldest entry is always the one the radio just acked. The
// directMessages feature owns RESP_SENT; it calls our `onSentTag` hook first.
interface PendingAdminSent {
  resolve: (tagHex: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// Awaiter for an out-of-band CLI reply (RESP_CONTACT_MSG_RECV with txt_type=1)
// from a specific remote pubkey, keyed by 6B sender pubkey prefix hex. The
// directMessages feature owns CONTACT_MSG_RECV; it calls our `onCliReply` hook.
interface PendingCli {
  pubKeyPrefixHex: string;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Per-session admin-correlation state (was the module-level adminSentQueue /
 *  pendingCli / pendingLocalStats). Relocated onto ctx.rt.adminCorr. */
export interface AdminCorrRuntime {
  adminSentQueue: PendingAdminSent[];
  pendingCli: Map<string, PendingCli>;
  pendingLocalStats: {
    resolve: (v: LocalStats) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null;
}

export function createAdminCorrRuntime(): AdminCorrRuntime {
  return { adminSentQueue: [], pendingCli: new Map(), pendingLocalStats: null };
}

/** Register the directMessages admin-intercept hooks against this session's
 *  queues. Called from ProtocolSession.start(). RESP_SENT / CLI replies arrive
 *  on opcodes owned by the directMessages feature; these hooks give the admin
 *  awaiters first crack (returning true when an awaiter consumed the frame). */
export function registerAdminHooks(ctx: FeatureContext): void {
  directMessages.setAdminHooks(ctx, {
    onSentTag: (tagHex) => {
      const adminAwait = ctx.rt.adminCorr.adminSentQueue.shift();
      if (!adminAwait) return false;
      clearTimeout(adminAwait.timer);
      adminAwait.resolve(tagHex);
      return true;
    },
    onCliReply: (prefix, body) => {
      const pending = ctx.rt.adminCorr.pendingCli.get(prefix);
      if (!pending) return false;
      clearTimeout(pending.timer);
      ctx.rt.adminCorr.pendingCli.delete(prefix);
      pending.resolve(body);
      return true;
    },
  });
}

/** Fail every in-flight admin awaiter + drop login sessions (on disconnect/stop). */
export function resetAdmin(ctx: FeatureContext, reason: string): void {
  const corr = ctx.rt.adminCorr;
  while (corr.adminSentQueue.length > 0) {
    const entry = corr.adminSentQueue.shift();
    if (entry) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
  }
  for (const entry of corr.pendingCli.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
  }
  corr.pendingCli.clear();
  if (corr.pendingLocalStats) {
    clearTimeout(corr.pendingLocalStats.timer);
    corr.pendingLocalStats.reject(new Error(reason));
    corr.pendingLocalStats = null;
  }
  ctx.admin.reset(reason);
}

// ---- Private helpers ---------------------------------------------------

function lookupRepeaterContact(
  ctx: FeatureContext,
  contactKey: string,
): { ok: true; publicKeyHex: string } | { ok: false; error: string } {
  const contact = ctx.state.getContacts().find((c) => c.key === contactKey);
  if (!contact) return { ok: false, error: `unknown contact ${contactKey}` };
  if (!contact.publicKeyHex || contact.publicKeyHex.length < 64) {
    return { ok: false, error: `contact ${contactKey} has no full 32B public key` };
  }
  return { ok: true, publicKeyHex: contact.publicKeyHex };
}

/** Generic mesh request (ACL / neighbours / owner / avg-min-max, or any custom
 *  REQ_TYPE). Issues CMD_SEND_BINARY_REQ, parks an awaiter for the matching
 *  PUSH_BINARY_RESPONSE tag, and returns the response body (which the caller
 *  decodes per req_type). `reqData` is `[REQ_TYPE byte, ...params]`.
 *
 *  Implementation note: `awaitTag` is registered synchronously inside the
 *  adminSentQueue resolver so that a PUSH_BINARY_RESPONSE arriving in the same
 *  synchronous turn as RESP_SENT (as happens in tests and under tight firmware
 *  timing) does not race past the awaiter registration. */
export function sendBinaryReq(
  ctx: FeatureContext,
  contactKey: string,
  reqData: Buffer,
  timeoutMs: number = ADMIN_REPLY_TIMEOUT_MS,
): Promise<Buffer> {
  const contact = lookupRepeaterContact(ctx, contactKey);
  if (!contact.ok) return Promise.reject(new Error(contact.error));
  let frame: Buffer;
  try {
    frame = buildSendBinaryReq(contact.publicKeyHex, reqData);
  } catch (err) {
    return Promise.reject(err);
  }
  return new Promise<Buffer>((resolve, reject) => {
    const queue = ctx.rt.adminCorr.adminSentQueue;
    const timer = setTimeout(() => {
      const i = queue.indexOf(entry);
      if (i !== -1) queue.splice(i, 1);
      reject(new Error(`admin RESP_SENT timed out after ${ADMIN_SENT_TIMEOUT_MS}ms`));
    }, ADMIN_SENT_TIMEOUT_MS);
    const entry: PendingAdminSent = {
      resolve: (tagHex) => {
        // Register the payload awaiter synchronously inside the RESP_SENT
        // resolver so a PUSH_BINARY_RESPONSE that arrives in the same
        // synchronous turn (e.g. tight firmware ack) is never missed.
        ctx.admin.awaitTag<Buffer>(tagHex, timeoutMs).then(resolve, reject);
      },
      reject,
      timer,
    };
    queue.push(entry);
    ctx.writeFrame(frame).catch((err) => {
      const i = queue.indexOf(entry);
      if (i !== -1) queue.splice(i, 1);
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ---- Public methods ----------------------------------------------------

/** Request a status snapshot from a repeater/room/contact. Returns ok on
 *  transport-level write; the actual `RepeaterStatusSnapshot` arrives later
 *  via PUSH_STATUS_RESPONSE → emit.repeaterStatus(). */
export async function sendStatusReq(ctx: FeatureContext, contactKey: string): Promise<{ ok: boolean; error?: string }> {
  const contact = ctx.state.getContacts().find((c) => c.key === contactKey);
  if (!contact) return { ok: false, error: `unknown contact ${contactKey}` };
  if (!contact.publicKeyHex || contact.publicKeyHex.length < 64) {
    return { ok: false, error: `contact ${contactKey} has no full 32B public key` };
  }
  try {
    await ctx.writeFrame(buildSendStatusReq(contact.publicKeyHex));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Request a CayenneLPP telemetry blob from a contact. See sendStatusReq. */
export async function sendTelemetryReq(ctx: FeatureContext, contactKey: string): Promise<{ ok: boolean; error?: string }> {
  const contact = ctx.state.getContacts().find((c) => c.key === contactKey);
  if (!contact) return { ok: false, error: `unknown contact ${contactKey}` };
  if (!contact.publicKeyHex || contact.publicKeyHex.length < 64) {
    return { ok: false, error: `contact ${contactKey} has no full 32B public key` };
  }
  try {
    await ctx.writeFrame(buildSendTelemetryReq(contact.publicKeyHex));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Login to a repeater. The wire mode is derived from the contact's current
 *  path state:
 *    - `preferDirect=true` → CMD_SEND_LOGIN (companion-side, no mesh routing)
 *    - else → CMD_SEND_ANON_REQ (mesh-routed; the radio uses whatever
 *      out_path the contact currently has — N-hop if set, flood otherwise)
 *  Success arrives later as PUSH_LOGIN_SUCCESS keyed on the recipient's
 *  pubkey prefix; failure as PUSH_LOGIN_FAIL. Returns the effective mode so
 *  the UI can label the toast (Direct / Flood / N-hop). */
export async function repeaterLogin(
  ctx: FeatureContext,
  contactKey: string,
  password: string,
): Promise<LoginSuccess & { mode: AdminMode; effective: 'direct' | 'flood' | 'path' }> {
  const lookup = lookupRepeaterContact(ctx, contactKey);
  if (!lookup.ok) throw new Error(lookup.error);
  const contact = ctx.state.getContacts().find((c) => c.key === contactKey);
  const preferDirect = contact?.preferDirect === true;
  const hasPath = !!contact?.outPathHex && contact.outPathHex.length > 0;
  const mode: AdminMode = preferDirect ? 'local' : 'remote';
  const effective: 'direct' | 'flood' | 'path' = preferDirect ? 'direct' : hasPath ? 'path' : 'flood';

  const prefix = lookup.publicKeyHex.slice(0, 12);
  const wait = ctx.admin.awaitLogin<LoginSuccess>(prefix, ADMIN_REPLY_TIMEOUT_MS);
  const frame = preferDirect ? buildSendLogin(lookup.publicKeyHex, password) : buildAnonLogin(lookup.publicKeyHex, password);
  try {
    await ctx.writeFrame(frame);
  } catch (err) {
    ctx.admin.rejectLogin(prefix, err as Error);
    throw err;
  }
  const result = await wait;
  const role: AdminRole = result.isAdmin ? 'admin' : 'guest';
  ctx.admin.setSession({
    contactKey,
    publicKeyHex: lookup.publicKeyHex,
    mode,
    role,
    permissionsBits: result.permissions,
    aclPermissionsBits: result.aclPermissions,
    firmwareVerLevel: result.firmwareVerLevel,
    loggedInAt: Date.now(),
  });
  return { ...result, mode, effective };
}

export async function repeaterLogout(ctx: FeatureContext, contactKey: string): Promise<void> {
  const contact = lookupRepeaterContact(ctx, contactKey);
  if (!contact.ok) throw new Error(contact.error);
  await ctx.writeFrame(buildLogout(contact.publicKeyHex));
  ctx.admin.clearSession(contactKey);
}

/** Request the ACL list. Admin-only (firmware returns nothing if guest). */
export async function repeaterRequestAcl(ctx: FeatureContext, contactKey: string): Promise<AclEntry[]> {
  const reqData = Buffer.from([REQ_TYPE.GET_ACCESS_LIST, 0, 0]);
  const payload = await sendBinaryReq(ctx, contactKey, reqData);
  return parseAclList(payload);
}

export async function repeaterRequestNeighbours(
  ctx: FeatureContext,
  contactKey: string,
  opts: {
    count?: number;
    offset?: number;
    orderBy?: number;
    prefixLen?: number;
  } = {},
): Promise<NeighboursPage> {
  const count = opts.count ?? 16;
  const offset = opts.offset ?? 0;
  const orderBy = opts.orderBy ?? 0;
  const prefixLen = opts.prefixLen ?? 6;
  const reqData = Buffer.alloc(11);
  reqData[0] = REQ_TYPE.GET_NEIGHBOURS;
  reqData[1] = 0; // request version
  reqData[2] = count & 0xff;
  reqData.writeUInt16LE(offset & 0xffff, 3);
  reqData[5] = orderBy & 0xff;
  reqData[6] = prefixLen & 0xff;
  // bytes 7..10: random blob to keep packet hash unique (firmware ignores it)
  for (let i = 7; i < 11; i += 1) reqData[i] = Math.floor(Math.random() * 256);
  const payload = await sendBinaryReq(ctx, contactKey, reqData);
  const parsed = parseNeighbours(payload, prefixLen);
  if (!parsed) throw new Error('failed to parse neighbours response');
  return parsed;
}

export async function repeaterRequestOwnerInfo(ctx: FeatureContext, contactKey: string): Promise<OwnerInfo> {
  const reqData = Buffer.from([REQ_TYPE.GET_OWNER_INFO]);
  const payload = await sendBinaryReq(ctx, contactKey, reqData);
  return parseOwnerInfo(payload);
}

/** Request a min/max/avg series window from a sensor (REQ_TYPE_GET_AVG_MIN_MAX).
 *  `startSecsAgo`/`endSecsAgo` are the window bounds relative to the repeater's
 *  clock (end is usually 0 = now). Requires read-only ACL perms on the device. */
export async function repeaterRequestAvgMinMax(
  ctx: FeatureContext,
  contactKey: string,
  opts: { startSecsAgo: number; endSecsAgo: number },
): Promise<AvgMinMaxResult> {
  const reqData = Buffer.alloc(11);
  reqData[0] = REQ_TYPE.GET_AVG_MIN_MAX;
  reqData.writeUInt32LE(opts.startSecsAgo >>> 0, 1);
  reqData.writeUInt32LE(opts.endSecsAgo >>> 0, 5);
  // bytes 9,10 reserved = 0 (firmware returns no data unless both are zero)
  const payload = await sendBinaryReq(ctx, contactKey, reqData);
  const parsed = parseAvgMinMax(payload);
  if (!parsed) throw new Error('failed to parse avg/min/max response');
  return parsed;
}

/** Send a remote CLI command (e.g. "setperm <hex> 1", "discover.neighbors")
 *  as a text message with txt_type=CLI_DATA. The reply arrives as a normal
 *  RESP_CONTACT_MSG_RECV(_V3) with txt_type=CLI_DATA; the directMessages
 *  feature routes it back here (onCliReply) by sender prefix. */
export async function repeaterSendCli(ctx: FeatureContext, contactKey: string, command: string): Promise<string> {
  const contact = lookupRepeaterContact(ctx, contactKey);
  if (!contact.ok) throw new Error(contact.error);
  const prefix = contact.publicKeyHex.slice(0, 12);
  const pendingCli = ctx.rt.adminCorr.pendingCli;
  const wait = new Promise<string>((resolve, reject) => {
    const existing = pendingCli.get(prefix);
    if (existing) {
      clearTimeout(existing.timer);
      existing.reject(new Error('superseded by newer CLI command'));
    }
    const timer = setTimeout(() => {
      pendingCli.delete(prefix);
      reject(new Error(`CLI command timed out after ${CLI_REPLY_TIMEOUT_MS}ms`));
    }, CLI_REPLY_TIMEOUT_MS);
    pendingCli.set(prefix, { pubKeyPrefixHex: prefix, resolve, reject, timer });
  });
  const frame = directMessages.encodeSendDmText({
    destPublicKeyHex: contact.publicKeyHex,
    text: command,
    txtType: TXT_TYPE.CLI_DATA,
  });
  // CLI sends are still DMs at the wire level — push onto the DM send FIFO so
  // the RESP_SENT FIFO advances correctly. The id is synthetic; the radio
  // doesn't ack CLI sends with PUSH_SEND_CONFIRMED so we won't get a state flip.
  const syntheticId = `cli-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  directMessages.enqueueDmSend(ctx, syntheticId);
  try {
    await ctx.writeFrame(frame);
  } catch (err) {
    directMessages.dequeueDmSend(ctx, syntheticId);
    const pending = pendingCli.get(prefix);
    if (pending) {
      clearTimeout(pending.timer);
      pendingCli.delete(prefix);
      pending.reject(err as Error);
    }
    throw err;
  }
  return wait;
}

/** CMD_SEND_TRACE_PATH — diagnostic trace along a known path. Reply lands
 *  as PUSH_TRACE_DATA. */
export async function repeaterTracePath(
  ctx: FeatureContext,
  opts: {
    tag: number;
    authCode: number;
    flags?: number;
    pathHex: string;
  },
): Promise<TraceData> {
  const path = Buffer.from(opts.pathHex, 'hex');
  const tagHex = Buffer.alloc(4);
  tagHex.writeUInt32LE(opts.tag >>> 0, 0);
  const wait = ctx.admin.awaitTag<TraceData>(tagHex.toString('hex'), ADMIN_REPLY_TIMEOUT_MS);
  await ctx.writeFrame(buildSendTracePath({ tag: opts.tag, authCode: opts.authCode, flags: opts.flags, path }));
  return wait;
}

/** CMD_GET_STATS — local stats for the directly-connected device. Reply
 *  arrives as RESP_CODE_STATS. */
export async function repeaterGetLocalStats(ctx: FeatureContext, subtype: keyof typeof STATS_TYPE): Promise<LocalStats> {
  const corr = ctx.rt.adminCorr;
  if (corr.pendingLocalStats) {
    corr.pendingLocalStats.reject(new Error('superseded by newer GET_STATS'));
    clearTimeout(corr.pendingLocalStats.timer);
    corr.pendingLocalStats = null;
  }
  const wait = new Promise<LocalStats>((resolve, reject) => {
    const timer = setTimeout(() => {
      corr.pendingLocalStats = null;
      reject(new Error('GET_STATS timed out'));
    }, ADMIN_REPLY_TIMEOUT_MS);
    corr.pendingLocalStats = { resolve, reject, timer };
  });
  await ctx.writeFrame(buildGetStats(STATS_TYPE[subtype]));
  return wait;
}

// ---- Inbound handlers --------------------------------------------------

function handleStatusResponse(frame: Buffer, ctx: FeatureContext): void {
  const parsed = parseStatusResponse(frame);
  if (!parsed) return;
  const contact = ctx.state
    .getContacts()
    .find((c) => c.publicKeyHex.toLowerCase().startsWith(parsed.senderPubKeyPrefixHex.toLowerCase()));
  if (!contact) {
    ctx.log.warn(`status response from unknown sender prefix=${parsed.senderPubKeyPrefixHex}`);
    return;
  }
  ctx.events.emit('repeaterStatus', {
    contactKey: contact.key,
    receivedAt: Date.now(),
    payloadHex: parsed.payloadHex,
    fields: parsed.fields,
  });
  ctx.log.debug(
    `status response from "${contact.name}" payload=${parsed.payloadHex.length / 2}B fields=${parsed.fields.length}`,
  );
}

function handleTelemetryResponse(frame: Buffer, ctx: FeatureContext): void {
  const parsed = parseTelemetryResponse(frame);
  if (!parsed) return;
  const contact = ctx.state
    .getContacts()
    .find((c) => c.publicKeyHex.toLowerCase().startsWith(parsed.senderPubKeyPrefixHex.toLowerCase()));
  if (!contact) {
    ctx.log.warn(`telemetry response from unknown sender prefix=${parsed.senderPubKeyPrefixHex}`);
    return;
  }
  ctx.events.emit('repeaterTelemetry', {
    contactKey: contact.key,
    receivedAt: Date.now(),
    payloadHex: parsed.payloadHex,
    fields: parsed.fields,
  });
  ctx.log.debug(
    `telemetry response from "${contact.name}" payload=${parsed.payloadHex.length / 2}B fields=${parsed.fields.length}`,
  );
}

export const repeaterAdminFeature: Feature = {
  handles: [
    PUSH.STATUS_RESPONSE,
    PUSH.TELEMETRY_RESPONSE,
    PUSH.LOGIN_SUCCESS,
    PUSH.LOGIN_FAIL,
    PUSH.BINARY_RESPONSE,
    PUSH.TRACE_DATA,
    PUSH.RAW_DATA,
    RESP.STATS,
  ],
  handle: (code, frame, ctx) => {
    if (code === PUSH.STATUS_RESPONSE) {
      handleStatusResponse(frame, ctx);
      return;
    }
    if (code === PUSH.TELEMETRY_RESPONSE) {
      handleTelemetryResponse(frame, ctx);
      return;
    }
    if (code === PUSH.LOGIN_SUCCESS) {
      const parsed = parseLoginSuccess(frame);
      if (parsed) ctx.admin.resolveLogin(parsed.pubKeyPrefixHex, parsed);
      return;
    }
    if (code === PUSH.LOGIN_FAIL) {
      const parsed = parseLoginFail(frame);
      if (parsed) {
        ctx.admin.rejectLogin(parsed.pubKeyPrefixHex, new Error('login rejected by repeater'));
      }
      return;
    }
    if (code === PUSH.BINARY_RESPONSE) {
      const parsed = parseBinaryResponse(frame);
      if (parsed) ctx.admin.resolveTag(parsed.tagHex, parsed.payload);
      return;
    }
    if (code === PUSH.TRACE_DATA) {
      const parsed = parseTraceData(frame);
      if (parsed) ctx.admin.resolveTag(parsed.tagHex, parsed);
      return;
    }
    if (code === PUSH.RAW_DATA) {
      // Currently only useful for debugging; admin responses arrive via
      // BINARY_RESPONSE / LOGIN_SUCCESS instead.
      const parsed = parseRawData(frame);
      if (parsed) ctx.log.trace(`raw_data snr=${parsed.snrDb} rssi=${parsed.rssi}`);
      return;
    }
    // RESP.STATS — reply to a CMD_GET_STATS write.
    const parsed = parseLocalStats(frame);
    if (parsed && ctx.rt.adminCorr.pendingLocalStats) {
      clearTimeout(ctx.rt.adminCorr.pendingLocalStats.timer);
      ctx.rt.adminCorr.pendingLocalStats.resolve(parsed);
      ctx.rt.adminCorr.pendingLocalStats = null;
    }
  },
};
