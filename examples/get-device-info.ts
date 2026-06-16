import { SerialPort } from 'serialport';
import { MeshCoreSession } from '@andyshinn/meshcore-ts';
import { SerialTransport } from '@andyshinn/meshcore-ts/transports';
import { requireArg, waitForEvent } from './lib/helpers';

const path = requireArg(process.argv, 2, 'usage: npm run example examples/get-device-info.ts <serial-port>');

const port = new SerialPort({ path, baudRate: 115200 });
const session = new MeshCoreSession({ transport: new SerialTransport(port) });

const mhz = (hz: number): string => `${(hz / 1_000_000).toFixed(3)} MHz`;
const khz = (hz: number): string => `${(hz / 1000).toFixed(1)} kHz`;
const coord = (v: number | null): string => (v === null ? 'not set' : v.toFixed(6));

session.events.on('transportState', async (state) => {
  if (state !== 'connected') return;
  console.log('Connected\n');
  try {
    // getSelfInfo() actively re-fetches the radio's identity + LoRa config and
    // folds it into RadioSettings / DeviceIdentity. DEVICE_QUERY (firmware,
    // model, capacities) already ran during the connect handshake.
    const self = await session.getSelfInfo();

    // Battery + storage aren't in DEVICE_QUERY — ask for them and wait for the
    // enriched deviceInfo. Best-effort: some builds may not answer.
    try {
      await session.requestBattAndStorage();
      await waitForEvent(session, 'deviceInfo', { timeoutMs: 5000 });
    } catch {
      console.log('(battery/storage not reported by this device)\n');
    }

    const info = session.state.getDeviceInfo();
    const radio = session.state.getRadioSettings();
    const id = session.state.getDeviceIdentity();

    console.log('Device');
    console.log(`  Name:             ${id.name || '(unknown)'}`);
    console.log(`  Public key:       ${id.publicKeyHex}`);
    console.log(`  Model:            ${info.deviceModel || '(unknown)'}`);
    console.log(`  Firmware:         ${info.firmwareVersion || '(unknown)'} (ver code ${info.firmwareVerCode})`);
    console.log(`  Build date:       ${info.firmwareBuildDate || '(unknown)'}`);
    console.log(`  BLE PIN:          ${info.blePin === 0 ? 'unset / random' : info.blePin}`);
    console.log(`  Max contacts:     ${info.maxContacts}`);
    console.log(`  Max channels:     ${info.maxChannels}`);
    console.log(`  Battery:          ${info.batteryMv} mV`);
    console.log(`  Storage:          ${info.storageUsedKb} / ${info.storageTotalKb} kB`);
    console.log(`  Position:         ${coord(id.lat)}, ${coord(id.lon)}`);
    console.log(`  Share position:   ${id.sharePositionInAdvert}`);

    console.log('\nRadio');
    console.log(`  Frequency:        ${mhz(radio.frequencyHz)}`);
    console.log(`  Bandwidth:        ${khz(radio.bandwidthHz)}`);
    console.log(`  Spreading factor: ${radio.spreadingFactor}`);
    console.log(`  Coding rate:      4/${radio.codingRate}`);
    console.log(`  TX power:         ${radio.txPowerDbm} dBm (max ${self.maxTxPowerDbm})`);
    console.log(`  Repeat mode:      ${radio.repeatMode}`);
    console.log(`  Path hash mode:   ${radio.pathHashMode} byte(s)/hop`);
  } catch (err) {
    console.error('Failed to fetch device/radio info:', err);
  } finally {
    session.stop();
    port.close();
  }
});

session.start();
