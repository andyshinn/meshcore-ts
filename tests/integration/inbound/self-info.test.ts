import { afterEach, describe, expect, it } from 'vitest';
import { frameBuf } from '../../support/frames';
import { deliver, makeSession } from '../../support/harness';

describe('RESP_SELF_INFO handled via the feature registry', () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  it('surfaces the radio identity as the app Owner and emits owner', async () => {
    const { session, transport } = makeSession();
    stop = () => session.stop();

    const owners: { name?: string; publicKeyHex?: string; publicKeyShort?: string }[] = [];
    const onOwner = (o: { name?: string; publicKeyHex?: string; publicKeyShort?: string } | null) => {
      if (o) owners.push(o);
    };
    session.events.on('owner', onOwner);

    deliver(transport, frameBuf('selfInfo'));
    await Promise.resolve();
    session.events.off('owner', onOwner);

    expect(owners.at(-1)?.publicKeyHex).toBe('1a3d3c6a09f057457bcf0ae5403e5c60072919d193ed8caff58501b7590dd5d5');
    expect(owners.at(-1)?.publicKeyShort).toBe('1a3d3c6a09f0');
    expect(session.state.getOwner()?.name).toContain('Hand');
  });
});
