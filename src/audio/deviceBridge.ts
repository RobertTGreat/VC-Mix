import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { AudioDevice } from './audio.types.js';

const executeFile = promisify(execFile);
export const AUDIO_HELPER_PATH = fileURLToPath(new URL('../../scripts/audio_device.py', import.meta.url));
export const PYTHON_PATH = fileURLToPath(new URL(
  process.platform === 'win32' ? '../../.venv/Scripts/python.exe' : '../../.venv/bin/python',
  import.meta.url,
));

/** Run the isolated Python audio bridge without a shell. */
export async function runAudioHelper(argumentsList: string[]): Promise<string> {
  try {
    await access(PYTHON_PATH);
  } catch {
    throw new Error('Python audio environment is missing. Run npm run setup first.');
  }
  try {
    const result = await executeFile(PYTHON_PATH, [AUDIO_HELPER_PATH, ...argumentsList], {
      timeout: 15_000, windowsHide: true, maxBuffer: 1_048_576,
    });
    return result.stdout;
  } catch (error) {
    const failure = error as Error & { stderr?: string };
    throw new Error(`Audio bridge failed: ${failure.stderr?.trim() || failure.message}`);
  }
}

/** Enumerate playback devices; only playback endpoints can receive routed PCM. */
export async function listAudioDevices(): Promise<AudioDevice[]> {
  const payload: unknown = JSON.parse(await runAudioHelper(['list']));
  if (!payload || typeof payload !== 'object' || !('devices' in payload) || !Array.isArray(payload.devices)) {
    throw new Error('Audio bridge returned an invalid device list.');
  }
  return payload.devices.map((device: unknown) => {
    if (!device || typeof device !== 'object' || !('id' in device) || !('name' in device)
      || !('hostApi' in device) || !('channels' in device)
      || typeof device.id !== 'number' || typeof device.name !== 'string'
      || typeof device.hostApi !== 'string' || typeof device.channels !== 'number') {
      throw new Error('Audio bridge returned an invalid device entry.');
    }
    return { id: device.id, name: device.name, hostApi: device.hostApi, channels: device.channels };
  });
}
