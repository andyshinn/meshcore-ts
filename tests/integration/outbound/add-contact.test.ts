import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it } from 'vitest';
import { Errors } from '../../../src/index.js';
import { deliver, makeSession } from '../../support/harness.js';

const PUBKEY = 'aa'.repeat(32);

function seedDiscovered(session: ReturnType<typeof makeSession>['session']): void {
  session.state.discovered.upsert(
    {
      publicKeyHex: PUBKEY,
      type: 1,
      flags: 0,
      outPathLen: 0xff,
      outPathHex: '',
      name: 'Alice',
      lastAdvertUnix: 0,
      gpsLat: 0,
      gpsLon: 0,
      lastmod: 0,
    },
    { onRadio: false, nowMs: 1_700_000_000_000, heardLive: true },
  );
}

describe('addContactToRadio reply handling', () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  it('commits the contact on RESP_OK', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    seedDiscovered(session);

    const p = session.addContactToRadio(PUBKEY);
    await Promise.resolve(); // ack entry is pre-registered synchronously; yield once so writeFrame starts before we reply
    deliver(transport, Buffer.from([0x00])); // RESP_OK
    await p;

    expect(session.state.discovered.get(PUBKEY)?.on_radio).toBe(1);
  });

  it('rejects with Errors.ContactTableFullError on RESP_ERR[0x03], leaving on_radio unset', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    seedDiscovered(session);

    const p = session.addContactToRadio(PUBKEY);
    await Promise.resolve();
    deliver(transport, Buffer.from([0x01, 0x03])); // RESP_ERR + ERR_CODE_TABLE_FULL
    await expect(p).rejects.toBeInstanceOf(Errors.ContactTableFullError);

    expect(session.state.discovered.get(PUBKEY)?.on_radio).toBe(0);
  });

  it('rejects generically on a bare RESP_ERR (no error code)', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    seedDiscovered(session);

    const p = session.addContactToRadio(PUBKEY);
    await Promise.resolve();
    deliver(transport, Buffer.from([0x01])); // bare RESP_ERR
    await expect(p).rejects.toThrow(/did not confirm/i);
    await expect(p).rejects.not.toBeInstanceOf(Errors.ContactTableFullError);

    expect(session.state.discovered.get(PUBKEY)?.on_radio).toBe(0);
  });
});
