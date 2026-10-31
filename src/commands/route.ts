import { listAudioDevices } from '../audio/deviceBridge.js';
import {
  DISCORD_ID_PATTERN, loadRoutingConfiguration, saveRoutingConfiguration,
} from '../configuration/configuration.js';

/** Pin a Discord user to a device, or free a previously reserved route. */
export async function route(argumentsList: string[]): Promise<void> {
  const [userOrAction, deviceOrUser] = argumentsList;
  const configuration = loadRoutingConfiguration();
  if (userOrAction === 'remove') {
    if (!deviceOrUser || !DISCORD_ID_PATTERN.test(deviceOrUser)) throw new Error('Usage: npm run route -- remove USER_ID');
    configuration.routes = configuration.routes.filter((existing) => existing.userId !== deviceOrUser);
    saveRoutingConfiguration(configuration);
    process.stdout.write('Route removed. Restart the receiver to apply.\n');
    return;
  }
  if (!userOrAction || !DISCORD_ID_PATTERN.test(userOrAction) || !deviceOrUser || !/^\d+$/.test(deviceOrUser)) {
    throw new Error('Usage: npm run route -- USER_ID DEVICE_ID. Use npm run devices to find a device ID.');
  }
  const selectedDevice = (await listAudioDevices()).find((device) => device.id === Number(deviceOrUser));
  if (!selectedDevice) throw new Error(`Output device ${deviceOrUser} is unavailable.`);
  configuration.routes = [
    ...configuration.routes.filter((existing) => existing.userId !== userOrAction),
    { userId: userOrAction, device: { name: selectedDevice.name, hostApi: selectedDevice.hostApi } },
  ];
  saveRoutingConfiguration(configuration);
  process.stdout.write(`Saved route to ${selectedDevice.name}. Restart the receiver to apply.\n`);
}
