// Minimal terminal "chrome" around the video: a persistent single-line status bar below the
// grid, transient toasts, and a help overlay.
//
// Unlike render/kitty.ts's Kitty graphics codes, none of this is wrapped in tmux passthrough:
// plain cursor movement and text are exactly what tmux's screen model exists to manage — that's
// the opposite situation from Kitty's APC codes, which tmux doesn't understand at all.
//
// The crosshair (keyboard-driven targeting) is deliberately reported in the status bar as text
// rather than drawn as an on-screen glyph: drawing a real marker over the video grid would
// locally overwrite whatever Unicode placeholder cell it lands on, breaking the image at that
// cell. A future milestone (hint mode) replaces coarse crosshair nudging anyway.

import type { KeyboardMode } from '../input/keymap.js';

export const HELP_LINES: readonly string[] = [
  'temu — key bindings',
  '',
  'Mouse   click = tap    drag = swipe/scroll    wheel = scroll    right-click = back',
  '',
  'h j k l / arrows    move crosshair (Shift = big step)',
  'Enter / Space       tap at crosshair',
  'i                   text-input mode (Esc to exit)',
  'b  Back      H  Home      r  Recents      p  Power      [ / ]  volume down / up',
  's  screenshot to file      S  screenshot + show full path',
  '+ / -               raise / lower the render frame-rate cap',
  '?                   toggle this help',
  'q / Ctrl+C          quit',
];

function moveTo(row: number, col: number): string {
  return `\x1b[${String(row)};${String(col)}H`;
}

// Deliberately not passthrough-wrapped, same reasoning as the rest of this file: DECSET 1049 is
// exactly the kind of screen-buffer-management sequence tmux itself needs to see and act on (it
// tracks the alternate screen per pane and restores the pane's own prior content on exit), not
// something to hide from it inside a passthrough envelope.
export function enterAltScreen(): void {
  process.stdout.write('\x1b[?1049h');
}

export function leaveAltScreen(): void {
  process.stdout.write('\x1b[?1049l');
}

function padTruncate(text: string, width: number): string {
  if (width <= 0) return '';
  if (text.length >= width) return text.slice(0, width);
  return text + ' '.repeat(width - text.length);
}

/** Writes lines starting at (originRow, originCol), one per row, without moving the cursor. */
function writeBlock(
  originRow: number,
  originCol: number,
  cols: number,
  lines: readonly string[],
): void {
  let out = '\x1b7'; // DECSC save cursor
  for (let i = 0; i < lines.length; i++) {
    out += moveTo(originRow + i, originCol) + padTruncate(lines[i] ?? '', cols);
  }
  out += '\x1b8'; // DECRC restore cursor
  process.stdout.write(out);
}

/** Temporarily takes over the video grid's cell rectangle to show the key-binding reference. */
export function renderHelpOverlay(
  originRow: number,
  originCol: number,
  cols: number,
  rows: number,
): void {
  const lines = Array.from({ length: rows }, (_, i) => HELP_LINES[i] ?? '');
  writeBlock(originRow, originCol, cols, lines);
}

export interface StatusBarState {
  mode: KeyboardMode;
  fps: number;
  crosshair: { x: number; y: number } | null;
  toast: string | null;
}

const DEFAULT_TOAST_DURATION_MS = 2500;

export class StatusBar {
  private mode: KeyboardMode = 'normal';
  private fps = 0;
  private crosshair: { x: number; y: number } | null = null;
  private toast: string | null = null;
  private toastTimer: NodeJS.Timeout | null = null;

  constructor(
    private row: number,
    private cols: number,
  ) {}

  resize(row: number, cols: number): void {
    this.row = row;
    this.cols = cols;
    this.render();
  }

  setMode(mode: KeyboardMode): void {
    this.mode = mode;
    this.render();
  }

  setFps(fps: number): void {
    this.fps = fps;
    this.render();
  }

  setCrosshair(position: { x: number; y: number } | null): void {
    this.crosshair = position;
    this.render();
  }

  showToast(message: string, durationMs = DEFAULT_TOAST_DURATION_MS): void {
    this.toast = message;
    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
    }
    this.toastTimer = setTimeout(() => {
      this.toast = null;
      this.toastTimer = null;
      this.render();
    }, durationMs);
    this.render();
  }

  dispose(): void {
    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }
  }

  private render(): void {
    const modeLabel = this.mode === 'text' ? 'TEXT' : 'NORMAL';
    const crosshairLabel = this.crosshair
      ? ` @${String(Math.round(this.crosshair.x))},${String(Math.round(this.crosshair.y))}`
      : '';
    const base = `[${modeLabel}]${crosshairLabel} fps~${String(this.fps)}  ?:help  q:quit`;
    const text = this.toast ? `${base}  |  ${this.toast}` : base;
    writeBlock(this.row, 1, this.cols, [text]);
  }
}
