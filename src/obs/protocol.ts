import type { Writable } from 'node:stream';

export const FRAME_KIND = { event: 1, audio: 2 } as const;
const MAXIMUM_AUDIO_BACKLOG_BYTES = 48_000 * 2 * 2 / 5;
const SNOWFLAKE_PATTERN = /^\d{17,20}$/;

/** Binary framing keeps audio and control events on a single private child-process pipe. */
export class ObsTransport {
  constructor(private readonly output: Writable) {}

  event(event: Readonly<Record<string, unknown>>): void {
    this.frame(Buffer.concat([Buffer.from([FRAME_KIND.event]), Buffer.from(JSON.stringify(event))]));
  }

  audio(userId: string, pcm: Buffer, timestamp = process.hrtime.bigint()): void {
    if (!SNOWFLAKE_PATTERN.test(userId)) throw new Error('Invalid audio participant ID.');
    if (pcm.length === 0 || pcm.length % 4 !== 0) throw new Error('Audio must contain complete stereo S16 frames.');
    if (this.output.writableLength > MAXIMUM_AUDIO_BACKLOG_BYTES) return;
    const header = Buffer.alloc(2 + userId.length + 8);
    header[0] = FRAME_KIND.audio;
    header[1] = userId.length;
    header.write(userId, 2, 'ascii');
    header.writeBigUInt64LE(timestamp, 2 + userId.length);
    this.frame(Buffer.concat([header, pcm]));
  }

  private frame(payload: Buffer): void {
    const length = Buffer.alloc(4);
    length.writeUInt32LE(payload.length);
    this.output.write(Buffer.concat([length, payload]));
  }
}

export interface ConnectCommand {
  command: 'connect';
  token: string;
  guildId: string;
  channelId: string;
  ignoredUserIds: string[];
}

export type HelperCommand = ConnectCommand | { command: 'disconnect' | 'test' | 'shutdown' };

/** Validate all commands received from the native host before using Discord credentials. */
export function parseHelperCommand(line: string): HelperCommand {
  if (line.length > 65_536) throw new Error('Settings message is too large.');
  const candidate: unknown = JSON.parse(line);
  if (!candidate || typeof candidate !== 'object' || !('command' in candidate)) {
    throw new Error('Expected a helper command.');
  }
  const command = candidate as Record<string, unknown>;
  switch (command.command) {
    case 'disconnect': case 'test': case 'shutdown': return { command: command.command };
    case 'connect': {
      if (typeof command.token !== 'string' || command.token.length < 20 || command.token.length > 512) {
        throw new Error('Enter a valid bot token in Tools > VC Mix.');
      }
      for (const key of ['guildId', 'channelId'] as const) {
        if (typeof command[key] !== 'string' || !SNOWFLAKE_PATTERN.test(command[key])) {
          throw new Error('Server and voice channel IDs must contain 17 to 20 digits.');
        }
      }
      if (!Array.isArray(command.ignoredUserIds) || command.ignoredUserIds.length > 100
        || !command.ignoredUserIds.every((userId: unknown) => typeof userId === 'string' && SNOWFLAKE_PATTERN.test(userId))) {
        throw new Error('Excluded participants must be a list of Discord user IDs.');
      }
      return { command: 'connect', token: command.token, guildId: command.guildId as string,
        channelId: command.channelId as string, ignoredUserIds: command.ignoredUserIds as string[] };
    }
    default: throw new Error('Unknown receiver command.');
  }
}
