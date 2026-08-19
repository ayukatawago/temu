// `temu` / `temu --device <serial>`: the live streaming render loop. Attaches to a device,
// works out how big a grid fits the current pane, and pumps frames from screenrecord through
// ffmpeg into the Kitty-graphics renderer until the user quits. Also wires up mouse-driven
// tap/drag/scroll/back (input/mouse.ts + input/adbshell.ts) — the modal keyboard layer for
// precise targeting (hjkl nudge, hint mode, text entry) lands in later milestones.

import { ScreenrecordSource } from './device/capture.js';
import { getDeviceGeometry, pickDefaultDevice, type DeviceGeometry } from './device/discover.js';
import { PngFrameSplitter } from './device/transcode.js';
import { AdbShellInputBackend } from './input/adbshell.js';
import type { InputBackend } from './input/backend.js';
import { MouseTracker } from './input/mouse.js';
import { detectCaps, queryCursorPosition, type CellPixelSize } from './render/caps.js';
import {
  cellToDevicePixel,
  fitDeviceToCells,
  type FitResult,
  type GridOrigin,
} from './render/geometry.js';
import { KittyRenderer } from './render/kitty.js';

export interface StreamOptions {
  device?: string | undefined;
  bitrate: string;
}

export function parseStreamArgs(argv: string[]): StreamOptions {
  let device: string | undefined;
  let bitrate = '8M';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--device') {
      device = argv[++i];
    } else if (arg === '--bitrate') {
      bitrate = argv[++i] ?? bitrate;
    }
  }
  return { device, bitrate };
}

const STATUS_BAR_ROWS = 1;
const RESIZE_DEBOUNCE_MS = 150;

/**
 * Owns one running (capture -> transcode) pipeline at a fixed capture resolution, and knows how
 * to tear itself down and be replaced by a new one — the only way to change the resolution
 * screenrecord/ffmpeg are working at, since neither can be resized in place.
 */
class Pipeline {
  private readonly capture: ScreenrecordSource;
  private splitter: PngFrameSplitter;
  private stopped = false;

  constructor(
    private readonly serial: string,
    private readonly capturePx: { width: number; height: number },
    private readonly bitrate: string,
    private readonly onFrame: (png: Buffer) => void,
    private readonly onLog: (message: string) => void,
  ) {
    this.capture = new ScreenrecordSource({
      serial,
      width: capturePx.width,
      height: capturePx.height,
      bitrate,
    });
    this.capture.on('restart', (event: { code: number | null; count: number }) => {
      this.onLog(
        `screenrecord restarted (attempt ${event.count}, exit code ${String(event.code)})`,
      );
    });
    this.splitter = this.attachSplitter();
  }

  private attachSplitter(): PngFrameSplitter {
    const splitter = new PngFrameSplitter(this.capture.h264, this.capturePx);
    splitter.on('frame', this.onFrame);
    splitter.on('exit', (event: { code: number | null }) => {
      if (this.stopped) {
        return;
      }
      this.onLog(`ffmpeg exited unexpectedly (code ${String(event.code)}) — restarting transcoder`);
      this.splitter = this.attachSplitter();
    });
    return splitter;
  }

  stop(): void {
    this.stopped = true;
    this.splitter.stop();
    this.capture.stop();
  }
}

function frameDropper(renderer: KittyRenderer, onError: (error: unknown) => void) {
  let inFlight = false;
  let pending: Buffer | null = null;

  const send = (png: Buffer): void => {
    inFlight = true;
    renderer
      .renderFramePng(png)
      .catch(onError)
      .finally(() => {
        inFlight = false;
        if (pending) {
          const next = pending;
          pending = null;
          send(next);
        }
      });
  };

  // Drop frames rather than queue them: if the previous frame's transmit is still in flight,
  // queuing would only build unbounded latency under load. At most one frame is ever "pending".
  return (png: Buffer): void => {
    if (inFlight) {
      pending = png;
      return;
    }
    send(png);
  };
}

function currentAvailableCells(): { cols: number; rows: number } {
  const cols = process.stdout.columns ?? 80;
  const rows = Math.max(1, (process.stdout.rows ?? 24) - STATUS_BAR_ROWS);
  return { cols, rows };
}

/** Wheel-to-swipe geometry: a short vertical drag centered on the pointer, in device pixels. */
const WHEEL_SWIPE_HALF_HEIGHT_PX = 220;
const WHEEL_SWIPE_DURATION_MS = 120;

function setUpMouse(
  input: InputBackend,
  origin: GridOrigin,
  getFit: () => FitResult,
  geometry: DeviceGeometry,
  onInterrupt: () => void,
): MouseTracker {
  const toDevicePx = (col: number, row: number): { x: number; y: number } =>
    cellToDevicePixel(col, row, origin, getFit(), geometry.width, geometry.height);

  return new MouseTracker({
    onTap: (col, row) => {
      const { x, y } = toDevicePx(col, row);
      input.tap(x, y);
    },
    onDragStart: (col, row) => {
      const { x, y } = toDevicePx(col, row);
      input.touchDown(x, y);
    },
    onDragMove: (col, row) => {
      const { x, y } = toDevicePx(col, row);
      input.touchMove(x, y);
    },
    onDragEnd: (col, row) => {
      const { x, y } = toDevicePx(col, row);
      input.touchUp(x, y);
    },
    onWheel: (direction, col, row) => {
      const { x, y } = toDevicePx(col, row);
      // "up" follows the traditional desktop convention: scrolling up reveals content further
      // down the page, i.e. the on-screen content moves up — a swipe from below to above.
      const [y1, y2] =
        direction === 'up'
          ? [y + WHEEL_SWIPE_HALF_HEIGHT_PX, y - WHEEL_SWIPE_HALF_HEIGHT_PX]
          : [y - WHEEL_SWIPE_HALF_HEIGHT_PX, y + WHEEL_SWIPE_HALF_HEIGHT_PX];
      input.swipe(x, y1, x, y2, WHEEL_SWIPE_DURATION_MS);
    },
    onRightClick: () => {
      input.keyevent('KEYCODE_BACK');
    },
    onInterrupt,
  });
}

export async function runStream(argv: string[]): Promise<number> {
  const options = parseStreamArgs(argv);

  if (!process.stdout.isTTY) {
    console.error('temu must be run attached to a terminal (stdout is not a TTY).');
    return 1;
  }

  let serial: string;
  try {
    serial = await pickDefaultDevice(options.device);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  let geometry: DeviceGeometry;
  try {
    geometry = await getDeviceGeometry(serial);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const caps = await detectCaps();
  if (caps.kittyGraphicsSupported === false) {
    console.error('This terminal does not appear to support Kitty graphics. Run `temu doctor`.');
    return 1;
  }
  if (caps.insideTmux && caps.tmuxAllowPassthrough !== 'on') {
    console.error('tmux allow-passthrough is off. Run `temu doctor --fix` first.');
    return 1;
  }
  const cellSize: CellPixelSize = caps.cellSize;

  const { cols: startCols, rows: startRows } = currentAvailableCells();
  let fit = fitDeviceToCells(startCols, startRows, geometry.width, geometry.height, cellSize);

  console.log(
    `temu — streaming ${serial} (${String(geometry.width)}x${String(geometry.height)}) ` +
      `at ${String(fit.cols)}x${String(fit.rows)} cells. Ctrl+C to quit.\n`,
  );

  // Queried right before the renderer draws its placeholder grid at the current cursor
  // position, so mouse reports (also absolute-viewport coordinates) can be mapped back to a
  // position within the grid. Falls back to assuming the top-left corner of the terminal if the
  // terminal doesn't answer in time — mouse targeting would be off, but nothing crashes.
  const cursorPosition = await queryCursorPosition();
  const gridOrigin: GridOrigin = cursorPosition ?? { row: 1, col: 1 };

  const renderer = new KittyRenderer({ cols: fit.cols, rows: fit.rows });
  const dropFrame = frameDropper(renderer, (error: unknown) => {
    console.error('render error:', error);
  });

  let pipeline = new Pipeline(serial, fit.capturePx, options.bitrate, dropFrame, (message) => {
    console.error(message);
  });

  let resizeTimer: NodeJS.Timeout | null = null;
  const handleResize = (): void => {
    if (resizeTimer) {
      clearTimeout(resizeTimer);
    }
    resizeTimer = setTimeout(() => {
      const { cols, rows } = currentAvailableCells();
      const nextFit = fitDeviceToCells(cols, rows, geometry.width, geometry.height, cellSize);
      if (
        nextFit.cols === fit.cols &&
        nextFit.rows === fit.rows &&
        nextFit.capturePx.width === fit.capturePx.width &&
        nextFit.capturePx.height === fit.capturePx.height
      ) {
        return;
      }
      fit = nextFit;
      renderer.resize(fit.cols, fit.rows);
      pipeline.stop();
      pipeline = new Pipeline(serial, fit.capturePx, options.bitrate, dropFrame, (message) => {
        console.error(message);
      });
    }, RESIZE_DEBOUNCE_MS);
  };
  process.stdout.on('resize', handleResize);

  const input = new AdbShellInputBackend(serial, (message) => console.error(message));

  let exiting = false;
  const cleanup = (): void => {
    if (exiting) {
      return;
    }
    exiting = true;
    if (resizeTimer) {
      clearTimeout(resizeTimer);
    }
    process.stdout.off('resize', handleResize);
    mouseTracker.disable();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.off('data', onStdinData);
    process.stdin.pause();
    input.dispose();
    pipeline.stop();
    renderer.dispose();
  };

  let resolveRun: ((code: number) => void) | null = null;
  const quit = (): void => {
    cleanup();
    resolveRun?.(0);
  };
  process.once('SIGINT', quit);
  process.once('SIGTERM', quit);

  const mouseTracker = setUpMouse(input, gridOrigin, () => fit, geometry, quit);
  const onStdinData = (chunk: Buffer): void => {
    mouseTracker.feed(chunk);
  };

  mouseTracker.enable();
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.on('data', onStdinData);

  return new Promise<number>((resolve) => {
    resolveRun = resolve;
  });
}
