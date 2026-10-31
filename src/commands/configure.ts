import { writeFileSync } from 'node:fs';
import { emitKeypressEvents, type Key } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { listAudioDevices } from '../audio/deviceBridge.js';
import {
  DISCORD_ID_PATTERN, ENVIRONMENT_PATH, loadRoutingConfiguration, saveRoutingConfiguration,
} from '../configuration/configuration.js';
import { printDevices } from './devices.js';

function readHiddenToken(): Promise<string> {
  if (!stdin.isTTY) throw new Error('Configure needs an interactive terminal. Alternatively, copy .env.example to .env.');
  stdout.write('Discord bot token (hidden): ');
  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let token = '';
    const finish = (error?: Error) => {
      stdin.off('keypress', handleKey);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      if (error) reject(error); else resolve(token.trim());
    };
    const handleKey = (text: string | undefined, key: Key) => {
      if (key.ctrl && key.name === 'c') return finish(new Error('Configuration cancelled.'));
      if (key.name === 'return' || key.name === 'enter') return finish();
      if (key.name === 'backspace') { token = token.slice(0, -1); return; }
      if (text && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(text)) token += text;
    };
    stdin.on('keypress', handleKey);
  });
}

function validateId(identifier: string, label: string): string {
  if (!DISCORD_ID_PATTERN.test(identifier)) throw new Error(`${label} must be a Discord ID (17-20 digits).`);
  return identifier;
}

/** Save secrets locally without echoing them; choose output devices by stable identity. */
export async function configure(): Promise<void> {
  const token = await readHiddenToken();
  if (!/^[A-Za-z\d._-]{20,}$/.test(token)) throw new Error('Enter the bot token from the Developer Portal, without a Bot prefix.');
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const guildId = validateId((await prompt.question('Discord server ID: ')).trim(), 'Server ID');
    const channelId = validateId((await prompt.question('Voice channel ID: ')).trim(), 'Channel ID');
    const ignoredUserId = (await prompt.question('Your user ID to exclude your mic (optional, Enter to skip): ')).trim();
    if (ignoredUserId) validateId(ignoredUserId, 'Your user ID');
    const devices = await listAudioDevices();
    printDevices(devices);
    const selection = (await prompt.question('Output device IDs, comma-separated (Enter = meters only): ')).trim();
    const devicePool = parseSelection(selection, devices);
    const routing = loadRoutingConfiguration();
    saveRoutingConfiguration({ ...routing, devicePool });
    writeFileSync(ENVIRONMENT_PATH, [
      `DISCORD_BOT_TOKEN=${token}`, `DISCORD_GUILD_ID=${guildId}`,
      `DISCORD_VOICE_CHANNEL_ID=${channelId}`, `DISCORD_IGNORED_USER_IDS=${ignoredUserId}`, '',
    ].join('\n'), { mode: 0o600 });
    stdout.write(`\nSaved .env and routes.json. Next: ${devicePool.length ? 'npm start' : 'npm start -- --meters-only'}\n`);
  } finally { prompt.close(); }
}

function parseSelection(selection: string, devices: Awaited<ReturnType<typeof listAudioDevices>>) {
  if (!selection) return [];
  const identifiers = selection.split(',').map((identifier) => identifier.trim());
  return identifiers.map((identifier) => {
    if (!/^\d+$/.test(identifier)) throw new Error(`Invalid device ID: ${identifier}`);
    const device = devices.find((available) => available.id === Number(identifier));
    if (!device) throw new Error(`Output device ${identifier} is unavailable.`);
    return { name: device.name, hostApi: device.hostApi };
  });
}
