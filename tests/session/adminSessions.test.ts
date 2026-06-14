import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AdminSessionState, AdminSessionStore } from '../../src/session/adminSessions';

function session(over: Partial<AdminSessionState> = {}): AdminSessionState {
  return {
    contactKey: 'c:aa',
    publicKeyHex: 'aa'.repeat(32),
    mode: 'remote',
    role: 'admin',
    permissionsBits: 0xff,
    aclPermissionsBits: null,
    firmwareVerLevel: null,
    loggedInAt: 1000,
    ...over,
  };
}

describe('AdminSessionStore.awaitTag / resolveTag', () => {
  it('resolves awaitTag with the value passed to resolveTag for the matching tag', async () => {
    const store = new AdminSessionStore();
    const p = store.awaitTag<{ ok: boolean }>('DEADBEEF');
    expect(store.resolveTag('deadbeef', { ok: true })).toBe(true);
    await expect(p).resolves.toEqual({ ok: true });
  });

  it('resolveTag returns false when no awaiter is parked', () => {
    const store = new AdminSessionStore();
    expect(store.resolveTag('cafebabe', { ok: true })).toBe(false);
  });

  it('supersedes an existing awaiter for the same tag with a rejection', async () => {
    const store = new AdminSessionStore();
    const first = store.awaitTag('aabbccdd');
    const second = store.awaitTag('aabbccdd');
    await expect(first).rejects.toThrow(/superseded by newer request/);
    expect(store.resolveTag('aabbccdd', 42)).toBe(true);
    await expect(second).resolves.toBe(42);
  });
});

describe('AdminSessionStore.awaitTag timeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects after the timeout elapses', async () => {
    vi.useFakeTimers();
    const store = new AdminSessionStore();
    const p = store.awaitTag('11223344', 1000);
    const assertion = expect(p).rejects.toThrow(/timed out after 1000ms/);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });
});

describe('AdminSessionStore.awaitLogin / resolveLogin / rejectLogin', () => {
  it('resolves awaitLogin via resolveLogin on the matching prefix', async () => {
    const store = new AdminSessionStore();
    const p = store.awaitLogin<string>('AABB');
    expect(store.resolveLogin('aabb', 'success')).toBe(true);
    await expect(p).resolves.toBe('success');
  });

  it('rejectLogin rejects the parked awaiter and returns true', async () => {
    const store = new AdminSessionStore();
    const p = store.awaitLogin('aabb');
    const assertion = expect(p).rejects.toThrow('login failed');
    expect(store.rejectLogin('aabb', new Error('login failed'))).toBe(true);
    await assertion;
  });

  it('rejectLogin returns false when nothing is parked', () => {
    const store = new AdminSessionStore();
    expect(store.rejectLogin('aabb', new Error('nope'))).toBe(false);
  });
});

describe('AdminSessionStore session round-trip', () => {
  it('setSession / getSession / listSessions / clearSession round-trip', () => {
    const store = new AdminSessionStore();
    expect(store.getSession('c:aa')).toBeNull();
    expect(store.listSessions()).toEqual([]);

    const s = session();
    store.setSession(s);
    expect(store.getSession('c:aa')).toEqual(s);

    const s2 = session({ contactKey: 'c:bb', publicKeyHex: 'bb'.repeat(32) });
    store.setSession(s2);
    expect(store.listSessions()).toEqual([s, s2]);

    store.clearSession('c:aa');
    expect(store.getSession('c:aa')).toBeNull();
    expect(store.listSessions()).toEqual([s2]);
  });
});

describe('AdminSessionStore.reset', () => {
  it('rejects all pending awaiters with the reason and clears sessions', async () => {
    const store = new AdminSessionStore();
    store.setSession(session());
    const tagWait = store.awaitTag('deadbeef');
    const loginWait = store.awaitLogin('aabb');

    const tagAssert = expect(tagWait).rejects.toThrow('disconnected');
    const loginAssert = expect(loginWait).rejects.toThrow('disconnected');
    store.reset('disconnected');
    await tagAssert;
    await loginAssert;

    expect(store.listSessions()).toEqual([]);
    // pending map cleared: a fresh resolve finds no awaiter
    expect(store.resolveTag('deadbeef', 1)).toBe(false);
  });
});
