import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import type { Models } from '../../../src/index.js';
import { frameBuf } from '../../support/frames';
import { deliver, makeSession } from '../../support/harness';

/** The captured RESP_SELF_INFO with byte 47 (`_prefs.manual_add_contacts`) rewritten.
 *  The fixture itself reports 0; frameBuf decodes a fresh Buffer per call. */
function selfInfoWithManualAdd(manualAddContacts: number): Buffer {
  const frame = frameBuf('selfInfo');
  frame[47] = manualAddContacts;
  return frame;
}

describe('RESP_SELF_INFO handled via the feature registry', () => {
  it('surfaces the radio identity as the app Owner and emits owner', async () => {
    const { session, transport } = makeSession();

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

  it('adopts the radio manual-add pref from byte 47 without clobbering the auto-add flags', async () => {
    const { session, transport } = makeSession();

    // Prime the kind flags from the radio first, so the byte-47 fold is visibly a
    // merge into AutoAddConfig rather than a wholesale replace.
    deliver(transport, Buffer.from([0x19, 0x06])); // RESP_AUTOADD_CONFIG: chat(0x02)|repeater(0x04)
    await Promise.resolve();

    const seen: Models.AutoAddConfig[] = [];
    const onCfg = (c: Models.AutoAddConfig) => seen.push(c);
    session.events.on('autoAddConfig', onCfg);

    deliver(transport, selfInfoWithManualAdd(1));
    await Promise.resolve();
    session.events.off('autoAddConfig', onCfg);

    expect(session.state.getAutoAddConfig().manualAddContacts).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen.at(-1)?.manualAddContacts).toBe(1);
    expect(seen.at(-1)?.chat).toBe(true);
    expect(seen.at(-1)?.repeater).toBe(true);
    expect(seen.at(-1)?.overwriteOldest).toBe(false);
  });

  it('emits autoAddConfig only when byte 47 differs from the value already held', async () => {
    const { session, transport } = makeSession();

    const seen: Models.AutoAddConfig[] = [];
    const onCfg = (c: Models.AutoAddConfig) => seen.push(c);
    session.events.on('autoAddConfig', onCfg);

    // 0 is the default already in state — nothing changed, so nothing is emitted.
    deliver(transport, selfInfoWithManualAdd(0));
    await Promise.resolve();
    expect(seen).toHaveLength(0);

    deliver(transport, selfInfoWithManualAdd(1));
    await Promise.resolve();
    expect(seen).toHaveLength(1);

    // A repeated getSelfInfo() carrying the same pref must not re-fire the event.
    deliver(transport, selfInfoWithManualAdd(1));
    await Promise.resolve();
    session.events.off('autoAddConfig', onCfg);

    expect(seen).toHaveLength(1);
    expect(session.state.getAutoAddConfig().manualAddContacts).toBe(1);
  });
});
