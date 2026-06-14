import type { ChannelsRuntime } from '../features/channels';
import type { DeviceAdminRuntime } from '../features/deviceAdmin';
import type { DrainRuntime } from '../features/drain';
import type { MeshObservations } from '../meshObservations';
import type { PendingChannelSends } from '../pendingChannelSends';

/** Per-session mutable state, replacing every former module-level global.
 *  Later feature tasks add fields (dm, contactsIter, adminCorr, pathDisc). */
export interface SessionRuntime {
  meshObs: MeshObservations;
  pendingChannelSends: PendingChannelSends;
  deviceAdmin: DeviceAdminRuntime;
  drain: DrainRuntime;
  channels: ChannelsRuntime;
}
