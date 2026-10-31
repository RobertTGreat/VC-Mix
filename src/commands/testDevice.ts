import { setTimeout as wait } from 'node:timers/promises';
import { DeviceOutput } from '../audio/DeviceOutput.js';
import { listAudioDevices } from '../audio/deviceBridge.js';

/** Open a selected output and send only digital silence; no bot login is needed. */
export async function testDevice(argumentsList: string[]): Promise<void> {
  const [identifier] = argumentsList;
  if (argumentsList.length !== 1 || !identifier || !/^\d+$/.test(identifier)) {
    throw new Error('Usage: npm run test:device -- DEVICE_ID. Find the ID with npm run devices.');
  }
  const device = (await listAudioDevices()).find((available) => available.id === Number(identifier));
  if (!device) throw new Error(`Output device ${identifier} is unavailable.`);
  let outputFailure: Error | undefined;
  const output = await DeviceOutput.open(device,
    (error) => { outputFailure = error; },
    (message) => process.stderr.write(`Audio warning: ${message}\n`));
  try {
    output.write(Buffer.alloc(3840));
    await wait(250);
    if (outputFailure) throw outputFailure;
  } finally { output.close(); }
  process.stdout.write(`Silent output check passed: ${device.name}\n`);
}
