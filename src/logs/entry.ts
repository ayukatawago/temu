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

export function formatEntry(entry: LogEntry, ctx: LogContext): string {
  const processName = ctx.processName(entry) ?? String(entry.pid);
  return `${entry.time} ${entry.level} ${processName} ${entry.tag}: ${entry.message}`;
}
