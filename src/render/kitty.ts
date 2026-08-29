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
import { requestTmuxRedraw, writeToTerminal } from './caps.js';
import { diacriticFor, MAX_DIACRITIC_INDEX, PLACEHOLDER_CHAR } from './rowcolumn-diacritics.js';

/**
 * The graphics protocol's image-id namespace is shared by the whole real terminal, not scoped
 * per pane/tty/client — confirmed by the exact bug this guards against: with a fixed default of
 * 1, a `temu split`-created pane's live frames also repainted the placeholder grid left behind
 * in a different pane (another concurrently-running temu instance, or that pane's own prior
 * run), since the terminal updates *every* on-screen placeholder tagged with a given image id
 * whenever new data arrives for it, regardless of which pane's stdout the transmission came
 * from. Deriving the default from this process's pid instead guarantees every concurrently
 * running temu instance on the machine picks a different id (no two live processes share a pid).
 *
 * Constrained to 1-255: `drawPlaceholderGrid` below encodes the image id via the placeholder
 * text's foreground color using the indexed 256-color form (`CSI 38;5;Nm`), which only has 256
 * values to work with (0 is avoided — the protocol reserves id 0 to mean "no id"/"most recently
 * used"). This doesn't make ids globally unique, only *very likely* distinct between whichever
 * few temu instances happen to be running on one machine at once, which is what actually matters
 * here.
 */
const DEFAULT_IMAGE_ID = (process.pid % 255) + 1;

export interface KittyRendererOptions {
  cols: number;
  rows: number;
  /**
   * Image id used for every frame (default: derived from this process's pid — see
   * {@link DEFAULT_IMAGE_ID}). The spec guarantees re-transmitting with the same id atomically
   * replaces the previous placement's content ("without flicker"), so one fixed id per renderer
   * is sufficient — see the note on `renderFramePng` below for why this project doesn't
   * ping-pong between two ids.
   */
  imageId?: number;
  /**
   * Placement id used for every frame (default 1). Only needs to be unique *within* this
   * renderer's own image id, not across the terminal, so a fixed value is fine as long as
   * `imageId` itself is process-unique. The spec's "replace without flicker" guarantee is
   * explicitly keyed on *both* the image id and the placement id matching — "If you send two
   * placements with the same image id and placement id the second one will replace the first."
   * Leaving this unset (placement id 0) is documented to instead risk creating a new, separate
   * placement on every call. A stable, explicit id removes that ambiguity.
   */
  placementId?: number;
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
  private readonly placementId: number;
  private cols: number;
  private rows: number;
  private placeholderDrawn = false;
  private tmuxRepaintPending = false;
  private previousTempFile: string | null = null;
  private frameSeq = 0;

  constructor(options: KittyRendererOptions) {
    assertWithinDiacriticRange(options.cols, options.rows);
    this.cols = options.cols;
    this.rows = options.rows;
    this.imageId = options.imageId ?? DEFAULT_IMAGE_ID;
    this.placementId = options.placementId ?? 1;
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
   *
   * Written with a plain `process.stdout.write`, **not** `writeToTerminal` — this is the one
   * thing in this file that must NOT be tmux-passthrough-wrapped. The whole point of the
   * Unicode-placeholder mechanism is that the grid is ordinary text that tmux lays out inside
   * the pane; passthrough does the exact opposite, handing the bytes straight to the real
   * terminal with tmux's cursor state untouched (`tty_cmd_rawstring` writes the payload at
   * whatever absolute position the physical cursor happens to be at and then invalidates its
   * cached tty state — it never repositions to the pane first, and tmux never records the text
   * in its screen model at all; verified by writing a passthrough-wrapped plain string to a
   * pane's tty and seeing `tmux capture-pane` come back empty). Consequences of getting this
   * wrong, all of which were observed as one reported bug: the `\r` starting each grid row
   * returns to column 0 of the *whole terminal* rather than column 0 of the pane, so only the
   * first row lands inside the pane and every row after it marches down the left edge of the
   * screen (and scrolls it) — invisible in an unsplit pane, where pane-relative and
   * terminal-absolute coordinates coincide, and glaringly wrong in `temu split`'s right-hand
   * pane. Nothing clips the grid to the pane, and any tmux redraw wipes cells tmux doesn't know
   * are occupied. Only the APC graphics commands below (`a=T` / `a=d`), which tmux genuinely
   * cannot interpret, belong inside a passthrough envelope.
   *
   * Handing the grid to tmux as text does mean tmux gets to decide how it reaches the terminal,
   * and tmux 3.7b gets that wrong in a right-hand split pane: it forwards each placeholder's base
   * codepoint but silently drops the row/column diacritics combined onto it (see
   * `requestTmuxRedraw` in caps.ts for the exact upstream cause). A terminal that receives bare
   * `U+10EEEE` cells falls back to the protocol's left-to-right inheritance rule, so every row
   * renders as image row 0 — the reported "top strip of the phone screen, tiled down the whole
   * pane". tmux's own grid is right, so `requestTmuxRedraw()` (below, once the frame the grid
   * belongs to has been transmitted) is enough to fix it.
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
    process.stdout.write(sequence);
    this.placeholderDrawn = true;
    this.tmuxRepaintPending = true;
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
    const controlData = `a=T,i=${this.imageId},p=${this.placementId},U=1,c=${this.cols},r=${this.rows},f=100,t=t,q=2`;
    writeToTerminal(`\x1b_G${controlData};${payload}\x1b\\`);

    // Repaint the grid tmux may have delivered with its diacritics stripped (see
    // `drawPlaceholderGrid` above). Deliberately after the transmission rather than straight
    // after the grid was printed, for two reasons: the placeholders only mean anything once the
    // image id they reference exists, and `tmux refresh-client` is a separate process talking to
    // the tmux server over its socket while the grid text went out through this pane's pty — the
    // extra `await writeFile` above (plus process spawn latency) leaves the tmux server ample
    // time to have read and applied the grid before the repaint request lands.
    if (this.tmuxRepaintPending) {
      this.tmuxRepaintPending = false;
      requestTmuxRedraw();
    }

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
