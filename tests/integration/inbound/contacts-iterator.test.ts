import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it } from 'vitest';
import { deliver, makeSession } from '../../support/harness';

// RESP_CONTACT (0x03) carries a full 148-byte record (same layout as
// PUSH_NEW_ADVERT, only the code byte differs).
function contactFrame(pubkeyHex: string, name: string): Buffer {
  const frame = Buffer.alloc(148);
  frame[0] = 0x03;
  Buffer.from(pubkeyHex, 'hex').copy(frame, 1);
  frame[33] = 1; // type = chat
  frame[35] = 0xff; // out_path_len = direct
  Buffer.from(name, 'utf8').copy(frame, 100);
  return frame;
}

const startFrame = (total: number) => {
  const f = Buffer.alloc(5);
  f[0] = 0x02; // RESP_CONTACTS_START
  f.writeUInt32LE(total, 1);
  return f;
};
const endFrame = Buffer.from([0x04, 0x00, 0x00, 0x00, 0x00]); // RESP_END_OF_CONTACTS

describe('inbound contacts iterator via the feature registry + contactsSync bridge', () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  it('drives syncProgress 0/2 → 1/2 → 2/2 → 2/2 and surfaces both contacts', () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();

    const progress: Array<{ done: number; total: number }> = [];
    const onProgress = (p: { contacts: { done: number; total: number } }) => progress.push({ ...p.contacts });
    session.events.on('syncProgress', onProgress);
    let lastContacts: Array<{ key: string }> = [];
    const onContacts = (c: Array<{ key: string }>) => {
      lastContacts = c;
    };
    session.events.on('contacts', onContacts);

    const pkA = 'a1'.repeat(32);
    const pkB = 'b2'.repeat(32);

    deliver(transport, startFrame(2));
    deliver(transport, contactFrame(pkA, 'Alice'));
    deliver(transport, contactFrame(pkB, 'Bob'));
    deliver(transport, endFrame);

    session.events.off('syncProgress', onProgress);
    session.events.off('contacts', onContacts);

    // The contactsSync bridge must reproduce the legacy handler's progress
    // transitions exactly: start(0/total) → per-contact(done/total) → end-snap.
    expect(progress).toEqual([
      { done: 0, total: 2 },
      { done: 1, total: 2 },
      { done: 2, total: 2 },
      { done: 2, total: 2 },
    ]);
    const keys = lastContacts.map((c) => c.key);
    expect(keys).toContain(`c:${pkA}`);
    expect(keys).toContain(`c:${pkB}`);
  });

  it('self-heals when more contacts arrive than CONTACTS_START promised', () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();

    const progress: Array<{ done: number; total: number }> = [];
    const onProgress = (p: { contacts: { done: number; total: number } }) => progress.push({ ...p.contacts });
    session.events.on('syncProgress', onProgress);

    deliver(transport, startFrame(1)); // radio promises 1
    deliver(transport, contactFrame('a1'.repeat(32), 'Alice'));
    deliver(transport, contactFrame('b2'.repeat(32), 'Bob')); // but sends 2
    deliver(transport, endFrame);

    session.events.off('syncProgress', onProgress);

    // total bumps to 2 once count exceeds the promised 1 — never "2/1".
    expect(progress).toEqual([
      { done: 0, total: 1 },
      { done: 1, total: 1 },
      { done: 2, total: 2 },
      { done: 2, total: 2 },
    ]);
  });
});
