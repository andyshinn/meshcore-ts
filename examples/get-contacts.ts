import { SerialPort } from 'serialport';
import { MeshCoreSession } from '@andyshinn/meshcore-ts';
import { SerialTransport } from '@andyshinn/meshcore-ts/transports';
import { requireArg } from './lib/helpers';

const path = requireArg(
  process.argv,
  2,
  'usage: npm run example examples/get-contacts.ts <serial-port>',
);

const port = new SerialPort({ path, baudRate: 115200 });
const session = new MeshCoreSession({ transport: new SerialTransport(port) });

session.events.on('transportState', async (state) => {
  if (state !== 'connected') return;
  console.log('Connected');
  try {
    const contacts = await session.getContacts();
    for (const contact of contacts) {
      console.log(`Contact: ${contact.name} (${contact.publicKeyHex.slice(0, 12)}…)`);
    }
  } catch (err) {
    console.error('Failed to fetch contacts:', err);
  } finally {
    session.stop();
    port.close();
  }
});

session.start();
