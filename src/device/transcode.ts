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
  /**
   * Caps ffmpeg's own output rate via its `fps` filter, applied before crop/scale. Without this,
   * ffmpeg fully decodes and PNG-encodes every frame screenrecord delivers (content-driven, up to
   * its native ~25fps during real motion — see device/capture.ts), even though a fps-capping
   * consumer downstream only ever uses a fraction of them. That's wasted work competing with
   * input handling on the same single-threaded event loop; capping it here instead of discarding
   * after the fact measurably reduces total CPU and data volume (verified: an ~21fps motion clip
   * dropped to ~7fps of *actual PNG-encoded output* with `fps=8`, not just fewer frames used).
   */
  fps?: number;
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
    const filters: string[] = [];
    if (options.fps) {
      filters.push(`fps=${String(options.fps)}`);
    }
    if (options.crop) {
      filters.push(
        `crop=${String(options.crop.width)}:${String(options.crop.height)}:${String(options.crop.x)}:${String(options.crop.y)}`,
      );
    }
    filters.push(`scale=${String(options.width)}:${String(options.height)}`);

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
        // `-max_ts_probe 1` is the fix for a serious live-streaming bug found by tracing
        // ffmpeg's own debug log: a raw H.264 Annex-B stream has no container-level
        // timestamps, so avformat_find_stream_info()'s generic "wait for the first
        // timestamp" logic keeps reading packets up to its default cap of 50 before ever
        // producing a single output frame. Against this project's content-driven capture
        // (near-zero new data while the screen is static — see ScreenrecordSource's own
        // doc comment), reaching 50 real frames could take many seconds of active use,
        // which reads as "the view is dead / not synced". Verified end to end: stream info
        // now completes ~0.5s after motion starts (not 50 frames in), across five separate
        // motion bursts over an 18s session, each producing frames within ~1-2s.
        '-max_ts_probe',
        '1',
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
