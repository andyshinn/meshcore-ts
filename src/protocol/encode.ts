import { Buffer } from 'node:buffer';
import { CMD } from './codes';

// CMD_SEND_SELF_ADVERT (firmware: companion_radio/MyMesh.cpp):
//   [0x07] alone → zero-hop advert
//   [0x07][1] → flood advert (peers many hops away learn us)
// Sending zero-hop is polite (low airtime), but flood is what makes peers in
// other parts of the mesh able to DM-reply. Default to flood on user-initiated
// adverts; the auto-on-connect advert is also flood so first-time peers see us.
export function buildSendSelfAdvert(flood = true): Buffer {
  return Buffer.from([CMD.SEND_SELF_ADVERT, flood ? 1 : 0]);
}

// CMD_REBOOT: literal "reboot" payload after the opcode. Anything else and the
// firmware ignores the write (safety against accidental opcode collisions).
export function buildReboot(): Buffer {
  const tag = Buffer.from('reboot', 'utf8');
  const out = Buffer.alloc(1 + tag.length);
  out[0] = CMD.REBOOT;
  tag.copy(out, 1);
  return out;
}
