import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it } from 'vitest';
import { deliver, makeSession } from '../../support/harness';

// The ingest path is a router: (1) solicited typed replies, (2) the feature
// registry, (3) the shared RESP_OK/RESP_ERR ack channel. Any code that matches
// none of those is a deliberate no-op — these tests pin that contract so a
// future "default: throw" can't silently break unknown frames.
describe('inbound dispatch contract', () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  it('ignores an unclaimed code without throwing and keeps dispatching after', () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();

    // 0x7e is owned by no feature and is not RESP_OK/RESP_ERR.
    expect(() => deliver(transport, Buffer.from([0x7e, 0x01, 0x02]))).not.toThrow();

    // A not-yet-implemented RESP (EXPORT_CONTACT 0x0b) is also a safe no-op.
    expect(() => deliver(transport, Buffer.from([0x0b, 0x00]))).not.toThrow();

    // The session still routes a real frame afterwards: a channel message for a
    // known slot lands in the store.
    session.markChannelPresent({ key: 'ch:General', name: 'General', kind: 'public', idx: 0 });
    const body = Buffer.from('Alice: hi', 'utf8');
    const chMsg = Buffer.alloc(11 + body.length);
    chMsg[0] = 0x11; // RESP_CHANNEL_MSG_RECV_V3
    chMsg[4] = 0; // idx
    chMsg[5] = 0xff; // direct
    chMsg.writeUInt32LE(1_700_000_000, 7);
    body.copy(chMsg, 11);
    deliver(transport, chMsg);

    expect(session.state.getMessagesForKey('ch:General')).toHaveLength(1);
  });

  it('ignores an inbound frame with no code (empty buffer)', () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();
    // PORT NOTE: the donor delivered a synthetic companion RawPacket with
    // code:undefined. In this library the ingest path parses the code from the
    // raw frame bytes, so the equivalent "no code" frame is an empty buffer.
    expect(() => deliver(transport, Buffer.alloc(0))).not.toThrow();
  });
});
