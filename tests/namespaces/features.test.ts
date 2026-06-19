// tests/namespaces/features.test.ts
// NOTE: a *value* import (not `import type`), so the module resolves at runtime —
// that is what makes the red state below fire. The barrel is type-only, so the
// runtime namespace object is empty; the per-type checks are enforced by `tsc`
// (Step 5), since each `Features.X` reference errors if X is not exported.
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as Features from '../../src/features';

describe('Features namespace barrel', () => {
  it('loads as a (type-only → empty) namespace object', () => {
    expect(Features).toBeTypeOf('object');
  });

  it('exposes the bounded public feature types (enforced by tsc)', () => {
    // Extension contracts.
    expectTypeOf<Features.Feature>().not.toBeNever();
    expectTypeOf<Features.FeatureContext>().not.toBeNever();
    expectTypeOf<Features.ContactsSyncSignal>().not.toBeNever();
    // Public feature types reached by MeshCoreSession's public methods.
    expectTypeOf<Features.SelfInfo>().not.toBeNever();
    expectTypeOf<Features.TuningParams>().not.toBeNever();
    expectTypeOf<Features.AutoAddFlagsInput>().not.toBeNever();
    expectTypeOf<Features.AdminMode>().not.toBeNever();
    expectTypeOf<Features.RepeaterReachMode>().not.toBeNever();
    expectTypeOf<Features.DefaultFloodScope>().not.toBeNever();
    expectTypeOf<Features.FloodScopeInput>().not.toBeNever();
    expectTypeOf<Features.RepeatFreqRange>().not.toBeNever();
    expectTypeOf<Features.AdvertPath>().not.toBeNever();
    expectTypeOf<Features.DiscoveredPath>().not.toBeNever();
  });
});
