// Per-repeater admin auth state, plus a pending-request map keyed by the u32
// tag the firmware echoes in RESP_SENT after we issue a mesh-side request
// (login, ACL list, neighbours, owner info). PUSH_BINARY_RESPONSE /
// PUSH_LOGIN_SUCCESS / PUSH_LOGIN_FAIL frames carry the same tag back to us;
// we use it to wake the original caller's awaiter.

export type AdminMode = 'local' | 'remote';
export type AdminRole = 'admin' | 'guest';

export interface AdminSessionState {
  contactKey: string;
  publicKeyHex: string;
  mode: AdminMode;
  role: AdminRole;
  permissionsBits: number;
  aclPermissionsBits: number | null;
  firmwareVerLevel: number | null;
  loggedInAt: number;
}

interface Pending<T> {
  resolve: (value: T) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export class AdminSessionStore {
  private readonly sessions = new Map<string, AdminSessionState>();
  // Pending awaiters keyed by `tagHex` (4-byte u32 LE in lowercase hex). Login
  // responses don't carry the tag directly — they carry the pubkey prefix —
  // so we also key login waits by `login:<pubKeyPrefixHex>`.
  private readonly pending = new Map<string, Pending<unknown>>();

  getSession(contactKey: string): AdminSessionState | null {
    return this.sessions.get(contactKey) ?? null;
  }

  listSessions(): AdminSessionState[] {
    return [...this.sessions.values()];
  }

  setSession(state: AdminSessionState): void {
    this.sessions.set(state.contactKey, state);
  }

  clearSession(contactKey: string): void {
    this.sessions.delete(contactKey);
  }

  /** Park an awaiter for a future PUSH_BINARY_RESPONSE / login push. The
   *  resolver gets the parsed payload when the matching tag arrives. */
  awaitTag<T>(tagHex: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    return this.awaitKey<T>(`tag:${tagHex.toLowerCase()}`, timeoutMs);
  }

  awaitLogin<T>(pubKeyPrefixHex: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    return this.awaitKey<T>(`login:${pubKeyPrefixHex.toLowerCase()}`, timeoutMs);
  }

  private awaitKey<T>(key: string, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const existing = this.pending.get(key);
      if (existing) {
        clearTimeout(existing.timer);
        existing.reject(new Error(`superseded by newer request (${key})`));
      }
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`admin request ${key} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(key, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
    });
  }

  resolveTag(tagHex: string, value: unknown): boolean {
    return this.resolveKey(`tag:${tagHex.toLowerCase()}`, value);
  }

  resolveLogin(pubKeyPrefixHex: string, value: unknown): boolean {
    return this.resolveKey(`login:${pubKeyPrefixHex.toLowerCase()}`, value);
  }

  rejectLogin(pubKeyPrefixHex: string, err: Error): boolean {
    const key = `login:${pubKeyPrefixHex.toLowerCase()}`;
    const entry = this.pending.get(key);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(key);
    entry.reject(err);
    return true;
  }

  private resolveKey(key: string, value: unknown): boolean {
    const entry = this.pending.get(key);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(key);
    entry.resolve(value);
    return true;
  }

  /** Drop everything — used on transport disconnect so awaiters don't hang. */
  reset(reason: string): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
    this.sessions.clear();
  }
}
