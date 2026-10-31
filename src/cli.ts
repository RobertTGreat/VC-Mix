import { configure } from './commands/configure.js';
import { devices } from './commands/devices.js';
import { doctor } from './commands/doctor.js';
import { route } from './commands/route.js';
import { startSplitter } from './commands/start.js';
import { testDevice } from './commands/testDevice.js';

const COMMAND = {
  start: 'start', configure: 'configure', devices: 'devices', doctor: 'doctor', route: 'route', testDevice: 'test-device',
} as const;

async function main(): Promise<void> {
  const [command = COMMAND.start, ...argumentsList] = process.argv.slice(2);
  switch (command) {
    case COMMAND.start:
      if (argumentsList.some((argument) => argument !== '--meters-only')) throw new Error('Unknown start option. Supported: --meters-only');
      return startSplitter(argumentsList.includes('--meters-only'));
    case COMMAND.configure: return configure();
    case COMMAND.devices: return devices();
    case COMMAND.doctor: return doctor();
    case COMMAND.route: return route(argumentsList);
    case COMMAND.testDevice: return testDevice(argumentsList);
    default: throw new Error('Commands: start [--meters-only], configure, devices, doctor, route USER_ID DEVICE_ID, test-device DEVICE_ID.');
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'An unexpected error occurred.';
  const token = process.env.DISCORD_BOT_TOKEN;
  const safeMessage = token ? message.replaceAll(token, '[redacted token]') : message;
  process.stderr.write(`Error: ${safeMessage}\n`);
  process.exitCode = 1;
});
