/** Thrown when a contact operation references a public key that isn't in the
 *  discovered pool, so it can't be added to the radio or favourited. Maps to
 *  HTTP 422 (request well-formed, but the referenced contact can't be acted
 *  on) rather than a 503 device error. */
export class UnknownContactError extends Error {
  constructor(public readonly publicKeyHex: string) {
    super(`unknown discovered contact ${publicKeyHex}`);
    this.name = 'UnknownContactError';
  }
}

/** Thrown when CMD_ADD_UPDATE_CONTACT is rejected with ERR_CODE_TABLE_FULL —
 *  the radio's on-device contact store is full (overwrite-oldest off, or every
 *  slot is a favourite). Maps to HTTP 409. The message is user-facing. */
export class ContactTableFullError extends Error {
  constructor() {
    super('Contact list full — remove a contact or enable overwrite-oldest.');
    this.name = 'ContactTableFullError';
  }
}

/** Thrown when a companion command is answered with RESP_ERR. `errorCode` is
 *  the firmware error byte (ERR_CODE_*); undefined on a bare RESP_ERR. */
export class ProtocolError extends Error {
  constructor(public readonly errorCode?: number) {
    super(
      errorCode !== undefined
        ? `radio returned error 0x${errorCode.toString(16).padStart(2, '0')}`
        : 'radio returned an error',
    );
    this.name = 'ProtocolError';
  }
}

/** Thrown when a build-flag-gated command (e.g. private-key export/import) is
 *  answered with RESP_DISABLED on this firmware build. */
export class FeatureDisabledError extends Error {
  constructor() {
    super('feature disabled on this firmware build');
    this.name = 'FeatureDisabledError';
  }
}

/** Thrown when a companion request times out waiting for its expected reply. */
export class ProtocolTimeoutError extends Error {
  constructor(public readonly expectedCode: number) {
    super(`timeout waiting for frame 0x${expectedCode.toString(16).padStart(2, '0')}`);
    this.name = 'ProtocolTimeoutError';
  }
}
