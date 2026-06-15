import { SerialPort } from 'serialport';
import { MeshCoreSession } from '@andyshinn/meshcore-ts';
import { SerialTransport } from '@andyshinn/meshcore-ts/transports';
import { requireArg } from './lib/helpers';

const path = requireArg(
  process.argv,
  2,
  'usage: npm run example examples/echo-bot.ts <serial-port>',
);

const port = new SerialPort({ path, baudRate: 115200 });
const session = new MeshCoreSession({ transport: new SerialTransport(port) });

const handled = new Set<string>();

session.events.on('transportState', async (state) => {
  if (state !== 'connected') return;
  console.log('Connected');
  await session.syncDeviceTime();
  await session.sendSelfAdvert(true);
});

session.events.on('messages', async (key, messages) => {
  const last = messages.at(-1);
  // Only inbound messages (owner sends omit fromPublicKeyHex), once each.
  if (!last || !last.fromPublicKeyHex || handled.has(last.id)) return;
  handled.add(last.id);

  console.log(`Echoing to ${key}: ${last.body}`);
  await session.sendDmText(key, last.body, `echo-${last.id}`);
});

session.start();
console.log('Echo bot running. Ctrl-C to stop.');
