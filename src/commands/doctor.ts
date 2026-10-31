import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { generateDependencyReport } from '@discordjs/voice';
import { ParticipantAudio } from '../audio/ParticipantAudio.js';
import { listAudioDevices, runAudioHelper } from '../audio/deviceBridge.js';
import { deviceKey, ENVIRONMENT_PATH, loadRoutingConfiguration } from '../configuration/configuration.js';
import { RouteAllocator } from '../routing/RouteAllocator.js';
import { printDevices } from './devices.js';

/** Check dependencies and device format support without logging in or playing sound. */
export async function doctor(): Promise<void> {
  process.stdout.write(`Node ${process.version}\n`);
  const majorVersion = Number(process.versions.node.split('.')[0]);
  const minorVersion = Number(process.versions.node.split('.')[1]);
  if (majorVersion < 22 || (majorVersion === 22 && minorVersion < 12)) throw new Error('Install Node.js 22.12 or newer.');
  const require = createRequire(import.meta.url);
  require('@snazzah/davey');
  process.stdout.write('DAVE encryption: loaded\n');
  const audio = new ParticipantAudio({ write: () => {}, close: () => {} }, () => {});
  audio.close();
  process.stdout.write('Native Opus decoder: @discordjs/opus (C libopus) loaded\n');
  const devices = await listAudioDevices();
  printDevices(devices);
  const routing = loadRoutingConfiguration();
  new RouteAllocator(routing, devices, () => {});
  const configuredKeys = new Set([...routing.devicePool, ...routing.routes.map((entry) => entry.device)].map(deviceKey));
  for (const device of devices.filter((device) => configuredKeys.has(deviceKey(device)))) {
    await runAudioHelper(['check', '--device', String(device.id)]);
    process.stdout.write(`48 kHz stereo: ${device.name} OK\n`);
  }
  process.stdout.write(existsSync(ENVIRONMENT_PATH) ? '\n.env exists (token was not printed or tested).\n' : '\nBot setup pending: npm run configure\n');
  process.stdout.write('\nVoice-library dependency report:\n');
  process.stdout.write(generateDependencyReport() + '\n');
}
