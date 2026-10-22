// The log pane: a filter field on row 1, log lines below it, a footer on the last row. Owns the
// ring buffer, the filtered view of it, and the scroll/follow state. Plain ANSI via moveTo +
// padTruncate (see render/chrome.ts), no tmux passthrough.
//
// Entries get absolute sequence numbers (`firstSeq` is entries[0]'s) and the filtered list stores
// those, not array indices, so evicting old entries from the ring only needs a leading trim of
// the filtered list rather than renumbering it.

import { moveTo, padTruncate } from '../render/chrome.js';
import { formatEntry, type LogContext, type LogEntry, type LogLevel } from './entry.js';
import { parseFilter, type LogPredicate } from './filter.js';

const MAX_ENTRIES = 10_000;
/** Trim in batches: shifting a 10k array per incoming line would be quadratic under load. */
const TRIM_SLACK = 1_000;
const RENDER_INTERVAL_MS = 33;

const LEVEL_SGR: Record<LogLevel, string> = {
  V: '\x1b[2m',
  D: '\x1b[36m',
  I: '',
  W: '\x1b[33m',
  E: '\x1b[31m',
  A: '\x1b[1;31m',
};
const RESET = '\x1b[0m';

export class LogView {
  private entries: LogEntry[] = [];
  private firstSeq = 0;
  private filtered: number[] = [];
  private query = '';
  /** Cursor position in code points (0..length), so editing never splits a character. */
  private cursor = 0;
  private predicate: LogPredicate;
  /** Lines scrolled up from the newest filtered line; 0 means following. */
  private scrollBack = 0;
  private dirty = true;
  private timer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(
    private rows: number,
    private cols: number,
    private readonly ctx: LogContext,
    initialQuery = '',
  ) {
    this.query = initialQuery;
    this.cursor = Array.from(initialQuery).length;
    this.predicate = parseFilter(initialQuery);
  }

  start(): void {
    this.timer = setInterval(() => {
      if (this.dirty) {
        this.render();
      }
    }, RENDER_INTERVAL_MS);
    this.render();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  resize(rows: number, cols: number): void {
    this.rows = rows;
    this.cols = cols;
    this.clampScroll();
    process.stdout.write('\x1b[2J');
    this.render();
  }

  addEntry(entry: LogEntry): void {
    const seq = this.firstSeq + this.entries.length;
    this.entries.push(entry);
    if (this.predicate(entry, this.ctx)) {
      this.filtered.push(seq);
      // Keep a scrolled-back view anchored on the same lines as new ones arrive.
      if (this.scrollBack > 0) {
        this.scrollBack++;
      }
    }
    if (this.entries.length > MAX_ENTRIES + TRIM_SLACK) {
      this.trim();
    }
    this.dirty = true;
  }

  private trim(): void {
    const excess = this.entries.length - MAX_ENTRIES;
    this.entries.splice(0, excess);
    this.firstSeq += excess;
    let drop = 0;
    while (drop < this.filtered.length && (this.filtered[drop] ?? 0) < this.firstSeq) {
      drop++;
    }
    if (drop > 0) {
      this.filtered.splice(0, drop);
      this.clampScroll();
    }
  }

  // --- filter field -------------------------------------------------------------------------

  insert(text: string): void {
    const chars = Array.from(this.query);
    const inserted = Array.from(text);
    chars.splice(this.cursor, 0, ...inserted);
    this.setQuery(chars.join(''), this.cursor + inserted.length);
  }

  backspace(): void {
    if (this.cursor === 0) {
      return;
    }
    const chars = Array.from(this.query);
    chars.splice(this.cursor - 1, 1);
    this.setQuery(chars.join(''), this.cursor - 1);
  }

  deleteForward(): void {
    const chars = Array.from(this.query);
    chars.splice(this.cursor, 1);
    this.setQuery(chars.join(''), this.cursor);
  }

  clearQuery(): void {
    this.setQuery('', 0);
  }

  /** Deletes the word before the cursor, leaving text after it alone. */
  deleteWord(): void {
    const chars = Array.from(this.query);
    const before = chars
      .slice(0, this.cursor)
      .join('')
      .replace(/\s*\S*$/, '');
    const keptLength = Array.from(before).length;
    this.setQuery(before + chars.slice(this.cursor).join(''), keptLength);
  }

  /** Moves the cursor without touching the text; negative = left. */
  moveCursor(delta: number): void {
    this.setCursor(this.cursor + delta);
  }

  cursorToStart(): void {
    this.setCursor(0);
  }

  cursorToEnd(): void {
    this.setCursor(Array.from(this.query).length);
  }

  private setCursor(cursor: number): void {
    const next = Math.min(Math.max(0, cursor), Array.from(this.query).length);
    if (next !== this.cursor) {
      this.cursor = next;
      this.dirty = true;
    }
  }

  private setQuery(query: string, cursor: number): void {
    this.cursor = cursor;
    this.dirty = true;
    if (query === this.query) {
      return;
    }
    this.query = query;
    this.predicate = parseFilter(query);
    this.filtered = [];
    this.entries.forEach((entry, index) => {
      if (this.predicate(entry, this.ctx)) {
        this.filtered.push(this.firstSeq + index);
      }
    });
    this.scrollBack = 0;
    this.dirty = true;
  }

  // --- scrolling ----------------------------------------------------------------------------

  private bodyRows(): number {
    return Math.max(1, this.rows - 2);
  }

  private clampScroll(): void {
    const max = Math.max(0, this.filtered.length - this.bodyRows());
    this.scrollBack = Math.min(Math.max(0, this.scrollBack), max);
  }

  scrollBy(lines: number): void {
    // Positive = toward older lines.
    this.scrollBack += lines;
    this.clampScroll();
    this.dirty = true;
  }

  pageUp(): void {
    this.scrollBy(this.bodyRows() - 1);
  }

  pageDown(): void {
    this.scrollBy(-(this.bodyRows() - 1));
  }

  toOldest(): void {
    this.scrollBack = Number.MAX_SAFE_INTEGER;
    this.clampScroll();
    this.dirty = true;
  }

  follow(): void {
    this.scrollBack = 0;
    this.dirty = true;
  }

  // --- drawing ------------------------------------------------------------------------------

  private render(): void {
    if (this.disposed) {
      return;
    }
    this.dirty = false;
    const body = this.bodyRows();
    const end = this.filtered.length - this.scrollBack;
    const start = Math.max(0, end - body);

    let out = '\x1b7\x1b[?25l';
    // The cursor is drawn as a reverse-video cell over the character it's on (a space past the
    // end) rather than as the real terminal cursor, which stays hidden.
    const chars = Array.from(this.query);
    const prefix = 'filter> ';
    const before = chars.slice(0, this.cursor).join('');
    const under = chars[this.cursor] ?? ' ';
    const after = chars.slice(this.cursor + 1).join('');
    const filterLine = `${prefix}${before}\x1b[7m${under}${RESET}${after}`;
    // padTruncate counts the escape bytes, so pad by the visible width instead.
    const visible = prefix.length + chars.length + (this.cursor >= chars.length ? 1 : 0);
    out +=
      moveTo(1, 1) +
      (visible >= this.cols
        ? padTruncate(`${prefix}${this.query}`, this.cols)
        : filterLine + ' '.repeat(this.cols - visible));
    for (let i = 0; i < body; i++) {
      const seq = this.filtered[start + i];
      const entry = seq === undefined ? undefined : this.entries[seq - this.firstSeq];
      const row = 2 + i;
      if (!entry || start + i >= end) {
        out += moveTo(row, 1) + padTruncate('', this.cols);
        continue;
      }
      out +=
        moveTo(row, 1) +
        LEVEL_SGR[entry.level] +
        padTruncate(formatEntry(entry, this.ctx), this.cols) +
        RESET;
    }
    const mode = this.scrollBack > 0 ? 'PAUSED' : 'FOLLOW';
    const footer =
      `${String(this.filtered.length)}/${String(this.entries.length)}  ${mode}  ` +
      '↑↓ PgUp PgDn scroll  End:follow  ←→ edit  Ctrl+U:clear  Ctrl+C:quit';
    out += `${moveTo(this.rows, 1)}\x1b[7m${padTruncate(footer, this.cols)}${RESET}`;
    out += '\x1b8';
    process.stdout.write(out);
  }
}
