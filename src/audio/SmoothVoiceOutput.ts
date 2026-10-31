import { AUDIO_BYTES_PER_SECOND, AUDIO_FORMAT } from './audioFormat.js';
import type { PcmOutput } from './audio.types.js';

const NANOSECONDS_PER_MILLISECOND = 1_000_000n;
const OUTPUT_DELAY_MILLISECONDS = 40;
const OUTPUT_BLOCK_MILLISECONDS = 10;
const FADE_MILLISECONDS = 5;
const BYTES_PER_FRAME = AUDIO_FORMAT.channels * AUDIO_FORMAT.bytesPerSample;
const BLOCK_BYTES = AUDIO_BYTES_PER_SECOND * OUTPUT_BLOCK_MILLISECONDS / 1000;
const MAXIMUM_QUEUE_BYTES = AUDIO_BYTES_PER_SECOND * AUDIO_FORMAT.maximumQueueMilliseconds / 1000;
const FADE_FRAMES = AUDIO_FORMAT.sampleRate * FADE_MILLISECONDS / 1000;
const QUEUE_COMPACTION_CHUNKS = 32;

export interface VoiceOutputScheduler {
  now(): bigint;
  after(milliseconds: number, callback: () => void): () => void;
}

const systemScheduler: VoiceOutputScheduler = {
  now: () => process.hrtime.bigint(),
  after: (milliseconds, callback) => {
    const timer = setTimeout(callback, milliseconds);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

/** Buffer PCM briefly so only the actual end of a talkspurt receives a release ramp. */
export class SmoothVoiceOutput implements PcmOutput {
  private chunks: Buffer[] = [];
  private chunkIndex = 0;
  private chunkOffset = 0;
  private queuedBytes = 0;
  private nextTimestamp = 0n;
  private attackFrames = 0;
  private cancelRender: (() => void) | undefined;
  private closed = false;

  constructor(
    private readonly output: PcmOutput,
    private readonly onNotice: (message: string) => void,
    private readonly scheduler: VoiceOutputScheduler = systemScheduler,
  ) {}

  write(audio: Buffer): void {
    if (this.closed || audio.length === 0) return;
    if (audio.length % BYTES_PER_FRAME) throw new Error('Voice smoothing requires complete stereo S16 frames.');
    let acceptedAudio = audio;
    if (this.queuedBytes + audio.length > MAXIMUM_QUEUE_BYTES) {
      this.resetQueue();
      this.onNotice('Voice playback fell behind; discarded queued audio to recover.');
      acceptedAudio = audio.subarray(Math.max(0, audio.length - MAXIMUM_QUEUE_BYTES));
    }
    if (!this.queuedBytes) {
      const now = this.scheduler.now();
      // A submitted block may still be playing. A slightly late packet can continue at its end.
      if (this.nextTimestamp === 0n || now > this.nextTimestamp)
        this.nextTimestamp = now + BigInt(OUTPUT_DELAY_MILLISECONDS) * NANOSECONDS_PER_MILLISECOND;
      this.attackFrames = 0;
    }
    this.chunks.push(Buffer.from(acceptedAudio));
    this.queuedBytes += acceptedAudio.length;
    this.scheduleRender();
  }

  private scheduleRender(): void {
    if (this.cancelRender || !this.queuedBytes) return;
    const delay = this.nextTimestamp - this.scheduler.now();
    this.cancelRender = this.scheduler.after(Math.max(0, Number(delay) / Number(NANOSECONDS_PER_MILLISECOND)), () => {
      this.cancelRender = undefined;
      try { this.renderDueAudio(); }
      catch (error) {
        this.closed = true;
        this.resetQueue();
        this.output.close();
        this.onNotice(`Voice output failed: ${error instanceof Error ? error.message : 'Unknown playback error.'}`);
      }
    });
  }

  private renderDueAudio(): void {
    const now = this.scheduler.now();
    while (this.queuedBytes && this.nextTimestamp <= now) this.renderBlock();
    this.scheduleRender();
  }

  private renderBlock(): void {
    const audio = this.takeBytes(Math.min(BLOCK_BYTES, this.queuedBytes));
    this.applyEnvelope(audio, this.queuedBytes === 0);
    this.output.write(audio, this.nextTimestamp);
    const frameCount = audio.length / BYTES_PER_FRAME;
    this.nextTimestamp += BigInt(frameCount) * 1_000_000_000n / BigInt(AUDIO_FORMAT.sampleRate);
  }

  private takeBytes(count: number): Buffer {
    const audio = Buffer.allocUnsafe(count);
    let copiedBytes = 0;
    while (copiedBytes < count) {
      const chunk = this.chunks[this.chunkIndex];
      if (!chunk) throw new Error('The voice playback queue lost an audio block.');
      const copyBytes = Math.min(count - copiedBytes, chunk.length - this.chunkOffset);
      chunk.copy(audio, copiedBytes, this.chunkOffset, this.chunkOffset + copyBytes);
      copiedBytes += copyBytes;
      this.chunkOffset += copyBytes;
      if (this.chunkOffset === chunk.length) { this.chunkIndex += 1; this.chunkOffset = 0; }
    }
    this.queuedBytes -= count;
    if (!this.queuedBytes) { this.chunks = []; this.chunkIndex = 0; }
    else if (this.chunkIndex >= QUEUE_COMPACTION_CHUNKS) {
      this.chunks = this.chunks.slice(this.chunkIndex);
      this.chunkIndex = 0;
    }
    return audio;
  }

  private applyEnvelope(audio: Buffer, ending: boolean): void {
    const frameCount = audio.length / BYTES_PER_FRAME;
    const releaseStart = Math.max(0, frameCount - FADE_FRAMES);
    const releaseFrames = frameCount - releaseStart;
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      let gain = Math.min(1, this.attackFrames / (FADE_FRAMES - 1));
      this.attackFrames = Math.min(FADE_FRAMES, this.attackFrames + 1);
      if (ending && frameIndex >= releaseStart) gain *= (frameCount - frameIndex - 1) / Math.max(1, releaseFrames - 1);
      if (gain === 1) continue;
      for (let channel = 0; channel < AUDIO_FORMAT.channels; channel += 1) {
        const offset = frameIndex * BYTES_PER_FRAME + channel * AUDIO_FORMAT.bytesPerSample;
        audio.writeInt16LE(Math.round(audio.readInt16LE(offset) * gain), offset);
      }
    }
  }

  private resetQueue(): void {
    this.cancelRender?.();
    this.cancelRender = undefined;
    this.chunks = [];
    this.chunkIndex = 0;
    this.chunkOffset = 0;
    this.queuedBytes = 0;
    this.nextTimestamp = 0n;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelRender?.();
    this.cancelRender = undefined;
    try { while (this.queuedBytes) this.renderBlock(); }
    finally { this.resetQueue(); this.output.close(); }
  }
}
