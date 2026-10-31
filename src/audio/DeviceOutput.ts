import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { AUDIO_BYTES_PER_SECOND, AUDIO_FORMAT } from './audioFormat.js';
import { AUDIO_HELPER_PATH, PYTHON_PATH } from './deviceBridge.js';
import type { AudioDevice, PcmOutput } from './audio.types.js';

const MAXIMUM_PIPE_BYTES = AUDIO_BYTES_PER_SECOND * AUDIO_FORMAT.maximumQueueMilliseconds / 1000;
const STARTUP_TIMEOUT_MILLISECONDS = 10_000;

/** Stream a single user's PCM to a single independent Windows output. */
export class DeviceOutput implements PcmOutput {
  private closed = false;
  private stderr = '';
  private lastDropNoticeAt = 0;
  droppedBytes = 0;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly onError: (error: Error) => void,
    private readonly onWarning: (message: string) => void,
  ) {
    child.stderr.on('data', (chunk: Buffer) => {
      const message = chunk.toString().trim();
      this.stderr = (this.stderr + message).slice(-2000);
      this.onWarning(message);
    });
    child.stdin.on('error', (error: Error) => this.fail(error));
    child.on('error', (error: Error) => this.fail(error));
    child.on('exit', (code) => {
      if (!this.closed) this.fail(new Error(`Audio output stopped (exit ${code}): ${this.stderr.trim()}`));
    });
  }

  static async open(
    device: AudioDevice,
    onError: (error: Error) => void,
    onWarning: (message: string) => void,
  ): Promise<DeviceOutput> {
    const child = spawn(PYTHON_PATH, [AUDIO_HELPER_PATH, 'play', '--device', String(device.id)], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const output = new DeviceOutput(child, onError, onWarning);
    try {
      await output.waitUntilReady();
      return output;
    } catch (error) {
      output.close();
      throw error;
    }
  }

  private waitUntilReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const lines = createInterface({ input: this.child.stdout });
      const cleanup = () => { clearTimeout(timeout); lines.close(); this.child.off('exit', onExit); this.child.off('error', onError); };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const onExit = () => onError(new Error(`Could not open audio output: ${this.stderr.trim()}`));
      const timeout = setTimeout(() => onError(new Error('Audio output did not become ready within 10 seconds.')), STARTUP_TIMEOUT_MILLISECONDS);
      this.child.once('exit', onExit);
      this.child.once('error', onError);
      lines.once('line', (line) => {
        try {
          const message: unknown = JSON.parse(line);
          if (!message || typeof message !== 'object' || !('ready' in message) || message.ready !== true) {
            throw new Error('Audio bridge returned an unexpected startup response.');
          }
          cleanup(); resolve();
        } catch (error) { onError(error instanceof Error ? error : new Error('Invalid audio startup response.')); }
      });
    });
  }

  write(audio: Buffer): void {
    if (this.closed) return;
    if (this.child.stdin.writableLength + audio.length > MAXIMUM_PIPE_BYTES) {
      this.droppedBytes += audio.length;
      if (Date.now() - this.lastDropNoticeAt >= 5000) {
        this.lastDropNoticeAt = Date.now();
        this.onWarning(`Audio output stalled; dropped ${this.droppedBytes} PCM bytes to limit delay.`);
      }
      return;
    }
    this.child.stdin.write(audio);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    const termination = setTimeout(() => this.child.kill(), 1000);
    termination.unref();
    this.child.once('exit', () => clearTimeout(termination));
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.close();
    this.onError(error);
  }
}
