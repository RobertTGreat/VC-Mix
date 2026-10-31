import assert from 'node:assert/strict';
import test from 'node:test';
import { ReceiverCommandQueue } from './ReceiverCommandQueue.js';

test('a disconnect submitted in the same input chunk prevents an obsolete connection from starting', async () => {
  const executed: string[] = [];
  const queue = new ReceiverCommandQueue<string>(async (command) => { executed.push(command); }, async () => {});
  void queue.submit('connect');
  await queue.submit('disconnect');
  assert.deepEqual(executed, ['disconnect']);
});

test('disconnect aborts an in-progress login before executing cleanup', async () => {
  const executed: string[] = [];
  let started!: () => void;
  const connecting = new Promise<void>((resolve) => { started = resolve; });
  const queue = new ReceiverCommandQueue<string>(async (command, signal) => {
    executed.push(command);
    if (command !== 'connect') return;
    started();
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
  }, async () => {});
  void queue.submit('connect');
  await connecting;
  await queue.submit('disconnect');
  assert.deepEqual(executed, ['connect', 'disconnect']);
});
