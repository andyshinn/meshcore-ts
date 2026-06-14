import { describe, expect, it } from 'vitest';
import { advTypeToKind, hopsFromOutPathLen } from '../src/contacts/discovered';

describe('hopsFromOutPathLen', () => {
  it('treats 0xFF (OUT_PATH_UNKNOWN) as undefined', () => {
    expect(hopsFromOutPathLen(0xff)).toBeUndefined();
  });

  it('returns the byte length as the hop count', () => {
    expect(hopsFromOutPathLen(3)).toBe(3);
  });

  it('returns 0 for a direct (zero-hop) path', () => {
    expect(hopsFromOutPathLen(0)).toBe(0);
  });
});

describe('advTypeToKind', () => {
  it('maps 2 to repeater', () => {
    expect(advTypeToKind(2)).toBe('repeater');
  });

  it('maps 3 to room', () => {
    expect(advTypeToKind(3)).toBe('room');
  });

  it('maps 4 to sensor', () => {
    expect(advTypeToKind(4)).toBe('sensor');
  });

  it('maps 1 to chat', () => {
    expect(advTypeToKind(1)).toBe('chat');
  });

  it('defaults unknown types to chat', () => {
    expect(advTypeToKind(0)).toBe('chat');
    expect(advTypeToKind(99)).toBe('chat');
  });
});
