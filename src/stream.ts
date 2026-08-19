// `temu` / `temu --device <serial>`: the live streaming render loop. Attaches to a device,
// works out how big a grid fits the current pane, and pumps frames from screenrecord through
// ffmpeg into the Kitty-graphics renderer until the user quits. Also wires up mouse-driven
// tap/drag/scroll/back (input/mouse.ts + input/adbshell.ts) and the modal keyboard (crosshair
// nudge, hardware buttons, text entry, hint mode, zoom).

import { writeFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { captureScreencapPng, ScreenrecordSource } from './device/capture.js';
import { getDeviceGeometry, pickDefaultDevice, type DeviceGeometry } from './device/discover.js';
import { PngFrameSplitter } from './device/transcode.js';
import { AdbShellInputBackend } from './input/adbshell.js';
import type { InputBackend } from './input/backend.js';
import {
  dumpUiHierarchy,
  parseHintTargets,
  renderHintOverlay,
  type HintTarget,
} from './input/hints.js';
import { KeyboardHandler, type KeyboardMode } from './input/keymap.js';
import { MouseTracker } from './input/mouse.js';
import { detectCaps, queryCursorPosition, type CellPixelSize } from './render/caps.js';
import { renderHelpOverlay, StatusBar } from './render/chrome.js';
import {
  cellToDevicePixel,
  computeZoomRegion,
  fitDeviceToCells,
  type FitResult,
  type GridOrigin,
  type ZoomRegion,
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

export interface PipelineOptions {
  /** What screenrecord is told to encode at (`--size`). */
  capturePx: { width: number; height: number };
  /** What ffmpeg scales (post-crop, if any) down to — always the on-screen target size. */
  outputPx: { width: number; height: number };
  /**
   * Sub-rectangle of the *captured* frame to crop to before scaling, in capture-pixel
   * coordinates. Used by zoom mode, which restarts the whole pipeline at full native capture
   * resolution specifically so a crop shows genuine extra detail rather than a blown-up blur of
   * an already-downscaled capture.
   */
  crop?: { x: number; y: number; width: number; height: number };
}

/**
 * Owns one running (capture -> transcode) pipeline at a fixed capture resolution, and knows how
 * to tear itself down and be replaced by a new one — the only way to change the resolution
 * screenrecord/ffmpeg are working at, since neither can be resized in place. Resize *and* zoom
 * both work by tearing down and rebuilding one of these with different options.
 */
class Pipeline {
  private readonly capture: ScreenrecordSource;
  private splitter: PngFrameSplitter;
  private stopped = false;

  constructor(
    private readonly serial: string,
    private readonly options: PipelineOptions,
    private readonly bitrate: string,
    private readonly onFrame: (png: Buffer) => void,
    private readonly onLog: (message: string) => void,
  ) {
    this.capture = new ScreenrecordSource({
      serial,
      width: options.capturePx.width,
      height: options.capturePx.height,
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
    const splitter = new PngFrameSplitter(this.capture.h264, {
      width: this.options.outputPx.width,
      height: this.options.outputPx.height,
      ...(this.options.crop ? { crop: this.options.crop } : {}),
    });
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
  });
}

const CROSSHAIR_BIG_STEP_MULTIPLIER = 5;
const DEFAULT_FPS_CAP = 15;
const MIN_FPS_CAP = 1;
const MAX_FPS_CAP = 30;
/** Zoom shows 1/ZOOM_FACTOR of the device's width and height, magnified to fill the same grid. */
const ZOOM_FACTOR = 3;

export interface KeyboardSetup {
  keyboard: KeyboardHandler;
  getFpsCap: () => number;
  isHelpVisible: () => boolean;
  isHintActive: () => boolean;
}

/**
 * Wires the modal keyboard's commands up to the input backend, a crosshair position tracked in
 * device pixels, the status bar, the help overlay, and hint mode. Zoom is the one command this
 * doesn't fully own: rebuilding the capture pipeline at a different resolution is runStream's
 * job (it owns `Pipeline`), so `onZoomRequested` just reports where the crosshair was when `z`
 * was pressed and leaves the rest to the caller.
 */
function setUpKeyboard(
  input: InputBackend,
  serial: string,
  geometry: DeviceGeometry,
  getFit: () => FitResult,
  origin: GridOrigin,
  renderer: KittyRenderer,
  statusBar: StatusBar,
  onQuit: () => void,
  onZoomRequested: (centerX: number, centerY: number) => void,
): KeyboardSetup {
  let crosshair = { x: Math.round(geometry.width / 2), y: Math.round(geometry.height / 2) };
  let fpsCap = DEFAULT_FPS_CAP;
  let helpVisible = false;
  let hintTargets: HintTarget[] = [];
  let hintBuffer = '';
  let hintActive = false;
  statusBar.setFps(fpsCap);
  statusBar.setCrosshair(crosshair);

  const finishHint = (): void => {
    hintActive = false;
    hintBuffer = '';
    hintTargets = [];
    const fit = getFit();
    renderer.resize(fit.cols, fit.rows); // forces a placeholder redraw, clearing the overlay
    keyboard.exitHintMode();
  };

  const keyboard = new KeyboardHandler({
    onQuit,
    onMoveCrosshair: (dx, dy, big) => {
      const fit = getFit();
      const multiplier = big ? CROSSHAIR_BIG_STEP_MULTIPLIER : 1;
      const stepX = Math.max(1, Math.round(geometry.width / fit.cols)) * multiplier;
      const stepY = Math.max(1, Math.round(geometry.height / fit.rows)) * multiplier;
      crosshair = {
        x: Math.min(geometry.width - 1, Math.max(0, crosshair.x + dx * stepX)),
        y: Math.min(geometry.height - 1, Math.max(0, crosshair.y + dy * stepY)),
      };
      statusBar.setCrosshair(crosshair);
    },
    onTapCrosshair: () => {
      input.tap(crosshair.x, crosshair.y);
    },
    onBack: () => input.keyevent('KEYCODE_BACK'),
    onHome: () => input.keyevent('KEYCODE_HOME'),
    onRecents: () => input.keyevent('KEYCODE_APP_SWITCH'),
    onPower: () => input.keyevent('KEYCODE_POWER'),
    onVolumeUp: () => input.keyevent('KEYCODE_VOLUME_UP'),
    onVolumeDown: () => input.keyevent('KEYCODE_VOLUME_DOWN'),
    onScreenshot: (announcePath) => {
      const filename = `temu-screenshot-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.png`;
      const fullPath = resolvePath(filename);
      captureScreencapPng(serial)
        .then((png) => writeFile(fullPath, png))
        .then(() => {
          statusBar.showToast(announcePath ? `saved: ${fullPath}` : `saved: ${filename}`, 4000);
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          statusBar.showToast(`screenshot failed: ${message}`, 4000);
        });
    },
    onFpsDelta: (delta) => {
      fpsCap = Math.min(MAX_FPS_CAP, Math.max(MIN_FPS_CAP, fpsCap + delta));
      statusBar.setFps(fpsCap);
    },
    onToggleHelp: () => {
      helpVisible = !helpVisible;
      const fit = getFit();
      if (helpVisible) {
        renderHelpOverlay(origin.row, origin.col, fit.cols, fit.rows);
      } else {
        // Forces the placeholder grid to be redrawn on the next frame, which overwrites the
        // help text sitting in the same cells.
        renderer.resize(fit.cols, fit.rows);
      }
    },
    onModeChange: (mode: KeyboardMode) => {
      statusBar.setMode(mode);
    },
    onTextChar: (chars) => input.text(chars),
    onTextBackspace: () => input.keyevent('KEYCODE_DEL'),
    onTextEnter: () => input.keyevent('KEYCODE_ENTER'),
    onEnterHintMode: () => {
      hintBuffer = '';
      hintActive = false;
      statusBar.showToast('computing hints…', 15000);
      dumpUiHierarchy(serial)
        .then((xml) => {
          const targets = parseHintTargets(xml);
          if (targets.length === 0) {
            statusBar.showToast('no clickable elements found', 2000);
            finishHint();
            return;
          }
          hintTargets = targets;
          hintActive = true;
          const fit = getFit();
          renderHintOverlay(targets, origin, fit, geometry.width, geometry.height);
          statusBar.showToast(
            `hint: ${String(targets.length)} targets — type a label, Esc cancels`,
            15000,
          );
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          statusBar.showToast(`hint mode failed: ${message}`, 3000);
          finishHint();
        });
    },
    onHintChar: (char) => {
      if (!hintActive) {
        return; // dump still in flight — ignore keys typed too early
      }
      hintBuffer += char.toLowerCase();
      const matches = hintTargets.filter((target) => target.label.startsWith(hintBuffer));
      if (matches.length === 0) {
        statusBar.showToast('no match', 1200);
        finishHint();
        return;
      }
      const exact = matches.find((target) => target.label === hintBuffer);
      if (exact && matches.length === 1) {
        const cx = (exact.bounds.x1 + exact.bounds.x2) / 2;
        const cy = (exact.bounds.y1 + exact.bounds.y2) / 2;
        input.tap(cx, cy);
        finishHint();
      }
      // Otherwise the buffer is still a valid prefix of more than one label — wait for more.
    },
    onHintCancel: () => {
      finishHint();
    },
    onZoomToggle: () => {
      onZoomRequested(crosshair.x, crosshair.y);
    },
  });

  return {
    keyboard,
    getFpsCap: () => fpsCap,
    isHelpVisible: () => helpVisible,
    isHintActive: () => hintActive,
  };
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
  const statusBar = new StatusBar(gridOrigin.row + fit.rows, fit.cols);

  // Frame-rate cap and the help/hint overlays all gate frames before they ever reach dropFrame:
  // capturing/transcoding keep running regardless (there's no cheap way to pause screenrecord),
  // this just decides whether a given decoded frame is worth spending a render on.
  let lastRenderedAt = 0;
  const onCaptureFrame = (png: Buffer): void => {
    if (isHelpVisible() || isHintActive()) {
      return;
    }
    const now = Date.now();
    if (now - lastRenderedAt < 1000 / getFpsCap()) {
      return;
    }
    lastRenderedAt = now;
    dropFrame(png);
  };

  // Zoom restarts the whole pipeline at full native capture resolution with a crop, rather than
  // cropping the already-downscaled normal capture — see PipelineOptions' doc comment for why.
  let zoomRegion: ZoomRegion | null = null;
  const buildPipelineOptions = (): PipelineOptions =>
    zoomRegion
      ? {
          capturePx: { width: geometry.width, height: geometry.height },
          outputPx: fit.capturePx,
          crop: zoomRegion,
        }
      : { capturePx: fit.capturePx, outputPx: fit.capturePx };

  let pipeline = new Pipeline(
    serial,
    buildPipelineOptions(),
    options.bitrate,
    onCaptureFrame,
    (message) => {
      console.error(message);
    },
  );

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
      statusBar.resize(gridOrigin.row + fit.rows, fit.cols);
      pipeline.stop();
      pipeline = new Pipeline(
        serial,
        buildPipelineOptions(),
        options.bitrate,
        onCaptureFrame,
        (message) => {
          console.error(message);
        },
      );
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
    statusBar.dispose();
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

  const onZoomRequested = (centerX: number, centerY: number): void => {
    zoomRegion = zoomRegion
      ? null
      : computeZoomRegion(centerX, centerY, geometry.width, geometry.height, ZOOM_FACTOR);
    statusBar.showToast(zoomRegion ? `zoomed ${String(ZOOM_FACTOR)}x` : 'zoom off', 1500);
    pipeline.stop();
    pipeline = new Pipeline(
      serial,
      buildPipelineOptions(),
      options.bitrate,
      onCaptureFrame,
      (message) => {
        console.error(message);
      },
    );
  };

  const mouseTracker = setUpMouse(input, gridOrigin, () => fit, geometry);
  const { keyboard, getFpsCap, isHelpVisible, isHintActive } = setUpKeyboard(
    input,
    serial,
    geometry,
    () => fit,
    gridOrigin,
    renderer,
    statusBar,
    quit,
    onZoomRequested,
  );
  const onStdinData = (chunk: Buffer): void => {
    const leftover = mouseTracker.feed(chunk);
    if (leftover.length > 0) {
      keyboard.feed(leftover);
    }
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
