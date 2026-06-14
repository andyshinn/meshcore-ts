import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it } from 'vitest';
import { deliver, makeSession } from '../../support/harness';

// PUSH_NEW_ADVERT (0x8a) carries a full 148-byte contact record — same layout
// as RESP_CONTACT, only the code byte differs.
function advertFrame(pubkeyHex: string, name: string): Buffer {
  const frame = Buffer.alloc(148);
  frame[0] = 0x8a;
  Buffer.from(pubkeyHex, 'hex').copy(frame, 1);
  frame[33] = 1; // type = chat
  frame[35] = 0xff; // out_path_len = direct
  Buffer.from(name, 'utf8').copy(frame, 100);
  return frame;
}

const PUBKEY = 'cc'.repeat(32);

describe('inbound PUSH_NEW_ADVERT discovery', () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  it('emits contactDiscovered the first time a pubkey is heard', () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();

    const discovered: Array<{ key: string; name: string; kind: string }> = [];
    session.events.on('contactDiscovered', (c: { key: string; name: string; kind: string }) => discovered.push(c));

    deliver(transport, advertFrame(PUBKEY, 'Carol'));

    expect(discovered).toEqual([{ key: `c:${PUBKEY}`, name: 'Carol', kind: 'chat' }]);
  });

  it('does not emit on a re-advert of a known pubkey', () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();

    const discovered: unknown[] = [];
    session.events.on('contactDiscovered', (c) => discovered.push(c));

    deliver(transport, advertFrame(PUBKEY, 'Carol')); // first → emits
    deliver(transport, advertFrame(PUBKEY, 'Carol')); // second → silent
    expect(discovered).toHaveLength(1);
  });
});
