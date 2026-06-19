import { MeshObservations } from '../model/meshObservations';
import { type ChannelsRuntime, createChannelsRuntime } from './channels';
import { type ContactsIterRuntime, createContactsIterRuntime } from './contacts';
import { createDeviceAdminRuntime, type DeviceAdminRuntime } from './deviceAdmin';
import { createDmRuntime, type DmRuntime } from './directMessages';
import { createDrainRuntime, type DrainRuntime } from './drain';
import { createPathDiagRuntime, type PathDiagRuntime } from './pathDiagnostics';
import { PendingChannelSends } from './pendingChannelSends';
import { type AdminCorrRuntime, createAdminCorrRuntime } from './repeaterAdmin';

/** Per-session mutable state, replacing every former module-level global. */
export interface SessionRuntime {
  meshObs: MeshObservations;
  pendingChannelSends: PendingChannelSends;
  deviceAdmin: DeviceAdminRuntime;
  drain: DrainRuntime;
  channels: ChannelsRuntime;
  contactsIter: ContactsIterRuntime;
  pathDisc: PathDiagRuntime;
  dm: DmRuntime;
  adminCorr: AdminCorrRuntime;
}

/** Build a fresh runtime bundle for one session — every feature's per-session
 *  mutable state in one place, so nothing leaks across session instances. */
export function createSessionRuntime(): SessionRuntime {
  return {
    meshObs: new MeshObservations(),
    pendingChannelSends: new PendingChannelSends(),
    deviceAdmin: createDeviceAdminRuntime(),
    drain: createDrainRuntime(),
    channels: createChannelsRuntime(),
    contactsIter: createContactsIterRuntime(),
    pathDisc: createPathDiagRuntime(),
    dm: createDmRuntime(),
    adminCorr: createAdminCorrRuntime(),
  };
}
