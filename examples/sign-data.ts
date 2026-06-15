import { Buffer } from 'node:buffer';
import { SerialPort } from 'serialport';
import { MeshCoreSession } from '@andyshinn/meshcore-ts';
import { SerialTransport } from '@andyshinn/meshcore-ts/transports';
import { requireArg } from './lib/helpers';

const usage = 'usage: npm run example examples/sign-data.ts <serial-port> [text]';
const path = requireArg(process.argv, 2, usage);
const text = process.argv[3] ?? 'meshcore-ts';

const port = new SerialPort({ path, baudRate: 115200 });
const session = new MeshCoreSession({ transport: new SerialTransport(port) });

session.events.on('transportState', async (state) => {
  if (state !== 'connected') return;
  console.log('Connected');
  try {
    const signature = await session.signData(Buffer.from(text, 'utf8'));
    console.log(`Signature: ${signature}`);
  } catch (err) {
    console.error('Sign failed:', err);
  } finally {
    session.stop();
    port.close();
  }
});

session.start();
