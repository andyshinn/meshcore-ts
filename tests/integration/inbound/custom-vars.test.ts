import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { deliver, makeSession } from '../../support/harness';

describe('RESP_CUSTOM_VARS handled via the feature registry', () => {
  it('folds gps + gps_interval into GpsConfig and emits gpsConfig', async () => {
    const { session, transport } = makeSession();
    const seen: { enabled?: boolean; intervalSec?: number }[] = [];
    const onGps = (c: { enabled?: boolean; intervalSec?: number }) => seen.push(c);
    session.events.on('gpsConfig', onGps);

    deliver(transport, Buffer.from([0x15, ...Buffer.from('gps:1\ngps_interval:45', 'utf8')]));
    await Promise.resolve();
    session.events.off('gpsConfig', onGps);

    expect(seen.at(-1)).toEqual({ enabled: true, intervalSec: 45 });
    expect(session.state.getGpsConfig().intervalSec).toBe(45);
  });
});
