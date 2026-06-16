import { Buffer } from 'node:buffer';
import noble, { type Characteristic, type Peripheral } from '@stoprocent/noble';
import { MeshCoreSession } from '@andyshinn/meshcore-ts';
import { createBleTransport, NORDIC_UART } from '@andyshinn/meshcore-ts/transports';

// noble compares 128-bit UUIDs without dashes, lowercased.
const toNoble = (uuid: string): string => uuid.replace(/-/g, '').toLowerCase();
const SERVICE = toNoble(NORDIC_UART.service);
const RX = toNoble(NORDIC_UART.rxWrite); // host → device
const TX = toNoble(NORDIC_UART.txNotify); // device → host

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
  session.events.on('owner', (owner) => console.log('Device:', owner?.name));
  session.start();

  try {
    const contacts = await session.getContacts();
    for (const contact of contacts) {
      console.log(`Contact: ${contact.name} (${contact.publicKeyHex.slice(0, 12)}…)`);
    }
  } finally {
    session.stop();
    await peripheral.disconnectAsync();
  }
}

// noble keeps the BLE adapter / HCI socket open, so the event loop never drains
// on its own — exit explicitly once the one-shot listing is done.
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('BLE example failed:', err);
    process.exit(1);
  });
