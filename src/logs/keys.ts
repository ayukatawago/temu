// Keyboard decoder for the log view. Separate from input/keymap.ts's KeyboardHandler on purpose:
// that one's modes are all about driving a streamed screen, while here every printable key is
// filter text. Shares its approach to the ESC-vs-CSI ambiguity (a short timeout on a lone ESC).

import { StringDecoder } from 'node:string_decoder';

export interface LogKeyHandlers {
  onQuit: () => void;
  onText: (text: string) => void;
  onBackspace: () => void;
  onClear: () => void;
  onDeleteWord: () => void;
  onScroll: (lines: number) => void;
  onPageUp: () => void;
  onPageDown: () => void;
  onHome: () => void;
  onEnd: () => void;
}

const ESCAPE_AMBIGUITY_TIMEOUT_MS = 30;

export class LogKeyboard {
  private pending: Buffer = Buffer.alloc(0);
  private escapeTimer: NodeJS.Timeout | null = null;
  private readonly decoder = new StringDecoder('utf8');

  constructor(private readonly handlers: LogKeyHandlers) {}

  dispose(): void {
    if (this.escapeTimer) {
      clearTimeout(this.escapeTimer);
      this.escapeTimer = null;
    }
  }

  feed(chunk: Buffer): void {
    this.pending = this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : chunk;
    for (;;) {
      if (this.pending.length === 0) {
        return;
      }
      const consumed = this.consumeOne();
      if (consumed === 0) {
        return;
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
        return 1; // bare Escape (or an Alt-chord we don't use): nothing to do in this view
      }
      for (let i = 2; i < this.pending.length; i++) {
        const byte = this.pending[i];
        if (byte !== undefined && byte >= 0x40 && byte <= 0x7e) {
          this.handleCsi(this.pending.subarray(2, i + 1).toString('latin1'));
          return i + 1;
        }
      }
      return 0; // incomplete CSI sequence, wait for more
    }
    // A UTF-8 character may arrive split across chunks; the decoder holds partial bytes.
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
      }
    }, ESCAPE_AMBIGUITY_TIMEOUT_MS);
  }

  private handleCsi(body: string): void {
    switch (body) {
      case 'A':
        this.handlers.onScroll(1);
        return;
      case 'B':
        this.handlers.onScroll(-1);
        return;
      case '5~':
        this.handlers.onPageUp();
        return;
      case '6~':
        this.handlers.onPageDown();
        return;
      case 'H':
      case '1~':
      case '7~':
        this.handlers.onHome();
        return;
      case 'F':
      case '4~':
      case '8~':
        this.handlers.onEnd();
        return;
      default:
        return;
    }
  }

  private handleByte(byte: number): void {
    switch (byte) {
      case 0x03: // Ctrl+C
        this.handlers.onQuit();
        return;
      case 0x15: // Ctrl+U
        this.handlers.onClear();
        return;
      case 0x17: // Ctrl+W
        this.handlers.onDeleteWord();
        return;
      case 0x7f:
      case 0x08:
        this.handlers.onBackspace();
        return;
      default:
        break;
    }
    if (byte < 0x20) {
      return; // other control bytes (Enter, Tab, ...) aren't meaningful in a one-line field
    }
    const text = this.decoder.write(Buffer.from([byte]));
    if (text.length > 0) {
      this.handlers.onText(text);
    }
  }
}
