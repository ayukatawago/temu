// Decodes the raw H.264 stream from ScreenrecordSource into individual PNG frames via ffmpeg,
// splitting ffmpeg's concatenated `image2pipe` output back into per-frame buffers.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';

export interface TranscodeOptions {
  /** Output frame size, after any crop — this is what actually reaches the renderer. */
  width: number;
  height: number;
  /**
   * Optional sub-rectangle of the *captured* frame to crop to before scaling, in the capture's
   * own pixel coordinates. Used by zoom mode: cropping has to happen on a frame captured at full
   * native resolution to show genuinely more detail — cropping an already-downscaled capture and
   * scaling the crop back up would just look blurrier, not more detailed.
   */
  crop?: { x: number; y: number; width: number; height: number };
}

// A PNG's IEND chunk always has zero-length data, so its bytes are fixed: a 4-byte length of 0,
// the ASCII type "IEND", and the CRC-32 of just that type string (0xAE426082 — the same for
// every encoder, verified against this project's own PNG encoder). That makes it a reliable,
// cheap marker for "a complete frame ends here" in the concatenated PNG stream ffmpeg emits.
const IEND_TRAILER = Buffer.from([
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

/**
 * Spawns ffmpeg to decode an H.264 Annex-B stream and scale it to a fixed size, and splits its
 * `image2pipe`/PNG stdout back into individual frame buffers, emitted as `'frame'` events.
 */
export class PngFrameSplitter extends EventEmitter {
  private ffmpeg: ChildProcessWithoutNullStreams;
  private buffer: Buffer = Buffer.alloc(0);
  private readonly recentStderr: string[] = [];

  constructor(input: Readable, options: TranscodeOptions) {
    super();
    const filters = options.crop
      ? [
          `crop=${String(options.crop.width)}:${String(options.crop.height)}:${String(options.crop.x)}:${String(options.crop.y)}`,
          `scale=${String(options.width)}:${String(options.height)}`,
        ]
      : [`scale=${String(options.width)}:${String(options.height)}`];

    this.ffmpeg = spawn(
      'ffmpeg',
      [
        // Deliberately no `-fflags nobuffer`: empirically (against this project's test
        // emulator) it makes ffmpeg silently decode zero frames from this Annex-B stream,
        // both from a file and piped live — presumably an interaction with how it buffers
        // waiting for SPS/PPS. `-flags low_delay` alone (safe here since screenrecord's
        // baseline-profile output has no B-frames to reorder) decodes correctly.
        '-flags',
        'low_delay',
        '-f',
        'h264',
        '-i',
        'pipe:0',
        '-vf',
        filters.join(','),
        '-f',
        'image2pipe',
        '-vcodec',
        'png',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    input.pipe(this.ffmpeg.stdin);
    // If ffmpeg dies, its stdin pipe becomes an EPIPE waiting to happen the next time the
    // capture source writes to it — without this handler that surfaces as an unhandled 'error'
    // event and crashes the process instead of the exit/restart path already handling it.
    this.ffmpeg.stdin.on('error', () => undefined);

    this.ffmpeg.stdout.on('data', (chunk: Buffer) => {
      this.onData(chunk);
    });
    this.ffmpeg.stderr.on('data', (chunk: Buffer) => {
      this.recentStderr.push(chunk.toString('utf8'));
      if (this.recentStderr.length > 20) {
        this.recentStderr.shift();
      }
    });
    this.ffmpeg.on('exit', (code, signal) => {
      this.emit('exit', { code, signal, stderr: this.recentStderr.join('') });
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length > 0 ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      const index = this.buffer.indexOf(IEND_TRAILER);
      if (index === -1) {
        break;
      }
      const frameEnd = index + IEND_TRAILER.length;
      const frame = Buffer.from(this.buffer.subarray(0, frameEnd));
      this.buffer = this.buffer.subarray(frameEnd);
      this.emit('frame', frame);
    }
  }

  stop(): void {
    this.ffmpeg.removeAllListeners('exit');
    this.ffmpeg.kill();
  }
}
