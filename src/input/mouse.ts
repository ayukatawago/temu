// Decodes SGR mouse reports from raw stdin and turns them into tap / drag / wheel / right-click
// gestures, in terminal cell coordinates (the caller maps those to device pixels).
//
// A tap and a drag start identically (a button-0 press) and only diverge once a motion report
// arrives before the matching release — so a press is held "armed" rather than immediately
// treated as either, and only resolves to onTap (no motion happened) or onDragStart+onDragMove
// (motion happened) once we know which.

export interface MouseHandlers {
  onTap: (col: number, row: number) => void;
  onDragStart: (col: number, row: number) => void;
  onDragMove: (col: number, row: number) => void;
  onDragEnd: (col: number, row: number) => void;
  onWheel: (direction: 'up' | 'down', col: number, row: number) => void;
  onRightClick: (col: number, row: number) => void;
}

export const ENABLE_MOUSE_TRACKING = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';
export const DISABLE_MOUSE_TRACKING = '\x1b[?1006l\x1b[?1002l\x1b[?1000l';

// SGR mouse report: CSI < Cb ; Cx ; Cy M (press/motion) or m (release).
// eslint-disable-next-line no-control-regex -- matching a real SGR mouse report from the terminal
const SGR_MOUSE_PATTERN = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/;

type ArmedState = { col: number; row: number } | null;

export class MouseTracker {
  private armed: ArmedState = null;
  private dragging = false;

  constructor(private readonly handlers: MouseHandlers) {}

  // Deliberately NOT wrapped in tmux passthrough (unlike render/kitty.ts's escape codes): tmux
  // needs to actually understand these DECSET sequences itself, since it's tmux — not the outer
  // terminal — that decides to start forwarding real mouse events to this pane as SGR reports
  // once it sees the pane's application asked for them. Passthrough-wrapping would hide that
  // request from tmux entirely and no mouse events would ever arrive.
  enable(): void {
    process.stdout.write(ENABLE_MOUSE_TRACKING);
  }

  disable(): void {
    process.stdout.write(DISABLE_MOUSE_TRACKING);
  }

  /**
   * Feed a raw chunk of stdin bytes read while mouse tracking is enabled. Returns whatever
   * wasn't consumed as a mouse report (in latin1 — a byte-for-byte view, since a keyboard's
   * escape sequences are all in the printable-ASCII/control-byte range anyway), for the
   * keyboard layer to decode.
   */
  feed(chunk: Buffer): Buffer {
    let text = chunk.toString('latin1');
    let leftover = '';
    for (;;) {
      const match = SGR_MOUSE_PATTERN.exec(text);
      if (!match) {
        leftover += text;
        break;
      }
      leftover += text.slice(0, match.index);
      this.handleReport(match);
      text = text.slice(match.index + match[0].length);
    }
    return Buffer.from(leftover, 'latin1');
  }

  private handleReport(match: RegExpExecArray): void {
    const cbStr = match[1];
    const colStr = match[2];
    const rowStr = match[3];
    const kind = match[4];
    if (!cbStr || !colStr || !rowStr || !kind) {
      return;
    }
    const cb = Number(cbStr);
    const col = Number(colStr);
    const row = Number(rowStr);
    const isRelease = kind === 'm';
    const isMotion = (cb & 0x20) !== 0;
    const isWheel = (cb & 0x40) !== 0;
    const button = cb & 0x03;

    if (isWheel) {
      this.handlers.onWheel(button === 0 ? 'up' : 'down', col, row);
      return;
    }

    if (isMotion) {
      if (this.armed && !this.dragging) {
        this.dragging = true;
        this.handlers.onDragStart(this.armed.col, this.armed.row);
      }
      if (this.dragging) {
        this.handlers.onDragMove(col, row);
      }
      return;
    }

    if (isRelease) {
      if (this.dragging) {
        this.handlers.onDragEnd(col, row);
      } else if (this.armed) {
        this.handlers.onTap(this.armed.col, this.armed.row);
      }
      this.armed = null;
      this.dragging = false;
      return;
    }

    // Press.
    if (button === 2) {
      this.handlers.onRightClick(col, row);
      return;
    }
    if (button === 0) {
      this.armed = { col, row };
    }
  }
}
