// Terminal / tmux capability detection: whether we're inside tmux, whether tmux will forward
// our escape codes to the real terminal (`allow-passthrough`), the physical pixel size of a
// terminal cell, and whether the terminal understands the Kitty graphics protocol.
//
// None of this can be assumed — it was empirically found on the maintainer's machine that
// Sixel is unavailable but Kitty graphics (including Unicode placeholders) is, and that
// `allow-passthrough` defaults to off. Every later render call depends on getting this right.

import { execFile } from 'node:child_process';

export interface CellPixelSize {
  width: number;
  height: number;
}

export type CellSizeSource = 'query' | 'flag' | 'default';
export type PassthroughState = 'on' | 'off' | 'unknown';
export type KittySupport = boolean | 'unknown';
export type KittySupportSource = 'query' | 'heuristic';

export interface TerminalCaps {
  insideTmux: boolean;
  isInteractive: boolean;
  tmuxAllowPassthrough: PassthroughState;
  cellSize: CellPixelSize;
  cellSizeSource: CellSizeSource;
  kittyGraphicsSupported: KittySupport;
  kittyGraphicsSource: KittySupportSource;
}

/** A cell size to fall back on when no live query is possible and no flag was given. */
export const DEFAULT_CELL_SIZE: CellPixelSize = { width: 8, height: 17 };

export function isInsideTmux(): boolean {
  return typeof process.env['TMUX'] === 'string' && process.env['TMUX'].length > 0;
}

/**
 * Wraps an escape sequence for tmux's passthrough (DCS) mechanism so the outer terminal — not
 * tmux itself — receives it. No-op when not running inside tmux. Requires tmux's
 * `allow-passthrough` option to be on; see {@link getTmuxAllowPassthrough}.
 */
export function wrapTmuxPassthrough(sequence: string): string {
  if (!isInsideTmux()) {
    return sequence;
  }
  const doubled = sequence.replaceAll('\x1b', '\x1b\x1b');
  return `\x1bPtmux;${doubled}\x1b\\`;
}

/** Writes a (possibly multi-part) escape sequence to the terminal, passthrough-wrapped. */
export function writeToTerminal(sequence: string): void {
  process.stdout.write(wrapTmuxPassthrough(sequence));
}

function runTmux(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('tmux', args, { timeout: 2000 }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}

export async function getTmuxAllowPassthrough(): Promise<PassthroughState> {
  if (!isInsideTmux()) {
    return 'unknown';
  }
  const output = await runTmux(['show', '-g', 'allow-passthrough']);
  if (!output) {
    return 'unknown';
  }
  const match = /allow-passthrough\s+(\S+)/.exec(output);
  const value = match?.[1];
  if (value === 'on' || value === 'all') {
    return 'on';
  }
  if (value === 'off') {
    return 'off';
  }
  return 'unknown';
}

/** Used by `temu doctor --fix`, after the CLI has asked the human operator for confirmation. */
export async function setTmuxAllowPassthroughOn(): Promise<boolean> {
  const output = await runTmux(['set-option', '-g', 'allow-passthrough', 'on']);
  return output !== null;
}

/**
 * Asks tmux to repaint the attached client from its own grid, discarding whatever it believes the
 * real terminal is currently showing. No-op outside tmux, and deliberately fire-and-forget — a
 * failed repaint is a cosmetic problem, not something any caller can act on.
 *
 * Exists for exactly one reason: tmux 3.7-era versions never send a cell's *combining characters*
 * to the terminal when the pane's horizontal offset is non-zero (the right-hand pane of a
 * left/right split — i.e. the one `temu split` creates). `screen_write_combine()` in tmux 3.7b
 * appends the combining character to its grid, then checks whether the cell it just modified is
 * on screen before re-emitting it, and passes a *pane-relative* x to that check while everything
 * else in the same file passes `wp->xoff + cx`:
 *
 *   if (wp != NULL) yoff = wp->yoff;                                  // note: no xoff
 *   r = screen_redraw_get_visible_ranges(wp, cx - n, cy + yoff, n, NULL);
 *   ... if (vis < n) return (1);                                      // "obscured" -> no re-emit
 *
 * For a pane at xoff 120, that asks whether column `cx` of the *window* is visible — a column
 * owned by the pane to the left — concludes the cell is obscured, and drops the re-emit. Upstream
 * fixed this after 3.7b (master now passes `xoff + cx - n`), but 3.7b is what ships today.
 *
 * Measured directly against tmux 3.7b with a client whose output was recorded byte for byte: a
 * 40x20 Kitty placeholder grid printed in the left pane (xoff 0) emitted 800/800 cells complete;
 * the identical grid in the right pane (xoff 120) emitted 800/800 cells as bare `U+10EEEE` with
 * every row/column diacritic missing, and one `refresh-client` afterwards re-emitted all 800
 * complete. tmux's own grid is correct throughout (`capture-pane` shows the diacritics either
 * way), which is why any full repaint fixes it and why this workaround is just "ask for one".
 */
export function requestTmuxRedraw(): void {
  if (!isInsideTmux()) {
    return;
  }
  void runTmux(['refresh-client']);
}

interface RawQueryOptions<T> {
  query: string;
  timeoutMs: number;
  /** Inspect the accumulated response buffer; return a result to settle, or undefined to keep waiting. */
  tryMatch: (buffer: string) => T | undefined;
  /**
   * Whether to send `query` through tmux's passthrough (default true). Cell pixel size and Kitty
   * graphics support are properties of the *real* terminal, which only passthrough can reach, so
   * they need it. Cursor position is different: tmux tracks and answers `CSI 6n` itself, in
   * coordinates relative to the *pane*, matching how it delivers SGR mouse reports — exactly what
   * `queryCursorPosition` needs. Passthrough-wrapping that one instead hands the query straight to
   * the real terminal, which has no notion of panes and answers with its own absolute on-screen
   * position; for any pane whose horizontal offset isn't 0 (`temu split`'s right-hand pane), that
   * silently breaks every tap (confirmed live: a real split-pane run measured `gridOrigin.col` as
   * the pane's absolute screen column instead of ~1, so `cellToDevicePixel`'s `mouseCol -
   * origin.col` went deeply negative and every tap clamped to the device's left edge).
   */
  passthrough?: boolean;
}

/**
 * Puts stdin into raw mode, writes a query sequence, and resolves with the first match from
 * `tryMatch` (or `null` on timeout / when not attached to an interactive terminal). Always
 * restores stdin's mode before resolving.
 */
function queryTerminal<T>({
  query,
  timeoutMs,
  tryMatch,
  passthrough = true,
}: RawQueryOptions<T>): Promise<T | null> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      resolve(null);
      return;
    }

    const stdin = process.stdin;
    let buffer = '';
    let settled = false;

    const finish = (value: T | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.off('data', onData);
      try {
        stdin.setRawMode(false);
      } catch {
        // Not fatal — best-effort restore.
      }
      stdin.pause();
      resolve(value);
    };

    const onData = (chunk: Buffer): void => {
      // latin1 keeps this a byte-for-byte view of the response, which is all ASCII/control
      // bytes anyway — no need to worry about multi-byte decoding here.
      buffer += chunk.toString('latin1');
      const result = tryMatch(buffer);
      if (result !== undefined) {
        finish(result);
      }
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    try {
      stdin.setRawMode(true);
    } catch {
      finish(null);
      return;
    }
    stdin.resume();
    stdin.on('data', onData);
    if (passthrough) {
      writeToTerminal(query);
    } else {
      process.stdout.write(query);
    }
  });
}

/**
 * Queries the physical pixel size of a single terminal cell via `CSI 16 t`, which a terminal
 * answers with `CSI 6 ; height ; width t`. Supported by fewer terminals than the window-size
 * variant (`CSI 14 t`), but far more useful for mapping cells to device pixels.
 */
export async function queryCellPixelSize(timeoutMs = 400): Promise<CellPixelSize | null> {
  const result = await queryTerminal<CellPixelSize | null>({
    query: '\x1b[16t',
    timeoutMs,
    tryMatch: (buffer) => {
      // eslint-disable-next-line no-control-regex -- matching the ESC in a real terminal reply
      const match = /\x1b\[6;(\d+);(\d+)t/.exec(buffer);
      if (!match) return undefined;
      const heightStr = match[1];
      const widthStr = match[2];
      if (!heightStr || !widthStr) return null;
      const height = Number(heightStr);
      const width = Number(widthStr);
      // Terminals that don't actually know the pixel size report zero rather than refusing.
      return width > 0 && height > 0 ? { width, height } : null;
    },
  });
  return result ?? null;
}

export interface CursorPosition {
  /**
   * 1-based, relative to the current pane (not the whole terminal, and not the pane's
   * scrollback) — matching the coordinate space tmux delivers SGR mouse reports in. Outside
   * tmux, or in an unsplit pane, this coincides with the terminal's own absolute position.
   */
  row: number;
  col: number;
}

/**
 * Queries the cursor's current position via the standard DSR request (`CSI 6 n`), answered with
 * `CSI row ; col R`. Used to remember where a placeholder grid's top-left cell landed on screen,
 * so mouse reports (which arrive in the same pane-relative space) can be translated into a
 * position relative to the grid.
 *
 * Deliberately sent *without* tmux passthrough (`passthrough: false` — see that option's doc
 * comment on `RawQueryOptions` for the measured bug this avoids): tmux answers this query itself,
 * in pane-relative coordinates, which is exactly the space this value needs to be in.
 */
export async function queryCursorPosition(timeoutMs = 400): Promise<CursorPosition | null> {
  const result = await queryTerminal<CursorPosition | null>({
    query: '\x1b[6n',
    timeoutMs,
    passthrough: false,
    tryMatch: (buffer) => {
      // eslint-disable-next-line no-control-regex -- matching the ESC in a real terminal reply
      const match = /\x1b\[(\d+);(\d+)R/.exec(buffer);
      if (!match) return undefined;
      const rowStr = match[1];
      const colStr = match[2];
      if (!rowStr || !colStr) return null;
      return { row: Number(rowStr), col: Number(colStr) };
    },
  });
  return result ?? null;
}

/** Best-effort guess from environment variables, used when a live query isn't possible. */
export function heuristicKittyGraphicsSupport(): KittySupport {
  const env = process.env;
  if (env['GHOSTTY_RESOURCES_DIR'] !== undefined || env['GHOSTTY_BIN_DIR'] !== undefined) {
    return true;
  }
  if (env['KITTY_WINDOW_ID'] !== undefined) {
    return true;
  }
  if (env['TERM_PROGRAM'] === 'WezTerm') {
    return true;
  }
  if (env['TERM_PROGRAM'] === 'iTerm.app') {
    // iTerm2 has its own inline-image protocol, not the Kitty graphics protocol.
    return false;
  }
  return 'unknown';
}

/**
 * Authoritative capability check, per the graphics protocol spec: send a query-mode (`a=q`)
 * transmit for a throwaway 1x1 pixel, immediately followed by a primary-device-attributes
 * request. A terminal that supports the protocol replies to the graphics query (in FIFO order,
 * before or alongside the DA reply); one that doesn't silently drops it and we only see the DA
 * reply.
 */
export async function queryKittyGraphicsSupport(timeoutMs = 400): Promise<boolean | null> {
  const probeId = 1;
  return queryTerminal<boolean>({
    query: `\x1b_Gi=${probeId},s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\\x1b[c`,
    timeoutMs,
    tryMatch: (buffer) => {
      if (new RegExp(`\\x1b_Gi=${probeId};[^\\x1b]*\\x1b\\\\`).test(buffer)) {
        return true;
      }
      // eslint-disable-next-line no-control-regex -- matching the ESC in a real terminal reply
      if (/\x1b\[\?[\d;]*c/.test(buffer)) {
        return false;
      }
      return undefined;
    },
  });
}

export interface DetectCapsOptions {
  cellSizeFlag?: CellPixelSize;
  queryTimeoutMs?: number;
}

export async function detectCaps(options: DetectCapsOptions = {}): Promise<TerminalCaps> {
  const insideTmux = isInsideTmux();
  const isInteractive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const tmuxAllowPassthrough = await getTmuxAllowPassthrough();
  const queryTimeoutMs = options.queryTimeoutMs ?? 400;

  // Live queries are pointless if tmux would discard them anyway.
  const canQueryLive = isInteractive && (!insideTmux || tmuxAllowPassthrough === 'on');

  let cellSize: CellPixelSize;
  let cellSizeSource: CellSizeSource;
  if (options.cellSizeFlag) {
    cellSize = options.cellSizeFlag;
    cellSizeSource = 'flag';
  } else {
    const queried = canQueryLive ? await queryCellPixelSize(queryTimeoutMs) : null;
    if (queried) {
      cellSize = queried;
      cellSizeSource = 'query';
    } else {
      cellSize = DEFAULT_CELL_SIZE;
      cellSizeSource = 'default';
    }
  }

  let kittyGraphicsSupported: KittySupport;
  let kittyGraphicsSource: KittySupportSource;
  const queriedKitty = canQueryLive ? await queryKittyGraphicsSupport(queryTimeoutMs) : null;
  if (queriedKitty !== null) {
    kittyGraphicsSupported = queriedKitty;
    kittyGraphicsSource = 'query';
  } else {
    kittyGraphicsSupported = heuristicKittyGraphicsSupport();
    kittyGraphicsSource = 'heuristic';
  }

  return {
    insideTmux,
    isInteractive,
    tmuxAllowPassthrough,
    cellSize,
    cellSizeSource,
    kittyGraphicsSupported,
    kittyGraphicsSource,
  };
}
