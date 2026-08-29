// `temu` / `temu --device <id>`: the live streaming render loop. Attaches to an Android device
// or a booted iOS Simulator (src/device/target.js's `resolveTarget` decides which), works out
// how big a grid fits the current pane, and pumps frames from the platform's capture source
// (adb screenrecord, or sim-use's bgra framebuffer stream) through ffmpeg into the
// Kitty-graphics renderer until the user quits. Also wires up mouse-driven tap/drag/scroll/back
// (input/mouse.ts + a per-platform InputBackend) and the modal keyboard (crosshair nudge,
// hardware buttons, text entry, hint mode, zoom) — none of which know or care which platform is
// actually on the other end.

import { writeFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import {
  resolveTarget,
  type CaptureHandle,
  type DeviceTarget,
  type InputFeature,
  type Platform,
  type PixelSize,
} from './device/target.js';
import { PngFrameSplitter, scalePng } from './device/transcode.js';
import type { InputBackend } from './input/backend.js';
import { renderHintOverlay, type HintTarget } from './input/hints.js';
import { KeyboardHandler, type KeyboardMode } from './input/keymap.js';
import { DISABLE_MOUSE_TRACKING, MouseTracker } from './input/mouse.js';
import { BlocksRenderer } from './render/blocks.js';
import { detectCaps, queryCursorPosition, type CellPixelSize } from './render/caps.js';
import { enterAltScreen, leaveAltScreen, renderHelpOverlay, StatusBar } from './render/chrome.js';
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
  platform?: Platform | undefined;
  bitrate: string;
}

export function parseStreamArgs(argv: string[]): StreamOptions {
  let device: string | undefined;
  let platform: Platform | undefined;
  let bitrate = '8M';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--device') {
      device = argv[++i];
    } else if (arg === '--platform') {
      const value = argv[++i];
      if (value === 'ios' || value === 'android') {
        platform = value;
      }
    } else if (arg === '--bitrate') {
      bitrate = argv[++i] ?? bitrate;
    }
  }
  return { device, platform, bitrate };
}

const STATUS_BAR_ROWS = 1;
const RESIZE_DEBOUNCE_MS = 150;

export interface PipelineOptions {
  /** What the platform's capture source is asked to encode at — a request Android's screenrecord
   * honors via `--size`; iOS's bgra framebuffer stream ignores it entirely (always native — see
   * src/device/ios/target.ts) since ffmpeg's own scale filter (`outputPx` below) already has to
   * do the size adaptation on that platform regardless. */
  capturePx: PixelSize;
  /** What ffmpeg scales (post-crop, if any) down to — always the on-screen target size. */
  outputPx: PixelSize;
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
 * capture/ffmpeg are working at, since none of Android's screenrecord, iOS's framebuffer stream,
 * or ffmpeg itself can be resized in place. Resize *and* zoom both work by tearing down and
 * rebuilding one of these with different options. Platform-agnostic: `target.createCapture`
 * hides whether it's spawning `adb screenrecord` or `sim-use stream-video --format bgra`.
 */
class Pipeline {
  private readonly capture: CaptureHandle;
  private splitter: PngFrameSplitter;
  private stopped = false;

  constructor(
    private readonly target: DeviceTarget,
    private readonly options: PipelineOptions,
    private readonly bitrate: string,
    private readonly onFrame: (png: Buffer) => void,
    private readonly onLog: (message: string) => void,
  ) {
    this.capture = target.createCapture({ requestedPx: options.capturePx, bitrate });
    this.capture.onRestart((event) => {
      this.onLog(
        `capture restarted (attempt ${String(event.count)}, exit code ${String(event.code)})`,
      );
    });
    this.splitter = this.attachSplitter();
  }

  private attachSplitter(): PngFrameSplitter {
    const splitter = new PngFrameSplitter(this.capture.readable, {
      source: this.capture.format,
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

/** Whichever renderer is active — KittyRenderer or the block-character fallback — implements this. */
export interface FrameRenderer {
  resize(cols: number, rows: number): void;
  renderFramePng(png: Buffer): Promise<void>;
  dispose(): void;
}

function frameDropper(renderer: FrameRenderer, onError: (error: unknown) => void) {
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

/**
 * `originRow` (1-based) is however many rows are already consumed above the grid — the startup
 * banner, typically — which must be subtracted here too, not just STATUS_BAR_ROWS below it.
 * Getting this wrong means the grid plus status bar overflow the pane's actual height, which
 * forces a scroll the moment they're printed — silently invalidating gridOrigin (captured right
 * before that print, under the assumption that nothing would move the viewport afterward) and
 * breaking every mouse coordinate computed from it. Found via exactly that symptom: real clicks
 * at every row consistently mapped to the same near-zero device Y.
 *
 * `process.stdout.columns`/`.rows` can be `0` rather than `undefined` — confirmed on a bare pty
 * with no winsize ever set (e.g. under `script`, or a raw `spawn` with no `stdio: 'inherit'`):
 * Node reports `{columns: 0, rows: 0}` there, and `?? 80` doesn't catch a `0`. Every tmux pane
 * always has a real winsize, which is why this only ever showed up outside tmux — left
 * unguarded it collapses `fitDeviceToCells` to a 1x1 grid.
 */
function currentAvailableCells(originRow: number): { cols: number; rows: number } {
  const rawCols = process.stdout.columns;
  const rawRows = process.stdout.rows;
  const cols = rawCols && rawCols > 0 ? rawCols : 80;
  const totalRows = rawRows && rawRows > 0 ? rawRows : 24;
  const rows = Math.max(1, totalRows - (originRow - 1) - STATUS_BAR_ROWS);
  return { cols, rows };
}

/**
 * Wheel-to-swipe geometry: a short vertical drag centered on the pointer. Expressed as a
 * fraction of the input space's height rather than a fixed pixel count — `inputSize` is device
 * pixels on Android but UIKit points on iOS (roughly a third the magnitude for the same physical
 * screen, see src/device/ios/target.ts), so an absolute constant tuned for one would be wildly
 * wrong for the other.
 */
const WHEEL_SWIPE_HALF_HEIGHT_FRACTION = 0.1;
const WHEEL_SWIPE_DURATION_MS = 120;

function setUpMouse(
  input: InputBackend,
  origin: GridOrigin,
  getFit: () => FitResult,
  inputSize: PixelSize,
): MouseTracker {
  const toDevicePx = (col: number, row: number): { x: number; y: number } =>
    cellToDevicePixel(col, row, origin, getFit(), inputSize.width, inputSize.height);
  const wheelHalfHeight = inputSize.height * WHEEL_SWIPE_HALF_HEIGHT_FRACTION;

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
          ? [y + wheelHalfHeight, y - wheelHalfHeight]
          : [y - wheelHalfHeight, y + wheelHalfHeight];
      input.swipe(x, y1, x, y2, WHEEL_SWIPE_DURATION_MS);
    },
    onRightClick: () => {
      input.back();
    },
  });
}

const CROSSHAIR_BIG_STEP_MULTIPLIER = 5;
// These used to be tuned lower (8/15) partly to fit under ffmpeg's own `fps=N` output filter,
// which capped the live pipeline's encode rate below MAX_FPS_CAP (see transcode.ts). That filter
// is gone now — ffmpeg decodes/encodes at screenrecord's own content-driven rate (up to its
// native ~25fps) regardless of the display cap — so this is purely about how often stream.ts
// spends effort rendering an already-decoded frame (a disk write plus a terminal-side PNG
// decode). PNG encode itself measures ~5.5ms CPU/frame at this pane size on typical hardware, so
// these are headroom ceilings, not tuned-for-smoothness targets; +/- still adjust the display
// rate live without needing either value to be exactly right.
const DEFAULT_FPS_CAP = 20;
const MIN_FPS_CAP = 1;
const MAX_FPS_CAP = 30;
/** Zoom shows 1/ZOOM_FACTOR of the device's input space, magnified to fill the same grid. */
const ZOOM_FACTOR = 3;
/**
 * How long the live capture pipeline can go without producing a new frame before it's treated as
 * stuck and a corrective snapshot is taken instead. This is still the *primary* mechanism for
 * "the screen changed once and then held still" (e.g. a popup) — not a rare backstop. Raw H.264
 * Annex-B has no end-of-access-unit marker, so ffmpeg's parser only knows a frame is complete
 * once it sees the start of the *next* one (or EOF); a genuinely final frame on a live, open
 * pipe has neither, and stays parsed-but-unemitted forever no matter how the demuxer/filters are
 * tuned (verified: even with transcode.ts's fps-filter removal and `-fpsprobesize 0`, the true
 * final frame of a feed-then-go-silent sequence was never emitted). This watchdog is the only
 * thing that can surface that frame at all. iOS's bgra framebuffer stream is content-driven the
 * same way (see src/device/ios/capture.ts) and benefits from the exact same watchdog.
 */
const STALE_FRAME_THRESHOLD_MS = 1500;

/**
 * Zoom's crosshair math (crosshair position, `computeZoomRegion`) all runs in the target's input
 * space — device pixels on Android, UIKit points on iOS — since that's what the crosshair and
 * hint-mode coordinates are already in. ffmpeg's crop filter, however, always operates on the
 * actual captured frame, which is native device pixels on both platforms. On Android those two
 * spaces are identical (this is a no-op); on iOS they differ by the screen's point-to-pixel
 * scale (3x on this project's test simulator), so the region has to be scaled up before it can
 * be used as a crop rectangle.
 */
function zoomRegionToCapturePx(
  region: ZoomRegion,
  target: DeviceTarget,
): { x: number; y: number; width: number; height: number } {
  const scaleX = target.capturePx.width / target.inputSize.width;
  const scaleY = target.capturePx.height / target.inputSize.height;
  return {
    x: Math.round(region.x * scaleX),
    y: Math.round(region.y * scaleY),
    width: Math.round(region.width * scaleX),
    height: Math.round(region.height * scaleY),
  };
}

export interface KeyboardSetup {
  keyboard: KeyboardHandler;
  getFpsCap: () => number;
  isHelpVisible: () => boolean;
  isHintActive: () => boolean;
}

/**
 * Wires the modal keyboard's commands up to the input backend, a crosshair position tracked in
 * the target's input coordinate space (device pixels on Android, points on iOS), the status
 * bar, the help overlay, and hint mode. Zoom is the one command this doesn't fully own:
 * rebuilding the capture pipeline at a different resolution is runStream's job (it owns
 * `Pipeline`), so `onZoomRequested` just reports where the crosshair was when `z` was pressed
 * and leaves the rest to the caller.
 */
function setUpKeyboard(
  input: InputBackend,
  target: DeviceTarget,
  getFit: () => FitResult,
  origin: GridOrigin,
  renderer: FrameRenderer,
  statusBar: StatusBar,
  onQuit: () => void,
  onZoomRequested: (centerX: number, centerY: number) => void,
): KeyboardSetup {
  const { inputSize } = target;
  let crosshair = { x: Math.round(inputSize.width / 2), y: Math.round(inputSize.height / 2) };
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

  // Some InputBackend methods have no primitive on every platform (no iOS equivalent of
  // Android's recents/volume keys — see src/device/ios/input.ts); this shows an honest toast
  // instead of silently sending a command that does nothing.
  const gate = (feature: InputFeature, label: string, action: () => void): void => {
    if (target.supports(feature)) {
      action();
      return;
    }
    statusBar.showToast(`${label}: not available on ${target.platform}`, 2000);
  };

  const keyboard = new KeyboardHandler({
    onQuit,
    onMoveCrosshair: (dx, dy, big) => {
      const fit = getFit();
      const multiplier = big ? CROSSHAIR_BIG_STEP_MULTIPLIER : 1;
      const stepX = Math.max(1, Math.round(inputSize.width / fit.cols)) * multiplier;
      const stepY = Math.max(1, Math.round(inputSize.height / fit.rows)) * multiplier;
      crosshair = {
        x: Math.min(inputSize.width - 1, Math.max(0, crosshair.x + dx * stepX)),
        y: Math.min(inputSize.height - 1, Math.max(0, crosshair.y + dy * stepY)),
      };
      statusBar.setCrosshair(crosshair);
    },
    onTapCrosshair: () => {
      input.tap(crosshair.x, crosshair.y);
    },
    onBack: () => gate('back', 'back', () => input.back()),
    onHome: () => gate('home', 'home', () => input.home()),
    onRecents: () => gate('recents', 'recents', () => input.recents()),
    onPower: () => gate('power', 'power', () => input.power()),
    onVolumeUp: () => gate('volume', 'volume', () => input.volumeUp()),
    onVolumeDown: () => gate('volume', 'volume', () => input.volumeDown()),
    onScreenshot: (announcePath) => {
      const filename = `temu-screenshot-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.png`;
      const fullPath = resolvePath(filename);
      target
        .snapshotPng()
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
    onTextBackspace: () => input.backspace(),
    onTextEnter: () => input.enter(),
    onEnterHintMode: () => {
      hintBuffer = '';
      hintActive = false;
      statusBar.showToast('computing hints…', 15000);
      target
        .hintTargets()
        .then((targets) => {
          if (targets.length === 0) {
            statusBar.showToast('no clickable elements found', 2000);
            finishHint();
            return;
          }
          hintTargets = targets;
          hintActive = true;
          const fit = getFit();
          renderHintOverlay(targets, origin, fit, inputSize.width, inputSize.height);
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
      // Named `candidate` rather than `target` here to avoid shadowing the outer DeviceTarget.
      const matches = hintTargets.filter((candidate) => candidate.label.startsWith(hintBuffer));
      if (matches.length === 0) {
        statusBar.showToast('no match', 1200);
        finishHint();
        return;
      }
      const exact = matches.find((candidate) => candidate.label === hintBuffer);
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

  // A write to stdout after the underlying pty is gone (e.g. `tmux kill-pane` tears it down
  // immediately on SIGHUP, before cleanup() gets a chance to run) throws EIO asynchronously as
  // an unhandled 'error' event on the stream, which crashes the process right there — reproduced
  // directly by kill-paning a live temu instance and watching cleanup() die on its very first
  // write (mouseTracker.disable()) before ever reaching renderer.dispose()'s Kitty image-delete
  // command or leaveAltScreen(). A dead pty can't be written to no matter what, so there's
  // nothing to recover; the fix is just to not let that crash skip the rest of cleanup().
  process.stdout.on('error', () => undefined);

  let target: DeviceTarget;
  try {
    target = await resolveTarget(options.device, options.platform);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  // Run alongside detectCaps rather than after it — it's a diagnostic check (see
  // DeviceTarget.isDisplayOn's implementations), so it shouldn't add its own wall-clock delay to
  // startup.
  const [caps, displayOn] = await Promise.all([detectCaps(), target.isDisplayOn()]);
  // 'unknown' (heuristic couldn't tell) is treated optimistically — try Kitty graphics anyway.
  // Only a confirmed 'false' falls back, since the fallback is a real quality trade-off.
  const useBlocks = caps.kittyGraphicsSupported === false;
  if (useBlocks) {
    console.error(
      'Kitty graphics not detected — falling back to a lower-quality block-character ' +
        'renderer. Run `temu doctor` for details.',
    );
  } else if (caps.insideTmux && caps.tmuxAllowPassthrough !== 'on') {
    // Only relevant to the Kitty path: the block renderer is plain text/SGR, which tmux
    // understands natively and needs no passthrough at all.
    console.error('tmux allow-passthrough is off. Run `temu doctor --fix` first.');
    return 1;
  }
  const cellSize: CellPixelSize = caps.cellSize;

  // Switches to the terminal's alternate screen buffer so quitting restores whatever was in the
  // pane/window before temu started, instead of leaving the (now image-less) placeholder grid
  // and status bar sitting there. Works the same inside tmux, which tracks the alternate screen
  // per pane and restores the pane's own prior content on `leaveAltScreen` below.
  enterAltScreen();

  // Clears the *screen* (not scrollback — prior output stays reachable by scrolling up) and
  // homes the cursor, so gridOrigin below always lands near row 1 regardless of how much was
  // already in the pane. Without this, a pane with a long scrollback of prior shell output
  // pushes the origin far down, which starves currentAvailableCells() of rows for no reason —
  // the grid doesn't need to coexist with old output, it just needs a predictable starting
  // point. Plain ANSI, not passthrough-wrapped: tmux understands clear-screen/cursor-home
  // natively. Also still needed on the alternate screen itself, which starts out as whatever was
  // last drawn on it (typically blank, but not guaranteed).
  process.stdout.write('\x1b[2J\x1b[H');

  // Deliberately no cell-size/grid-dimensions mention here: those depend on knowing gridOrigin
  // first (see currentAvailableCells' doc comment), and gridOrigin has to be queried as the
  // *last* thing printed before the grid itself — anything printed after the query but before
  // the grid draws would shift the viewport and invalidate it right away.
  console.log(`temu — streaming ${target.label}. Ctrl+C to quit.\n`);

  // Falls back to assuming the top-left corner of the terminal if the terminal doesn't answer
  // in time — mouse targeting would be off, but nothing crashes.
  const cursorPosition = await queryCursorPosition();
  const gridOrigin: GridOrigin = cursorPosition ?? { row: 1, col: 1 };

  const { cols: startCols, rows: startRows } = currentAvailableCells(gridOrigin.row);
  let fit = fitDeviceToCells(
    startCols,
    startRows,
    target.capturePx.width,
    target.capturePx.height,
    cellSize,
  );

  const renderer: FrameRenderer = useBlocks
    ? new BlocksRenderer({ cols: fit.cols, rows: fit.rows })
    : new KittyRenderer({ cols: fit.cols, rows: fit.rows });
  const dropFrame = frameDropper(renderer, (error: unknown) => {
    console.error('render error:', error);
  });
  const statusBar = new StatusBar(gridOrigin.row + fit.rows, fit.cols);

  // Android's screenrecord emits essentially nothing while the display is asleep (see
  // src/device/discover.ts's isDisplayOn) — from here that's indistinguishable from a broken
  // pipeline, so say so explicitly rather than leaving the pane looking stuck. Deliberately
  // doesn't send a wake keyevent itself: temu shouldn't change device state on the user's behalf
  // just for starting up. (Always true on iOS — see src/device/ios/target.ts's isDisplayOn.)
  if (!displayOn) {
    statusBar.showToast('device display is asleep — press p to wake', 8000);
  }

  // Seed the pane with a real snapshot immediately. On Android this is the same root cause as
  // the staleness watchdog below: the first frame screenrecord captures on launch has nothing
  // after it yet, so ffmpeg's Annex-B parser can't tell it's complete and won't emit it until a
  // *second* frame's data starts arriving — which, if the screen is genuinely static from the
  // moment temu starts, might not happen for an unbounded time. On iOS the bgra framebuffer
  // stream is content-driven the same way (see BgraFramebufferSource) and can go just as long
  // without a first frame on a static screen. A one-shot snapshot bypasses the live pipeline
  // entirely and shows the actual current screen right away; the live stream overwrites it as
  // soon as it manages to produce its own first frame. Scaled to the exact size the live
  // pipeline renders at — a snapshot's native resolution has a different aspect-ratio rounding
  // than fitDeviceToCells' pane-pixel-perfect fit, and displaying it as-is showed up as a
  // visible squish/resize the moment the live stream's first (correctly-sized) frame replaced
  // it.
  target
    .snapshotPng()
    .then((png) => scalePng(png, fit.capturePx.width, fit.capturePx.height))
    .then((png) => dropFrame(png))
    .catch(() => undefined);

  // Frame-rate cap and the help/hint overlays gate frames before they ever reach dropFrame:
  // capturing/transcoding keep running regardless (there's no cheap way to pause screenrecord),
  // this just decides whether a given decoded frame is worth spending a render on.
  //
  // Deliberately renders whichever frame is newest *at tick time*, not whichever happens to
  // arrive right as the previous throttle window ends. That distinction matters after an idle
  // period: ffmpeg's decoder can stall for seconds on a static screen (see the screencap-seeding
  // note above) and then release its entire backlog in one burst once motion resumes. A gate
  // that just checks "has enough time passed since the last render" accepts the first backlog
  // frame it sees and then works through the rest of the backlog one throttle-interval at a
  // time — which looks like several seconds of stale, already-outdated frames before the view
  // catches up to the present. Keeping only the latest received frame and discarding the rest
  // jumps straight to "now" the moment the backlog arrives, instead of replaying through it.
  let latestFrame: Buffer | null = null;
  let lastLiveFrameAt = Date.now();
  // Cleared whenever a genuine live frame arrives; set once a stillness period has already been
  // corrected. Without this, a screen that stays static forever would get re-"corrected" every
  // STALE_FRAME_THRESHOLD_MS indefinitely — each one a full-resolution decode, visible as a
  // repeating flash/rescale — instead of exactly once per stillness period.
  let correctedThisStillPeriod = false;
  const onCaptureFrame = (png: Buffer): void => {
    latestFrame = png;
    lastLiveFrameAt = Date.now();
    correctedThisStillPeriod = false;
  };

  // Staleness watchdog: the live pipeline can go quiet indefinitely on a screen that changes
  // once and then holds still — e.g. a popup that appears and then just sits there. That last
  // "settled" frame is exactly the kind the decoder tends to hold back (see the snapshot-seeding
  // note above for why, on both platforms): motion is what pushes buffered frames out, and a
  // popup produces one change followed by no motion at all, so the pre-popup frame can simply
  // stay on screen forever with nothing to dislodge it. If no new live frame has arrived in
  // STALE_FRAME_THRESHOLD_MS, take one corrective snapshot — cheap, always accurate, and
  // bypasses the live pipeline entirely — so the view can't drift for longer than that. Only
  // one correction per stillness period: onCaptureFrame clears the flag again as soon as the
  // live pipeline produces a genuinely new frame.
  let screencapInFlight = false;
  const refreshFromScreencapIfStale = (): void => {
    if (screencapInFlight || correctedThisStillPeriod || zoomRegion) {
      // A snapshot is a full, unzoomed frame — showing one while zoomed in would flash the
      // view back out to full-screen, which is worse than a brief stale frame.
      return;
    }
    if (Date.now() - lastLiveFrameAt < STALE_FRAME_THRESHOLD_MS) {
      return;
    }
    screencapInFlight = true;
    target
      .snapshotPng()
      .then((png) => scalePng(png, fit.capturePx.width, fit.capturePx.height))
      .then((png) => {
        latestFrame = png;
        correctedThisStillPeriod = true;
      })
      .catch(() => undefined)
      .finally(() => {
        screencapInFlight = false;
      });
  };

  let renderTickTimer: NodeJS.Timeout | null = null;
  // Not started here: it closes over getFpsCap/isHelpVisible/isHintActive, which don't exist
  // until setUpKeyboard runs further down — started there instead.
  const scheduleRenderTick = (): void => {
    renderTickTimer = setTimeout(() => {
      if (!isHelpVisible() && !isHintActive()) {
        refreshFromScreencapIfStale();
        if (latestFrame) {
          const frame = latestFrame;
          latestFrame = null;
          dropFrame(frame);
        }
      }
      scheduleRenderTick();
    }, 1000 / getFpsCap());
  };

  // Zoom restarts the whole pipeline at full native capture resolution with a crop, rather than
  // cropping the already-downscaled normal capture — see PipelineOptions' doc comment for why.
  let zoomRegion: ZoomRegion | null = null;
  // ffmpeg decodes and PNG-encodes every frame the capture source delivers regardless of the
  // current display fps (adjustable live via +/- without a restart); the render tick (below) is
  // what throttles what's actually rendered down to the newest frame per tick.
  const buildPipelineOptions = (): PipelineOptions =>
    zoomRegion
      ? {
          capturePx: target.capturePx,
          outputPx: fit.capturePx,
          crop: zoomRegionToCapturePx(zoomRegion, target),
        }
      : { capturePx: fit.capturePx, outputPx: fit.capturePx };

  let pipeline = new Pipeline(
    target,
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
      const { cols, rows } = currentAvailableCells(gridOrigin.row);
      const nextFit = fitDeviceToCells(
        cols,
        rows,
        target.capturePx.width,
        target.capturePx.height,
        cellSize,
      );
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
        target,
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

  const input: InputBackend = target.createInput((message) => console.error(message));

  let exiting = false;
  const cleanup = (): void => {
    if (exiting) {
      return;
    }
    exiting = true;
    if (resizeTimer) {
      clearTimeout(resizeTimer);
    }
    if (renderTickTimer) {
      clearTimeout(renderTickTimer);
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
    // Last: the Kitty image-delete APC above still needs the placements to exist when it's sent,
    // which requires still being on the same screen buffer they were drawn on.
    leaveAltScreen();
  };

  // Safety net for a crash or an unexpected process.exit that skips cleanup() entirely: leaving
  // the terminal on the alternate screen with SGR mouse tracking still enabled would strand
  // whatever shell/terminal the user returns to. process.stdout.write to a TTY is synchronous on
  // POSIX, so this reliably lands even during an 'exit' handler, which cannot run async work.
  process.once('exit', () => {
    if (exiting) {
      return;
    }
    process.stdout.write(DISABLE_MOUSE_TRACKING);
    leaveAltScreen();
  });

  let resolveRun: ((code: number) => void) | null = null;
  const quit = (): void => {
    cleanup();
    resolveRun?.(0);
  };
  process.once('SIGINT', quit);
  process.once('SIGTERM', quit);
  // tmux sends SIGHUP (not SIGINT/SIGTERM) to a pane's process when the pane closes out from
  // under it — `tmux kill-pane`, closing the pane via its own window-manager-style controls, or
  // the pane's window disappearing. Without a handler, that skips cleanup() entirely: the Kitty
  // image is never deleted (`a=d`) and the pane may never leave the alternate screen. Since the
  // Kitty graphics protocol's image store lives on the real terminal somewhat independently of
  // tmux's own per-pane text model (see src/render/kitty.ts's DEFAULT_IMAGE_ID comment), an
  // image that's never explicitly deleted can resurface later wherever the terminal happens to
  // redraw the same placeholder text again (e.g. after further pane churn reshuffles the
  // layout) — reproduced by repeatedly `tmux kill-pane`-ing temu instances while diagnosing a
  // report of video appearing in the wrong pane after `temu split`.
  process.once('SIGHUP', quit);

  const onZoomRequested = (centerX: number, centerY: number): void => {
    zoomRegion = zoomRegion
      ? null
      : computeZoomRegion(
          centerX,
          centerY,
          target.inputSize.width,
          target.inputSize.height,
          ZOOM_FACTOR,
        );
    statusBar.showToast(zoomRegion ? `zoomed ${String(ZOOM_FACTOR)}x` : 'zoom off', 1500);
    pipeline.stop();
    pipeline = new Pipeline(
      target,
      buildPipelineOptions(),
      options.bitrate,
      onCaptureFrame,
      (message) => {
        console.error(message);
      },
    );
  };

  const mouseTracker = setUpMouse(input, gridOrigin, () => fit, target.inputSize);
  const { keyboard, getFpsCap, isHelpVisible, isHintActive } = setUpKeyboard(
    input,
    target,
    () => fit,
    gridOrigin,
    renderer,
    statusBar,
    quit,
    onZoomRequested,
  );
  scheduleRenderTick();
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
