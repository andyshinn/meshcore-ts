import { describe, expect, it } from 'vitest';
import * as Models from '../../src/model';

describe('Models namespace barrel', () => {
  it('exposes domain value helpers and defaults', () => {
    expect(Models.DEFAULT_RADIO_SETTINGS).toBeDefined();
    expect(Models.hasValidFix).toBeTypeOf('function');
    expect(Models.MeshObservations).toBeTypeOf('function');
    expect(Models.advTypeToKind).toBeTypeOf('function');
  });

  it('does NOT leak errors or internal state', () => {
    const keys = Object.keys(Models);
    expect(keys).not.toContain('ProtocolError');
    expect(keys).not.toContain('SessionState');
  });

  it('exposes domain types (compile-time)', () => {
    const c: Models.Contact = {} as Models.Contact;
    const s: Models.SyncProgress = Models.DEFAULT_SYNC_PROGRESS;
    expect(c).toBeDefined();
    expect(s).toBe(Models.DEFAULT_SYNC_PROGRESS);
  });
});
