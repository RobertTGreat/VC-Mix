import type { AudioLevel, PcmOutput } from '../audio/audio.types.js';

/** Receives channel events without depending on a terminal or OBS. */
export interface VoiceSessionObserver {
  setStatus(status: string): void;
  add(userId: string, name: string, route: string): void;
  remove(userId: string): void;
  level(userId: string, level: AudioLevel): void;
  notice(message: string): void;
}

export interface ParticipantOutput {
  output: PcmOutput;
  label: string;
}

export type ParticipantOutputFactory = (userId: string) => ParticipantOutput;
