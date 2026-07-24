import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { Channel, MessageHop, MessagePath } from './types';

// PATH_HASH_SIZE = 1 in firmware MeshCore.h — every channel publishes only the
// first byte of sha256(secret) on the wire so receivers can route GRP_TXT
// without learning the secret.
export function channelHashOf(channel: Channel): number | null {
  if (!channel.secretHex) return null;
  const secret = Buffer.from(channel.secretHex, 'hex');
  if (secret.length === 0) return null;
  return createHash('sha256').update(secret).digest()[0];
}

/** Build the display path for one flood reception: a synthesized `origin`, one
 *  `hop` per on-air path hash, and a synthesized `sink` (our radio).
 *
 *  `pathHex` holds only the repeaters that relayed the packet — the firmware
 *  appends one hash per forward, and neither endpoint writes itself in — so the
 *  two endpoints here exist only for rendering and `hops.length` runs two above
 *  the radio hop count. See MessagePath in ./types.
 *
 *  `senderName` may equal `ownerName`: PendingChannelSends calls this for a
 *  repeater rebroadcast of our OWN send that our radio overheard, which is
 *  genuinely a me → repeater(s) → me round trip. Both endpoints then derive the
 *  same `shortId` from the owner name, so renderers must key on array position
 *  or `kind`, not `shortId`, or they'll collapse the two ends into one node. */
export function buildPath(
  pathHex: string,
  hashSize: number,
  finalSnr: number,
  senderName: string | null,
  ownerName: string | undefined,
): MessagePath {
  const hops: MessageHop[] = [];
  hops.push({
    kind: 'origin',
    shortId: senderName ? senderName.slice(0, 2).toLowerCase() : '??',
    name: senderName ?? null,
    pk: null,
    unnamed: senderName == null,
  });
  for (let i = 0; i < pathHex.length; i += hashSize * 2) {
    const shortId = pathHex.slice(i, i + hashSize * 2);
    hops.push({ kind: 'hop', shortId, name: null, pk: null, unnamed: true });
  }
  hops.push({
    kind: 'sink',
    shortId: ownerName ? ownerName.slice(0, 2).toLowerCase() : 'me',
    name: ownerName ?? 'My radio',
    pk: null,
  });
  return {
    id: createHash('sha1').update(`${pathHex}|${hashSize}`).digest('hex').slice(0, 16),
    hops,
    hashMode: hashSize,
    finalSnr,
  };
}
