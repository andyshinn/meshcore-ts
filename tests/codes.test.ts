import { describe, expect, it } from 'vitest';
import { ANON_REQ_TYPE, getAnonReqTypeName, getRequestTypeName, REQ_TYPE } from '../src/codes';

describe('getRequestTypeName', () => {
  it('maps a known REQ_TYPE byte to its enum key name', () => {
    expect(getRequestTypeName(REQ_TYPE.GET_ACCESS_LIST)).toBe('GET_ACCESS_LIST');
    expect(getRequestTypeName(REQ_TYPE.GET_STATUS)).toBe('GET_STATUS');
  });

  it('returns UNKNOWN for an unmapped byte', () => {
    expect(getRequestTypeName(0xff)).toBe('UNKNOWN');
  });
});

describe('getAnonReqTypeName', () => {
  it('maps a known ANON_REQ_TYPE byte to its enum key name', () => {
    expect(getAnonReqTypeName(ANON_REQ_TYPE.REGIONS)).toBe('REGIONS');
    expect(getAnonReqTypeName(ANON_REQ_TYPE.OWNER)).toBe('OWNER');
  });

  it('returns UNKNOWN for an unmapped byte', () => {
    expect(getAnonReqTypeName(0xff)).toBe('UNKNOWN');
  });
});
