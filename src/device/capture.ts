// Pulls frames off an Android device. Two sources behind a similar shape:
//
// - ScreenrecordSource: `adb exec-out screenrecord --output-format=h264 ... -`, streamed to a
//   long-lived PassThrough that survives the underlying adb process being restarted. Measured at
//   ~25fps on this project's test emulator; screenrecord's own doc doesn't mention
//   --output-format at all for this SDK, so treat any exit as recoverable and just restart.
// - ScreencapPollSource: `adb exec-out screencap -p` polled on an interval, for devices/hosts
//   where screenrecord isn't available. It already emits complete PNGs, so unlike the h264 path
//   it bypasses transcode.ts entirely.

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, type Readable } from 'node:stream';

/** A child process spawned with stdin ignored and stdout/stderr piped (no stdin to write to). */
type ChildWithPipedOutput = ChildProcessByStdio<null, Readable, Readable>;

export interface ScreenrecordOptions {
  serial: string;
  width: number;
  height: number;
  bitrate?: string;
}

export interface ScreenrecordRestartEvent {
  code: number | null;
  signal: NodeJS.Signals | null;
  count: number;
}

/**
 * Streams raw H.264 (Annex B) from `adb exec-out screenrecord` on a PassThrough that stays open
 * across restarts of the underlying adb child process — so a consumer piping it into ffmpeg
 * never has to notice a restart happened.
 */
export class ScreenrecordSource extends EventEmitter {
  readonly h264 = new PassThrough();
  private child: ChildWithPipedOutput | null = null;
  private stopped = false;
  private restartCount = 0;

  constructor(private readonly options: ScreenrecordOptions) {
    super();
    this.spawnChild();
  }

  private spawnChild(): void {
    if (this.stopped) {
      return;
    }
    const { serial, width, height, bitrate = '8M' } = this.options;
    this.child = spawn(
      'adb',
      [
        '-s',
        serial,
        'exec-out',
        'screenrecord',
        '--output-format=h264',
        '--time-limit',
        '0',
        '--size',
        `${width}x${height}`,
        '--bit-rate',
        bitrate,
        '-',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    this.child.stdout.on('data', (chunk: Buffer) => {
      this.h264.write(chunk);
    });
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.emit('stderr', chunk.toString('utf8'));
    });
    this.child.on('error', (error) => {
      this.emit('error', error);
    });
    this.child.on('exit', (code, signal) => {
      this.child = null;
      if (this.stopped) {
        return;
      }
      this.restartCount++;
      const event: ScreenrecordRestartEvent = { code, signal, count: this.restartCount };
      this.emit('restart', event);
      // Small backoff so a fundamentally broken screenrecord doesn't spin us into a tight loop.
      setTimeout(() => this.spawnChild(), 200);
    });
  }

  stop(): void {
    this.stopped = true;
    this.child?.kill();
    this.h264.end();
  }
}

/** Also used directly for the `s`/`S` screenshot keybinding, not just the polling fallback. */
export function captureScreencapPng(serial: string): Promise<Buffer> {
  return new Promise((resolveCap, rejectCap) => {
    const child = spawn('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', rejectCap);
    child.on('exit', (code) => {
      if (code !== 0) {
        rejectCap(new Error(`screencap exited with code ${String(code)}`));
        return;
      }
      resolveCap(Buffer.concat(chunks));
    });
  });
}

/** Polls `screencap -p` on an interval and emits complete PNG buffers as `'frame'` events. */
export class ScreencapPollSource extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private inFlight = false;

  constructor(
    private readonly serial: string,
    private readonly intervalMs = 250,
  ) {
    super();
    this.scheduleNext();
  }

  private scheduleNext(): void {
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(() => {
      this.tick().catch((error: unknown) => this.emit('error', error));
    }, this.intervalMs);
  }

  private async tick(): Promise<void> {
    if (this.inFlight) {
      this.scheduleNext();
      return;
    }
    this.inFlight = true;
    try {
      const png = await captureScreencapPng(this.serial);
      this.emit('frame', png);
    } catch (error) {
      this.emit('error', error);
    } finally {
      this.inFlight = false;
      this.scheduleNext();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
  }
}
