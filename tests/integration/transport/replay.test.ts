import { afterEach, describe, expect, it } from 'vitest';
import { frameBuf, frameHex } from '../../support/frames.js';
import { deliver, makeSession } from '../../support/harness.js';

// PORT NOTE: the donor exercised a `FileReplayTransport` class that loaded a
// JSON array of frames and re-emitted each onto the global bus as a companion /
// mesh RawPacket, asserting the parsed `code`/`kind`/`payloadHex`. This library
// has no FileReplayTransport; the equivalent is to load the captured fixture
// frames (the same JSON shape the donor replayed) and `deliver()` each through a
// real LoopbackTransport into a real MeshCoreSession, then assert the resulting
// session.state / session.events — i.e. that a recorded connect session, replayed
// frame-by-frame, drives the same observable end state as a live one.
describe('fixture-frame replay drives session state', () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  it('replays the captured connect-session frames and folds them into state + events', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();

    const owners: ({ name?: string; publicKeyHex?: string } | null)[] = [];
    const deviceInfos: { firmwareVerCode?: number }[] = [];
    session.events.on('owner', (o) => owners.push(o));
    session.events.on('deviceInfo', (d) => deviceInfos.push(d));

    // The captured frames, in capture order: RESP_DEVICE_INFO (0x0d),
    // RESP_SELF_INFO (0x05), then a raw mesh packet (0x88 PUSH_LOG_RX_DATA).
    for (const name of ['deviceInfo', 'selfInfo', 'meshPacketRaw'] as const) {
      deliver(transport, frameBuf(name));
    }
    await Promise.resolve();

    // RESP_SELF_INFO → owner identity is surfaced + emitted.
    expect(session.state.getOwner()?.publicKeyHex).toBe('1a3d3c6a09f057457bcf0ae5403e5c60072919d193ed8caff58501b7590dd5d5');
    expect(session.state.getOwner()?.name).toContain('Hand');
    expect(owners.at(-1)?.publicKeyHex).toBe('1a3d3c6a09f057457bcf0ae5403e5c60072919d193ed8caff58501b7590dd5d5');

    // RESP_DEVICE_INFO → firmware info folded into device state + emitted.
    expect(session.state.getDeviceInfo().maxContacts).toBe(0xaf * 2);
    expect(deviceInfos.at(-1)?.firmwareVerCode).toBe(0x0b);

    // The 0x88 mesh packet (a non-companion frame) is recorded as a flood
    // observation rather than routed through the companion handlers, and it must
    // not disturb the companion-driven state above.
    expect(session.state.getOwner()?.name).toContain('Hand');
  });

  it('replaying the same frames is a no-op past the first pass (idempotent end state)', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();

    const names = ['deviceInfo', 'selfInfo'] as const;
    for (const name of names) deliver(transport, frameBuf(name));
    await Promise.resolve();
    const ownerAfterFirst = session.state.getOwner()?.publicKeyHex;

    for (const name of names) deliver(transport, frameBuf(name));
    await Promise.resolve();

    expect(session.state.getOwner()?.publicKeyHex).toBe(ownerAfterFirst);
    // The fixture hex is the actual companion frame the library re-parses on
    // each replay; sanity-check the loader round-trips the leading code byte.
    expect(frameHex('selfInfo').slice(0, 2)).toBe('05');
    expect(frameHex('deviceInfo').slice(0, 2)).toBe('0d');
  });
});
