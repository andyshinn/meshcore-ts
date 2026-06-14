import type { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { buildReboot, buildSendSelfAdvert } from '../src/encode';

const hex = (b: Buffer) => b.toString('hex');

describe('encode: device bare-opcode commands', () => {
  it('buildSendSelfAdvert encodes the flood flag', () => {
    expect(hex(buildSendSelfAdvert())).toBe('0701');
    expect(hex(buildSendSelfAdvert(false))).toBe('0700');
  });

  it('buildReboot appends the literal "reboot"', () => {
    expect(hex(buildReboot())).toBe('137265626f6f74');
  });
});
