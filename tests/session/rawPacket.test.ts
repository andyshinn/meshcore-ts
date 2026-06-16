import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { deliver, makeSession } from '../support/harness';

describe('rawPacket event', () => {
  it('emits for a PUSH_LOG_RX_DATA (0x88) frame with inner mesh hex and snr/rssi', () => {
    const { session, transport } = makeSession();
    const seen: Array<{ hex: string; source: string; snr: number; rssi: number }> = [];
    session.events.on('rawPacket', (p) => seen.push(p));

    // [0x88][snr*4 = 12 → 3][rssi 0xb0 → -80][mesh deadbeef]
    deliver(transport, Buffer.from([0x88, 12, 0xb0, 0xde, 0xad, 0xbe, 0xef]));

    expect(seen).toEqual([{ hex: 'deadbeef', source: 'log_rx', snr: 3, rssi: -80 }]);
    session.stop();
  });

  it('emits for a PUSH_RAW_DATA (0x84) frame, skipping the 0xFF reserved byte', () => {
    const { session, transport } = makeSession();
    const seen: Array<{ hex: string; source: string; snr: number; rssi: number }> = [];
    session.events.on('rawPacket', (p) => seen.push(p));

    // [0x84][snr*4 = 0xf8 → -2][rssi 0xa5 → -91][0xFF reserved][mesh 010203]
    deliver(transport, Buffer.from([0x84, 0xf8, 0xa5, 0xff, 0x01, 0x02, 0x03]));

    expect(seen).toEqual([{ hex: '010203', source: 'raw', snr: -2, rssi: -91 }]);
    session.stop();
  });
});
