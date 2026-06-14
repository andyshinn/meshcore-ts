import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { decodeSelfInfo, encodeAppStart } from '../../src/features/selfInfo';

// De-framed RESP_SELF_INFO captured from a connected Heltec/egrmesh "Hand" node
// (donor fixture connect-session.json → "selfInfo"). The decoder pulls the 32B
// pubkey at offset 4 and the trailing printable name region.
const SELF_INFO_HEX =
  '050114161a3d3c6a09f057457bcf0ae5403e5c60072919d193ed8caff58501b7590dd5d508fdcc0109472cfa00012a00bde40d0024f4000007056567726d652e73682048616e64';

describe('selfInfo encode/decode', () => {
  it('encodeAppStart matches the logged handshake frame', () => {
    // coresense.log: BLE_TX 24B cmd=0x01 hex=01010000000000006d657368636f72652d666c7574746572
    expect(encodeAppStart('meshcore-flutter', 1).toString('hex')).toBe('01010000000000006d657368636f72652d666c7574746572');
  });

  it('encodeAppStart lays out [cmd][version][6 reserved zero bytes][name]', () => {
    const out = encodeAppStart('mc', 1);
    expect(out[0]).toBe(0x01);
    expect(out[1]).toBe(0x01);
    expect([...out.subarray(2, 8)]).toEqual([0, 0, 0, 0, 0, 0]);
    expect(out.subarray(8).toString('utf8')).toBe('mc');
  });

  it('decodeSelfInfo extracts the 32-byte public key at offset 4', () => {
    const self = decodeSelfInfo(Buffer.from(SELF_INFO_HEX, 'hex'));
    expect(self).not.toBeNull();
    expect(self?.publicKeyHex).toBe('1a3d3c6a09f057457bcf0ae5403e5c60072919d193ed8caff58501b7590dd5d5');
    expect(self?.name).toContain('Hand'); // trailing printable name region
  });

  it('decodeSelfInfo returns null when the code byte is not 0x05', () => {
    const bad = Buffer.alloc(40);
    bad[0] = 0x06;
    expect(decodeSelfInfo(bad)).toBeNull();
  });

  it('decodeSelfInfo returns null below 36 bytes', () => {
    expect(decodeSelfInfo(Buffer.alloc(35))).toBeNull();
  });
});
