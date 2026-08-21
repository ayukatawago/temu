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
    // No `fps=N` filter here (there used to be one, to cap ffmpeg's own encode rate below
    // screenrecord's native ~25fps). It computes each frame's duration from the *next* frame's
    // PTS, so on top of the underlying Annex-B issue below, it added its own reason to withhold
    // the newest decoded frame until a successor showed up. Removing it doesn't fully fix "a
    // screen that changes once and then holds still" (see the note below on why that needs the
    // screencap watchdog in stream.ts instead) — but it does fix the pipeline stalling *during
    // genuine ongoing motion*, which it was doing unconditionally: verified with 20 realistically
    // -paced access units fed over a live pipe, this filter alone made ffmpeg emit zero frames,
    // full stop, regardless of the fps_probe_size fix below. stream.ts already throttles what it
    // renders down to the newest frame per tick, so nothing downstream needed the fps cap to
    // begin with.
    //
    // Deeper cause of the "changes once, then holds still" case, for whoever hits this next: raw
    // H.264 Annex-B has no explicit end-of-access-unit marker, so ffmpeg's demuxer/parser can
    // only tell the current AU is complete once it sees the start code of the *next* NAL (or
    // reaches EOF). On a live, unterminated pipe, a truly final frame — nothing sent after it,
    // ever — has no next NAL to trigger that, so it sits parsed-but-unemitted forever. Verified
    // precisely (encoding 6 distinguishable frames, comparing decoded PNG bytes against a
    // known-good EOF-terminated decode of the same data): with both this fps-filter removal and
    // `-fpsprobesize 0` below, the true final frame of a feed-then-go-silent sequence was *never*
    // emitted, even after a 3s wait — the decoder stayed exactly one frame behind. That's why the
    // screencap-based staleness watchdog in stream.ts still exists and is not just a backstop for
    // rare cases; it's the only thing that can ever surface that last frame at all.
    const filters: string[] = [];
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
        // `fps_probe_size` (default 20 *frames*) is a second, independent probe counter that
        // `-max_ts_probe` does not cover — avformat_find_stream_info() still waits to see this
        // many frames before returning, even with the timestamp probe capped at 1. On this
        // project's content-driven capture that can be many seconds of real interaction before
        // the first output frame, which is the same "view is dead" symptom -max_ts_probe was
        // added for above, just gated on a different counter. Verified: setting this to 0 was
        // necessary (though not sufficient on its own — see the fps-filter removal above) to get
        // any frame at all out of a live emulator that had gone idle.
        '-fpsprobesize',
        '0',
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

/**
 * Scales a standalone PNG (e.g. a `screencap` snapshot used to seed the view or paper over a
 * stalled live frame) to the exact pixel size the live pipeline is currently rendering at.
 *
 * Matters more than it looks: `screencap` always returns the device's full native resolution,
 * a different (and differently-rounded) aspect ratio than `fitDeviceToCells`' pixel-perfect fit
 * for the current pane. Displaying it unscaled — even though Kitty stretches any image into the
 * same cell box regardless of its native size — showed up as a visible squish/resize each time
 * the view swapped between a screencap frame and a live one. Scaling to the identical target
 * size first makes the swap invisible.
 */
export function scalePng(png: Buffer, width: number, height: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(
      'ffmpeg',
      [
        '-f',
        'image2pipe',
        '-i',
        'pipe:0',
        '-vf',
        `scale=${String(width)}:${String(height)}`,
        '-f',
        'image2pipe',
        '-vcodec',
        'png',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const chunks: Buffer[] = [];
    ffmpeg.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    ffmpeg.stdin.on('error', () => undefined);
    ffmpeg.on('error', reject);
    ffmpeg.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg scale exited with code ${String(code)}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    ffmpeg.stdin.write(png);
    ffmpeg.stdin.end();
  });
}
