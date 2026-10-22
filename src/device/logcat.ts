// Streams Android's logcat as parsed LogEntry records: `adb logcat -v threadtime -T 1` (only
// lines from now on), restarted on exit the same way ScreenrecordSource is. threadtime has no
// package column, so a pid -> process-name map is refreshed from `ps` in the background and
// looked up lazily at display/filter time — a pid seen before the first refresh still gets a name
// once the map catches up.

import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import type { LogEntry, LogLevel } from '../logs/entry.js';

// `MM-DD HH:MM:SS.mmm  PID  TID L TAG: message`
const THREADTIME_PATTERN =
  /^\d{2}-\d{2}\s+(\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+\d+\s+([VDIWEAF])\s+(.*?)\s*: ?(.*)$/;

const PROCESS_REFRESH_MS = 3000;

export function parseThreadtimeLine(line: string, previous: LogEntry | null): LogEntry | null {
  const match = THREADTIME_PATTERN.exec(line);
  if (match) {
    const [, time, pid, level, tag, message] = match;
    if (time === undefined || pid === undefined || level === undefined) {
      return null;
    }
    return {
      time,
      pid: Number(pid),
      level: (level === 'F' ? 'A' : level) as LogLevel,
      tag: tag ?? '',
      process: undefined,
      message: message ?? '',
    };
  }
  // Multi-line messages (stack traces) and `--------- beginning of ...` markers don't match;
  // attach the former to the entry before them, drop the latter when there's nothing to attach to.
  if (previous && line.length > 0 && !line.startsWith('---------')) {
    return { ...previous, message: line };
  }
  return null;
}

export class LogcatSource extends EventEmitter {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private stopped = false;
  private restartCount = 0;
  private last: LogEntry | null = null;
  private readonly processNames = new Map<number, string>();
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(private readonly serial: string) {
    super();
    this.spawnChild();
    this.refreshProcessNames();
  }

  processName(pid: number): string | undefined {
    return this.processNames.get(pid);
  }

  private spawnChild(): void {
    if (this.stopped) {
      return;
    }
    const child = spawn('adb', ['-s', this.serial, 'logcat', '-v', 'threadtime', '-T', '1'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    createInterface({ input: child.stdout }).on('line', (line) => {
      const entry = parseThreadtimeLine(line, this.last);
      if (entry) {
        this.last = entry;
        this.emit('entry', entry);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      this.emit('stderr', chunk.toString('utf8'));
    });
    child.on('error', (error) => {
      this.emit('error', error);
    });
    child.on('exit', (code) => {
      this.child = null;
      if (this.stopped) {
        return;
      }
      this.restartCount++;
      this.emit('restart', { code, count: this.restartCount });
      setTimeout(() => this.spawnChild(), 500);
    });
  }

  private refreshProcessNames(): void {
    if (this.stopped) {
      return;
    }
    execFile(
      'adb',
      ['-s', this.serial, 'shell', 'ps', '-A', '-o', 'PID,NAME'],
      { maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (!error) {
          for (const line of stdout.split('\n')) {
            const match = /^\s*(\d+)\s+(\S+)/.exec(line);
            if (match?.[1] !== undefined && match[2] !== undefined) {
              this.processNames.set(Number(match[1]), match[2]);
            }
          }
        }
        if (!this.stopped) {
          this.refreshTimer = setTimeout(() => this.refreshProcessNames(), PROCESS_REFRESH_MS);
        }
      },
    );
  }

  stop(): void {
    this.stopped = true;
    this.child?.kill();
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
  }
}
