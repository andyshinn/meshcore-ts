import { SerialPort } from 'serialport';
import { MeshCoreSession } from '@andyshinn/meshcore-ts';
import { SerialTransport } from '@andyshinn/meshcore-ts/transports';
import { requireArg, waitForEvent } from './lib/helpers';

const usage =
  'usage: pnpm example examples/get-repeater-telemetry.ts <serial-port> <pubkey-prefix-hex> [password]';
const path = requireArg(process.argv, 2, usage);
const prefix = requireArg(process.argv, 3, usage);
const password = process.argv[4] ?? '';

const port = new SerialPort({ path, baudRate: 115200 });
const session = new MeshCoreSession({ transport: new SerialTransport(port) });

session.events.on('transportState', async (state) => {
  if (state !== 'connected') return;
  console.log('Connected');
  try {
    await session.getContacts();
    const repeater = session.findContactByPublicKeyPrefix(prefix);
    if (!repeater) {
      console.error(`Repeater not found for prefix: ${prefix}`);
      return;
    }

    console.log('Logging in…');
    await session.repeaterLogin(repeater.key, password);

    console.log('Fetching telemetry…');
    const sent = await session.sendTelemetryReq(repeater.key);
    if (!sent.ok) {
      console.error('Telemetry request failed:', sent.error);
      return;
    }
    const [telemetry] = await waitForEvent(session, 'repeaterTelemetry');
    console.dir(telemetry, { depth: null });
  } catch (err) {
    console.error('Error:', err);
  } finally {
    session.stop();
    port.close();
  }
});

session.start();
