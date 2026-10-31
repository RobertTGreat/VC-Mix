import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { RTP_OPUS_PAYLOAD_TYPE, VoiceConnection } from '@discordjs/voice';
import opus from '@discordjs/opus';
import { AUDIO_FORMAT } from './audioFormat.js';
import { ParticipantAudio } from './ParticipantAudio.js';
import { measurePcm } from './measurePcm.js';
import type { AudioLevel, PcmOutput } from './audio.types.js';

const FRAME_SAMPLES = 960;
const FIRST_USER_ID = '111111111111111111';
const SECOND_USER_ID = '222222222222222222';
const FIRST_STREAM_ID = 101;
const SECOND_STREAM_ID = 202;
const FIRST_TONE_HERTZ = 440;
const SECOND_TONE_HERTZ = 880;

class MemoryOutput implements PcmOutput {
  readonly buffers: Buffer[] = [];
  closed = false;
  write(audio: Buffer): void { this.buffers.push(Buffer.from(audio)); }
  close(): void { this.closed = true; }
}

test('valid hybrid-mode silence followed by terminal silence never creates a full-volume click', () => {
  // Generated from zero PCM at 12 kbps. The Rust decoder emitted 80 clipped samples on the next packet.
  const hybridSilence = Buffer.from('680be4c136ecc58d8c4948426cd0', 'hex');
  for (const terminalHex of ['f8fffe', 'fcfffe']) {
    const output = new MemoryOutput();
    const participant = new ParticipantAudio(output, () => {});
    try {
      participant.receive(hybridSilence);
      participant.receive(Buffer.from(terminalHex, 'hex'));
      assert.equal(output.buffers.length, 2);
      for (const audio of output.buffers) {
        let peak = 0;
        for (let offset = 0; offset < audio.length; offset += 2) peak = Math.max(peak, Math.abs(audio.readInt16LE(offset)));
        assert.ok(peak < 64, `${terminalHex}: silent input produced peak ${peak}; expected near-zero PCM.`);
      }
    } finally { participant.close(); }
  }
});

test('three simultaneous participants decode sustained valid audio without corrupting shared state', () => {
  const outputs = Array.from({ length: 3 }, () => new MemoryOutput());
  const participants = outputs.map((output) => new ParticipantAudio(output, () => {}));
  const silencePacket = Buffer.from('fcfffe', 'hex'); // Valid 20 ms stereo Opus silence.
  try {
    for (let packetIndex = 0; packetIndex < 1000; packetIndex += 1) {
      for (const participant of participants) participant.receive(silencePacket);
    }
    for (const output of outputs) {
      assert.equal(output.buffers.length, 1000);
      assert.equal(output.buffers[0]?.length, 3840);
    }
  } finally {
    for (const participant of participants) participant.close();
  }
});

test('a malformed packet does not corrupt another participant or prevent later valid audio', () => {
  const firstOutput = new MemoryOutput();
  const secondOutput = new MemoryOutput();
  const firstParticipant = new ParticipantAudio(firstOutput, () => {});
  const secondParticipant = new ParticipantAudio(secondOutput, () => {});
  const silencePacket = Buffer.from('fcfffe', 'hex');
  try {
    assert.throws(() => firstParticipant.receive(Buffer.from('03', 'hex')));
    secondParticipant.receive(silencePacket);
    firstParticipant.receive(silencePacket);
    assert.equal(firstOutput.buffers.length, 1);
    assert.equal(secondOutput.buffers.length, 1);
  } finally {
    firstParticipant.close(); secondParticipant.close();
  }
});

function makeTone(frequency: number, frameIndex: number): Buffer {
  const audio = Buffer.alloc(FRAME_SAMPLES * AUDIO_FORMAT.channels * AUDIO_FORMAT.bytesPerSample);
  for (let sampleIndex = 0; sampleIndex < FRAME_SAMPLES; sampleIndex += 1) {
    const phase = 2 * Math.PI * frequency * (frameIndex * FRAME_SAMPLES + sampleIndex) / AUDIO_FORMAT.sampleRate;
    const sample = Math.round(Math.sin(phase) * 8000);
    audio.writeInt16LE(sample, sampleIndex * 4);
    audio.writeInt16LE(sample, sampleIndex * 4 + 2);
  }
  return audio;
}

function toneMagnitude(audio: Buffer, frequency: number): number {
  let realPart = 0;
  let imaginaryPart = 0;
  const sampleCount = audio.length / 4;
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const angle = 2 * Math.PI * frequency * sampleIndex / AUDIO_FORMAT.sampleRate;
    const sample = audio.readInt16LE(sampleIndex * 4);
    realPart += sample * Math.cos(angle);
    imaginaryPart += sample * Math.sin(angle);
  }
  return Math.hypot(realPart, imaginaryPart) / sampleCount;
}

function encryptedPacket(opus: Buffer, streamId: number, sequence: number, key: Buffer): Buffer {
  const header = Buffer.alloc(12);
  header[0] = 0x80;
  header[1] = RTP_OPUS_PAYLOAD_TYPE;
  header.writeUInt16BE(sequence, 2);
  header.writeUInt32BE(sequence * FRAME_SAMPLES, 4);
  header.writeUInt32BE(streamId, 8);
  const nonce = Buffer.alloc(12);
  nonce.writeUInt32BE(sequence, 0);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(header);
  return Buffer.concat([header, cipher.update(opus), cipher.final(), cipher.getAuthTag(), nonce.subarray(0, 4)]);
}

test('simultaneous encrypted speakers reach their own decoder and output without crossfeed', async () => {
  // Exercise the actual library receiver with locally generated RTP; no Discord account is used.
  const connection = new VoiceConnection({
    guildId: '333333333333333333', channelId: '444444444444444444', group: 'isolation-test', selfMute: true, selfDeaf: false,
  }, { adapterCreator: () => ({ sendPayload: () => true, destroy: () => {} }) });
  const receiver = connection.receiver;
  const transportKey = randomBytes(32);
  receiver.connectionData = { encryptionMode: 'aead_aes256_gcm_rtpsize', nonceBuffer: Buffer.alloc(12), secretKey: transportKey };
  receiver.ssrcMap.update({ userId: FIRST_USER_ID, audioSSRC: FIRST_STREAM_ID });
  receiver.ssrcMap.update({ userId: SECOND_USER_ID, audioSSRC: SECOND_STREAM_ID });
  const firstOutput = new MemoryOutput();
  const secondOutput = new MemoryOutput();
  const firstAudio = new ParticipantAudio(firstOutput, () => {});
  const secondAudio = new ParticipantAudio(secondOutput, () => {});
  const firstEncoder = new opus.OpusEncoder(48_000, 2);
  const secondEncoder = new opus.OpusEncoder(48_000, 2);
  const firstStream = receiver.subscribe(FIRST_USER_ID);
  const secondStream = receiver.subscribe(SECOND_USER_ID);
  firstStream.on('data', (packet: Buffer) => firstAudio.receive(packet));
  secondStream.on('data', (packet: Buffer) => secondAudio.receive(packet));
  try {
    for (let frameIndex = 0; frameIndex < 50; frameIndex += 1) {
      const firstPacket = firstEncoder.encode(makeTone(FIRST_TONE_HERTZ, frameIndex));
      const secondPacket = secondEncoder.encode(makeTone(SECOND_TONE_HERTZ, frameIndex));
      receiver.onUdpMessage(encryptedPacket(firstPacket, FIRST_STREAM_ID, frameIndex * 2, transportKey));
      receiver.onUdpMessage(encryptedPacket(secondPacket, SECOND_STREAM_ID, frameIndex * 2 + 1, transportKey));
    }
    await setImmediate();
    assert.equal(firstOutput.buffers.length, 50);
    assert.equal(secondOutput.buffers.length, 50);
    const firstDecoded = Buffer.concat(firstOutput.buffers);
    const secondDecoded = Buffer.concat(secondOutput.buffers);
    assert.ok(toneMagnitude(firstDecoded, FIRST_TONE_HERTZ) > toneMagnitude(firstDecoded, SECOND_TONE_HERTZ) * 30);
    assert.ok(toneMagnitude(secondDecoded, SECOND_TONE_HERTZ) > toneMagnitude(secondDecoded, FIRST_TONE_HERTZ) * 30);
    firstAudio.close();
    secondAudio.receive(secondEncoder.encode(makeTone(SECOND_TONE_HERTZ, 50)));
    assert.equal(secondOutput.buffers.length, 51, 'Closing one user must leave the other output working.');
  } finally {
    firstStream.destroy(); secondStream.destroy();
    firstAudio.close(); secondAudio.close();
    connection.destroy();
  }
});

test('empty PCM and digital silence report a silent meter', () => {
  const expected: AudioLevel = { rmsDb: -90, peakDb: -90 };
  assert.deepEqual(measurePcm(Buffer.alloc(0)), expected);
  assert.deepEqual(measurePcm(Buffer.alloc(3840)), expected);
});

test('full-scale negative samples report zero dBFS and incomplete samples are rejected', () => {
  const sample = Buffer.alloc(2);
  sample.writeInt16LE(-32768);
  assert.deepEqual(measurePcm(sample), { rmsDb: 0, peakDb: 0 });
  assert.throws(() => measurePcm(Buffer.alloc(1)), /complete 16-bit/);
});

test('a closed participant ignores further packets and closes its output once', () => {
  let closeCount = 0;
  const participant = new ParticipantAudio({
    write: () => assert.fail('Closed participant wrote audio.'),
    close: () => { closeCount += 1; },
  }, () => assert.fail('Closed participant updated its meter.'));
  participant.close(); participant.close(); participant.receive(Buffer.alloc(0));
  assert.equal(closeCount, 1);
});
