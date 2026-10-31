export interface DeviceIdentity {
  name: string;
  hostApi: string;
}

export interface AudioDevice extends DeviceIdentity {
  id: number;
  channels: number;
}

export interface PcmOutput {
  write(audio: Buffer, timestampNanoseconds?: bigint): void;
  close(): void;
}

export interface AudioLevel {
  rmsDb: number;
  peakDb: number;
}
