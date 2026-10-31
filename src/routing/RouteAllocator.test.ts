import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AudioDevice } from '../audio/audio.types.js';
import { parseRoutingConfiguration, type RoutingConfiguration } from '../configuration/configuration.js';
import { RouteAllocator } from './RouteAllocator.js';

const FIRST_USER_ID = '111111111111111111';
const SECOND_USER_ID = '222222222222222222';
const THIRD_USER_ID = '333333333333333333';
const firstDevice: AudioDevice = { id: 12, name: 'CABLE-A Input', hostApi: 'Windows WASAPI', channels: 2 };
const secondDevice: AudioDevice = { id: 15, name: 'CABLE-B Input', hostApi: 'Windows WASAPI', channels: 2 };

test('each user gets an exclusive device and exhaustion leaves extra users unrouted', () => {
  const configuration: RoutingConfiguration = { devicePool: [firstDevice, secondDevice], routes: [] };
  const saved: RoutingConfiguration[] = [];
  const allocator = new RouteAllocator(configuration, [firstDevice, secondDevice], (updated) => saved.push(structuredClone(updated)));

  assert.equal(allocator.assign(FIRST_USER_ID), firstDevice);
  assert.equal(allocator.assign(SECOND_USER_ID), secondDevice);
  assert.equal(allocator.assign(THIRD_USER_ID), undefined);
  assert.equal(allocator.assign(FIRST_USER_ID), firstDevice);
  assert.equal(saved.length, 2, 'An existing route must not be reassigned or rewritten.');
});

test('reserved outputs remain assigned to their owners even when another user arrives first', () => {
  const configuration: RoutingConfiguration = {
    devicePool: [firstDevice, secondDevice], routes: [{ userId: FIRST_USER_ID, device: firstDevice }],
  };
  const allocator = new RouteAllocator(configuration, [firstDevice, secondDevice], () => {});
  assert.equal(allocator.assign(SECOND_USER_ID), secondDevice);
  assert.equal(allocator.assign(FIRST_USER_ID), firstDevice);
});

test('device identity survives changed numeric indices', () => {
  const currentDevice = { ...firstDevice, id: 99 };
  const allocator = new RouteAllocator({ devicePool: [], routes: [{ userId: FIRST_USER_ID, device: firstDevice }] }, [currentDevice], () => {});
  assert.equal(allocator.assign(FIRST_USER_ID)?.id, 99);
});

test('allocating a route does not mutate the caller configuration', () => {
  const configuration: RoutingConfiguration = { devicePool: [firstDevice], routes: [] };
  const allocator = new RouteAllocator(configuration, [firstDevice], () => {});
  allocator.assign(FIRST_USER_ID);
  assert.deepEqual(configuration.routes, []);
});

test('duplicate device names fail instead of selecting an arbitrary endpoint', () => {
  assert.throws(() => new RouteAllocator({ devicePool: [firstDevice], routes: [] },
    [firstDevice, { ...firstDevice, id: 88 }], () => {}), /ambiguous/);
});

test('a missing output fails instead of silently playing through the default speakers', () => {
  assert.throws(() => new RouteAllocator({ devicePool: [firstDevice], routes: [] }, [], () => {}), /unavailable/);
});

test('failed persistence does not consume a device reservation', () => {
  const configuration: RoutingConfiguration = { devicePool: [firstDevice], routes: [] };
  const allocator = new RouteAllocator(configuration, [firstDevice], () => { throw new Error('disk full'); });
  assert.throws(() => allocator.assign(FIRST_USER_ID), /disk full/);
  assert.equal(configuration.routes.length, 0);
});

test('configuration rejects shared devices and invalid Discord user identifiers', () => {
  assert.throws(() => parseRoutingConfiguration({ devicePool: [], routes: [
    { userId: FIRST_USER_ID, device: firstDevice }, { userId: SECOND_USER_ID, device: firstDevice },
  ] }), /share an output/);
  assert.throws(() => parseRoutingConfiguration({ devicePool: [], routes: [
    { userId: 'not-a-discord-id', device: firstDevice },
  ] }), /valid Discord userId/);
  assert.throws(() => parseRoutingConfiguration({ devicePool: [firstDevice, firstDevice], routes: [] }), /duplicate outputs/);
});
