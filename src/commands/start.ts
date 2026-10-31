import { once } from 'node:events';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { listAudioDevices, runAudioHelper } from '../audio/deviceBridge.js';
import {
  loadBotConfiguration, loadRoutingConfiguration, saveRoutingConfiguration,
  deviceKey,
} from '../configuration/configuration.js';
import { VoiceSession } from '../discord/VoiceSession.js';
import { RouteAllocator } from '../routing/RouteAllocator.js';
import { ConsoleView } from '../terminal/ConsoleView.js';

async function prepareAllocator(metersOnly: boolean): Promise<RouteAllocator | undefined> {
  if (metersOnly) return undefined;
  const routing = loadRoutingConfiguration();
  const configuredDevices = [...routing.devicePool, ...routing.routes.map((route) => route.device)];
  if (!configuredDevices.length) {
    throw new Error('No output routes configured. Run npm run configure, or use npm start -- --meters-only.');
  }
  const devices = await listAudioDevices();
  const allocator = new RouteAllocator(routing, devices, saveRoutingConfiguration);
  for (const device of devices.filter((available) => configuredDevices.some((configured) => deviceKey(configured) === deviceKey(available)))) {
    await runAudioHelper(['check', '--device', String(device.id)]);
  }
  return allocator;
}

/** Log in with a bot, keep all receive streams independent, and clean up on exit. */
export async function startSplitter(metersOnly: boolean): Promise<void> {
  const configuration = loadBotConfiguration();
  const allocator = await prepareAllocator(metersOnly);
  const controller = new AbortController();
  const stop = () => controller.abort();
  const view = new ConsoleView();
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  const session = new VoiceSession(client, configuration, allocator, view, (error) => controller.abort(error));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  view.start();
  try {
    await connectClient(client, configuration.token, controller.signal);
    await session.start(controller.signal);
    if (!controller.signal.aborted) await once(controller.signal, 'abort');
    if (controller.signal.reason instanceof Error && controller.signal.reason.name !== 'AbortError') throw controller.signal.reason;
  } catch (error) {
    if (!controller.signal.aborted || (controller.signal.reason instanceof Error && controller.signal.reason.name !== 'AbortError')) throw error;
  } finally {
    await session.close();
    await client.destroy();
    view.stop();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

async function connectClient(client: Client, token: string, signal: AbortSignal): Promise<void> {
  const timeoutSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  await Promise.all([
    once(client, Events.ClientReady, { signal: timeoutSignal }),
    client.login(token),
  ]);
}
