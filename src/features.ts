// Feature framework contracts + the bounded set of feature types that appear in
// MeshCoreSession's public method signatures (the `Features` namespace).
// Internal wiring (FeatureRegistry, encoders, runtime stores) stays internal.

export type { AdminMode } from './features/adminSessions';
export type { AutoAddFlagsInput } from './features/autoAdd';
export type { ContactsSyncSignal, Feature, FeatureContext } from './features/feature';
export type { DefaultFloodScope, FloodScopeInput } from './features/floodScope';
export type { RepeatFreqRange } from './features/misc';
export type { AdvertPath, DiscoveredPath } from './features/pathDiagnostics';
export type { RepeaterReachMode } from './features/repeaterAdmin';
export type { SelfInfo } from './features/selfInfo';
export type { TuningParams } from './features/tuning';
