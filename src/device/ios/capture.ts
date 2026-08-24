// Pulls frames off an iOS Simulator via sim-use's `--format bgra` stream — the private
// `SimDisplayIOSurface`/framebuffer path (sim-use's own `--format bgra` help text and the class
// name it logs in `--verbose` mode, `SimulatorKit.SimDeviceLegacyHIDClient`, confirm this links
// Apple's private simulator frameworks rather than polling `screenshot` in a loop). Content-driven
// like Android's ScreenrecordSource (src/device/capture.ts): measured at ~1.5 frames per 6s on an
// idle screen, vs a constant ~9.6fps for sim-use's screenshot-polling formats (`mjpeg`/`raw`/
// `ffmpeg`) — bgra only sends a frame when the simulator's own display surface actually updates.
//
// `--scale 1.0` is deliberate: sim-use's own scaling roughly halved throughput when measured on
// the (screenshot-based) mjpeg format, and ffmpeg already has to scale/crop this source's output
// to fit the pane regardless — no reason to pay that cost twice, or lose detail before ffmpeg
// gets to decide what to keep.

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSimUseStream } from './simuse.js';

export interface BgraFramebufferOptions {
  udid: string;
}

export interface BgraRestartEvent {
  code: number | null;
  signal: NodeJS.Signals | null;
  count: number;
}

/**
 * Streams raw BGRA frames from `sim-use stream-video --format bgra` on a PassThrough that stays
 * open across restarts of the underlying sim-use child process — mirrors ScreenrecordSource's
 * shape exactly (src/device/capture.ts) so Pipeline (src/stream.ts) doesn't need to know which
 * platform it's driving.
 */
export class BgraFramebufferSource extends EventEmitter {
  readonly bgra = new PassThrough();
  private child: ReturnType<typeof spawnSimUseStream> | null = null;
  private stopped = false;
  private restartCount = 0;

  constructor(private readonly options: BgraFramebufferOptions) {
    super();
    this.spawnChild();
  }

  private spawnChild(): void {
    if (this.stopped) {
      return;
    }
    this.child = spawnSimUseStream([
      'stream-video',
      '--device',
      this.options.udid,
      '--format',
      'bgra',
      '--scale',
      '1.0',
    ]);

    this.child.stdout.on('data', (chunk: Buffer) => {
      this.bgra.write(chunk);
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
      const event: BgraRestartEvent = { code, signal, count: this.restartCount };
      this.emit('restart', event);
      // Same small backoff as ScreenrecordSource, for the same reason: don't spin tightly if
      // sim-use/the simulator is in a state where it exits immediately every time.
      setTimeout(() => this.spawnChild(), 200);
    });
  }

  stop(): void {
    this.stopped = true;
    this.child?.kill();
    this.bgra.end();
  }
}
