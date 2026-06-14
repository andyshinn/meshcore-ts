import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it } from 'vitest';
import { deliver, makeSession } from '../../support/harness';

describe('RESP_AUTOADD_CONFIG folds the flags byte into auto-add config', () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  it('maps the flags byte into auto-add config and emits autoAddConfig', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();

    const seen: Array<{ chat: boolean; repeater: boolean; overwriteOldest: boolean }> = [];
    const onCfg = (c: { chat: boolean; repeater: boolean; overwriteOldest: boolean }) => {
      seen.push(c);
    };
    session.events.on('autoAddConfig', onCfg);

    deliver(transport, Buffer.from([0x19, 0x06])); // chat(0x02)|repeater(0x04)
    await Promise.resolve();
    session.events.off('autoAddConfig', onCfg);

    const cfg = seen.at(-1);
    expect(cfg?.chat).toBe(true);
    expect(cfg?.repeater).toBe(true);
    expect(cfg?.overwriteOldest).toBe(false);
  });
});
