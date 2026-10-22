// `temu --logs`: the log-viewer session. No capture, ffmpeg or renderer involved — just a log
// source feeding a LogView on the alternate screen, with the same terminal-safety handling
// (signals, dead-pty EIO, exit safety net) runStream has and for the same documented reasons.

import { LogcatSource } from '../device/logcat.js';
import { IosLogStreamSource } from '../device/ios/logstream.js';
import { resolveDeviceRef } from '../device/target.js';
import { DISABLE_MOUSE_TRACKING, MouseTracker } from '../input/mouse.js';
import { enterAltScreen, leaveAltScreen } from '../render/chrome.js';
import type { StreamOptions } from '../stream.js';
import type { LogContext, LogEntry } from './entry.js';
import { LogKeyboard } from './keys.js';
import { LogView } from './view.js';

const WHEEL_LINES = 3;

/** Same `0`-not-just-`undefined` winsize guard as stream.ts's currentAvailableCells. */
function paneSize(): { rows: number; cols: number } {
  const cols = process.stdout.columns;
  const rows = process.stdout.rows;
  return { cols: cols && cols > 0 ? cols : 80, rows: rows && rows > 0 ? rows : 24 };
}

export async function runLogs(options: StreamOptions): Promise<number> {
  if (!process.stdout.isTTY) {
    console.error('temu must be run attached to a terminal (stdout is not a TTY).');
    return 1;
  }
  process.stdout.on('error', () => undefined);

  let ref;
  try {
    ref = await resolveDeviceRef(options.device, options.platform);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const source = ref.platform === 'ios' ? new IosLogStreamSource(ref.id) : new LogcatSource(ref.id);
  const ctx: LogContext = {
    processName: (entry) =>
      entry.process ?? (source instanceof LogcatSource ? source.processName(entry.pid) : undefined),
  };
  // Source errors (adb/xcrun missing mid-session) shouldn't crash the viewer as unhandled events.
  source.on('error', () => undefined);

  enterAltScreen();
  process.stdout.write('\x1b[2J\x1b[H');

  const size = paneSize();
  const view = new LogView(size.rows, size.cols, ctx, options.filter ?? '');
  source.on('entry', (entry: LogEntry) => view.addEntry(entry));

  const onResize = (): void => {
    const next = paneSize();
    view.resize(next.rows, next.cols);
  };
  process.stdout.on('resize', onResize);

  const mouse = new MouseTracker({
    onTap: () => undefined,
    onDragStart: () => undefined,
    onDragMove: () => undefined,
    onDragEnd: () => undefined,
    onRightClick: () => undefined,
    onWheel: (direction) => view.scrollBy(direction === 'up' ? WHEEL_LINES : -WHEEL_LINES),
  });

  let exiting = false;
  let resolveRun: ((code: number) => void) | null = null;
  const onStdinData = (chunk: Buffer): void => {
    keyboard.feed(mouse.feed(chunk));
  };
  const cleanup = (): void => {
    if (exiting) {
      return;
    }
    exiting = true;
    process.stdout.off('resize', onResize);
    mouse.disable();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.off('data', onStdinData);
    process.stdin.pause();
    keyboard.dispose();
    view.dispose();
    source.stop();
    process.stdout.write('\x1b[?25h');
    leaveAltScreen();
  };
  const quit = (): void => {
    cleanup();
    resolveRun?.(0);
  };

  const keyboard = new LogKeyboard({
    onQuit: quit,
    onText: (text) => view.insert(text),
    onBackspace: () => view.backspace(),
    onClear: () => view.clearQuery(),
    onDeleteWord: () => view.deleteWord(),
    onScroll: (lines) => view.scrollBy(lines),
    onPageUp: () => view.pageUp(),
    onPageDown: () => view.pageDown(),
    onHome: () => view.toOldest(),
    onEnd: () => view.follow(),
  });

  process.once('exit', () => {
    if (exiting) {
      return;
    }
    process.stdout.write(`${DISABLE_MOUSE_TRACKING}\x1b[?25h`);
    leaveAltScreen();
  });
  process.once('SIGINT', quit);
  process.once('SIGTERM', quit);
  process.once('SIGHUP', quit);

  view.start();
  mouse.enable();
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.on('data', onStdinData);

  return new Promise<number>((resolve) => {
    resolveRun = resolve;
  });
}
