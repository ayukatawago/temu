# temu

Display and drive an Android emulator or a booted iOS Simulator as live pixels inside your
terminal — so the device sits side by side with a CLI AI agent instead of in a separate GUI
window. Works in any terminal; tmux is entirely optional (see below).

## Installation

```sh
brew install ayukatawago/tap/temu
```

This also pulls in `ffmpeg`. See [Requirements](#requirements) below for `adb`/`sim-use`/tmux,
which are platform-specific and not installed automatically.

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
temu --logs [--filter <query>]  # show the device log (Android logcat / iOS Simulator unified log)
                                 # instead of its screen — see "Log mode" below
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

## Log mode

`temu --logs` shows the device's live log in the terminal instead of its screen: `adb logcat` on
Android, the unified log (`log stream`) on a booted iOS Simulator. Which view you get is chosen at
launch, not toggled mid-session — run the screen in one pane and the logs in another, or let tmux
do it with `temu split --logs`. It accepts the same `--device` / `--platform` flags as streaming,
and `--filter "<query>"` to start with a filter already applied. It needs only `adb` (Android) or
`xcrun` (iOS) — not `ffmpeg`, a Kitty-capable terminal, or the iOS helper.

The top row is a filter field that always has focus: whatever you type narrows the log live. The
last row shows how many lines match (`shown/total`) and whether the view is following new output
(`FOLLOW`) or paused because you scrolled up (`PAUSED`). The last 10,000 lines since temu started
are kept, and changing the filter re-applies it to all of them. Lines are colored by level, and
the process and tag columns are fixed-width (longer names are cut with `…` for display only —
filtering still sees the full text) so messages line up.

### Filter syntax

Terms are separated by spaces; wrap a value in `"double quotes"` to include spaces.

| Term                     | Matches                                                                 |
| ------------------------ | ----------------------------------------------------------------------- |
| `tag:X`                  | Tag contains `X` (iOS: `subsystem:category`)                            |
| `package:X`, `process:X` | Process / package name contains `X`                                     |
| `message:X`              | Message contains `X`                                                    |
| `level:W`                | That level and above: `V` `D` `I` `W` `E` `A` (or `warn`, `error`, ...) |
| `-tag:X`, `-message:X`   | Negation — excludes lines matching the term (works for every key)       |
| `word`, `-word`          | Bare word: case-insensitive match anywhere in the line; `-` excludes it |

Matching is case-insensitive. Like Android Studio, several terms for the same key are OR'd,
different keys are AND'd, and every negation is AND'd — so `tag:Net tag:Http level:W -message:retry`
means "tag contains Net or Http, at warning or above, not mentioning retry". A term that can't be
parsed (such as `level:zzz`) is treated as a bare word instead of raising an error.

### Log mode keys

| Input                         | Action                                                      |
| ----------------------------- | ----------------------------------------------------------- |
| Typing, `Backspace`, `Delete` | Edit the filter at the cursor                               |
| `←` / `→`                     | Move the filter cursor without deleting anything            |
| `Ctrl+A` / `Ctrl+E`           | Cursor to start / end of the filter                         |
| `Ctrl+W` / `Ctrl+U`           | Delete the word before the cursor / clear the whole filter  |
| `↑` / `↓`, mouse wheel        | Scroll one line (wheel: three) — scrolling up pauses follow |
| `PgUp` / `PgDn`               | Scroll one page                                             |
| `Home` / `End`                | Jump to the oldest line / back to following new output      |
| `Ctrl+C`                      | Quit (`q` is a filter character here, so it doesn't quit)   |

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
