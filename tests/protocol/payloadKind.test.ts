import { describe, expect, it } from 'vitest';
import { type OnAirPayload, PayloadKind } from '../../src/protocol/onAirPackets';

describe('PayloadKind constants', () => {
  it('maps readable names to the kind discriminant literals', () => {
    expect(PayloadKind.ADVERT).toBe('advert');
    expect(PayloadKind.GRP_TXT).toBe('grpTxt');
    expect(PayloadKind.TRACE).toBe('trace');
    expect(PayloadKind.RAW).toBe('raw');
  });

  it('narrows payload in a switch — via the constant AND the raw string', () => {
    const payload = { kind: 'grpTxt', channelHash: '01', macHex: '0203', cipherLen: 4 } as OnAirPayload;

    let viaConst: string | undefined;
    switch (payload.kind) {
      case PayloadKind.GRP_TXT:
        viaConst = payload.channelHash; // narrows: channelHash is in scope
        break;
    }
    expect(viaConst).toBe('01');

    let viaString: number | undefined;
    switch (payload.kind) {
      case 'grpTxt': // raw string — equivalent, still narrows
        viaString = payload.cipherLen;
        break;
    }
    expect(viaString).toBe(4);
  });
});
