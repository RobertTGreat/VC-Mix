import type { AudioLevel } from './audio.types.js';

const MAXIMUM_SAMPLE = 32_768;
const MINIMUM_DECIBELS = -90;
const SAMPLE_BYTES = 2;

function toDecibels(amplitude: number): number {
  return amplitude === 0 ? MINIMUM_DECIBELS : Math.max(MINIMUM_DECIBELS, 20 * Math.log10(amplitude));
}

/** Measure signed 16-bit PCM without modifying the input buffer. */
export function measurePcm(audio: Buffer): AudioLevel {
  if (audio.length % SAMPLE_BYTES !== 0) {
    throw new Error('PCM audio must contain complete 16-bit samples.');
  }
  let sumOfSquares = 0;
  let peakAmplitude = 0;
  for (let offset = 0; offset < audio.length; offset += SAMPLE_BYTES) {
    const amplitude = audio.readInt16LE(offset) / MAXIMUM_SAMPLE;
    sumOfSquares += amplitude * amplitude;
    peakAmplitude = Math.max(peakAmplitude, Math.abs(amplitude));
  }
  const sampleCount = audio.length / SAMPLE_BYTES;
  const rmsAmplitude = sampleCount === 0 ? 0 : Math.sqrt(sumOfSquares / sampleCount);
  return { rmsDb: toDecibels(rmsAmplitude), peakDb: toDecibels(peakAmplitude) };
}
