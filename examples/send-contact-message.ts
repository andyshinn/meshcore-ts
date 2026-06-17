import { SerialPort } from 'serialport';
import { MeshCoreSession } from '@andyshinn/meshcore-ts';
import { SerialTransport } from '@andyshinn/meshcore-ts/transports';
import { requireArg, waitForEvent } from './lib/helpers';

const usage =
  'usage: pnpm example examples/send-contact-message.ts <serial-port> <contact-name> [text]';
const path = requireArg(process.argv, 2, usage);
const contactName = requireArg(process.argv, 3, usage);
const text = process.argv[4] ?? 'Hello from meshcore-ts';

const port = new SerialPort({ path, baudRate: 115200 });
const session = new MeshCoreSession({ transport: new SerialTransport(port) });

session.events.on('transportState', async (state) => {
  if (state !== 'connected') return;
  console.log('Connected');
  try {
    await session.getContacts();
    const contact = session.findContactByName(contactName);
    if (!contact) {
      console.error(`Contact not found: ${contactName}`);
      return;
    }

    const messageId = `send-${Date.now()}`;
    console.log('Sending message…');
    const result = await session.sendDmText(contact.key, text, messageId);
    if (!result.ok) {
      console.error('Send failed:', result.error);
      return;
    }

    // Wait for delivery confirmation (sent → ack), or give up after the timeout.
    const [, finalState] = await waitForEvent(session, 'messageState', {
      predicate: (id, state) => id === messageId && (state === 'ack' || state === 'failed'),
    });
    console.log(`Message ${finalState}`);
  } catch (err) {
    console.error('Error:', err);
  } finally {
    session.stop();
    port.close();
  }
});

session.start();
