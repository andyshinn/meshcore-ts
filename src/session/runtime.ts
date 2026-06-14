import type { ChannelsRuntime } from '../features/channels';
import type { ContactsIterRuntime } from '../features/contacts';
import type { DeviceAdminRuntime } from '../features/deviceAdmin';
import type { DmRuntime } from '../features/directMessages';
import type { DrainRuntime } from '../features/drain';
import type { PathDiagRuntime } from '../features/pathDiagnostics';
import type { MeshObservations } from '../meshObservations';
import type { PendingChannelSends } from '../pendingChannelSends';

/** Per-session mutable state, replacing every former module-level global.
 *  Later feature tasks add fields (adminCorr). */
export interface SessionRuntime {
  meshObs: MeshObservations;
  pendingChannelSends: PendingChannelSends;
  deviceAdmin: DeviceAdminRuntime;
  drain: DrainRuntime;
  channels: ChannelsRuntime;
  contactsIter: ContactsIterRuntime;
  pathDisc: PathDiagRuntime;
  dm: DmRuntime;
}
