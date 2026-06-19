import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import type { FeatureContext } from '../../src/feature';
import {
  createChannelsRuntime,
  decodeChannelInfo,
  deriveChannelSecret,
  encodeGetChannel,
  encodeSetChannel,
  getChannel,
} from '../../src/features/channels';
import { SessionState } from '../../src/model/state/model';
import { MeshCoreEvents } from '../../src/ports/events';
import { noopLogger } from '../../src/ports/logger';

const hex = (b: Buffer) => b.toString('hex');

describe('channels: encodeGetChannel', () => {
  it('appends the slot index', () => {
    expect(hex(encodeGetChannel(0))).toBe('1f00');
    expect(hex(encodeGetChannel(3))).toBe('1f03');
  });
});

describe('channels: encodeSetChannel', () => {
  it('lays out [0x20][idx][name 32B null-padded][secret 16B]', () => {
    const out = encodeSetChannel(1, 'General', 'ab'.repeat(16));
    expect(out.length).toBe(50);
    expect(out[0]).toBe(0x20);
    expect(out[1]).toBe(1);
    const nameRegion = out.subarray(2, 34);
    expect(nameRegion.subarray(0, nameRegion.indexOf(0)).toString('utf8')).toBe('General');
    expect(out.subarray(34, 50).toString('hex')).toBe('ab'.repeat(16));
  });

  it('rejects a secret that is not 16 bytes', () => {
    expect(() => encodeSetChannel(0, 'x', 'abcd')).toThrow(/16 bytes/);
  });
});

describe('channels: deriveChannelSecret', () => {
  it('is 16 bytes (32 lowercase hex chars) and deterministic', () => {
    const a = deriveChannelSecret('public');
    const b = deriveChannelSecret('public');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).toBe('efa1f375d76194fa51a3556a97e641e6'); // golden: SHA-256('public')[:16]
  });

  it('differs for different channel names', () => {
    expect(deriveChannelSecret('public')).not.toBe(deriveChannelSecret('private'));
  });
});

describe('channels: decodeChannelInfo', () => {
  it('reads idx, null-terminated name, and 16-byte key', () => {
    const frame = Buffer.alloc(50);
    frame[0] = 0x12;
    frame[1] = 2; // idx
    Buffer.from('General', 'utf8').copy(frame, 2); // name region (null-padded)
    Buffer.alloc(16, 0xab).copy(frame, 34); // 16-byte key, all 0xab
    const info = decodeChannelInfo(frame);
    expect(info?.idx).toBe(2);
    expect(info?.name).toBe('General');
    expect(info?.secretHex).toBe('ab'.repeat(16));
    expect(info?.empty).toBe(false);
  });

  it('flags an all-zero key as empty', () => {
    const frame = Buffer.alloc(50);
    frame[0] = 0x12;
    expect(decodeChannelInfo(frame)?.empty).toBe(true);
  });

  it('returns null below the 50-byte frame length', () => {
    expect(decodeChannelInfo(Buffer.alloc(49))).toBeNull();
  });
});

function channelInfoFrame(idx: number, name: string, keyHex: string): Buffer {
  const f = Buffer.alloc(50);
  f[0] = 0x12; // RESP_CHANNEL_INFO
  f[1] = idx;
  Buffer.from(name, 'utf8').copy(f, 2);
  Buffer.from(keyHex, 'hex').copy(f, 34);
  return f;
}

describe('channels: getChannel', () => {
  it('resolves the decoded Channel and updates state when a slot is present', async () => {
    const frame = channelInfoFrame(2, 'Public', 'ab'.repeat(16));
    const events = new MeshCoreEvents();
    const state = new SessionState();
    const ctx = {
      requestOrNull: async () => frame,
      events,
      state,
      log: noopLogger,
      rt: { channels: createChannelsRuntime() },
    } as unknown as FeatureContext;

    const ch = await getChannel(ctx, 2);
    expect(ch).toMatchObject({ key: 'ch:Public', name: 'Public', kind: 'public', idx: 2 });
    expect(state.getChannels()).toHaveLength(1);
  });

  it('resolves null for an empty slot (requestOrNull → null)', async () => {
    const state = new SessionState();
    const ctx = {
      requestOrNull: async () => null,
      events: new MeshCoreEvents(),
      state,
      log: noopLogger,
      rt: { channels: createChannelsRuntime() },
    } as unknown as FeatureContext;
    expect(await getChannel(ctx, 5)).toBeNull();
    expect(state.getChannels()).toHaveLength(0);
  });

  it('resolves null for a decoded-but-empty slot (all-zero key) and does not touch state', async () => {
    const frame = channelInfoFrame(3, '', '00'.repeat(16));
    const state = new SessionState();
    const ctx = {
      requestOrNull: async () => frame,
      events: new MeshCoreEvents(),
      state,
      log: noopLogger,
      rt: { channels: createChannelsRuntime() },
    } as unknown as FeatureContext;
    expect(await getChannel(ctx, 3)).toBeNull();
    expect(state.getChannels()).toHaveLength(0);
  });
});
