import {
  EndBehaviorType, entersState, joinVoiceChannel, VoiceConnectionStatus,
  type AudioReceiveStream, type VoiceConnection,
} from '@discordjs/voice';
import {
  ChannelType, Events, PermissionFlagsBits,
  type Client, type GuildMember, type VoiceChannel, type VoiceState,
} from 'discord.js';
import { DeviceOutput } from '../audio/DeviceOutput.js';
import { ParticipantAudio } from '../audio/ParticipantAudio.js';
import type { PcmOutput } from '../audio/audio.types.js';
import type { BotConfiguration } from '../configuration/configuration.js';
import type { RouteAllocator } from '../routing/RouteAllocator.js';
import type { ParticipantOutputFactory, VoiceSessionObserver } from './VoiceSessionObserver.js';

const CONNECTION_TIMEOUT_MILLISECONDS = 30_000;
const RECONNECT_START_TIMEOUT_MILLISECONDS = 5000;

interface ParticipantCapture {
  stream: AudioReceiveStream;
  audio: ParticipantAudio;
}

/** Manage channel membership and one subscription/decoder/output per human user. */
export class VoiceSession {
  private connection: VoiceConnection | undefined;
  private channel: VoiceChannel | undefined;
  private readonly captures = new Map<string, ParticipantCapture>();
  private readonly pending = new Map<string, Promise<void>>();
  private closed = false;

  constructor(
    private readonly client: Client,
    private readonly configuration: BotConfiguration,
    private readonly allocator: RouteAllocator | undefined,
    private readonly view: VoiceSessionObserver,
    private readonly onFatalError: (error: Error) => void,
    private readonly outputFactory?: ParticipantOutputFactory,
  ) {}

  async start(signal: AbortSignal): Promise<void> {
    const channel = await this.resolveChannel();
    signal.throwIfAborted();
    this.channel = channel;
    this.connection = joinVoiceChannel({
      guildId: channel.guild.id, channelId: channel.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false, selfMute: true, daveEncryption: true,
    });
    this.connection.on('error', this.onFatalError);
    this.connection.on(VoiceConnectionStatus.Disconnected, this.handleDisconnect);
    await entersState(this.connection, VoiceConnectionStatus.Ready,
      AbortSignal.any([signal, AbortSignal.timeout(CONNECTION_TIMEOUT_MILLISECONDS)]));
    this.client.on(Events.VoiceStateUpdate, this.handleVoiceState);
    this.connection.receiver.speaking.on('start', this.handleSpeaking);
    let outputMode = 'meters only';
    if (this.allocator) outputMode = 'device routing';
    if (this.outputFactory) outputMode = 'OBS audio sources';
    this.view.setStatus(`Connected to ${channel.name} | DAVE enabled | ${outputMode}`);
    const members = [...channel.members.values()].sort((first, second) => first.id.localeCompare(second.id));
    for (const member of members) {
      signal.throwIfAborted();
      await this.ensureParticipant(member);
    }
  }

  private async resolveChannel(): Promise<VoiceChannel> {
    const channel = await this.client.channels.fetch(this.configuration.channelId);
    if (!channel || channel.type !== ChannelType.GuildVoice || channel.guild.id !== this.configuration.guildId) {
      throw new Error('The configured channel must be a regular voice channel in the configured server.');
    }
    const currentMember = channel.guild.members.me ?? await channel.guild.members.fetchMe();
    if (!channel.permissionsFor(currentMember).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect])) {
      throw new Error('The bot needs View Channel and Connect permissions in this voice channel.');
    }
    return channel;
  }

  private handleSpeaking = (userId: string): void => {
    const member = this.channel?.members.get(userId);
    if (member) void this.ensureParticipant(member);
  };

  private handleVoiceState = (previous: VoiceState, current: VoiceState): void => {
    if (current.guild.id !== this.configuration.guildId) return;
    if (current.id === this.client.user?.id && current.channelId !== this.configuration.channelId) {
      this.onFatalError(new Error('The bot left or was moved out of the configured voice channel. Restart to reconnect.'));
      return;
    }
    if (current.channelId !== this.configuration.channelId) {
      if (previous.channelId === this.configuration.channelId) this.stopParticipant(current.id);
      return;
    }
    if (current.member) void this.ensureParticipant(current.member);
  };

  private ensureParticipant(member: GuildMember): Promise<void> {
    if (this.closed || member.user.bot || this.configuration.ignoredUserIds.includes(member.id)
      || this.captures.has(member.id)) return Promise.resolve();
    const existing = this.pending.get(member.id);
    if (existing) return existing;
    const opening = this.openParticipant(member)
      .catch((error: unknown) => {
        this.view.notice(`Could not capture ${member.displayName}: ${error instanceof Error ? error.message : 'Unknown audio error.'}`);
      })
      .finally(() => this.pending.delete(member.id));
    this.pending.set(member.id, opening);
    return opening;
  }

  private async openParticipant(member: GuildMember): Promise<void> {
    const device = this.allocator?.assign(member.id);
    const customOutput = this.outputFactory?.(member.id);
    let output: PcmOutput = customOutput?.output ?? { write: () => {}, close: () => {} };
    if (device) {
      output = await DeviceOutput.open(device, (error) => {
        this.view.notice(`Output error for ${member.displayName}: ${error.message}`);
        this.stopParticipant(member.id);
      }, (message) => this.view.notice(`${member.displayName}: ${message}`));
    }
    if (this.closed || member.voice.channelId !== this.configuration.channelId || !this.connection) {
      output.close(); return;
    }
    const routeName = customOutput?.label ?? device?.name ?? 'UNROUTED - meters only; no output device assigned';
    this.view.add(member.id, member.displayName, routeName);
    const audio = new ParticipantAudio(output, (level) => this.view.level(member.id, level));
    const stream = this.connection.receiver.subscribe(member.id, { end: { behavior: EndBehaviorType.Manual } });
    this.captures.set(member.id, { stream, audio });
    this.attachPackets(member.id, stream, audio);
  }

  private attachPackets(userId: string, stream: AudioReceiveStream, audio: ParticipantAudio): void {
    let lastDecodeErrorAt = 0;
    stream.on('data', (packet: Buffer) => {
      try { audio.receive(packet); }
      catch (error) {
        // One corrupt packet must not stop everyone else's audio.
        if (Date.now() - lastDecodeErrorAt < 5000) return;
        lastDecodeErrorAt = Date.now();
        this.view.notice(`Decode error for ${userId}: ${error instanceof Error ? error.message : 'Invalid Opus packet.'}`);
      }
    });
    stream.on('error', (error: Error) => this.view.notice(`Receive error for ${userId}: ${error.message}`));
    stream.once('close', () => {
      if (this.captures.get(userId)?.stream === stream) this.stopParticipant(userId);
    });
  }

  private stopParticipant(userId: string): void {
    const capture = this.captures.get(userId);
    this.captures.delete(userId);
    capture?.stream.destroy();
    capture?.audio.close();
    this.view.remove(userId);
  }

  private handleDisconnect = (): void => {
    void this.reconnect().catch((error: unknown) => {
      if (!this.closed) this.onFatalError(new Error(`Voice reconnection failed: ${error instanceof Error ? error.message : 'Restart the receiver.'}`));
    });
  };

  private async reconnect(): Promise<void> {
    const connection = this.connection;
    if (!connection || this.closed) return;
    this.view.setStatus('Reconnecting to voice');
    await Promise.any([
      entersState(connection, VoiceConnectionStatus.Signalling, RECONNECT_START_TIMEOUT_MILLISECONDS),
      entersState(connection, VoiceConnectionStatus.Connecting, RECONNECT_START_TIMEOUT_MILLISECONDS),
    ]);
    await entersState(connection, VoiceConnectionStatus.Ready, CONNECTION_TIMEOUT_MILLISECONDS);
    if (!this.closed) this.view.setStatus('Voice connection restored');
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.client.off(Events.VoiceStateUpdate, this.handleVoiceState);
    this.connection?.receiver.speaking.off('start', this.handleSpeaking);
    for (const userId of this.captures.keys()) this.stopParticipant(userId);
    if (this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed) this.connection.destroy();
    await Promise.allSettled(this.pending.values());
  }
}
