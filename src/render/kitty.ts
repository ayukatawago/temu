// Renders frames via the Kitty graphics protocol's Unicode-placeholder mechanism (see
// https://sw.kovidgoyal.net/kitty/graphics-protocol/#unicode-placeholders), which is the only
// approach that survives being hosted inside tmux: the placeholder is ordinary text, so tmux's
// screen model scrolls, reflows, and redraws it correctly without knowing anything about images.
//
// Transmission uses `t=t` (temporary file) rather than `t=d` (inline base64): the terminal reads
// the frame from disk, so only a few dozen bytes of escape sequence cross the tmux control
// socket per frame instead of the ~1MB/s that base64-in-band would cost at a useful frame rate.

import { unlink } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { writeToTerminal } from './caps.js';
import { diacriticFor, MAX_DIACRITIC_INDEX, PLACEHOLDER_CHAR } from './rowcolumn-diacritics.js';

export interface KittyRendererOptions {
  cols: number;
  rows: number;
  /**
   * Image id used for every frame (default 1). The spec guarantees re-transmitting with the
   * same id atomically replaces the previous placement's content ("without flicker"), so a
   * single fixed id is sufficient here — see the note on `renderFramePng` below for why this
   * project doesn't ping-pong between two ids.
   */
  imageId?: number;
}

function assertWithinDiacriticRange(cols: number, rows: number): void {
  if (cols - 1 > MAX_DIACRITIC_INDEX || rows - 1 > MAX_DIACRITIC_INDEX) {
    throw new RangeError(
      `${cols}x${rows} grid exceeds the ${MAX_DIACRITIC_INDEX + 1} rows/columns a single ` +
        'row/column diacritic can address',
    );
  }
}

/**
 * Draws a live-updatable image inside a tmux pane using Kitty graphics virtual placements.
 *
 * Usage: construct once per on-screen region, call `renderFramePng` for each new frame (the
 * first call also draws the placeholder text grid), and call `dispose` when done to free the
 * image and any temp file still pending cleanup.
 */
export class KittyRenderer {
  private readonly imageId: number;
  private cols: number;
  private rows: number;
  private placeholderDrawn = false;
  private previousTempFile: string | null = null;
  private frameSeq = 0;

  constructor(options: KittyRendererOptions) {
    assertWithinDiacriticRange(options.cols, options.rows);
    this.cols = options.cols;
    this.rows = options.rows;
    this.imageId = options.imageId ?? 1;
  }

  /** Changes the display size, forcing the placeholder grid to be redrawn on the next frame. */
  resize(cols: number, rows: number): void {
    assertWithinDiacriticRange(cols, rows);
    this.cols = cols;
    this.rows = rows;
    this.placeholderDrawn = false;
  }

  /**
   * Writes the Unicode-placeholder text grid at the current cursor position. Deliberately uses
   * relative line breaks rather than absolute cursor positioning: the placeholder is meant to
   * behave exactly like ordinary text (scroll, reflow, survive a redraw), so the caller
   * positions the cursor beforehand the same way it would before printing any other text.
   */
  private drawPlaceholderGrid(): void {
    const lines: string[] = [];
    for (let r = 0; r < this.rows; r++) {
      const rowDiacritic = diacriticFor(r);
      let line = '';
      for (let c = 0; c < this.cols; c++) {
        line += PLACEHOLDER_CHAR + rowDiacritic + diacriticFor(c);
      }
      lines.push(line);
    }
    const sequence = `\x1b[38;5;${this.imageId}m${lines.join('\r\n')}\x1b[39m\r\n`;
    writeToTerminal(sequence);
    this.placeholderDrawn = true;
  }

  /** Transmits one PNG-encoded frame and displays it over the placeholder grid. */
  async renderFramePng(png: Buffer): Promise<void> {
    if (!this.placeholderDrawn) {
      this.drawPlaceholderGrid();
    }

    // The `tty-graphics-protocol` substring in the filename is required by the spec for the
    // terminal to be willing to auto-delete a `t=t` temp file after reading it.
    const tempFile = join(
      tmpdir(),
      `tty-graphics-protocol-temu-${process.pid}-${this.frameSeq++}.png`,
    );
    await writeFile(tempFile, png);

    const payload = Buffer.from(resolve(tempFile), 'utf8').toString('base64');
    const controlData = `a=T,i=${this.imageId},U=1,c=${this.cols},r=${this.rows},f=100,t=t,q=2`;
    writeToTerminal(`\x1b_G${controlData};${payload}\x1b\\`);

    // The protocol requires the terminal to delete t=t files itself after reading them, but
    // that only happens if passthrough is on and the terminal actually understood the sequence.
    // Clean up the *previous* frame's file ourselves as a safety net, after a delay generous
    // enough that a well-behaved terminal has long since read it.
    if (this.previousTempFile) {
      const stale = this.previousTempFile;
      setTimeout(() => unlink(stale, () => undefined), 2000);
    }
    this.previousTempFile = tempFile;
  }

  /** Frees the image on the terminal side and cleans up any temp file still pending removal. */
  dispose(): void {
    writeToTerminal(`\x1b_Ga=d,d=I,i=${this.imageId},q=2\x1b\\`);
    if (this.previousTempFile) {
      unlink(this.previousTempFile, () => undefined);
      this.previousTempFile = null;
    }
  }
}
