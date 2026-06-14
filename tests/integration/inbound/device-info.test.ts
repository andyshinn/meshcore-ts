import { afterEach, describe, expect, it } from 'vitest';
import { frameBuf } from '../../support/frames';
import { deliver, makeSession } from '../../support/harness';

describe('RESP_DEVICE_INFO handled via the feature registry', () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  it('folds firmware info into device state and emits deviceInfo + deviceCapabilities', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();

    const info: { firmwareVerCode?: number }[] = [];
    const caps: { repeatMode?: boolean; identityKeyIO?: boolean }[] = [];
    const onInfo = (d: { firmwareVerCode?: number }) => info.push(d);
    const onCaps = (c: { repeatMode?: boolean; identityKeyIO?: boolean }) => caps.push(c);
    session.events.on('deviceInfo', onInfo);
    session.events.on('deviceCapabilities', onCaps);

    deliver(transport, frameBuf('deviceInfo'));
    await Promise.resolve();
    session.events.off('deviceInfo', onInfo);
    session.events.off('deviceCapabilities', onCaps);

    expect(info.at(-1)?.firmwareVerCode).toBe(0x0b);
    expect(caps.at(-1)?.repeatMode).toBe(true); // ver 11 >= 9
    expect(caps.at(-1)?.identityKeyIO).toBe(false); // ver 11 < 25
    expect(session.state.getDeviceInfo().maxContacts).toBe(0xaf * 2);
  });
});
