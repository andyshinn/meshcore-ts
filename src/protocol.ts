// Power-user wire-codec surface (the `Protocol` namespace).
// Forward-looking — lets consumers build/parse companion frames directly.
// NOTE: paths.ts is intentionally excluded (it is model-layer, not codec).
// NOTE: codeNames.ts is intentionally excluded — `invertCodes` is an internal
//   helper for building reverse lookup tables, not part of the public surface.
export * from './protocol/advert';
export * from './protocol/buffer';
export * from './protocol/channelCrypto';
export * from './protocol/codes';
export * from './protocol/encode';
export * from './protocol/frame';
export * from './protocol/meshPacket';
export * from './protocol/onAirPackets';
export * from './protocol/pubkey';
export * from './protocol/repeater';
