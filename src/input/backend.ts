// The interface every input backend implements, so the mouse/keyboard layers (mouse.ts, and the
// modal keyboard) don't need to know how a tap actually reaches the device.
//
// See adbshell.ts for why the Android backend isn't built on raw evdev injection as originally
// planned: it's blocked by SELinux on stock Android policy, not merely slow.
//
// Hardware/software buttons are named semantically (`back`, `home`, ...) rather than exposed as
// a single `keyevent(code)` escape hatch: that shape leaked Android's `KEYCODE_*` vocabulary
// into the interface, which the iOS Simulator backend (sim-use) has no use for — it maps what it
// can to its own primitives (`button home`, `button lock`, an edge swipe for back, HID keycodes
// for enter/backspace) and reports the rest as unsupported via `DeviceTarget.supports()`
// (src/device/target.ts) rather than silently swallowing an Android-shaped code.
export interface InputBackend {
  tap(x: number, y: number): void;
  touchDown(x: number, y: number): void;
  touchMove(x: number, y: number): void;
  touchUp(x: number, y: number): void;
  /** A single canned swipe over `durationMs` — good enough for a discrete scroll-wheel tick. */
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): void;
  back(): void;
  home(): void;
  recents(): void;
  power(): void;
  volumeUp(): void;
  volumeDown(): void;
  enter(): void;
  backspace(): void;
  text(value: string): void;
  dispose(): void;
}
