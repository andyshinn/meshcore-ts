import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  decodeAdvertPath,
  decodePathDiscoveryResponse,
  decodePathUpdated,
  encodeGetAdvertPath,
  encodeSendPathDiscoveryReq,
} from '../../src/features/pathDiagnostics';

const hex = (b: Buffer) => b.toString('hex');
const PK = 'aa'.repeat(32);

describe('pathDiagnostics encoders', () => {
  it('encodeSendPathDiscoveryReq is [0x34][0x00][32B pubkey]', () => {
    expect(hex(encodeSendPathDiscoveryReq(PK))).toBe(`3400${PK}`);
  });

  it('encodeGetAdvertPath is [0x2a][0x00][32B pubkey]', () => {
    expect(hex(encodeGetAdvertPath(PK))).toBe(`2a00${PK}`);
  });

  it('both reject a short public key', () => {
    expect(() => encodeSendPathDiscoveryReq('aabb')).toThrow(/32B/);
    expect(() => encodeGetAdvertPath('aabb')).toThrow(/32B/);
  });
});

describe('decodeAdvertPath', () => {
  it('reads recv_timestamp + a compound-encoded path (hashSize 2)', () => {
    // path_len 0x42 = hop_count 2, hash_size 2 → 4 path bytes
    const frame = Buffer.concat([
      Buffer.from([0x16]),
      (() => {
        const b = Buffer.alloc(4);
        b.writeUInt32LE(1000, 0);
        return b;
      })(),
      Buffer.from([0x42]),
      Buffer.from('aabbccdd', 'hex'),
    ]);
    expect(decodeAdvertPath(frame)).toEqual({
      recvTimestampUnix: 1000,
      hops: 2,
      pathHex: 'aabbccdd',
    });
  });

  it('reads an empty path (path_len 0)', () => {
    const frame = Buffer.from([0x16, 0xe8, 0x03, 0x00, 0x00, 0x00]); // ts 1000, path_len 0
    expect(decodeAdvertPath(frame)).toEqual({ recvTimestampUnix: 1000, hops: 0, pathHex: '' });
  });

  it('returns null below the header, or when the path overruns the frame', () => {
    expect(decodeAdvertPath(Buffer.from([0x16, 0x00, 0x00]))).toBeNull();
    // path_len 2 (2 bytes) but only 1 byte present
    expect(decodeAdvertPath(Buffer.from([0x16, 0x00, 0x00, 0x00, 0x00, 0x02, 0xaa]))).toBeNull();
  });
});

describe('decodePathDiscoveryResponse', () => {
  it('parses prefix + out_path + in_path (single-byte hops)', () => {
    const frame = Buffer.concat([
      Buffer.from([0x8d, 0x00]), // code + reserved
      Buffer.from('aabbccddeeff', 'hex'), // 6B prefix
      Buffer.from([0x02]), // out_path_len: hops 2, size 1 → 2 bytes
      Buffer.from('1122', 'hex'),
      Buffer.from([0x01]), // in_path_len: hops 1, size 1 → 1 byte
      Buffer.from('33', 'hex'),
    ]);
    expect(decodePathDiscoveryResponse(frame)).toEqual({
      pubKeyPrefixHex: 'aabbccddeeff',
      outHops: 2,
      outPathHex: '1122',
      inHops: 1,
      inPathHex: '33',
    });
  });

  it('returns null when a path length overruns the frame', () => {
    const frame = Buffer.concat([
      Buffer.from([0x8d, 0x00]),
      Buffer.from('aabbccddeeff', 'hex'),
      Buffer.from([0x05]), // claims 5 out_path bytes
      Buffer.from('1122', 'hex'), // only 2 present
    ]);
    expect(decodePathDiscoveryResponse(frame)).toBeNull();
    expect(decodePathDiscoveryResponse(Buffer.from([0x8d, 0x00]))).toBeNull();
  });
});

describe('decodePathUpdated', () => {
  it('returns the 32-byte pubkey hex, or null when short', () => {
    const frame = Buffer.concat([Buffer.from([0x81]), Buffer.from(PK, 'hex')]);
    expect(decodePathUpdated(frame)).toBe(PK);
    expect(decodePathUpdated(Buffer.from([0x81, 0x01]))).toBeNull();
  });
});
