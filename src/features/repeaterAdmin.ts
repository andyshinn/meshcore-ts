import { Buffer } from 'node:buffer';
import { contactKindToAdvType } from '../model/contacts';
import { ADMIN_REPLY_TIMEOUT_MS, ADMIN_SENT_TIMEOUT_MS, CLI_REPLY_TIMEOUT_MS } from '../model/timeouts';
import type { CliSendPhase, Contact } from '../model/types';
import { ANON_REQ_TYPE, PUSH, REQ_TYPE, RESP, STATS_TYPE, TXT_TYPE } from '../protocol/codes';
import {
  type AclEntry,
  type AvgMinMaxResult,
  buildGetStats,
  buildLogout,
  buildSendAnonReq,
  buildSendBinaryReq,
  buildSendLogin,
  buildSendStatusReq,
  buildSendTracePath,
  type LocalStats,
  type LoginSuccess,
  type NeighboursPage,
  type OwnerInfo,
  parseAclList,
  parseAnonOwnerInfo,
  parseAvgMinMax,
  parseBinaryResponse,
  parseLocalStats,
  parseLoginFail,
  parseLoginSuccess,
  parseNeighbours,
  parseRawData,
  parseStatusResponse,
  parseTelemetryLpp,
  parseTelemetryResponse,
  parseTraceData,
  type TraceData,
} from '../protocol/repeater';
import type { AdminMode, AdminRole } from './adminSessions';
import { encodeAddUpdateContact, encodeResetPath } from './contacts';
import * as directMessages from './directMessages';
import type { Feature, FeatureContext } from './feature';

/** How a repeater login was actually dispatched, so the UI can label the toast:
 *  `'direct'` (companion-side CMD_SEND_LOGIN), `'path'` (mesh-routed over a known
 *  out-path) or `'flood'` (mesh-routed, no path). */
export type RepeaterReachMode = 'direct' | 'flood' | 'path';

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
  const contact = ctx.state.getContact(contactKey);
  if (!contact) return { ok: false, error: `unknown contact ${contactKey}` };
  if (!contact.publicKeyHex || contact.publicKeyHex.length < 64) {
    return { ok: false, error: `contact ${contactKey} has no full 32B public key` };
  }
  return { ok: true, publicKeyHex: contact.publicKeyHex };
}

/** Write a pre-built request frame, park an admin RESP_SENT awaiter for the tag
 *  the firmware echoes, then resolve the matching PUSH_BINARY_RESPONSE body.
 *  Shared by CMD_SEND_BINARY_REQ (sendBinaryReq) and CMD_SEND_ANON_REQ
 *  (sendAnonReq) — both correlate their reply by the same tag seam.
 *
 *  `onSent` (optional) fires synchronously when RESP_SENT arrives, carrying the
 *  tag — sendAnonReq uses it to restore a flood contact's path the instant the
 *  packet is on its way (mirrors meshcore_py's reset-after-send).
 *
 *  Implementation note: `awaitTag` is registered synchronously inside the
 *  adminSentQueue resolver so that a PUSH_BINARY_RESPONSE arriving in the same
 *  synchronous turn as RESP_SENT (as happens in tests and under tight firmware
 *  timing) does not race past the awaiter registration. */
function sendTaggedReq(
  ctx: FeatureContext,
  frame: Buffer,
  timeoutMs: number,
  onSent?: (tagHex: string) => void,
): Promise<Buffer> {
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
        onSent?.(tagHex);
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

/** Generic mesh request (ACL / neighbours / avg-min-max, or any custom
 *  REQ_TYPE). Issues CMD_SEND_BINARY_REQ, parks an awaiter for the matching
 *  PUSH_BINARY_RESPONSE tag, and returns the response body (which the caller
 *  decodes per req_type). `reqData` is `[REQ_TYPE byte, ...params]`.
 *
 *  NOTE: this is the LOGIN/ACL-gated request family. Public repeaters answer
 *  OWNER / REGIONS / CLOCK only over the anon family — see sendAnonReq. */
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
  return sendTaggedReq(ctx, frame, timeoutMs);
}

/** Build the reverse reply-path an anon request must carry so the repeater can
 *  answer it DIRECT (anon OWNER/REGIONS/CLOCK are direct-only). The bytes are
 *  `[out_path_len][reversed out_path]` where `out_path_len` is the packed
 *  MeshCore path byte `((hashSize-1)<<6)|hopCount` — exactly what the repeater
 *  reads back (firmware handleAnon*Req: `*data & 63` hops, `(*data>>6)+1` size).
 *
 *  A flood contact (no out_path) yields the zero-hop reply `[0x00]`; the caller
 *  then temporarily gives the radio a zero-hop path so the send goes direct.
 *
 *  The route is reversed by HOP (hop order flipped, each hop's bytes kept in
 *  order), which is correct for every hash size and reduces to a plain byte
 *  reversal for the common 1-byte mode. (meshcore_py byte-reverses the whole
 *  path, which is only right for 1-byte hashes.) */
export function buildAnonReplyPath(contact: Pick<Contact, 'outPathHex' | 'outPathHashSize'>): {
  replyPath: Buffer;
  isFlood: boolean;
} {
  const pathHex = contact.outPathHex ?? '';
  if (pathHex.length === 0) {
    return { replyPath: Buffer.from([0x00]), isFlood: true };
  }
  const pathBytes = Buffer.from(pathHex, 'hex');
  const hashSize = contact.outPathHashSize ?? 1;
  const hopCount = Math.floor(pathBytes.length / hashSize);
  const reversed = Buffer.alloc(hopCount * hashSize);
  for (let h = 0; h < hopCount; h += 1) {
    const src = (hopCount - 1 - h) * hashSize;
    pathBytes.copy(reversed, h * hashSize, src, src + hashSize);
  }
  const packed = (((hashSize - 1) & 0x03) << 6) | (hopCount & 0x3f);
  return { replyPath: Buffer.concat([Buffer.from([packed]), reversed]), isFlood: false };
}

/** Public anon request (CMD_SEND_ANON_REQ, 0x39). Unlike sendBinaryReq this is
 *  NOT login-gated — it's how a client reads OWNER (0x02) / REGIONS (0x01) /
 *  CLOCK (0x03) from a repeater that serves them publicly. The repeater answers
 *  these only over a DIRECT route, so the app payload carries a reverse
 *  reply-path and, when the contact is flood-only, we temporarily install a
 *  zero-hop path on the radio so the request is sent direct, restoring flood
 *  afterwards (mirrors meshcore_py send_anon_req). Resolves the tagged
 *  PUSH_BINARY_RESPONSE body. */
export async function sendAnonReq(
  ctx: FeatureContext,
  contactKey: string,
  anonType: number,
  timeoutMs: number = ADMIN_REPLY_TIMEOUT_MS,
): Promise<Buffer> {
  const contact = ctx.state.getContact(contactKey);
  if (!contact) throw new Error(`unknown contact ${contactKey}`);
  if (!contact.publicKeyHex || contact.publicKeyHex.length < 64) {
    throw new Error(`contact ${contactKey} has no full 32B public key`);
  }
  const { replyPath, isFlood } = buildAnonReplyPath(contact);
  const data = Buffer.concat([Buffer.from([anonType & 0xff]), replyPath]);
  const frame = buildSendAnonReq(contact.publicKeyHex, data);

  // Restore a flood contact's path exactly once (on RESP_SENT, or as a
  // finally-net if the send never confirms) so no zero-hop path leaks.
  let restored = false;
  const restoreFlood = async (): Promise<void> => {
    if (!isFlood || restored) return;
    restored = true;
    try {
      await ctx.writeFrame(encodeResetPath(contact.publicKeyHex));
    } catch (err) {
      ctx.log.warn(`anon req: path reset failed for ${contactKey}: ${(err as Error).message}`);
    }
  };

  if (isFlood) {
    // Temporarily give the radio a zero-hop (empty) path so BaseChatMesh sends
    // this ANON_REQ DIRECT (out_path_len != OUT_PATH_UNKNOWN) — a flooded anon
    // OWNER/REGIONS/CLOCK is answered only with a path-return, never the data.
    await ctx.writeFrame(
      encodeAddUpdateContact({
        publicKeyHex: contact.publicKeyHex,
        advType: contactKindToAdvType(contact.kind),
        flags: contact.favourite ? 0x01 : 0x00,
        outPathHex: '',
        name: contact.name,
      }),
    );
  }
  try {
    return await sendTaggedReq(ctx, frame, timeoutMs, () => {
      void restoreFlood();
    });
  } finally {
    await restoreFlood();
  }
}

// ---- Public methods ----------------------------------------------------

/** Request a status snapshot from a repeater/room/contact. Returns ok on
 *  transport-level write; the actual `RepeaterStatusSnapshot` arrives later
 *  via PUSH_STATUS_RESPONSE → emit.repeaterStatus(). */
export async function sendStatusReq(ctx: FeatureContext, contactKey: string): Promise<{ ok: boolean; error?: string }> {
  const contact = ctx.state.getContact(contactKey);
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

/** Request a CayenneLPP telemetry blob from a contact. Returns `ok` once the
 *  request is accepted (contact validated + request fired); the decoded
 *  telemetry arrives asynchronously via the `repeaterTelemetry` event.
 *
 *  Uses CMD_SEND_BINARY_REQ(TELEMETRY=0x03) — the firmware deprecated the old
 *  CMD_SEND_TELEMETRY_REQ in its favour. The reply is now a tag-matched
 *  PUSH_BINARY_RESPONSE (raw LPP) instead of the standalone
 *  PUSH_TELEMETRY_RESPONSE, so we correlate it here and re-emit the SAME
 *  `repeaterTelemetry` snapshot shape consumers already handle. */
export async function sendTelemetryReq(ctx: FeatureContext, contactKey: string): Promise<{ ok: boolean; error?: string }> {
  const contact = ctx.state.getContact(contactKey);
  if (!contact) return { ok: false, error: `unknown contact ${contactKey}` };
  if (!contact.publicKeyHex || contact.publicKeyHex.length < 64) {
    return { ok: false, error: `contact ${contactKey} has no full 32B public key` };
  }
  sendBinaryReq(ctx, contactKey, Buffer.from([REQ_TYPE.GET_TELEMETRY_DATA]))
    .then((lpp) => emitTelemetryFromBinary(ctx, contactKey, lpp))
    .catch((err) => ctx.log.debug(`telemetry req for ${contactKey} failed: ${(err as Error).message}`));
  return { ok: true };
}

/** Decode a tag-matched telemetry LPP payload and emit `repeaterTelemetry` with
 *  the same snapshot shape as the PUSH_TELEMETRY_RESPONSE path. */
function emitTelemetryFromBinary(ctx: FeatureContext, contactKey: string, lpp: Buffer): void {
  const fields = parseTelemetryLpp(lpp);
  ctx.events.emit('repeaterTelemetry', {
    contactKey,
    receivedAt: Date.now(),
    payloadHex: lpp.toString('hex'),
    fields,
  });
  ctx.log.debug(`telemetry (binary) from "${contactKey}" payload=${lpp.length}B fields=${fields.length}`);
}

/** Login to a repeater. Always dispatched via CMD_SEND_LOGIN (0x1a): the radio
 *  routes it for us — DIRECT when the contact has a known route (including a
 *  known 0-hop route to a direct neighbour), FLOOD only when the `out_path` is
 *  unknown (out_path_len 0xFF) — so the one opcode covers Direct / Flood /
 *  N-hop. An empty `password` is a GUEST login (the flooded reply installs the
 *  out_path and adds us to the repeater's ACL). Success arrives later as
 *  PUSH_LOGIN_SUCCESS keyed on the recipient's pubkey prefix; failure as
 *  PUSH_LOGIN_FAIL.
 *
 *  `mode`/`effective` are UI labels derived from the contact's current path
 *  state (Direct / Flood / N-hop), not a second dispatch decision. */
export async function repeaterLogin(
  ctx: FeatureContext,
  contactKey: string,
  password: string,
): Promise<LoginSuccess & { mode: AdminMode; effective: RepeaterReachMode }> {
  const lookup = lookupRepeaterContact(ctx, contactKey);
  if (!lookup.ok) throw new Error(lookup.error);
  const contact = ctx.state.getContact(contactKey);
  const preferDirect = contact?.preferDirect === true;
  const mode: AdminMode = preferDirect ? 'local' : 'remote';
  // `contact.hops` is hopsFromOutPathLen(out_path_len): undefined for flood
  // (out_path_len 0xFF, meshcore_py's -1), 0 for a direct neighbour, >=1 for a
  // routed path. A known 0-hop route is DIRECT, not flood — flood is only the
  // unknown path.
  const effective: RepeaterReachMode = preferDirect
    ? 'direct'
    : contact?.hops === undefined
      ? 'flood' // out_path_len 0xFF == py's -1
      : contact.hops === 0
        ? 'direct' // known 0-hop route = direct
        : 'path';

  const prefix = lookup.publicKeyHex.slice(0, 12);
  const wait = ctx.admin.awaitLogin<LoginSuccess>(prefix, ADMIN_REPLY_TIMEOUT_MS);
  const frame = buildSendLogin(lookup.publicKeyHex, password);
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

/** Fetch a repeater's owner info. Uses the PUBLIC anon OWNER request (0x02), not
 *  the login-gated REQ_TYPE_GET_OWNER_INFO — so it works against a repeater that
 *  serves us without a login. The anon response is `name\nowner` (no firmware
 *  version), mapped into the existing OwnerInfo shape with an empty
 *  `firmwareVersion`. Returns null if the response can't be parsed. */
export async function repeaterRequestOwnerInfo(ctx: FeatureContext, contactKey: string): Promise<OwnerInfo | null> {
  const payload = await sendAnonReq(ctx, contactKey, ANON_REQ_TYPE.OWNER);
  return parseAnonOwnerInfo(payload);
}

/** Public anon REGIONS request (0x01). Resolves the repeater's region-name
 *  listing (the leading `now` clock + null padding are stripped). */
export async function requestRegions(ctx: FeatureContext, contactKey: string): Promise<string> {
  const payload = await sendAnonReq(ctx, contactKey, ANON_REQ_TYPE.REGIONS);
  const text = payload.subarray(4).toString('utf8');
  const nul = text.indexOf('\0');
  return nul === -1 ? text : text.slice(0, nul);
}

/** Public anon CLOCK/BASIC request (0x03). Resolves the repeater's RTC clock in
 *  unix seconds — the `now` field every anon response is prefixed with. */
export async function requestClock(ctx: FeatureContext, contactKey: string): Promise<number> {
  const payload = await sendAnonReq(ctx, contactKey, ANON_REQ_TYPE.BASIC);
  if (payload.length < 4) throw new Error('clock response too short');
  return payload.readUInt32LE(0);
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
  // bytes 9-10 reserved; firmware ignores the request if either is non-zero
  const payload = await sendBinaryReq(ctx, contactKey, reqData);
  const parsed = parseAvgMinMax(payload);
  if (!parsed) throw new Error('failed to parse avg/min/max response');
  return parsed;
}

/** Options for {@link repeaterSendCli}. */
export interface RepeaterCliOptions {
  /** Wait for the repeater's CLI reply. Default `true` — current behavior.
   *  Set `false` for commands the firmware never answers (`reboot`,
   *  `poweroff`, `clkreboot`, `start ota`): the handler reboots or powers down
   *  instead of writing a reply, and the firmware only transmits one when
   *  `strlen(reply) > 0`. Such a send registers no reply awaiter — it resolves
   *  `''` the moment the radio confirms the send (RESP_SENT) and rejects as
   *  soon as the send definitively fails. The timer it arms bounds that send
   *  confirmation rather than a reply, which is why the default drops from
   *  {@link CLI_REPLY_TIMEOUT_MS} to the much shorter
   *  {@link ADMIN_SENT_TIMEOUT_MS}. */
  expectReply?: boolean;
  /** Override the wait. Defaults to {@link CLI_REPLY_TIMEOUT_MS} when
   *  `expectReply` is true, {@link ADMIN_SENT_TIMEOUT_MS} when it is false. */
  timeoutMs?: number;
  /** Abort the awaiter; the promise rejects with `signal.reason`. The command
   *  may already be on the air — aborting drops our awaiter and frees the
   *  per-repeater slot, it does not recall the send. */
  signal?: AbortSignal;
}

/** Send a remote CLI command (e.g. "setperm <hex> 1", "discover.neighbors")
 *  as a text message with txt_type=CLI_DATA. The reply arrives as a normal
 *  RESP_CONTACT_MSG_RECV(_V3) with txt_type=CLI_DATA; the directMessages
 *  feature routes it back here (onCliReply) by sender prefix.
 *
 *  Only one CLI command may be outstanding per repeater — a second call
 *  supersedes the first. Callers that need queueing own it. */
export async function repeaterSendCli(
  ctx: FeatureContext,
  contactKey: string,
  command: string,
  opts: RepeaterCliOptions = {},
): Promise<string> {
  const { signal } = opts;
  if (signal?.aborted) throw signal.reason;
  const contact = lookupRepeaterContact(ctx, contactKey);
  if (!contact.ok) throw new Error(contact.error);

  const expectReply = opts.expectReply !== false;
  const timeoutMs = opts.timeoutMs ?? (expectReply ? CLI_REPLY_TIMEOUT_MS : ADMIN_SENT_TIMEOUT_MS);
  const prefix = contact.publicKeyHex.slice(0, 12);
  const pendingCli = ctx.rt.adminCorr.pendingCli;

  // Hoisted out of the executor (which runs synchronously) so the send path
  // below can settle the promise.
  let cleanup = (): void => {};
  let failWait = (_err: Error): void => {};
  let onSendState = (_state: CliSendPhase, _reason?: string): void => {};
  const wait = new Promise<string>((resolve, reject) => {
    let entry: PendingCli | undefined;
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          expectReply ? `CLI command timed out after ${timeoutMs}ms` : `CLI send was not confirmed after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
    const onAbort = (): void => {
      cleanup();
      reject(signal?.reason);
    };
    // Drop our awaiter and timers. Deliberately does NOT touch the DM send
    // FIFO: a RESP_SENT may still be in flight and must find its entry, or the
    // next real DM's 'sent' event is mis-attributed to this command.
    cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (entry && pendingCli.get(prefix) === entry) pendingCli.delete(prefix);
    };
    failWait = (err: Error): void => {
      cleanup();
      reject(err);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    // A fire-and-forget send settles on the DM send FIFO's own bookkeeping
    // instead — it registers no awaiter, so the single per-repeater slot stays
    // free for a command that does expect an answer. That also means nothing
    // else can settle it: resetAdmin has no pendingCli entry to reject, so a
    // definite failure has to arrive through here or the caller waits out the
    // whole timeout and is told the send "was not confirmed" — which is both
    // late and the wrong reason.
    onSendState = (state: CliSendPhase, reason?: string): void => {
      if (state === 'failed') {
        failWait(new Error(reason ? `CLI send failed: ${reason}` : 'CLI send failed'));
        return;
      }
      // 'ack' may still follow the resolve; resolve() is a no-op by then.
      if (state === 'sent') {
        cleanup();
        resolve('');
      }
    };
    if (!expectReply) return;

    const existing = pendingCli.get(prefix);
    if (existing) {
      clearTimeout(existing.timer);
      existing.reject(new Error('superseded by newer CLI command'));
    }
    entry = {
      pubKeyPrefixHex: prefix,
      resolve: (text) => {
        cleanup();
        resolve(text);
      },
      reject: (err) => {
        cleanup();
        reject(err);
      },
      timer,
    };
    pendingCli.set(prefix, entry);
  });

  const frame = directMessages.encodeSendDmText({
    destPublicKeyHex: contact.publicKeyHex,
    text: command,
    txtType: TXT_TYPE.CLI_DATA,
  });
  // CLI sends are still DMs at the wire level — take a DM send FIFO slot so
  // the RESP_SENT FIFO advances correctly. The id is synthetic and tagged as a
  // CLI send, so its progress reports on `cliSendState`, not `messageState`.
  const syntheticId = `cli-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  directMessages.enqueueCliSend(ctx, syntheticId, {
    contactKey,
    // Only a fire-and-forget send settles on the wire state; a reply-expecting
    // one must keep waiting for the repeater's answer.
    onState: expectReply ? undefined : onSendState,
  });
  // Fire the write off and hand `wait` straight back, the same shape
  // sendTaggedReq uses. Awaiting the write here would suspend before anything
  // has chained onto `wait`, so an abort / supersede / short timeout landing
  // inside the write window — a BLE GATT write or serial drain is milliseconds
  // wide — would reject a promise with no handler attached, which Node reports
  // as an unhandled rejection (fatal under its default
  // --unhandled-rejections=throw). The caller still sees the same rejection.
  ctx.writeFrame(frame).catch((err) => {
    // The radio won't reply with RESP_SENT, so pop the entry to keep the FIFO
    // aligned, and settle `wait` with the write error.
    directMessages.dequeueDmSend(ctx, syntheticId);
    failWait(err as Error);
  });
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
