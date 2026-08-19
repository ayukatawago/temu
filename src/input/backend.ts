// The interface every input backend implements, so the mouse/keyboard layers (mouse.ts, and the
// modal keyboard in a later milestone) don't need to know how a tap actually reaches the device.
//
// See adbshell.ts for why this isn't built on raw evdev injection as originally planned: it's
// blocked by SELinux on stock Android policy, not merely slow.

export interface InputBackend {
  tap(x: number, y: number): void;
  touchDown(x: number, y: number): void;
  touchMove(x: number, y: number): void;
  touchUp(x: number, y: number): void;
  /** A single canned swipe over `durationMs` — good enough for a discrete scroll-wheel tick. */
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): void;
  keyevent(code: string): void;
  text(value: string): void;
  dispose(): void;
}
