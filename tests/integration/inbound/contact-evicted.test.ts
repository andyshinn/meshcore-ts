import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it } from 'vitest';
import { deliver, makeSession } from '../../support/harness';

const PUBKEY = 'bb'.repeat(32);

function contactDeletedFrame(pubkeyHex: string): Buffer {
  const frame = Buffer.alloc(1 + 32);
  frame[0] = 0x8f; // PUSH_CODE_CONTACT_DELETED
  Buffer.from(pubkeyHex, 'hex').copy(frame, 1);
  return frame;
}

describe('inbound PUSH_CONTACT_DELETED', () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  it('removes the contact and emits contactEvicted with its name', () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    session.state.discovered.upsert(
      {
        publicKeyHex: PUBKEY,
        type: 1,
        flags: 0,
        outPathLen: 0xff,
        outPathHex: '',
        name: 'Bob',
        lastAdvertUnix: 0,
        gpsLat: 0,
        gpsLon: 0,
        lastmod: 0,
      },
      { onRadio: true, nowMs: 1_700_000_000_000, heardLive: false },
    );

    const evicted: string[] = [];
    session.events.on('contactEvicted', (name: string) => evicted.push(name));

    deliver(transport, contactDeletedFrame(PUBKEY));

    expect(evicted).toEqual(['Bob']);
    expect(session.state.discovered.get(PUBKEY)?.on_radio).toBe(0);
  });
});
