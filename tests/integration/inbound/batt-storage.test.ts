import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it } from 'vitest';
import { deliver, makeSession } from '../../support/harness';

describe('RESP_BATT_AND_STORAGE handled via the feature registry', () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  it('folds battery + storage into device info and emits deviceInfo', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();

    const emitted: { batteryMv?: number; storageUsedKb?: number }[] = [];
    const onInfo = (info: { batteryMv?: number; storageUsedKb?: number }) => {
      emitted.push(info);
    };
    session.events.on('deviceInfo', onInfo);

    deliver(transport, Buffer.from([0x0c, 0x10, 0x0e, 0x00, 0x01, 0x00, 0x00, 0x00, 0x10, 0x00, 0x00]));
    await Promise.resolve();
    session.events.off('deviceInfo', onInfo);

    expect(emitted.at(-1)?.batteryMv).toBe(3600);
    expect(emitted.at(-1)?.storageUsedKb).toBe(256);
    expect(session.state.getDeviceInfo().storageTotalKb).toBe(4096);
  });
});
