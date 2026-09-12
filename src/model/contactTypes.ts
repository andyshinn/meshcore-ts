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

/** Where an ingested contact was heard: `'sync'` (the radio listing what it
 *  stores — a RESP_CONTACT during a GET_CONTACTS enumeration, or a
 *  PUSH_PATH_UPDATED re-fetch) or `'advert'` (we heard the node transmit — a
 *  PUSH_ADVERT (0x80) re-fetch, or a PUSH_NEW_ADVERT (0x8a), which means the
 *  radio refused to store it).
 *
 *  `'advert'` says nothing about contact-store membership in either direction:
 *  0x80 means the node IS stored (including one auto-added microseconds ago),
 *  0x8a means it is NOT. Read `DiscoveredContact.onRadio` for that. */
export type ContactSource = 'sync' | 'advert';
