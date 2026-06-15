import { SerialPort } from 'serialport';
import { MeshCoreSession } from '@andyshinn/meshcore-ts';
import { SerialTransport } from '@andyshinn/meshcore-ts/transports';
import { requireArg } from './lib/helpers';

const usage =
  'usage: npm run example examples/send-channel-message.ts <serial-port> <channel-name> [text]';
const path = requireArg(process.argv, 2, usage);
const channelName = requireArg(process.argv, 3, usage);
const text = process.argv[4] ?? 'Hello from meshcore-ts';

const port = new SerialPort({ path, baudRate: 115200 });
const session = new MeshCoreSession({ transport: new SerialTransport(port) });

session.events.on('transportState', async (state) => {
  if (state !== 'connected') return;
  console.log('Connected');
  try {
    await session.getChannels();
    const channel = session.findChannelByName(channelName);
    if (!channel) {
      console.error(`Channel not found: ${channelName}`);
      return;
    }

    console.log('Sending message…');
    const result = await session.sendChannelText(channel.key, text);
    if (!result.ok) {
      console.error('Send failed:', result.error);
      return;
    }
    console.log('Sent to channel');
  } catch (err) {
    console.error('Error:', err);
  } finally {
    session.stop();
    port.close();
  }
});

session.start();
