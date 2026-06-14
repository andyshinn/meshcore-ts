import { PUSH } from '../codes';
import type { Feature } from '../feature';

// PUSH_CODE_CONTACTS_FULL (0x90): the radio's contact store is full and a new
// advert could not be auto-added (overwrite-oldest off / all favourites). There
// is no `error` event in this library (the donor app's toast channel was
// dropped during extraction), so we surface this as a log warning only.
export const contactsFullFeature: Feature = {
  handles: [PUSH.CONTACTS_FULL],
  handle: (_code, _frame, ctx) => {
    ctx.log.warn('radio contact store is full — remove or favourite contacts to make room');
  },
};
