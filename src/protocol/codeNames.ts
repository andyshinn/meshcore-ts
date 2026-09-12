// Internal helper for turning a `{ NAME: code }` constant table into the
// reverse `{ code: 'NAME' }` lookup used for display and logging.
//
// Deliberately NOT re-exported from src/protocol.ts: this is a package-internal
// utility, not part of the published `Protocol` namespace.

/** Invert a `{ NAME: code }` constant table into `{ code: '<prefix>NAME' }`.
 *
 *  Later keys win on a duplicate code, matching plain object-literal semantics.
 *
 *  @param codes  A code table (typically declared `as const`).
 *  @param prefix Optional string prepended to every key name, so `PUSH` yields
 *                `PUSH_ADVERT` rather than bare `ADVERT`.
 */
export function invertCodes(codes: Record<string, number>, prefix = ''): Record<number, string> {
  return Object.fromEntries(Object.entries(codes).map(([name, value]) => [value, `${prefix}${name}`]));
}
