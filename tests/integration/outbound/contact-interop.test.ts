import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it } from 'vitest';
import { Errors } from '../../../src/index.js';
import { deliver, makeSession } from '../../support/harness.js';

const PK = 'aa'.repeat(32);
const RESP_OK = Buffer.from([0x00]);
const RESP_ERR_NOT_FOUND = Buffer.from([0x01, 0x02]);
const flush = () => new Promise((r) => setTimeout(r, 0));
const sentHex = (t: { sent: Uint8Array[] }) => Buffer.from(t.sent.at(-1) ?? Buffer.alloc(0)).toString('hex');

// A full 148-byte RESP_CONTACT frame for the given pubkey.
function respContact(pkHex: string, name: string): Buffer {
  const f = Buffer.alloc(148);
  f[0] = 0x03;
  Buffer.from(pkHex, 'hex').copy(f, 1);
  f[33] = 1; // type: chat
  f[35] = 0; // out_path_len
  Buffer.from(name, 'utf8').copy(f, 100);
  f.writeUInt32LE(1000, 132); // last_advert
  f.writeUInt32LE(2000, 144); // lastmod
  return f;
}

describe('outbound contact interop', () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  it('shareContact writes [0x10][pubkey] and resolves on RESP_OK', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    const p = session.shareContact(PK);
    expect(sentHex(transport)).toBe(`10${PK}`);
    deliver(transport, RESP_OK);
    await expect(p).resolves.toBeUndefined();
  });

  it('exportContact (self) returns the blob from RESP_EXPORT_CONTACT', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    const p = session.exportContact();
    await flush();
    expect(sentHex(transport)).toBe('11'); // bare opcode = export self
    const blob = 'bb'.repeat(50);
    deliver(transport, Buffer.concat([Buffer.from([0x0b]), Buffer.from(blob, 'hex')]));
    expect(await p).toBe(blob);
  });

  it('exportContact returns null on RESP_ERR (contact not found)', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    const p = session.exportContact(PK);
    await flush();
    deliver(transport, RESP_ERR_NOT_FOUND);
    expect(await p).toBeNull();
  });

  it('importContact writes [0x12][blob] and rejects Errors.ProtocolError on RESP_ERR', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    const blob = 'cc'.repeat(98);
    const p = session.importContact(blob);
    expect(sentHex(transport)).toBe(`12${blob}`);
    deliver(transport, RESP_ERR_NOT_FOUND);
    await expect(p).rejects.toBeInstanceOf(Errors.ProtocolError);
  });

  it('getContactByKey resolves the record from RESP_CONTACT without touching the sync', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    // PORT NOTE: the donor listened on the global bus's `contactsSync` signal and
    // asserted 0 emissions. In this library `contactsSync` is an internal
    // FeatureContext callback (not a public event), and the bulk-sync iterator's
    // observable side effect is folding the contact into state + emitting
    // `contacts`. So the equivalent "didn't touch the sync" assertion is that the
    // solicited reply is consumed by getContactByKey and NOT added to the contact
    // store, and no `contacts` event fires.
    const contactsEmissions: unknown[] = [];
    const onContacts = (c: unknown) => contactsEmissions.push(c);
    session.events.on('contacts', onContacts);
    try {
      const p = session.getContactByKey(PK);
      await flush();
      expect(sentHex(transport)).toBe(`1e${PK}`);
      deliver(transport, respContact(PK, 'Alice'));
      const rec = await p;
      expect(rec?.publicKeyHex).toBe(PK);
      expect(rec?.name).toBe('Alice');
      expect(session.state.getContacts()).toHaveLength(0); // not folded into the bulk-sync iterator
      expect(contactsEmissions).toHaveLength(0);
    } finally {
      session.events.off('contacts', onContacts);
    }
  });

  it('getContactByKey resolves null on RESP_ERR (not found)', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    const p = session.getContactByKey(PK);
    await flush();
    deliver(transport, RESP_ERR_NOT_FOUND);
    expect(await p).toBeNull();
  });
});
