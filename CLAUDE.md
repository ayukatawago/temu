# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

temu displays and drives an Android emulator/device or a booted iOS Simulator as live pixels
inside a terminal, so the device sits next to a CLI AI agent instead of in a separate GUI window.
tmux is one host among others, not a requirement — the render/input path degrades correctly
without it (see `src/render/caps.ts`'s `wrapTmuxPassthrough`, a no-op when `$TMUX` is unset), and
`temu` runs the same way in a plain terminal window. The one genuinely tmux-only feature is
`temu split` (`src/split.ts`), which needs an actual multiplexer to split a pane; everything else
in this doc that mentions tmux is describing behavior that also has to work without it. No
Electron, no GUI toolkit — just `adb`/`sim-use` + `ffmpeg` + raw terminal escape sequences. There
are no tests in this repo; correctness is established by reading the code's own doc comments
(many encode specific measurements/verifications against a real emulator or simulator) and by
manual runs against a live device.

Android is the zero-extra-dependency path (`adb` + `ffmpeg` only). iOS requires `sim-use` on
PATH: it's the only way to reach a simulator's private framebuffer/HID APIs (`xcrun simctl` alone
has no input verb of any kind — verified directly against Xcode 26.6). See
`src/device/target.ts` for the platform abstraction and `src/device/ios/simuse.ts` for why every
sim-use call runs with `SIM_USE_NO_DAEMON=1`.

## Commands

```sh
npm install
npm run dev              # run the CLI from source via tsx (no build step needed)
npm run build            # compile src/ -> dist/ (tsc)
npm run lint             # eslint .
npm run lint:fix
npm run format           # prettier --write .
npm run format:check     # prettier --check .
```

Before committing, run in this order and fix everything before proceeding to the next:
`npm run format:check && npm run lint && npm run build` (see `.claude/skills/commit/SKILL.md` for
the full commit convention — Conventional Commits, `Co-authored-by: Claude Code <claude@anthropic.com>`
trailer).

Manual verification commands used throughout this codebase's history (there's no automated test
suite, so these are how changes actually get checked):

```sh
node dist/cli.js                          # or: npm run dev
node dist/cli.js --device <serial> --bitrate 4M   # Android
node dist/cli.js --device <udid>                  # iOS Simulator (auto-detected by UUID shape)
node dist/cli.js --platform ios                   # disambiguate without naming a device/udid
node dist/cli.js split --percent 40       # tmux only (alias: `node dist/cli.js tmux ...`)
node dist/cli.js doctor [--fix] [--no-render-test]
adb devices                               # confirm a target Android device/emulator is attached
xcrun simctl list devices booted          # confirm a target iOS Simulator is booted
sim-use devices                           # confirm sim-use can see both
```

## Architecture

### Platform abstraction

- `src/device/target.ts` — the `DeviceTarget` interface `stream.ts` actually drives, plus
  `resolveTarget`, which decides whether `--device`/`--platform` (or an auto-scan of both
  platforms when neither is given) means Android or iOS. A `DeviceTarget` exposes two pixel
  sizes that matter for different reasons: `capturePx` (native framebuffer pixels — what
  ffmpeg/rendering size against) and `inputSize` (the coordinate space `tap`/`swipe`/hint bounds
  are expressed in). These are identical on Android; on iOS `inputSize` is UIKit points, about a
  third the magnitude of `capturePx` on a Retina simulator — `src/stream.ts` converts explicitly
  at the one place it matters (`zoomRegionToCapturePx`, since ffmpeg's crop filter only
  understands native pixels) and otherwise never mixes the two spaces.
- `src/device/android-target.ts` — thin `DeviceTarget` adapter over the pieces that existed
  before this abstraction did (`ScreenrecordSource`, `captureScreencapPng`, `getDeviceGeometry`,
  `AdbShellInputBackend`, uiautomator-based hints). No behavior change from before this
  abstraction existed.
- `src/device/ios/` — the iOS `DeviceTarget` (`target.ts`, assembled from this directory's other
  files):
  - `simuse.ts` — the one place that spawns `sim-use`. Always sets `SIM_USE_NO_DAEMON=1`:
    measured on this project's dev machine, sim-use's own background daemon adds a flat ~5s to
    every call (amortization that never pays off here, since temu issues one input command at a
    time rather than a rapid-fire sequence) vs ~0.15s for a bare HID call without it.
  - `discover.ts` — booted-simulator listing (`sim-use devices --platform ios`) and geometry:
    `capturePx` from decoding a seed screenshot's own PNG IHDR (authoritative for whatever the
    framebuffer's actual current size is), `inputSize` from the device type's `profile.plist`
    (`mainScreenScale`), falling back to `sim-use ui`'s reported screen size if that plist lookup
    fails for any reason.
  - `capture.ts` — `BgraFramebufferSource` spawns `sim-use stream-video --format bgra`, the
    private `SimDisplayIOSurface`/framebuffer path (not screenshot polling) — content-driven like
    Android's `ScreenrecordSource`: measured at ~1.5 frames per 6s on an idle screen, vs a
    constant ~9.6fps for sim-use's screenshot-polling formats. `--scale 1.0` always — sim-use's
    own scaling measurably halved throughput in testing, and ffmpeg already has to scale/crop
    regardless.
  - `input.ts` — `SimUseInputBackend`: one `sim-use` child process per input event, queued and
    run strictly one at a time (no persistent-session equivalent of `adb shell` exists — `sim-use
ios batch --stdin` was verified to slurp its stdin to EOF before executing a single step, so
    it can't serve as one). Live per-pixel dragging isn't reproducible at ~0.15-0.25s/call, so
    drags coalesce into one `swipe` from the recorded start position to the release point over
    the elapsed real time, instead of replaying real intermediate positions.
  - `hints.ts` — hint mode's iOS data source: `sim-use ui`'s accessibility outline mapped onto
    the same `HintTarget` shape `src/input/hints.ts` defines for Android, reusing that file's
    `generateLabels`/`renderHintOverlay` unchanged.
- `src/input/backend.ts` — `InputBackend`: semantic methods (`back`/`home`/`recents`/`power`/
  `volumeUp`/`volumeDown`/`enter`/`backspace`), not an Android-`KEYCODE_*`-shaped escape hatch —
  so the iOS backend can map what it can (home/lock/an edge-swipe for back) and let
  `DeviceTarget.supports()` report the rest (recents, volume — no sim-use primitive exists for
  either) so `stream.ts` can show an honest "not available" toast instead of a silent no-op.

### Pipeline: device pixels -> terminal pixels

```
Android: adb screenrecord (h264)         -\
iOS:     sim-use stream-video --format bgra -> PassThrough -> ffmpeg (decode+crop+scale+PNG)
                                                                              |
                                                                    IEND-split frames
                                                                              |
                                                      snapshot watchdog ------+
                                                     (fills stalled/first frames)
                                                                              v
                                                        KittyRenderer / BlocksRenderer
```

- `src/device/capture.ts` — `ScreenrecordSource` spawns
  `adb exec-out screenrecord --output-format=h264 ... -` and pipes raw H.264 Annex-B onto a
  long-lived `PassThrough` that survives the underlying adb process restarting (screenrecord
  exits/restarts are treated as normal, not exceptional). `captureScreencapPng` /
  `ScreencapPollSource` are the PNG-polling fallback path (also used directly for the `s`/`S`
  screenshot keys and for seeding/patching a stalled live view — see below). The iOS equivalent,
  `BgraFramebufferSource` (`src/device/ios/capture.ts`), has the exact same restart-on-exit shape.
- `src/device/transcode.ts` — `PngFrameSplitter` spawns ffmpeg to decode a raw device stream
  (Android's H.264 Annex-B, or iOS's rawvideo BGRA — `TranscodeOptions.source` picks ffmpeg's
  input-side flags via `buildInputArgs`) and scale it, then splits ffmpeg's concatenated
  `image2pipe` PNG stdout back into per-frame buffers by scanning for the PNG `IEND` trailer (a
  fixed 12-byte sequence). The Annex-B-specific ffmpeg flags (`-flags low_delay`,
  `-max_ts_probe 1`, `-fpsprobesize 0`, no `-fflags nobuffer`, no `fps=N` filter) each fix a
  specific empirically-verified stall/latency bug on a _live, unterminated_ Annex-B pipe — read
  the comments before changing any of them, they're not arbitrary tuning. rawvideo needs none of
  those (its format/size are declared up front via `-pixel_format`/`-video_size`, so there's
  nothing to probe for) but tolerates zero desync — a framebuffer resize (e.g. rotation) corrupts
  every subsequent frame with no way to resync short of rebuilding the pipeline; out of scope for
  v1 (portrait-only). The PNG encoder itself runs at `-compression_level 1`, not ffmpeg's default
  6: measured at ~0.6-0.8s to encode a single full-resolution iOS frame (1206x2622) at the default
  level — slower than any fps cap this codebase offers, so every frame queued up behind the
  encoder rather than the capture source or render tick. Level 1 measured ~0.1-0.15s for the same
  frame, for ~20% larger output — irrelevant since the PNG goes straight from a local temp file
  into Kitty's `t=t` transmission, never over a network. `scalePng` is a separate one-shot ffmpeg
  invocation used to rescale a snapshot PNG to match the live pipeline's current output size.
- **Structural limitation to know before touching the Android path**: raw H.264 Annex-B has no
  end-of-access-unit marker, so ffmpeg's demuxer can only tell a frame is complete once it sees
  the _next_ NAL's start code, or EOF. On a live pipe, a genuinely final frame (screen changes
  once, then holds still — e.g. a popup that appears and stays) has no successor and is **never**
  emitted by ffmpeg, with or without flag tuning. This is why the snapshot watchdog below exists
  and is load-bearing, not a rare fallback. iOS's bgra stream is content-driven the same way (no
  frame at all while the screen is static) and leans on the exact same watchdog for the same
  reason, even though its underlying cause (no Annex-B framing at all) is different.
- `src/stream.ts` — the main render/input loop and the piece that ties everything else together.
  Owns one `Pipeline` (capture source + `PngFrameSplitter`) at a time, rebuilding it whenever
  capture resolution needs to change (pane resize, zoom toggle — none of screenrecord, sim-use's
  framebuffer stream, or ffmpeg can be resized in place). Runs a fixed-interval render tick
  (`1000 / fpsCap`, adjustable live via `+`/`-`) that always renders the newest available frame
  and drops older ones — this, not the capture source's own rate, is what the fps cap controls.
  Each tick also calls `refreshFromScreencapIfStale`: if no live frame has arrived for
  `STALE_FRAME_THRESHOLD_MS`, it takes one platform-appropriate snapshot
  (`DeviceTarget.snapshotPng`) and displays that instead — the only mechanism that can surface a
  frame stuck by either platform's own capture limitation. Also wires up the keyboard/mouse
  handlers, the crosshair, hint mode, zoom, and the asleep-display toast (`isDisplayOn` — always
  `true` on iOS, since a locked simulator still renders a lock screen rather than going dark the
  way a sleeping Android display does). Runs on the alternate screen buffer
  (`enterAltScreen`/`leaveAltScreen` from `src/render/chrome.ts`) so quitting restores whatever
  was on screen before temu started, on both tmux and plain terminals; a `process.once('exit', ...)`
  safety net disables mouse tracking and leaves the alt screen even if `cleanup()` never runs
  (crash, unexpected `process.exit`). `currentAvailableCells` treats `process.stdout.columns`/
  `.rows` of exactly `0` — not just `undefined` — as "unknown, use the fallback": confirmed on a
  bare pty with no winsize ever set (`process.stdout` reports `{columns: 0, rows: 0}` there, which
  `?? 80` doesn't catch), collapsing the grid to 1x1. Every tmux pane always has a real winsize,
  which is why this only ever surfaces outside tmux. Handles `SIGHUP` alongside `SIGINT`/
  `SIGTERM`: tmux sends it (not the other two) when a pane closes out from under its process —
  `tmux kill-pane`, or the pane's window disappearing — and without it, `cleanup()` never runs at
  all, leaking the Kitty image (`src/render/kitty.ts`'s `dispose()` never gets called). Also
  installs a no-op `process.stdout.on('error', ...)`: once the pane's pty is gone, tmux has
  already destroyed it by the time `cleanup()` runs, so its very _first_ write (disabling mouse
  tracking) throws `EIO` — reproduced directly by `kill-pane`-ing a live instance and watching
  the unhandled `'error'` event on the stream crash the process right there, before it ever
  reaches `renderer.dispose()`'s image-delete command or `leaveAltScreen()`. Swallowing that
  error doesn't recover the write (a dead pty can't be written to, full stop), it just stops one
  failed write from aborting the rest of cleanup.

  `--renderer kitty|blocks` overrides `detectCaps()`'s Kitty-support autodetection outright, in
  either direction — a general-purpose manual escape hatch for whatever autodetection can't
  observe directly, not a workaround for one specific known bug. It was originally added while
  chasing a `temu split` video-in-the-wrong-pane report that looked like a Kitty-compositing
  limitation in the host terminal; that turned out to be temu's own bug (a placeholder grid
  wrongly sent through tmux passthrough — see `src/render/kitty.ts`'s `drawPlaceholderGrid` doc
  comment) and is fixed there directly, not worked around here.

### Rendering

- `src/render/kitty.ts` — primary renderer, via the Kitty graphics protocol's **Unicode
  placeholder** mechanism (not inline/base64 images): a grid of invisible placeholder codepoints
  paired with row/column combining diacritics (`src/render/rowcolumn-diacritics.ts`) is printed
  as ordinary text, so tmux's screen model can scroll/reflow/redraw it without knowing anything
  about images. Each frame is written to a temp PNG file and referenced via `t=t` transmission
  (not `t=d` base64-inline) specifically to keep tmux's control-socket traffic tiny. Requires
  tmux's `allow-passthrough` to be on when running inside tmux (`temu doctor --fix` sets it). The
  image id defaults to a value derived from `process.pid`, not a fixed constant: the protocol's
  image-id namespace is shared by the whole real terminal, not scoped per pane, so two temu
  instances both defaulting to id 1 (e.g. one running directly, one opened via `temu split`)
  would repaint each other's placeholder grids — confirmed as the exact cause of a reported bug
  where a `split`-created pane's video appeared on the _original_ pane instead. Every placeholder
  grid draw is followed by a `tmux refresh-client` (`requestTmuxRedraw` in caps.ts, a no-op
  outside tmux): tmux 3.7b drops a cell's combining diacritics on the way to the terminal whenever
  the pane's `xoff` is non-zero (the right-hand pane `temu split` creates), because
  `screen_write_combine()` checks the modified cell's visibility using a pane-relative x where the
  rest of that file uses `wp->xoff + cx` — so the re-emit is skipped as "obscured". Bare
  placeholders make every row render as image row 0, which is the reported "top strip of the phone
  screen tiled down the pane". tmux's own grid keeps the diacritics, so one full repaint fixes it;
  fixed upstream after 3.7b, hence a workaround rather than a version bump.
- `src/render/blocks.ts` — fallback renderer for terminals without Kitty graphics support: draws
  frames as colored upper-half-block characters (2 vertical "pixels" per cell via independent
  fg/bg SGR colors). Implements the same `renderFramePng`/`resize`/`dispose` shape as
  `KittyRenderer` so `stream.ts` doesn't care which one it's driving.
- `src/render/caps.ts` — all terminal/tmux capability detection (inside-tmux, allow-passthrough,
  cell pixel size, Kitty graphics support) lives here, via live escape-sequence queries with a
  heuristic (env-var-based) fallback when queries aren't possible (non-interactive, or tmux would
  swallow them). Nothing else in the codebase should be probing terminal capabilities directly.
  Cell pixel size and Kitty graphics support are properties of the _real_ terminal, so their
  queries go through tmux passthrough to reach it — but `queryCursorPosition` deliberately
  doesn't (`passthrough: false`): tmux answers `CSI 6n` itself, in coordinates relative to the
  _pane_, matching the space SGR mouse reports already arrive in. Passthrough-wrapping it instead
  gets the real terminal's own absolute on-screen answer, which only coincides with pane-relative
  in an unsplit pane — confirmed as the cause of every tap landing on the device's left edge in a
  `temu split` pane (`gridOrigin.col` measured as the pane's absolute screen column instead of
  ~1, driving `cellToDevicePixel`'s `mouseCol - origin.col` deeply negative before it clamps).
- `src/render/geometry.ts` — pure math: fitting the device's native aspect ratio into the pane's
  available cell grid (`fitDeviceToCells`, also picks the capture resolution to request), and
  converting between terminal cell coordinates and "device pixel" coordinates in both directions,
  including through an active zoom region. Doesn't know or care whether "device pixel" means
  actual pixels (Android) or UIKit points (iOS) — it just linearly maps whatever width/height
  numbers `stream.ts` passes in (`DeviceTarget.inputSize`), which is why this file needed no
  changes at all to support a second platform.
- `src/render/png.ts` — a minimal dependency-free PNG encoder/decoder (no image library
  dependency). The encoder exists for `doctor`'s self-test pattern; the decoder exists only to
  back the block-renderer fallback, which needs raw pixels rather than an opaque PNG buffer.
- `src/render/chrome.ts` — the status bar (mode/crosshair/fps/toast, one line, always redrawn in
  place via save/restore cursor), the key-binding help overlay (`?`), and `enterAltScreen`/
  `leaveAltScreen` (DECSET 1049). All deliberately plain ANSI/text, not passthrough-wrapped, since
  tmux needs to understand cursor movement and screen-buffer switches natively (it tracks the
  alternate screen per pane and restores the pane's own prior content) — the opposite of Kitty's
  APC codes, which tmux doesn't understand at all.

### Input

- `src/input/mouse.ts` — decodes SGR mouse reports (`CSI < Cb;Cx;Cy M/m`) into
  tap/drag-start/drag-move/drag-end/wheel/right-click callbacks, in terminal cell coordinates.
  Buffers a possibly-split escape sequence across `feed()` calls. Platform-agnostic: it hands
  `stream.ts` cell coordinates, which get converted to whichever `DeviceTarget.inputSize` space
  is in play.
- `src/input/keymap.ts` — a small modal keyboard state machine (`normal` / `text` / `hint`
  modes) decoding raw stdin bytes left over after `MouseTracker` takes its share. Handles the
  ESC-vs-CSI-prefix ambiguity with a short timeout rather than guessing.
- `src/input/hints.ts` — hint mode (`f`) on Android: dumps the live accessibility tree via
  `adb exec-out uiautomator dump /dev/tty`, parses clickable element bounds, and assigns short
  letter labels so the caller can tap a labeled element's exact center in device pixels —
  sidesteps the coarse cell-grid resolution of mouse-driven tapping entirely. Also exports
  `generateLabels`/`renderHintOverlay`/the `HintTarget` shape, reused as-is by
  `src/device/ios/hints.ts` for the iOS equivalent (`sim-use ui`'s accessibility outline).
- `src/input/backend.ts` — `InputBackend`: the semantic (not Android-keycode-shaped) interface
  both platforms' input backends implement — see "Platform abstraction" above for why.
- `src/input/adbshell.ts` — `AdbShellInputBackend`, the Android `InputBackend`. Drives Android's
  `input` command through one persistent `adb shell` session rather than spawning a process per
  call (a naive per-call approach measured ~250-600ms/tap from adb transport overhead alone; a
  persistent shell amortizes that to ~21ms/call). Raw evdev injection was the original design but
  is blocked by SELinux under stock AOSP policy — not just slow, actually denied — so don't
  reintroduce that path without solving that first. `src/device/ios/input.ts`'s
  `SimUseInputBackend` is the iOS counterpart — no persistent-session equivalent exists there
  (see "Platform abstraction" above), so it pays sim-use's ~0.15-0.25s per-call cost directly,
  queued through one serial queue rather than a shared shell.

### Log mode (`temu --logs`)

A separate session type chosen at launch (never toggled mid-session), so `temu split --logs`
works for free via `split.ts`'s generic flag forwarding. `runStream` hands off to
`src/logs/run.ts`'s `runLogs` right after `parseStreamArgs` — no capture/ffmpeg/renderer is
involved, so `--renderer`/`--bitrate` are ignored.

- `src/device/logcat.ts` (`LogcatSource`, `adb logcat -v threadtime -T 1`) and
  `src/device/ios/logstream.ts` (`IosLogStreamSource`, `xcrun simctl spawn <udid> log stream
--style ndjson`) both emit `LogEntry` (`src/logs/entry.ts`) and restart on exit like the
  capture sources. iOS needs no `temu-ios` helper. threadtime has no package column, so
  `LogcatSource` refreshes a pid -> name map from `ps` every 3s and the name is resolved lazily
  (`LogContext.processName`) at display/filter time.
- `src/logs/filter.ts` — Android-Studio-lite query (`tag:`/`package:`/`process:`/`message:`/
  `level:`, `-` negation, bare words). Same key OR'd, different keys AND'd, negations AND'd;
  unparseable terms degrade to bare words rather than throwing.
- `src/logs/view.ts` — `LogView`: 10k-entry ring buffer, filtered list stored as absolute
  sequence numbers (so ring eviction only trims the list's head), follow/paused scroll state,
  render throttled to ~30Hz. `src/logs/keys.ts` — `LogKeyboard`, separate from `keymap.ts`
  because every printable key is filter text here (hence quit is Ctrl+C only).
- `resolveDeviceRef` (`src/device/target.ts`) is `resolveTarget`'s device-choosing half, so log
  mode doesn't pay for building a full `DeviceTarget` (iOS geometry lookup).

### Entry points

- `src/cli.ts` — argv dispatch only (`temu`, `temu doctor`, `temu split`/`temu tmux`); no logic of
  its own. Any other leading `--flag` (not just a fixed `--device`/`--bitrate` allowlist) routes
  to the default streaming command — `src/stream.ts`'s own arg parser is the single source of
  truth for which flags exist.
- `src/stream.ts` — default command (streaming/interactive session).
- `src/doctor.ts` — environment/capability checks (adb/ffmpeg presence — required; tmux/sim-use
  presence — optional, `warn` not `fail` on a machine that doesn't need them; tmux
  allow-passthrough when applicable; terminal cell size; Kitty graphics support; and on macOS:
  xcrun/sim-use presence plus booted simulators) plus an interactive render self-test; `--fix`
  offers to turn on tmux's `allow-passthrough`. `runCommand`'s spawn-failure detection (an
  `ENOENT`-style `error.code` is a string; a nonzero-exit failure's `error.code` is a number) is
  what makes "not found on PATH" actually distinguishable from "ran fine" — confirmed directly
  against a nonexistent binary — so don't go back to resolving on every `execFile` callback
  regardless of error the way this used to.
- `src/split.ts` — `temu split` (alias: `temu tmux`): splits the current tmux window and re-execs
  the same node binary/script in the new pane with the same argv shape (not a shell string — the
  target pane's shell may not be POSIX sh, so args are passed as an argv array to avoid quoting
  bugs). Forwards every non-`--percent` flag through to the new pane's invocation verbatim
  (`--device`, `--platform`, `--renderer`, `--bitrate`, ...) rather than re-listing recognized
  ones here — this file used to hardcode just `--device`/`--platform` and silently drop
  everything else, which meant `--renderer` (see `stream.ts`'s entry below) had no effect when
  combined with `split`; forwarding generically is what actually closes that off for any current
  or future stream-only flag, mirroring `cli.ts`'s own "runStream's parser is the single source
  of truth" dispatch philosophy. This is the one feature that's genuinely tmux-only (see "What
  this is" above) — outside tmux it prints a message telling the user to open a second
  window/pane themselves, rather than erroring as if tmux were required for temu in general.

## Conventions worth knowing

- TypeScript strict mode plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` — array
  indexing and optional properties are typed accordingly; don't add `!` assertions to work around
  it, handle the `undefined` case.
- ESM throughout (`"type": "module"`, `verbatimModuleSyntax`, NodeNext resolution) — internal
  imports use explicit `.js` extensions even though the source is `.ts`.
- No runtime _npm_ dependencies (`package.json` `dependencies` is empty) — this is intentional
  (self-contained; think twice before adding one, especially for something like PNG encode/decode
  this codebase already implements itself for exactly that reason). The external surface is
  `adb` + `ffmpeg` on `PATH` for Android, plus `sim-use` on `PATH` for iOS (required only when
  attaching to an iOS Simulator target — see "What this is" above for why there's no
  zero-dependency alternative there).
- Prettier: single quotes, semicolons, trailing commas, 100-char print width.
