import { Buffer } from 'node:buffer';
import type { Feature, FeatureContext } from '../feature';
import { CMD, PUSH, RESP } from '../protocol/codes';

// Backoff on the inbox-pump. The bridge's InboxRouter already serialises 0x0a
// across proxy clients; we issue our own 0x0a but pace ourselves so we don't
// starve concurrent phones.
const DRAIN_INTERVAL_MS = 250;

/** Per-session drain pump state (was the module-level drainBusy/drainPending).
 *  `busy` is cleared only on NO_MORE_MESSAGES — not after writeFrame returns —
 *  so the pump doesn't oversubscribe the radio. */
export interface DrainRuntime {
  busy: boolean;
  pending: boolean;
}

export function createDrainRuntime(): DrainRuntime {
  return { busy: false, pending: false };
}

// CMD_GET_NEXT_MSG drains the device's inbox queue by one. Replied to with
// RESP_CONTACT_MSG_RECV(_V3) / RESP_CHANNEL_MSG_RECV(_V3) / RESP_NO_MORE_MESSAGES.
export function encodeGetNextMsg(): Buffer {
  return Buffer.from([CMD.GET_NEXT_MSG]);
}

function isConnected(ctx: FeatureContext): boolean {
  return ctx.getTransportState() === 'connected';
}

/** True while a drain round is active. Message handlers gate their follow-up
 *  pump on this (`if (isDraining(ctx)) pumpAfterRecv(ctx)`). */
export function isDraining(ctx: FeatureContext): boolean {
  return ctx.rt.drain.busy;
}

/** Kick a drain round. If one is already active, mark a pending round so a
 *  single follow-up fires once the current round ends. */
export async function scheduleDrain(ctx: FeatureContext): Promise<void> {
  if (ctx.rt.drain.busy) {
    ctx.rt.drain.pending = true;
    return;
  }
  ctx.rt.drain.busy = true;
  await sleep(DRAIN_INTERVAL_MS);
  try {
    await ctx.writeFrame(encodeGetNextMsg());
  } catch (err) {
    ctx.log.warn(`drain write failed: ${(err as Error).message}`);
    ctx.rt.drain.busy = false;
    // No reply will come, so re-arm if another PUSH_MSG_WAITING raced in.
    if (ctx.rt.drain.pending) {
      ctx.rt.drain.pending = false;
      void scheduleDrain(ctx);
    }
  }
}

/** Called from the message handlers after a drain returned a message. Issues
 *  the next GET_NEXT_MSG immediately so we keep draining until the device says
 *  NO_MORE_MESSAGES. */
export function pumpAfterRecv(ctx: FeatureContext): void {
  if (!isConnected(ctx)) return;
  ctx.writeFrame(encodeGetNextMsg()).catch((err) => {
    ctx.log.warn(`drain pump write failed: ${(err as Error).message}`);
    ctx.rt.drain.busy = false;
  });
}

/** Clear pump state on disconnect so a reconnect starts a fresh drain cycle. */
export function resetDrain(ctx: FeatureContext): void {
  ctx.rt.drain.busy = false;
  ctx.rt.drain.pending = false;
}

export const drainFeature: Feature = {
  handles: [PUSH.MSG_WAITING, RESP.NO_MORE_MESSAGES],
  handle: (code, _frame, ctx) => {
    if (code === PUSH.MSG_WAITING) {
      void scheduleDrain(ctx);
      return;
    }
    // RESP.NO_MORE_MESSAGES — the drain round is complete.
    ctx.rt.drain.busy = false;
    ctx.log.trace('drain done: NO_MORE_MESSAGES');
    if (ctx.rt.drain.pending) {
      ctx.rt.drain.pending = false;
      void scheduleDrain(ctx);
    }
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
