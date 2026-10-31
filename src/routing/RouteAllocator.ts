import type { AudioDevice } from '../audio/audio.types.js';
import { deviceKey, type RoutingConfiguration } from '../configuration/configuration.js';

/** Reserve a dedicated physical endpoint for each user, including across reconnects. */
export class RouteAllocator {
  private readonly devices: Map<string, AudioDevice>;
  private configuration: RoutingConfiguration;

  constructor(
    configuration: RoutingConfiguration,
    availableDevices: AudioDevice[],
    private readonly persist: (configuration: RoutingConfiguration) => void,
  ) {
    this.configuration = structuredClone(configuration);
    this.devices = new Map(availableDevices.map((device) => [deviceKey(device), device]));
    const configuredDevices = [...configuration.devicePool, ...configuration.routes.map((route) => route.device)];
    for (const device of configuredDevices) {
      if (availableDevices.filter((available) => deviceKey(available) === deviceKey(device)).length > 1) {
        throw new Error(`Output name is ambiguous: ${device.name}. Rename the duplicate Windows devices first.`);
      }
      if (!this.devices.has(deviceKey(device))) {
        throw new Error(`Configured output is unavailable: ${device.name} (${device.hostApi}). Run npm run devices.`);
      }
    }
  }

  assign(userId: string): AudioDevice | undefined {
    const existingRoute = this.configuration.routes.find((route) => route.userId === userId);
    if (existingRoute) return this.devices.get(deviceKey(existingRoute.device));
    const reservedDevices = new Set(this.configuration.routes.map((route) => deviceKey(route.device)));
    const selectedDevice = this.configuration.devicePool.find((device) => !reservedDevices.has(deviceKey(device)));
    if (!selectedDevice) return undefined;
    const updated = {
      ...this.configuration,
      routes: [...this.configuration.routes, { userId, device: selectedDevice }],
    };
    this.persist(updated);
    this.configuration = updated;
    return this.devices.get(deviceKey(selectedDevice));
  }
}
