// Write-order stamps for the companion protocol's immediate replies.
//
// RESP_SENT and RESP_ERR carry no correlation id: the firmware answers each
// command synchronously, in the order the commands arrived, so the only way to
// pair a reply with its request is that order. The session keeps one awaiter
// queue per reply family (the RESP_OK/ERR ack FIFO, typed-reply waiters, the
// admin RESP_SENT FIFO, the DM send FIFO, getContactByKey lookups). Each entry
// takes a stamp from this one per-session counter when it is queued, which is
// immediately before its frame is written. When a RESP_SENT or RESP_ERR could
// belong to more than one queue, the entry with the smallest stamp sent the
// oldest command still waiting for an answer, so it owns the reply.

/** Per-session write-order counter. */
export interface ReplyOrderRuntime {
  next: number;
}

export function createReplyOrderRuntime(): ReplyOrderRuntime {
  return { next: 0 };
}

/** Take the next write-order stamp. Call it in the same synchronous turn as
 *  the writeFrame() it stamps, so stamp order matches wire order. */
export function nextReplySeq(ctx: { rt: { replyOrder: ReplyOrderRuntime } }): number {
  const seq = ctx.rt.replyOrder.next;
  ctx.rt.replyOrder.next += 1;
  return seq;
}

/** The smallest stamp among queue heads, ignoring empty queues. */
export function oldestSeq(...seqs: Array<number | undefined>): number | undefined {
  let min: number | undefined;
  for (const s of seqs) {
    if (s !== undefined && (min === undefined || s < min)) min = s;
  }
  return min;
}
