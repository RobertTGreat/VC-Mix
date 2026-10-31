import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import type { DeviceIdentity } from '../audio/audio.types.js';

export const PROJECT_DIRECTORY = fileURLToPath(new URL('../../', import.meta.url));
export const ENVIRONMENT_PATH = fileURLToPath(new URL('../../.env', import.meta.url));
export const ROUTES_PATH = fileURLToPath(new URL('../../routes.json', import.meta.url));
export const DISCORD_ID_PATTERN = /^\d{17,20}$/;

export interface BotConfiguration {
  token: string;
  guildId: string;
  channelId: string;
  ignoredUserIds: string[];
}

export interface UserRoute {
  userId: string;
  device: DeviceIdentity;
}

export interface RoutingConfiguration {
  devicePool: DeviceIdentity[];
  routes: UserRoute[];
}

/** Stable device identity; numeric indices can change after reboot. */
export function deviceKey(device: DeviceIdentity): string {
  return JSON.stringify([device.hostApi, device.name]);
}

function parseDevice(input: unknown): DeviceIdentity {
  if (!input || typeof input !== 'object' || !('name' in input) || !('hostApi' in input)
    || typeof input.name !== 'string' || !input.name.trim()
    || typeof input.hostApi !== 'string' || !input.hostApi.trim()) {
    throw new Error('Each device needs a nonempty name and hostApi. Run npm run devices.');
  }
  if (process.platform === 'win32' && input.hostApi !== 'Windows WASAPI') {
    throw new Error('Use Windows WASAPI outputs so the same device cannot be assigned under multiple audio APIs.');
  }
  return { name: input.name, hostApi: input.hostApi };
}

function parseRoute(input: unknown): UserRoute {
  if (!input || typeof input !== 'object' || !('userId' in input) || !('device' in input)
    || typeof input.userId !== 'string' || !DISCORD_ID_PATTERN.test(input.userId)) {
    throw new Error('Each route needs a valid Discord userId and a device.');
  }
  return { userId: input.userId, device: parseDevice(input.device) };
}

/** Validate all persisted routes, including collisions that would mix participants. */
export function parseRoutingConfiguration(input: unknown): RoutingConfiguration {
  if (!input || typeof input !== 'object' || !('devicePool' in input) || !('routes' in input)
    || !Array.isArray(input.devicePool) || !Array.isArray(input.routes)) {
    throw new Error('routes.json must contain devicePool and routes arrays.');
  }
  const devicePool = input.devicePool.map(parseDevice);
  const routes = input.routes.map(parseRoute);
  if (new Set(devicePool.map(deviceKey)).size !== devicePool.length) {
    throw new Error('The device pool contains duplicate outputs. Each cable can appear once.');
  }
  if (new Set(routes.map((route) => route.userId)).size !== routes.length) {
    throw new Error('A Discord user has more than one route. Keep one route per user.');
  }
  if (new Set(routes.map((route) => deviceKey(route.device))).size !== routes.length) {
    throw new Error('Two users share an output. Assign separate devices to keep voices isolated.');
  }
  return { devicePool, routes };
}

export function loadRoutingConfiguration(): RoutingConfiguration {
  if (!existsSync(ROUTES_PATH)) return { devicePool: [], routes: [] };
  try {
    return parseRoutingConfiguration(JSON.parse(readFileSync(ROUTES_PATH, 'utf8')));
  } catch (error) {
    throw new Error(`Could not read routes.json: ${error instanceof Error ? error.message : 'Invalid configuration.'}`);
  }
}

export function saveRoutingConfiguration(configuration: RoutingConfiguration): void {
  const validated = parseRoutingConfiguration(configuration);
  const temporaryPath = `${ROUTES_PATH}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, ROUTES_PATH);
}

/** Load an official bot's credentials from the local environment. */
export function loadBotConfiguration(): BotConfiguration {
  if (existsSync(ENVIRONMENT_PATH)) loadEnvFile(ENVIRONMENT_PATH);
  const token = process.env.DISCORD_BOT_TOKEN?.trim();
  const guildId = process.env.DISCORD_GUILD_ID?.trim();
  const channelId = process.env.DISCORD_VOICE_CHANNEL_ID?.trim();
  if (!token || /[\r\n]/.test(token)) throw new Error('Missing bot token. Run npm run configure.');
  if (!guildId || !DISCORD_ID_PATTERN.test(guildId)) throw new Error('Invalid server ID. Run npm run configure.');
  if (!channelId || !DISCORD_ID_PATTERN.test(channelId)) throw new Error('Invalid voice-channel ID. Run npm run configure.');
  const ignoredUserIds = (process.env.DISCORD_IGNORED_USER_IDS ?? '').split(',').map((userId) => userId.trim()).filter(Boolean);
  if (ignoredUserIds.some((userId) => !DISCORD_ID_PATTERN.test(userId))) {
    throw new Error('DISCORD_IGNORED_USER_IDS must contain comma-separated Discord user IDs.');
  }
  return { token, guildId, channelId, ignoredUserIds };
}
