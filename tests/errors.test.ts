import { describe, expect, it } from 'vitest';
import { FeatureDisabledError, ProtocolError } from '../src/model/errors';
import { ERR_CODE } from '../src/protocol/codes';

describe('ERR_CODE', () => {
  it('covers the firmware error set', () => {
    expect(ERR_CODE).toStrictEqual({
      UNSUPPORTED_CMD: 0x01,
      NOT_FOUND: 0x02,
      TABLE_FULL: 0x03,
      BAD_STATE: 0x04,
      FILE_IO_ERROR: 0x05,
      ILLEGAL_ARG: 0x06,
    });
  });
});

describe('ProtocolError', () => {
  it('carries the firmware error code and renders it in the message', () => {
    const err = new ProtocolError(0x06);
    expect(err).toBeInstanceOf(Error);
    expect(err.errorCode).toBe(0x06);
    expect(err.message).toMatch(/0x06/);
  });

  it('tolerates an undefined error code', () => {
    expect(new ProtocolError().errorCode).toBeUndefined();
  });
});

describe('FeatureDisabledError', () => {
  it('is an Error subclass', () => {
    expect(new FeatureDisabledError()).toBeInstanceOf(Error);
    expect(new FeatureDisabledError().name).toBe('FeatureDisabledError');
  });
});
