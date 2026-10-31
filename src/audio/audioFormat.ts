/** The decoded format delivered to every independent audio output. */
export const AUDIO_FORMAT = {
  sampleRate: 48_000,
  channels: 2,
  bytesPerSample: 2,
  maximumQueueMilliseconds: 200,
} as const;

export const AUDIO_BYTES_PER_SECOND =
  AUDIO_FORMAT.sampleRate * AUDIO_FORMAT.channels * AUDIO_FORMAT.bytesPerSample;
