import { SerialPort } from 'serialport';
import { MeshCoreSession } from '@andyshinn/meshcore-ts';
import { SerialTransport } from '@andyshinn/meshcore-ts/transports';
import { requireArg } from './lib/helpers';

const path = requireArg(
  process.argv,
  2,
  'usage: npm run example examples/command-bot.ts <serial-port>',
);

const port = new SerialPort({ path, baudRate: 115200 });
const session = new MeshCoreSession({ transport: new SerialTransport(port) });

const handled = new Set<string>();

const helpMenu = [
  '🤖 Command Bot Help',
  '/help - show this menu',
  '/ping - replies with pong',
  '/date - replies with current date',
].join('\n');

function reply(text: string): string {
  switch (text.trim()) {
    case '/ping':
      return 'PONG! 🏓';
    case '/date':
      return new Date().toISOString();
    default:
      return helpMenu;
  }
}

session.events.on('transportState', async (state) => {
  if (state !== 'connected') return;
  console.log('Connected');
  await session.syncDeviceTime();
  await session.sendSelfAdvert(true);
});

session.events.on('messages', async (key, messages) => {
  const last = messages.at(-1);
  if (!last || !last.fromPublicKeyHex || handled.has(last.id)) return;
  handled.add(last.id);

  console.log(`Command from ${key}: ${last.body}`);
  await session.sendDmText(key, reply(last.body), `cmd-${last.id}`);
});

session.start();
console.log('Command bot running. Ctrl-C to stop.');
