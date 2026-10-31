import assert from 'node:assert/strict';
import { test } from 'node:test';
import opus from '@discordjs/opus';
import { ParticipantAudio } from './ParticipantAudio.js';
import { SmoothVoiceOutput, type VoiceOutputScheduler } from './SmoothVoiceOutput.js';
import type { PcmOutput } from './audio.types.js';

const NANOSECONDS_PER_MILLISECOND = 1_000_000n;
const FRAMES_PER_PACKET = 960;
const STEREO_FRAME_BYTES = 4;
const TEST_AMPLITUDE = 6000;
const FADE_BYTES = 240 * STEREO_FRAME_BYTES;

interface ScheduledTask { at: bigint; callback: () => void; cancelled: boolean }

class TestScheduler implements VoiceOutputScheduler {
  private time = 0n;
  private tasks: ScheduledTask[] = [];
  now(): bigint { return this.time; }
  after(milliseconds: number, callback: () => void): () => void {
    const task = { at: this.time + BigInt(Math.ceil(milliseconds * 1e6)), callback, cancelled: false };
    this.tasks.push(task);
    return () => { task.cancelled = true; };
  }
  advanceTo(milliseconds: number): void {
    const target = BigInt(milliseconds) * NANOSECONDS_PER_MILLISECOND;
    while (true) {
      this.tasks = this.tasks.filter((task) => !task.cancelled).sort((first, second) => Number(first.at - second.at));
      const next = this.tasks[0];
      if (!next || next.at > target) break;
      this.tasks.shift(); this.time = next.at; next.callback();
    }
    this.time = target;
  }
}

class MemoryOutput implements PcmOutput {
  readonly blocks: Buffer[] = [];
  readonly timestamps: bigint[] = [];
  closes = 0;
  write(audio: Buffer, timestamp = 0n): void { this.blocks.push(Buffer.from(audio)); this.timestamps.push(timestamp); }
  close(): void { this.closes += 1; }
  audio(): Buffer { return Buffer.concat(this.blocks); }
}

function constantAudio(frames = FRAMES_PER_PACKET): Buffer {
  const audio = Buffer.alloc(frames * STEREO_FRAME_BYTES);
  for (let offset = 0; offset < audio.length; offset += 2) audio.writeInt16LE(TEST_AMPLITUDE, offset);
  return audio;
}

test('an abruptly ending voice reaches zero without dropping its first or last audio frames', () => {
  const scheduler = new TestScheduler();
  const output = new MemoryOutput();
  const voice = new SmoothVoiceOutput(output, assert.fail, scheduler);
  const input = constantAudio();
  voice.write(input);
  scheduler.advanceTo(39);
  assert.equal(output.blocks.length, 0);
  scheduler.advanceTo(60);
  const audio = output.audio();
  assert.equal(audio.length, input.length);
  assert.equal(audio.readInt16LE(0), 0);
  assert.equal(audio.readInt16LE(audio.length - 2), 0);
  assert.deepEqual(audio.subarray(FADE_BYTES, audio.length - FADE_BYTES), input.subarray(FADE_BYTES, input.length - FADE_BYTES));
  for (let offset = 4; offset < audio.length; offset += 4) {
    assert.ok(Math.abs(audio.readInt16LE(offset) - audio.readInt16LE(offset - 4)) <= 26);
    assert.equal(audio.readInt16LE(offset), audio.readInt16LE(offset + 2));
  }
  assert.deepEqual(output.timestamps, [40_000_000n, 50_000_000n]);
  voice.close();
});

test('continuous speech keeps its interior samples unchanged across packet boundaries', () => {
  const scheduler = new TestScheduler();
  const output = new MemoryOutput();
  const voice = new SmoothVoiceOutput(output, assert.fail, scheduler);
  const packets = 80;
  for (let packetIndex = 0; packetIndex < packets; packetIndex += 1) {
    scheduler.advanceTo(packetIndex * 20);
    voice.write(constantAudio());
  }
  scheduler.advanceTo(packets * 20 + 60);
  const audio = output.audio();
  assert.equal(audio.length, packets * FRAMES_PER_PACKET * STEREO_FRAME_BYTES);
  for (let offset = FADE_BYTES; offset < audio.length - FADE_BYTES; offset += 2) assert.equal(audio.readInt16LE(offset), TEST_AMPLITUDE);
  for (let index = 1; index < output.timestamps.length; index += 1) assert.equal(output.timestamps[index]! - output.timestamps[index - 1]!, 10_000_000n);
  voice.close();
});

test('the natural Opus terminal silence tail is decoded and preserved', () => {
  for (const silenceHex of ['f8fffe', 'fcfffe']) {
    const scheduler = new TestScheduler();
    const output = new MemoryOutput();
    const encoder = new opus.OpusEncoder(48_000, 2);
    const reference = new opus.OpusEncoder(48_000, 2);
    const expected: Buffer[] = [];
    const participant = new ParticipantAudio(new SmoothVoiceOutput(output, assert.fail, scheduler), () => {});
    for (let packetIndex = 0; packetIndex < 5; packetIndex += 1) {
      scheduler.advanceTo(packetIndex * 20);
      const pcm = constantAudio();
      const packet = packetIndex < 3 ? encoder.encode(pcm) : Buffer.from(silenceHex, 'hex');
      expected.push(Buffer.from(reference.decode(packet)));
      participant.receive(packet);
    }
    scheduler.advanceTo(160);
    const decoded = Buffer.concat(expected);
    assert.deepEqual(output.audio().subarray(FADE_BYTES), decoded.subarray(FADE_BYTES));
    participant.close();
  }
});

test('longer 120 ms Opus frames retain all their PCM and receive only one ending fade', () => {
  const scheduler = new TestScheduler();
  const output = new MemoryOutput();
  const voice = new SmoothVoiceOutput(output, assert.fail, scheduler);
  voice.write(constantAudio(FRAMES_PER_PACKET * 6));
  scheduler.advanceTo(180);
  const audio = output.audio();
  assert.equal(audio.length, FRAMES_PER_PACKET * 6 * STEREO_FRAME_BYTES);
  assert.equal(audio.readInt16LE(audio.length - FADE_BYTES - 2), TEST_AMPLITUDE);
  assert.equal(audio.readInt16LE(audio.length - 2), 0);
  voice.close();
});

test('a late packet arriving before the previous block finishes keeps the same playback timeline', () => {
  const scheduler = new TestScheduler();
  const output = new MemoryOutput();
  const voice = new SmoothVoiceOutput(output, assert.fail, scheduler);
  voice.write(constantAudio());
  scheduler.advanceTo(55);
  voice.write(constantAudio());
  scheduler.advanceTo(100);
  assert.deepEqual(output.timestamps, [40_000_000n, 50_000_000n, 60_000_000n, 70_000_000n]);
  assert.equal(output.audio().readInt16LE(FRAMES_PER_PACKET * STEREO_FRAME_BYTES - 2), 0);
  assert.equal(output.audio().readInt16LE(FRAMES_PER_PACKET * STEREO_FRAME_BYTES), 0);
  voice.close();
});

test('a new talkspurt gets its own fade and another participant stays independent', () => {
  const scheduler = new TestScheduler();
  const firstOutput = new MemoryOutput();
  const secondOutput = new MemoryOutput();
  const first = new SmoothVoiceOutput(firstOutput, assert.fail, scheduler);
  const second = new SmoothVoiceOutput(secondOutput, assert.fail, scheduler);
  first.write(constantAudio()); second.write(constantAudio());
  scheduler.advanceTo(60);
  first.close();
  second.write(constantAudio());
  scheduler.advanceTo(120);
  assert.equal(firstOutput.audio().length, FRAMES_PER_PACKET * STEREO_FRAME_BYTES);
  assert.equal(secondOutput.audio().readInt16LE(FRAMES_PER_PACKET * STEREO_FRAME_BYTES), 0);
  assert.equal(secondOutput.audio().length, FRAMES_PER_PACKET * STEREO_FRAME_BYTES * 2);
  second.close();
});

test('closing drains a faded tail once and cancels outstanding render timers', () => {
  const scheduler = new TestScheduler();
  const output = new MemoryOutput();
  const voice = new SmoothVoiceOutput(output, assert.fail, scheduler);
  voice.write(constantAudio());
  voice.close(); voice.close(); voice.write(constantAudio());
  const audio = output.audio();
  assert.equal(audio.length, FRAMES_PER_PACKET * STEREO_FRAME_BYTES);
  assert.equal(audio.readInt16LE(audio.length - 2), 0);
  scheduler.advanceTo(1000);
  assert.equal(output.audio().length, audio.length);
  assert.equal(output.closes, 1);
});

test('a stalled output queue stays bounded and reports recovery', () => {
  const scheduler = new TestScheduler();
  const output = new MemoryOutput();
  const notices: string[] = [];
  const voice = new SmoothVoiceOutput(output, (notice) => notices.push(notice), scheduler);
  voice.write(constantAudio(FRAMES_PER_PACKET * 30));
  scheduler.advanceTo(300);
  assert.equal(notices.length, 1);
  assert.equal(output.audio().length, FRAMES_PER_PACKET * STEREO_FRAME_BYTES * 10);
  voice.close();
});

test('a failing sink closes only its own voice instead of repeatedly calling it', () => {
  const scheduler = new TestScheduler();
  const notices: string[] = [];
  let closes = 0;
  let writes = 0;
  const voice = new SmoothVoiceOutput({
    write: () => { writes += 1; throw new Error('Test sink failed.'); }, close: () => { closes += 1; },
  }, (notice) => notices.push(notice), scheduler);
  voice.write(constantAudio());
  scheduler.advanceTo(200);
  voice.write(constantAudio()); voice.close();
  assert.equal(writes, 1); assert.equal(closes, 1);
  assert.match(notices[0]!, /Test sink failed/);
});
