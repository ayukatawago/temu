// Decodes raw stdin bytes left over after MouseTracker has taken its share (SGR mouse reports)
// into a small modal keyboard: normal mode (crosshair nudge + hardware buttons) and text-input
// mode. Hint mode (`f`) and zoom (`z`) — the real answer to "cells are too coarse to click
// precisely" — land in a later milestone; this is the fallback that always works.
//
// Terminal input is a byte stream with an inherent ambiguity: a lone ESC byte (the Escape key)
// looks identical to the start of a CSI sequence (arrow keys, etc.) until the next byte arrives.
// This buffers incomplete sequences and resolves a trailing lone ESC via a short timeout instead
// of guessing.

export type KeyboardMode = 'normal' | 'text';

export interface KeyboardHandlers {
  onQuit: () => void;
  /** dx/dy are unit direction (-1, 0, or 1); `big` requests the larger (Shift+arrow) step. */
  onMoveCrosshair: (dx: -1 | 0 | 1, dy: -1 | 0 | 1, big: boolean) => void;
  onTapCrosshair: () => void;
  onBack: () => void;
  onHome: () => void;
  onRecents: () => void;
  onPower: () => void;
  onVolumeUp: () => void;
  onVolumeDown: () => void;
  onScreenshot: (announcePath: boolean) => void;
  onFpsDelta: (delta: number) => void;
  onToggleHelp: () => void;
  onModeChange: (mode: KeyboardMode) => void;
  onTextChar: (char: string) => void;
  onTextBackspace: () => void;
  onTextEnter: () => void;
}

const ESCAPE_AMBIGUITY_TIMEOUT_MS = 30;

const ARROW_DELTAS: Record<'A' | 'B' | 'C' | 'D', [-1 | 0 | 1, -1 | 0 | 1]> = {
  A: [0, -1], // up
  B: [0, 1], // down
  C: [1, 0], // right
  D: [-1, 0], // left
};

export class KeyboardHandler {
  private mode: KeyboardMode = 'normal';
  private pending: Buffer = Buffer.alloc(0);
  private escapeTimer: NodeJS.Timeout | null = null;
  private textBuffer = '';
  private textFlushTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly handlers: KeyboardHandlers,
    private readonly textFlushDelayMs = 120,
  ) {}

  feed(chunk: Buffer): void {
    this.pending = this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : chunk;
    this.drain();
  }

  private drain(): void {
    for (;;) {
      if (this.pending.length === 0) {
        return;
      }
      const consumed = this.consumeOne();
      if (consumed === 0) {
        return; // waiting for more bytes to disambiguate an escape sequence
      }
      this.pending = this.pending.subarray(consumed);
    }
  }

  private consumeOne(): number {
    const first = this.pending[0];
    if (first === undefined) {
      return 0;
    }

    if (first === 0x1b) {
      if (this.pending.length === 1) {
        this.scheduleEscapeFlush();
        return 0;
      }
      if (this.pending[1] !== 0x5b /* '[' */) {
        this.handleEscapeKey();
        return 1;
      }
      for (let i = 2; i < this.pending.length; i++) {
        const byte = this.pending[i];
        if (byte === undefined) {
          break;
        }
        if (byte >= 0x40 && byte <= 0x7e) {
          this.handleCsiSequence(this.pending.subarray(0, i + 1).toString('latin1'));
          return i + 1;
        }
      }
      return 0; // incomplete CSI sequence, wait for more
    }

    this.handleByte(first);
    return 1;
  }

  private scheduleEscapeFlush(): void {
    if (this.escapeTimer) {
      return;
    }
    this.escapeTimer = setTimeout(() => {
      this.escapeTimer = null;
      if (this.pending.length === 1 && this.pending[0] === 0x1b) {
        this.pending = this.pending.subarray(1);
        this.handleEscapeKey();
      }
    }, ESCAPE_AMBIGUITY_TIMEOUT_MS);
  }

  private handleCsiSequence(seq: string): void {
    // eslint-disable-next-line no-control-regex -- matching a real CSI sequence from the terminal
    const match = /^\x1b\[(?:1;(\d))?([ABCD])$/.exec(seq);
    if (!match) {
      return; // unrecognized CSI sequence, ignore
    }
    const modifierStr = match[1];
    const direction = match[2] as 'A' | 'B' | 'C' | 'D' | undefined;
    if (!direction) {
      return;
    }
    // xterm modifier encoding: value = 1 + bitmask(shift=1, alt=2, ctrl=4) — shift is set for
    // any of the odd bitmask combinations, which all land on an even encoded value.
    const modifier = modifierStr ? Number(modifierStr) : 1;
    const big = modifier % 2 === 0;
    const [dx, dy] = ARROW_DELTAS[direction];
    if (this.mode === 'normal') {
      this.handlers.onMoveCrosshair(dx, dy, big);
    }
  }

  private handleEscapeKey(): void {
    if (this.mode === 'text') {
      this.flushText();
      this.setMode('normal');
    }
  }

  private setMode(mode: KeyboardMode): void {
    if (this.mode === mode) {
      return;
    }
    this.mode = mode;
    this.handlers.onModeChange(mode);
  }

  private queueTextChar(char: string): void {
    this.textBuffer += char;
    if (this.textFlushTimer) {
      clearTimeout(this.textFlushTimer);
    }
    this.textFlushTimer = setTimeout(() => this.flushText(), this.textFlushDelayMs);
  }

  private flushText(): void {
    if (this.textFlushTimer) {
      clearTimeout(this.textFlushTimer);
      this.textFlushTimer = null;
    }
    if (this.textBuffer.length > 0) {
      this.handlers.onTextChar(this.textBuffer);
      this.textBuffer = '';
    }
  }

  private handleByte(byte: number): void {
    if (this.mode === 'text') {
      this.handleTextModeByte(byte);
      return;
    }
    this.handleNormalModeByte(byte);
  }

  private handleTextModeByte(byte: number): void {
    if (byte === 0x0d || byte === 0x0a) {
      this.flushText();
      this.handlers.onTextEnter();
      return;
    }
    if (byte === 0x7f || byte === 0x08) {
      this.flushText();
      this.handlers.onTextBackspace();
      return;
    }
    if (byte === 0x03) {
      // Ctrl+C still quits even mid-typing — there's no other way to force-exit if something
      // goes wrong, and losing an in-progress word is an acceptable trade-off for that.
      this.handlers.onQuit();
      return;
    }
    if (byte >= 0x20 && byte < 0x7f) {
      this.queueTextChar(String.fromCharCode(byte));
    }
    // Other control bytes in text mode (tab, etc.) are ignored for now.
  }

  private handleNormalModeByte(byte: number): void {
    switch (byte) {
      case 0x03: // Ctrl+C
      case 0x71: // q
        this.handlers.onQuit();
        return;
      case 0x68: // h
        this.handlers.onMoveCrosshair(-1, 0, false);
        return;
      case 0x6a: // j
        this.handlers.onMoveCrosshair(0, 1, false);
        return;
      case 0x6b: // k
        this.handlers.onMoveCrosshair(0, -1, false);
        return;
      case 0x6c: // l
        this.handlers.onMoveCrosshair(1, 0, false);
        return;
      case 0x0d: // Enter
      case 0x20: // Space
        this.handlers.onTapCrosshair();
        return;
      case 0x69: // i
        this.setMode('text');
        return;
      case 0x62: // b
        this.handlers.onBack();
        return;
      case 0x48: // H
        this.handlers.onHome();
        return;
      case 0x72: // r
        this.handlers.onRecents();
        return;
      case 0x70: // p
        this.handlers.onPower();
        return;
      case 0x5b: // [
        this.handlers.onVolumeDown();
        return;
      case 0x5d: // ]
        this.handlers.onVolumeUp();
        return;
      case 0x73: // s
        this.handlers.onScreenshot(false);
        return;
      case 0x53: // S
        this.handlers.onScreenshot(true);
        return;
      case 0x2b: // +
        this.handlers.onFpsDelta(1);
        return;
      case 0x2d: // -
        this.handlers.onFpsDelta(-1);
        return;
      case 0x3f: // ?
        this.handlers.onToggleHelp();
        return;
      default:
        return;
    }
  }
}
