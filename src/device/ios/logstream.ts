// Streams a booted iOS Simulator's unified log as parsed LogEntry records via public
// `xcrun simctl spawn <udid> log stream --style ndjson` — no temu-ios helper involved, same
// principle as discover.ts. Restarted on exit like the Android source.

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { basename } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import type { LogEntry, LogLevel } from '../../logs/entry.js';

const MESSAGE_TYPE_LEVELS: Record<string, LogLevel> = {
  Debug: 'D',
  Info: 'I',
  Default: 'I',
  Error: 'E',
  Fault: 'A',
};

/** Returns null for the banner line and anything else that isn't a log JSON object. */
export function parseNdjsonLogLine(line: string): LogEntry | null {
  if (!line.startsWith('{')) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const str = (key: string): string => {
    const value = record[key];
    return typeof value === 'string' ? value : '';
  };
  const subsystem = str('subsystem');
  const category = str('category');
  const image = str('processImagePath');
  const pid = record['processID'];
  // "2024-05-01 12:34:56.789012+0900" -> "12:34:56.789"
  const time = /(\d{2}:\d{2}:\d{2}\.\d{3})/.exec(str('timestamp'))?.[1] ?? '';
  return {
    time,
    pid: typeof pid === 'number' ? pid : 0,
    level: MESSAGE_TYPE_LEVELS[str('messageType')] ?? 'I',
    tag: subsystem && category ? `${subsystem}:${category}` : subsystem || category,
    process: image ? basename(image) : undefined,
    message: str('eventMessage'),
  };
}

export class IosLogStreamSource extends EventEmitter {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private stopped = false;
  private restartCount = 0;

  constructor(private readonly udid: string) {
    super();
    this.spawnChild();
  }

  private spawnChild(): void {
    if (this.stopped) {
      return;
    }
    const child = spawn(
      'xcrun',
      ['simctl', 'spawn', this.udid, 'log', 'stream', '--style', 'ndjson', '--level', 'info'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.child = child;
    createInterface({ input: child.stdout }).on('line', (line) => {
      const entry = parseNdjsonLogLine(line);
      if (entry) {
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

  stop(): void {
    this.stopped = true;
    this.child?.kill();
  }
}
