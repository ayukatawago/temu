// `temu` / `temu --device <serial>`: the live streaming render loop. Attaches to a device,
// works out how big a grid fits the current pane, and pumps frames from screenrecord through
// ffmpeg into the Kitty-graphics renderer until the user quits.
//
// Input handling (tap/swipe/keyboard) lands in later milestones — for now this is display-only.

import { ScreenrecordSource } from './device/capture.js';
import { getDeviceGeometry, pickDefaultDevice, type DeviceGeometry } from './device/discover.js';
import { PngFrameSplitter } from './device/transcode.js';
import { detectCaps, type CellPixelSize } from './render/caps.js';
import { fitDeviceToCells } from './render/geometry.js';
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
    pipeline.stop();
    renderer.dispose();
  };

  return new Promise<number>((resolveRun) => {
    const quit = (): void => {
      cleanup();
      resolveRun(0);
    };
    process.once('SIGINT', quit);
    process.once('SIGTERM', quit);
  });
}
