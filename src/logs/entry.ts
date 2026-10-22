// The platform-neutral log record both log sources (Android logcat, iOS `log stream`) produce, and
// the one-line text form the log view draws and the filter's bare-word terms match against.

export type LogLevel = 'V' | 'D' | 'I' | 'W' | 'E' | 'A';

export const LOG_LEVEL_ORDER: readonly LogLevel[] = ['V', 'D', 'I', 'W', 'E', 'A'];

export function levelRank(level: LogLevel): number {
  return LOG_LEVEL_ORDER.indexOf(level);
}

export interface LogEntry {
  /** `HH:MM:SS.mmm`. */
  time: string;
  pid: number;
  level: LogLevel;
  /** Android tag, or `subsystem:category` on iOS. */
  tag: string;
  /** Known at parse time on iOS; on Android resolved later from a pid -> package map. */
  process: string | undefined;
  message: string;
}

/** Resolves an entry's process/package name, falling back to what the source already knew. */
export interface LogContext {
  processName(entry: LogEntry): string | undefined;
}

const PROCESS_COLUMN_WIDTH = 24;
const TAG_COLUMN_WIDTH = 24;

/** Pads to `width`, or cuts to it with a `…` at the cut end (`keep` = which end survives). */
function fitColumn(text: string, width: number, keep: 'start' | 'end'): string {
  const chars = Array.from(text);
  if (chars.length <= width) {
    return text + ' '.repeat(width - chars.length);
  }
  return keep === 'start'
    ? `${chars.slice(0, width - 1).join('')}…`
    : `…${chars.slice(chars.length - (width - 1)).join('')}`;
}

/**
 * The line as drawn: process and tag in fixed-width columns so messages all start at the same
 * position. Process keeps its tail (the distinguishing part of a package name is the end), tag
 * keeps its head. Truncation is display-only — the filter matches `formatEntry`'s full text.
 */
export function formatEntryColumns(entry: LogEntry, ctx: LogContext): string {
  const processName = ctx.processName(entry) ?? String(entry.pid);
  return (
    `${entry.time} ${entry.level} ` +
    `${fitColumn(processName, PROCESS_COLUMN_WIDTH, 'end')} ` +
    `${fitColumn(entry.tag, TAG_COLUMN_WIDTH, 'start')} ${entry.message}`
  );
}

export function formatEntry(entry: LogEntry, ctx: LogContext): string {
  const processName = ctx.processName(entry) ?? String(entry.pid);
  return `${entry.time} ${entry.level} ${processName} ${entry.tag}: ${entry.message}`;
}
