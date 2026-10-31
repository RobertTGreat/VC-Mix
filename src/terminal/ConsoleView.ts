import { clearScreenDown, cursorTo } from 'node:readline';
import type { AudioLevel } from '../audio/audio.types.js';

const REFRESH_MILLISECONDS = 150;
const METER_CHARACTER_COUNT = 20;
const LEVEL_EXPIRY_MILLISECONDS = 350;
const MAXIMUM_NOTICES = 4;

interface ParticipantDisplay {
  name: string;
  route: string;
  level: AudioLevel;
  lastAudioAt: number;
  packets: number;
}

function safeTerminalText(text: string, maximumLength = 500): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, maximumLength);
}

/** Keep terminal refreshes and log notices out of the real-time audio pipeline. */
export class ConsoleView {
  private readonly participants = new Map<string, ParticipantDisplay>();
  private readonly notices: string[] = [];
  private timer: NodeJS.Timeout | undefined;
  private status = 'Starting';

  start(): void {
    if (process.stdout.isTTY) {
      process.stdout.write('\x1b[?25l');
      this.timer = setInterval(() => this.render(), REFRESH_MILLISECONDS);
    }
  }

  setStatus(status: string): void { this.status = safeTerminalText(status); this.notice(status); }

  add(userId: string, name: string, route: string): void {
    const safeName = safeTerminalText(name, 100);
    const safeRoute = safeTerminalText(route, 200);
    const previous = this.participants.get(userId);
    if (previous) { previous.name = safeName; previous.route = safeRoute; return; }
    this.participants.set(userId, {
      name: safeName, route: safeRoute, level: { rmsDb: -90, peakDb: -90 }, lastAudioAt: 0, packets: 0,
    });
    this.notice(`${name} (${userId}) -> ${route}`);
  }

  remove(userId: string): void { this.participants.delete(userId); }

  level(userId: string, level: AudioLevel): void {
    const participant = this.participants.get(userId);
    if (!participant) return;
    participant.level = level;
    participant.lastAudioAt = Date.now();
    participant.packets += 1;
  }

  notice(message: string): void {
    const safeMessage = safeTerminalText(message);
    this.notices.push(safeMessage);
    if (this.notices.length > MAXIMUM_NOTICES) this.notices.shift();
    if (!process.stdout.isTTY) process.stdout.write(`${safeMessage}\n`);
  }

  private render(): void {
    const lines = [`VC Mix | ${this.status}`, 'Ctrl+C to disconnect. Restart after changing routes.', ''];
    for (const [userId, participant] of this.participants) {
      const level = Date.now() - participant.lastAudioAt < LEVEL_EXPIRY_MILLISECONDS ? participant.level.rmsDb : -90;
      const filled = Math.round(Math.max(0, Math.min(1, (level + 60) / 60)) * METER_CHARACTER_COUNT);
      lines.push(`${participant.name} (${userId})`,
        `[${'#'.repeat(filled)}${' '.repeat(METER_CHARACTER_COUNT - filled)}] ${level.toFixed(1)} dBFS | ${participant.packets} packets`,
        `  ${participant.route}`, '');
    }
    if (!this.participants.size) lines.push('Waiting for voice-channel participants.', '');
    lines.push(...this.notices.map((notice) => `> ${notice}`));
    cursorTo(process.stdout, 0, 0);
    clearScreenDown(process.stdout);
    process.stdout.write(lines.join('\n'));
  }

  stop(): void {
    clearInterval(this.timer);
    if (process.stdout.isTTY) process.stdout.write('\x1b[?25h\n');
  }
}
