// Drives an iOS Simulator through one `sim-use` child process per input event, queued and run
// strictly one at a time.
//
// This is not the same shape as AdbShellInputBackend (src/input/adbshell.ts), which holds one
// persistent `adb shell` open and amortises transport cost across calls. sim-use has no
// equivalent persistent-session mode for input — `sim-use ios batch --stdin` looked like a
// candidate but was verified to slurp its stdin to EOF before executing a single step, so it
// can't serve as a long-lived command channel the way `adb shell` does. Each call here pays
// sim-use's own per-call cost instead: measured at ~0.15-0.25s with `SIM_USE_NO_DAEMON=1` (see
// simuse.ts) — an order of magnitude slower than adb's ~21ms, but the best available without
// building a second daemon protocol on top of a private API. The serial queue below exists so
// that cost is additive rather than a source of races: overlapping HID sessions against the same
// simulator have not been tested and are not worth risking.
//
// Live per-pixel dragging (Android's DOWN/MOVE.../UP) isn't reproducible at this latency: a real
// drag can easily generate motion reports faster than one call every ~200ms can drain. Instead,
// `touchDown` only records where and when the drag started; `touchMove` is a no-op; `touchUp`
// issues one `swipe` from the recorded start to the release point over the elapsed real time —
// giving flick-scrolling plausible velocity without pretending to track intermediate positions
// that were never actually sent.

import type { InputBackend } from '../../input/backend.js';
import { runSimUse } from './simuse.js';

const MAX_QUEUE_DEPTH = 8;
const MIN_SWIPE_DURATION_MS = 60;
const MAX_SWIPE_DURATION_MS = 2000;
/** How far in from the left edge to start a back-gesture swipe, in points. */
const BACK_SWIPE_START_X = 6;
const BACK_SWIPE_END_X_FRACTION = 0.45;
const BACK_SWIPE_DURATION_MS = 180;

interface QueuedOp {
  kind: string;
  run: () => Promise<unknown>;
}

export class SimUseInputBackend implements InputBackend {
  private readonly queue: QueuedOp[] = [];
  private draining = false;
  private disposed = false;
  private readonly onLog: (message: string) => void;
  private dragStart: { x: number; y: number; at: number } | null = null;

  constructor(
    private readonly udid: string,
    private readonly pointSize: { width: number; height: number },
    onLog?: (message: string) => void,
  ) {
    this.onLog = onLog ?? ((): void => undefined);
  }

  private enqueue(kind: string, run: () => Promise<unknown>): void {
    if (this.disposed) {
      return;
    }
    // A burst of events faster than sim-use can drain them (~0.15-0.25s/call) means the user has
    // already moved on — drop the oldest queued op rather than let a backlog of stale taps play
    // out late. Never drops the op currently being awaited in drain(), only ones still queued.
    if (this.queue.length >= MAX_QUEUE_DEPTH) {
      this.queue.shift();
    }
    this.queue.push({ kind, run });
    this.drain();
  }

  private drain(): void {
    if (this.draining) {
      return;
    }
    this.draining = true;
    void (async (): Promise<void> => {
      for (let op = this.queue.shift(); op; op = this.queue.shift()) {
        try {
          await op.run();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.onLog(`sim-use ${op.kind} failed: ${message}`);
        }
      }
      this.draining = false;
    })();
  }

  private point(x: number, y: number): [string, string] {
    return [String(Math.round(x)), String(Math.round(y))];
  }

  private runSwipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs: number,
  ): Promise<unknown> {
    const clampedMs = Math.min(MAX_SWIPE_DURATION_MS, Math.max(MIN_SWIPE_DURATION_MS, durationMs));
    return runSimUse([
      'swipe',
      '--device',
      this.udid,
      '--from',
      `${String(Math.round(x1))},${String(Math.round(y1))}`,
      '--to',
      `${String(Math.round(x2))},${String(Math.round(y2))}`,
      '--duration',
      (clampedMs / 1000).toFixed(3),
    ]);
  }

  tap(x: number, y: number): void {
    const [px, py] = this.point(x, y);
    this.enqueue('tap', () => runSimUse(['tap', '--device', this.udid, '-x', px, '-y', py]));
  }

  touchDown(x: number, y: number): void {
    // No sim-use call here — see the file-level comment. A plain tap (no motion) never reaches
    // touchDown/touchMove/touchUp at all; MouseTracker (src/input/mouse.ts) only calls these once
    // a motion report has actually arrived, so this is exclusively the drag-start case.
    this.dragStart = { x, y, at: Date.now() };
  }

  touchMove(_x: number, _y: number): void {
    // Intentionally a no-op — see the file-level comment on why intermediate positions aren't
    // sent to sim-use.
  }

  touchUp(x: number, y: number): void {
    const start = this.dragStart;
    this.dragStart = null;
    if (!start) {
      // touchUp without a matching touchDown shouldn't happen given MouseTracker's state machine,
      // but fall back to a same-point swipe (a harmless no-op-ish flick) rather than dropping the
      // release silently.
      this.enqueue('swipe', () => this.runSwipe(x, y, x, y, MIN_SWIPE_DURATION_MS));
      return;
    }
    const elapsedMs = Date.now() - start.at;
    this.enqueue('swipe', () => this.runSwipe(start.x, start.y, x, y, elapsedMs));
  }

  swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): void {
    this.enqueue('swipe', () => this.runSwipe(x1, y1, x2, y2, durationMs));
  }

  back(): void {
    // No hardware/software "back" primitive exists for iOS in sim-use's `button` command (that
    // button-type is Android-only) — approximate it with the same left-edge swipe gesture a real
    // finger would use to pop a UINavigationController screen. Works only in apps that support
    // the system edge-swipe-back gesture, which is the closest iOS equivalent of Android's
    // always-available system Back button; DeviceTarget.supports('back') on iOS still reports
    // true because *some* screens do respond to this, unlike volume/recents which have no
    // primitive whatsoever.
    const midY = this.pointSize.height / 2;
    const endX = this.pointSize.width * BACK_SWIPE_END_X_FRACTION;
    this.enqueue('swipe', () =>
      this.runSwipe(BACK_SWIPE_START_X, midY, endX, midY, BACK_SWIPE_DURATION_MS),
    );
  }

  home(): void {
    this.enqueue('button', () => runSimUse(['button', 'home', '--device', this.udid]));
  }

  recents(): void {
    // No primitive on iOS — gated by DeviceTarget.supports('recents') before stream.ts ever calls
    // this; kept as a no-op rather than throwing so the interface stays uniform across backends.
  }

  power(): void {
    // "lock" is the closest iOS Simulator analog to Android's power button (both put the display
    // to sleep from the user's perspective).
    this.enqueue('button', () => runSimUse(['button', 'lock', '--device', this.udid]));
  }

  volumeUp(): void {
    // No primitive on iOS — see recents().
  }

  volumeDown(): void {
    // No primitive on iOS — see recents().
  }

  enter(): void {
    // HID keycode 40 = Enter (sim-use's own cheatsheet).
    this.enqueue('key', () => runSimUse(['ios', 'key', '40', '--device', this.udid]));
  }

  backspace(): void {
    // HID keycode 42 = Backspace.
    this.enqueue('key', () => runSimUse(['ios', 'key', '42', '--device', this.udid]));
  }

  text(value: string): void {
    // sim-use `type` only supports US keyboard/ASCII characters (its own --help is explicit
    // about this); route anything outside that range through `paste`, which goes via the
    // simulator pasteboard instead of HID keycodes and isn't limited to ASCII.
    // eslint-disable-next-line no-control-regex -- deliberately checking for pure ASCII text
    const isAscii = /^[\x00-\x7f]*$/.test(value);
    this.enqueue('type', () =>
      isAscii
        ? runSimUse(['type', value, '--device', this.udid])
        : runSimUse(['paste', value, '--device', this.udid]),
    );
  }

  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
  }
}
