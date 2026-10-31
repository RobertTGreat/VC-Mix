import { Client, Events, GatewayIntentBits } from 'discord.js';
import { VoiceSession } from '../discord/VoiceSession.js';
import type { VoiceSessionObserver } from '../discord/VoiceSessionObserver.js';
import { ObsTransport, parseHelperCommand, type ConnectCommand, type HelperCommand } from './protocol.js';
import { ReceiverCommandQueue } from './ReceiverCommandQueue.js';
import { SmoothVoiceOutput } from '../audio/SmoothVoiceOutput.js';
import type { PcmOutput } from '../audio/audio.types.js';

const transport = new ObsTransport(process.stdout);
const TEST_PARTICIPANTS = [
  { userId: '111111111111111111', name: 'Test voice A (440 Hz)', frequency: 440 },
  { userId: '222222222222222222', name: 'Test voice B (880 Hz)', frequency: 880 },
] as const;
let activeClient: Client | undefined;
let activeSession: VoiceSession | undefined;
let testTimer: NodeJS.Timeout | undefined;
let testOutputs: PcmOutput[] = [];
let activeToken = '';

function reportError(error: unknown): void {
  let message = error instanceof Error ? error.message : 'The receiver encountered an unexpected error.';
  if (activeToken) message = message.replaceAll(activeToken, '[redacted]');
  transport.event({ type: 'error', message: message.slice(0, 1000) });
}

const observer: VoiceSessionObserver = {
  setStatus: (message) => transport.event({ type: 'status', message }),
  add: (userId, name) => transport.event({ type: 'participant', userId, name }),
  remove: (userId) => transport.event({ type: 'left', userId }),
  level: () => {},
  notice: (message) => reportError(new Error(message)),
};

async function disconnect(): Promise<void> {
  clearInterval(testTimer);
  testTimer = undefined;
  for (const output of testOutputs) output.close();
  testOutputs = [];
  await activeSession?.close();
  activeSession = undefined;
  await activeClient?.destroy();
  activeClient = undefined;
  activeToken = '';
  transport.event({ type: 'reset' });
  transport.event({ type: 'status', message: 'Disconnected' });
}

async function connect(command: ConnectCommand, cancellation: AbortSignal): Promise<void> {
  activeToken = command.token;
  const signal = AbortSignal.any([cancellation, AbortSignal.timeout(30_000)]);
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  client.on(Events.Error, (error) => { if (!cancellation.aborted) reportError(error); });
  activeClient = client;
  transport.event({ type: 'status', message: 'Connecting to Discord…' });
  const ready = new Promise<void>((resolve, reject) => {
    const abort = (): void => reject(new Error('Discord connection was cancelled or timed out.'));
    signal.addEventListener('abort', abort, { once: true });
    client.once(Events.ClientReady, () => { signal.removeEventListener('abort', abort); resolve(); });
    client.login(command.token).catch((error: unknown) => { signal.removeEventListener('abort', abort); reject(error); });
  });
  await ready;
  signal.throwIfAborted();
  activeSession = new VoiceSession(client, command, undefined, observer, (error) => {
    if (cancellation.aborted) return;
    reportError(error);
    void commandQueue.submit({ command: 'disconnect' });
  }, (userId) => ({ label: 'OBS participant source', output: createParticipantOutput(userId) }));
  await activeSession.start(signal);
}

function createParticipantOutput(userId: string): PcmOutput {
  return new SmoothVoiceOutput({
    write: (pcm, timestamp) => transport.audio(userId, pcm, timestamp), close: () => {},
  }, (message) => observer.notice(`${userId}: ${message}`));
}

function testTone(frequency: number, sampleOffset: number): Buffer {
  const pcm = Buffer.alloc(960 * 4);
  for (let sampleIndex = 0; sampleIndex < 960; sampleIndex += 1) {
    const amplitude = Math.round(Math.sin(2 * Math.PI * frequency * (sampleOffset + sampleIndex) / 48_000) * 4000);
    pcm.writeInt16LE(amplitude, sampleIndex * 4);
    pcm.writeInt16LE(amplitude, sampleIndex * 4 + 2);
  }
  return pcm;
}

function startTestAudio(): void {
  for (const participant of TEST_PARTICIPANTS) observer.add(participant.userId, participant.name, 'OBS');
  const voices = TEST_PARTICIPANTS.map((participant) => ({ ...participant, output: createParticipantOutput(participant.userId) }));
  testOutputs = voices.map((voice) => voice.output);
  let sampleOffset = 0;
  const startedAt = process.hrtime.bigint();
  testTimer = setInterval(() => {
    const elapsedSamples = Number((process.hrtime.bigint() - startedAt) * 48_000n / 1_000_000_000n);
    // Keep test tones continuous when Windows delays a timer tick; bound catch-up to 200 ms.
    if (elapsedSamples - sampleOffset > 9600) sampleOffset = Math.floor(elapsedSamples / 960) * 960;
    while (sampleOffset + 960 <= elapsedSamples) {
      for (const participant of voices) {
        participant.output.write(testTone(participant.frequency, sampleOffset));
      }
      sampleOffset += 960;
    }
  }, 10);
  transport.event({ type: 'status', message: 'Test audio: add both test participants as sources. Disconnect to stop.' });
}

async function execute(command: HelperCommand, signal: AbortSignal): Promise<void> {
  await disconnect();
  if (signal.aborted) return;
  switch (command.command) {
    case 'connect': await connect(command, signal); break;
    case 'test': startTestAudio(); break;
    case 'shutdown': process.exitCode = 0; process.stdin.destroy(); break;
    case 'disconnect': break;
  }
}

const commandQueue = new ReceiverCommandQueue<HelperCommand>(execute, async (error, cancelled) => {
  if (!cancelled) reportError(error);
  await disconnect();
});

let inputBuffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  inputBuffer += chunk;
  if (inputBuffer.length > 65_536) { reportError(new Error('Settings message is too large.')); process.exit(1); }
  let newline = inputBuffer.indexOf('\n');
  while (newline !== -1) {
    const line = inputBuffer.slice(0, newline);
    inputBuffer = inputBuffer.slice(newline + 1);
    try {
      const command = parseHelperCommand(line);
      void commandQueue.submit(command);
    } catch (error) { reportError(error); }
    newline = inputBuffer.indexOf('\n');
  }
});
process.stdin.on('end', () => { void commandQueue.submit({ command: 'shutdown' }).finally(() => process.exit(0)); });
process.stdout.on('error', () => process.exit(0));
process.on('uncaughtException', (error) => { reportError(error); void disconnect().finally(() => process.exit(1)); });
process.on('unhandledRejection', (error: unknown) => { reportError(error); void disconnect().finally(() => process.exit(1)); });
transport.event({ type: 'ready', version: 1 });
