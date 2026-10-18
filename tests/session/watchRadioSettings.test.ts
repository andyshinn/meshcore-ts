import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { MeshCoreSession, Transports } from '../../src/index.js';

const CMD_GET_CUSTOM_VAR = 0x28;
const RESP_CUSTOM_VARS_HEX = (text: string) => `15${Buffer.from(text).toString('hex')}`;
const getVars = (t: Transports.Loopback): number => t.sent.filter((f) => f[0] === CMD_GET_CUSTOM_VAR).length;

/** Connected session whose handshake has been left to time out, so the sync
 *  lock is free and polls are allowed to run. */
async function settledSession(): Promise<{ session: MeshCoreSession; transport: Transports.Loopback }> {
  const transport = new Transports.Loopback();
  transport.setState('connected');
  const session = new MeshCoreSession({ transport });
  session.start();
  onTestFinished(() => session.stop());
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  transport.sent.length = 0;
  return { session, transport };
}

describe('watchRadioSettings', () => {
  it('sends nothing without a subscriber', async () => {
    vi.useFakeTimers();
    try {
      const { transport } = await settledSession();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(getVars(transport)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('polls while subscribed, stops on the last stop(), and stop() is idempotent', async () => {
    vi.useFakeTimers();
    try {
      const { session, transport } = await settledSession();
      const stopA = session.watchRadioSettings({ intervalMs: 20_000 });
      const stopB = session.watchRadioSettings({ intervalMs: 30_000 });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(getVars(transport)).toBe(1);

      stopA();
      stopA();
      transport.sent.length = 0;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(getVars(transport)).toBe(1);

      stopB();
      transport.sent.length = 0;
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(getVars(transport)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits gpsConfig only when the gps value changes', async () => {
    vi.useFakeTimers();
    try {
      const { session, transport } = await settledSession();
      const seen: unknown[] = [];
      session.events.on('gpsConfig', (c) => seen.push(c));
      session.watchRadioSettings({ intervalMs: 10_000 });

      for (const gps of ['1', '1', '0']) {
        await vi.advanceTimersByTimeAsync(10_000);
        transport.receiveHex(RESP_CUSTOM_VARS_HEX(`gps:${gps}`));
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(seen).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes no poll frame during the handshake', async () => {
    vi.useFakeTimers();
    try {
      const transport = new Transports.Loopback();
      transport.setState('connected');
      const session = new MeshCoreSession({ transport });
      session.start();
      onTestFinished(() => session.stop());
      session.watchRadioSettings({ intervalMs: 10_000 });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(getVars(transport)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops on disconnect and resumes on reconnect', async () => {
    vi.useFakeTimers();
    try {
      const { session, transport } = await settledSession();
      session.watchRadioSettings({ intervalMs: 10_000 });
      transport.setState('idle');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getVars(transport)).toBe(0);

      transport.setState('connected');
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(getVars(transport)).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
