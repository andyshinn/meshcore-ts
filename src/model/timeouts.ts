// Default timeouts for the admin / CLI request families. Public so a consumer
// can render an accurate countdown or size its own queue without hardcoding
// values that belong to the library.

/** Default wait for a repeater's CLI reply (`repeaterSendCli`). */
export const CLI_REPLY_TIMEOUT_MS = 30_000;

/** Default wait for the radio's RESP_SENT echo after an admin write. Also the
 *  default for a fire-and-forget CLI send, which resolves on that echo. */
export const ADMIN_SENT_TIMEOUT_MS = 5_000;

/** Default wait for a mesh-routed admin reply — binary/anon requests, login. */
export const ADMIN_REPLY_TIMEOUT_MS = 20_000;
