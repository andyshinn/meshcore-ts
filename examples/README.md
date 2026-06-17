# Examples

Runnable examples for `@andyshinn/meshcore-ts`, ported from
[meshcore.js](https://github.com/liamcottle/meshcore.js). They use the library's
built-in transports (`SerialTransport`, `createBleTransport`) and run with `tsx`
against the local source — no build step.

## Running

```
pnpm example examples/<file>.ts [args]
```

Most examples take your device's serial port as the first argument:

```
pnpm example examples/get-contacts.ts /dev/cu.usbmodemXXXX
```

Finding your serial port:

- **macOS:** `ls /dev/cu.usbmodem*`
- **Linux:** `ls /dev/ttyACM* /dev/ttyUSB*`
- **Windows:** a `COM<n>` port (Device Manager → Ports)

## The examples

| Example | Needs device? | What it does |
| --- | --- | --- |
| `parse-packet.ts` | no | Parse raw mesh-packet bytes |
| `parse-advert.ts` | no | Parse an advert from a `meshcore://` URL |
| `decode-on-air-packet.ts` | no | Structurally decode on-air packets (advert, group/text, trace) into a tagged union |
| `get-contacts.ts` | serial | List the device's contacts |
| `get-device-info.ts` | serial | Print device + radio info (firmware, model, battery, LoRa params) |
| `send-contact-message.ts <port> <name> [text]` | serial | DM a contact found by name |
| `send-channel-message.ts <port> <channel> [text]` | serial | Post to a channel found by name |
| `echo-bot.ts` | serial | Echo every incoming DM back to the sender |
| `command-bot.ts` | serial | Reply to `/ping`, `/date`, `/help` |
| `sign-data.ts <port> [text]` | serial | Sign data with the device key |
| `get-repeater-status.ts <port> <pubkey-prefix> [pw]` | serial | Login + fetch repeater status |
| `get-repeater-telemetry.ts <port> <pubkey-prefix> [pw]` | serial | Login + fetch repeater telemetry |
| `get-repeater-neighbours.ts <port> <pubkey-prefix> [pw]` | serial | Login + fetch repeater neighbours |
| `get-sensor-telemetry.ts <port> <pubkey-prefix>` | serial | Fetch sensor telemetry (no login) |
| `ble-get-contacts.ts` | BLE | List contacts over BLE (requires `@stoprocent/noble`) |
| `ble-get-device-info.ts` | BLE | Print device + radio info over BLE (requires `@stoprocent/noble`) |

The three no-device examples (`parse-packet.ts`, `parse-advert.ts`,
`decode-on-air-packet.ts`) run with no hardware and print deterministic output.
