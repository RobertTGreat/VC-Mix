import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { ObsTransport, parseHelperCommand } from './protocol.js';

test('audio framing preserves the participant, timestamp and complete PCM samples', () => {
  const output = new PassThrough();
  const transport = new ObsTransport(output);
  const pcm = Buffer.from([1, 0, 2, 0]);
  transport.audio('114040764912107522', pcm, 1234n);
  const frame = output.read() as Buffer;
  assert.equal(frame.readUInt32LE(), frame.length - 4);
  assert.equal(frame[4], 2);
  assert.equal(frame.subarray(6, 24).toString(), '114040764912107522');
  assert.equal(frame.readBigUInt64LE(24), 1234n);
  assert.deepEqual(frame.subarray(32), pcm);
});

test('commands reject malformed IDs and unknown operations before connecting', () => {
  assert.throws(() => parseHelperCommand('{"command":"exec"}'), /Unknown/);
  assert.throws(() => parseHelperCommand(JSON.stringify({ command: 'connect', token: 'a'.repeat(30),
    guildId: '../../invalid', channelId: '114040764912107522', ignoredUserIds: [] })), /17 to 20/);
  assert.deepEqual(parseHelperCommand('{"command":"test"}'), { command: 'test' });
});

test('audio drops queued frames instead of allowing unbounded latency', () => {
  const output = new PassThrough({ highWaterMark: 1 });
  output.write(Buffer.alloc(50_000));
  const queuedBytes = output.writableLength;
  new ObsTransport(output).audio('114040764912107522', Buffer.alloc(3840));
  assert.equal(output.writableLength, queuedBytes);
});
