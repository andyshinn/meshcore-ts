import type { Feature } from '../feature';
import { PUSH } from '../protocol/codes';

// PUSH_CODE_CONTACTS_FULL (0x90): the radio's contact store is full and a new
// advert could not be auto-added (overwrite-oldest off / all favourites). There
// is no generic `error` event in this library (the donor app's toast channel was
// dropped during extraction), so we surface this as a log warning AND a dedicated
// `contactsFull` event that adapters may bridge onto their own error/toast channel.
export const contactsFullFeature: Feature = {
  handles: [PUSH.CONTACTS_FULL],
  handle: (_code, _frame, ctx) => {
    ctx.log.warn('radio contact store is full — remove or favourite contacts to make room');
    ctx.events.emit('contactsFull');
  },
};
