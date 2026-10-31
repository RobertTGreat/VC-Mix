import { listAudioDevices } from '../audio/deviceBridge.js';
import type { AudioDevice } from '../audio/audio.types.js';

const VIRTUAL_OUTPUT_PATTERN = /\bCABLE\b|Voicemeeter|Virtual Audio/i;

/** Print playback endpoints; OBS captures the matching recording endpoint. */
export function printDevices(devices: AudioDevice[]): void {
  const wasapiDevices = devices.filter((device) => device.hostApi === 'Windows WASAPI');
  const recommendedDevices = wasapiDevices.length ? wasapiDevices : devices;
  process.stdout.write('\nPlayback devices (IDs are for this machine/session):\n');
  for (const device of recommendedDevices) {
    const label = VIRTUAL_OUTPUT_PATTERN.test(device.name) ? ' [virtual]' : '';
    process.stdout.write(`  ${device.id}: ${device.name} | ${device.hostApi}${label}\n`);
  }
  if (!recommendedDevices.length) process.stdout.write('  No stereo playback devices found.\n');
  if (!recommendedDevices.some((device) => VIRTUAL_OUTPUT_PATTERN.test(device.name))) {
    process.stdout.write('No virtual cables found. Install separate virtual cables for OBS, or use --meters-only.\n');
  }
  process.stdout.write('For VB-CABLE, send to CABLE Input here; capture CABLE Output in OBS.\n');
}

export async function devices(): Promise<void> { printDevices(await listAudioDevices()); }
