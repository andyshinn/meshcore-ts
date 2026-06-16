import { Buffer } from 'node:buffer';
import noble, { type Characteristic, type Peripheral } from '@stoprocent/noble';
import { MeshCoreSession } from '@andyshinn/meshcore-ts';
import { createBleTransport, NORDIC_UART } from '@andyshinn/meshcore-ts/transports';
import { waitForEvent } from './lib/helpers';

// noble compares 128-bit UUIDs without dashes, lowercased.
const toNoble = (uuid: string): string => uuid.replace(/-/g, '').toLowerCase();
const SERVICE = toNoble(NORDIC_UART.service);
const RX = toNoble(NORDIC_UART.rxWrite); // host → device
const TX = toNoble(NORDIC_UART.txNotify); // device → host

const mhz = (hz: number): string => `${(hz / 1_000_000).toFixed(3)} MHz`;
const khz = (hz: number): string => `${(hz / 1000).toFixed(1)} kHz`;
const coord = (v: number | null): string => (v === null ? 'not set' : v.toFixed(6));

async function main(): Promise<void> {
  await noble.waitForPoweredOn();

  console.log('Scanning for a MeshCore device…');
  await noble.startScanningAsync([SERVICE], false);

  const peripheral = await new Promise<Peripheral>((resolve) => {
    noble.once('discover', (p: Peripheral) => resolve(p));
  });
  await noble.stopScanningAsync();

  console.log(`Connecting to ${peripheral.advertisement?.localName ?? peripheral.id}…`);
  await peripheral.connectAsync();

  const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
    [SERVICE],
    [RX, TX],
  );
  const rxChar = characteristics.find((c: Characteristic) => c.uuid === RX);
  const txChar = characteristics.find((c: Characteristic) => c.uuid === TX);
  if (!rxChar || !txChar) {
    console.error('MeshCore characteristics not found on device');
    await peripheral.disconnectAsync();
    return;
  }

  const transport = createBleTransport({
    write: (bytes) => rxChar.writeAsync(Buffer.from(bytes), true),
    subscribe: (onBytes) => {
      txChar.on('data', (data: Buffer) => onBytes(new Uint8Array(data)));
      void txChar.subscribeAsync();
    },
    watchState: (onState) => {
      peripheral.once('disconnect', (_error: string) => onState('idle'));
    },
  });

  const session = new MeshCoreSession({ transport });
  session.start();

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
      console.log('(battery/storage not reported by this device)');
    }

    const info = session.state.getDeviceInfo();
    const radio = session.state.getRadioSettings();
    const id = session.state.getDeviceIdentity();

    console.log('\nDevice');
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
  } finally {
    session.stop();
    await peripheral.disconnectAsync();
  }
}

// noble keeps the BLE adapter / HCI socket open, so the event loop never drains
// on its own — exit explicitly once the one-shot report is done.
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('BLE example failed:', err);
    process.exit(1);
  });
