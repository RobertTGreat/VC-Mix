import opus from '@discordjs/opus';
import { AUDIO_FORMAT } from './audioFormat.js';
import { measurePcm } from './measurePcm.js';
import type { AudioLevel, PcmOutput } from './audio.types.js';

/** Own the decoder and output for exactly one Discord participant. */
export class ParticipantAudio {
  private decoder: opus.OpusEncoder | undefined = new opus.OpusEncoder(
    AUDIO_FORMAT.sampleRate, AUDIO_FORMAT.channels,
  );

  constructor(
    private readonly output: PcmOutput,
    private readonly onLevel: (level: AudioLevel) => void,
  ) {}

  receive(packet: Buffer): void {
    const decoder = this.decoder;
    if (!decoder) return;
    const audio = decoder.decode(packet);
    this.onLevel(measurePcm(audio));
    this.output.write(audio);
  }

  close(): void {
    if (!this.decoder) return;
    // Native libopus instances own their state and release it when collected.
    this.decoder = undefined;
    this.output.close();
  }
}
