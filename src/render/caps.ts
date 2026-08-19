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

interface RawQueryOptions<T> {
  query: string;
  timeoutMs: number;
  /** Inspect the accumulated response buffer; return a result to settle, or undefined to keep waiting. */
  tryMatch: (buffer: string) => T | undefined;
}

/**
 * Puts stdin into raw mode, writes a query sequence, and resolves with the first match from
 * `tryMatch` (or `null` on timeout / when not attached to an interactive terminal). Always
 * restores stdin's mode before resolving.
 */
function queryTerminal<T>({ query, timeoutMs, tryMatch }: RawQueryOptions<T>): Promise<T | null> {
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
    writeToTerminal(query);
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
