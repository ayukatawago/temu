# temu

Display and drive an Android emulator or a booted iOS Simulator as live pixels inside your
terminal — so the device sits side by side with a CLI AI agent instead of in a separate GUI
window. Works in any terminal; tmux is entirely optional (see below).

## Requirements

- `adb` on `PATH`, with a running Android emulator or connected device — for Android targets
- macOS with Xcode's Simulator, plus `sim-use` on `PATH` — for iOS Simulator targets. `sim-use`
  is the only way to reach a simulator's private framebuffer/HID APIs; there's no
  zero-dependency path (`xcrun simctl` alone can capture a screenshot but has no input verb of
  any kind). Not needed at all if you only ever attach to Android devices.
- `ffmpeg` on `PATH`
- tmux is optional — temu renders and takes input the same way in a plain terminal window. It's
  only needed for `temu split` (splitting your current pane), and, if you do run temu inside
  tmux, for its `allow-passthrough` setting (see `temu doctor --fix`).
- Ideally a terminal with Kitty graphics protocol support (virtual placements), for real pixels.
  Terminals without it get an automatic fallback to a lower-quality block-character renderer, so
  temu always displays something — run `temu doctor` to see which path you're on.

## Usage

```sh
temu                            # attach to the only connected device/simulator and stream it
temu --device <serial>          # attach to a specific Android device (adb serial)
temu --device <udid>            # attach to a specific iOS Simulator (auto-detected by UUID shape)
temu --platform ios             # disambiguate platform without naming a specific device/udid
temu --bitrate <rate>           # screenrecord encode bitrate, e.g. 4M (default 8M; Android only)
temu --renderer kitty|blocks    # manually override which renderer to use, instead of the
                                 # automatic choice: `kitty` shows real pixels via the Kitty
                                 # graphics protocol (the default when supported); `blocks` is
                                 # the lower-quality plain-text fallback. Only useful for
                                 # troubleshooting — e.g. `blocks` if video ever looks wrong and
                                 # you want a reliable fallback, or `kitty` to force it despite
                                 # a negative autodetection result
temu split [--percent <n>] [any other temu flag, e.g. --device/--renderer/--bitrate]
                                 # tmux only: split the current tmux window (new pane gets <n>%
                                 # of its width, default 40) and run temu in the new pane, with
                                 # every flag other than --percent forwarded through unchanged —
                                 # e.g. `temu split --renderer blocks` (alias: temu tmux).
                                 # Outside tmux, just open a second window or pane yourself and
                                 # run temu there.
temu doctor [--fix] [--no-render-test]
                                 # check adb/ffmpeg/terminal-graphics, plus tmux/sim-use if
                                 # present; --fix offers to turn on tmux's allow-passthrough if
                                 # it's off
```

`q` / `Ctrl+C` restores whatever was on screen before temu started — it runs on the terminal's
alternate screen buffer, both inside and outside tmux.

With no `--device`, temu attaches to the sole device/simulator visible across both platforms —
an ambiguous or empty result errors out listing what it found (or didn't).

While streaming:

| Input                                        | Action                                                                        |
| -------------------------------------------- | ----------------------------------------------------------------------------- |
| Click / drag / scroll wheel                  | Tap / swipe / scroll                                                          |
| Right-click                                  | Back                                                                          |
| `h j k l` / arrow keys (Shift = bigger step) | Move the crosshair                                                            |
| `Enter` / `Space`                            | Tap at the crosshair                                                          |
| `f`                                          | Hint mode — labels every tappable element; type its label to tap it precisely |
| `z`                                          | Zoom into a region around the crosshair, for fine targeting                   |
| `i`                                          | Text-input mode (`Esc` to exit)                                               |
| `b` / `H` / `r` / `p`                        | Back / Home / Recents / Power                                                 |
| `[` / `]`                                    | Volume down / up                                                              |
| `s` / `S`                                    | Screenshot to file / screenshot and show the full path                        |
| `+` / `-`                                    | Raise / lower the render frame-rate cap                                       |
| `?`                                          | Toggle the key-binding help overlay                                           |
| `q` / `Ctrl+C`                               | Quit                                                                          |

### iOS Simulator differences

- **Drag** is one coalesced swipe on release, not a live-tracked motion path: sim-use's per-call
  latency (~0.15-0.25s, even bypassing its own daemon) is too slow to send intermediate touch
  positions the way Android's persistent `adb shell` session can (~21ms/call). Flick-scrolling
  still gets plausible velocity from the elapsed time between press and release.
- **Recents and volume have no primitive at all** in sim-use's API — pressing `r`/`[`/`]` shows a
  toast instead of doing nothing silently.
- **Back** is a best-effort left-edge swipe (the same gesture a finger would use to pop a
  `UINavigationController` screen), since iOS has no system-wide Back button/gesture API the way
  Android's `KEYCODE_BACK` is — it works on screens that support edge-swipe-back and does nothing
  on ones that don't.
- **Hint mode (`f`) takes noticeably longer** (~5s vs ~2s on Android): it walks sim-use's
  accessibility quadtree rather than dumping Android's uiautomator tree.
- **Crosshair/zoom/hint coordinates are UIKit points, not pixels** — about a third the magnitude
  of the device's real framebuffer resolution on Retina simulators; this is handled internally,
  not something you need to account for.

## Development

```sh
npm install
npm run dev       # run the CLI from source via tsx
npm run build     # compile to dist/
npm run lint
npm run format:check
```

Commits in this repo follow Conventional Commits — see `.claude/skills/commit/SKILL.md`.

## License

MIT — see [LICENSE](LICENSE).
