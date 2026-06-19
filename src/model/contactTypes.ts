// Consumer-facing contact value types. Previously declared inside
// features/contacts.ts; relocated to the model layer so ports/events and the
// public barrel can reference them without importing a feature.

export interface ContactRecord {
  publicKeyHex: string;
  type: number;
  flags: number;
  outPathLen: number;
  outPathHex: string;
  name: string;
  lastAdvertUnix: number;
  gpsLat: number;
  gpsLon: number;
  lastmod: number;
}

/** Where an ingested contact was heard: `'sync'` (RESP_CONTACT during the
 *  GET_CONTACTS handshake — always on-radio) or `'advert'` (live PUSH_NEW_ADVERT
 *  — on-radio only if already in the store). */
export type ContactSource = 'sync' | 'advert';
