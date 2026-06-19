import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it } from 'vitest';
import type { Models } from '../../../src/index.js';
import { deliver, makeSession } from '../../support/harness';

// RESP_CONTACT (0x03) and PUSH_NEW_ADVERT (0x8a) share the 148-byte record
// layout — only the leading code byte differs.
function contactRecordFrame(code: number, pubkeyHex: string, name: string): Buffer {
  const frame = Buffer.alloc(148);
  frame[0] = code;
  Buffer.from(pubkeyHex, 'hex').copy(frame, 1);
  frame[33] = 1; // type = chat
  frame[35] = 0xff; // out_path_len = direct
  Buffer.from(name, 'utf8').copy(frame, 100);
  return frame;
}

const startFrame = (total: number): Buffer => {
  const f = Buffer.alloc(5);
  f[0] = 0x02; // RESP_CONTACTS_START
  f.writeUInt32LE(total, 1);
  return f;
};
const endFrame = Buffer.from([0x04, 0x00, 0x00, 0x00, 0x00]); // RESP_END_OF_CONTACTS

const SYNC_PK = 'a1'.repeat(32);
const ADVERT_PK = 'cc'.repeat(32);

describe('inbound contactObserved bus event', () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  it('fires for sync (RESP_CONTACT) then advert (PUSH_NEW_ADVERT) ingestion', () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();

    const observed: Array<{ record: Models.ContactRecord; source: Models.ContactSource }> = [];
    session.events.on('contactObserved', (record: Models.ContactRecord, source: Models.ContactSource) =>
      observed.push({ record, source }),
    );

    // sync: a RESP_CONTACT delivered during the GET_CONTACTS handshake
    deliver(transport, startFrame(1));
    deliver(transport, contactRecordFrame(0x03, SYNC_PK, 'Alice'));
    deliver(transport, endFrame);

    // advert: a live PUSH_NEW_ADVERT
    deliver(transport, contactRecordFrame(0x8a, ADVERT_PK, 'Carol'));

    expect(observed).toHaveLength(2);
    expect(observed[0].source).toBe('sync');
    expect(observed[0].record).toMatchObject({ publicKeyHex: SYNC_PK, name: 'Alice' });
    expect(observed[1].source).toBe('advert');
    expect(observed[1].record).toMatchObject({ publicKeyHex: ADVERT_PK, name: 'Carol' });
  });
});
