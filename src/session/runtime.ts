import type { DeviceAdminRuntime } from '../features/deviceAdmin';
import type { MeshObservations } from '../meshObservations';
import type { PendingChannelSends } from '../pendingChannelSends';

/** Per-session mutable state, replacing every former module-level global.
 *  Later feature tasks add fields (dm, contactsIter, drain, adminCorr,
 *  channels, pathDisc, deviceAdmin). */
export interface SessionRuntime {
  meshObs: MeshObservations;
  pendingChannelSends: PendingChannelSends;
  deviceAdmin: DeviceAdminRuntime;
}
