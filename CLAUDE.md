# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

temu displays and drives an Android emulator/device as live pixels inside a terminal (typically a
tmux pane), so the device sits next to a CLI AI agent instead of in a separate GUI window. No
Electron, no GUI toolkit — just `adb` + `ffmpeg` + raw terminal escape sequences. There are no
tests in this repo; correctness is established by reading the code's own doc comments (many
encode specific measurements/verifications against a real emulator) and by manual runs against a
live device.

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
node dist/cli.js --device <serial> --bitrate 4M
node dist/cli.js tmux --percent 40
node dist/cli.js doctor [--fix] [--no-render-test]
adb devices                               # confirm a target device/emulator is attached
```

## Architecture

### Pipeline: device pixels -> terminal pixels

```
adb screenrecord (h264) -> PassThrough -> ffmpeg (decode+scale+PNG) -> IEND-split frames
                                                                              |
                                                     screencap watchdog ------+
                                                     (fills stalled/first frames)
                                                                              v
                                                        KittyRenderer / BlocksRenderer
```

- `src/device/capture.ts` — `ScreenrecordSource` spawns
  `adb exec-out screenrecord --output-format=h264 ... -` and pipes raw H.264 Annex-B onto a
  long-lived `PassThrough` that survives the underlying adb process restarting (screenrecord
  exits/restarts are treated as normal, not exceptional). `captureScreencapPng` /
  `ScreencapPollSource` are the PNG-polling fallback path (also used directly for the `s`/`S`
  screenshot keys and for seeding/patching a stalled live view — see below).
- `src/device/transcode.ts` — `PngFrameSplitter` spawns ffmpeg to decode that Annex-B stream and
  scale it, then splits ffmpeg's concatenated `image2pipe` PNG stdout back into per-frame buffers
  by scanning for the PNG `IEND` trailer (a fixed 12-byte sequence). The ffmpeg flags here
  (`-flags low_delay`, `-max_ts_probe 1`, `-fpsprobesize 0`, no `-fflags nobuffer`, no `fps=N`
  filter) each fix a specific empirically-verified stall/latency bug on a _live, unterminated_
  Annex-B pipe — read the comments before changing any of them, they're not arbitrary tuning.
  `scalePng` is a separate one-shot ffmpeg invocation used to rescale a screencap PNG to match the
  live pipeline's current output size.
- **Structural limitation to know before touching this pipeline**: raw H.264 Annex-B has no
  end-of-access-unit marker, so ffmpeg's demuxer can only tell a frame is complete once it sees
  the _next_ NAL's start code, or EOF. On a live pipe, a genuinely final frame (screen changes
  once, then holds still — e.g. a popup that appears and stays) has no successor and is **never**
  emitted by ffmpeg, with or without flag tuning. This is why the screencap watchdog below exists
  and is load-bearing, not a rare fallback.
- `src/stream.ts` — the main render/input loop and the piece that ties everything else together.
  Owns one `Pipeline` (capture source + `PngFrameSplitter`) at a time, rebuilding it whenever
  capture resolution needs to change (pane resize, zoom toggle — neither screenrecord nor ffmpeg
  can be resized in place). Runs a fixed-interval render tick (`1000 / fpsCap`, adjustable live via
  `+`/`-`) that always renders the newest available frame and drops older ones — this, not
  ffmpeg's own rate, is what the fps cap now controls, since the `fps=N` output filter was removed
  from the ffmpeg pipeline. Each tick also calls `refreshFromScreencapIfStale`: if no live frame
  has arrived for `STALE_FRAME_THRESHOLD_MS`, it takes one `screencap` snapshot and displays that
  instead — the only mechanism that can surface a frame stuck by the Annex-B limitation above.
  Also wires up the keyboard/mouse handlers, the crosshair, hint mode, zoom, and the asleep-display
  toast (`isDisplayOn`).

### Rendering

- `src/render/kitty.ts` — primary renderer, via the Kitty graphics protocol's **Unicode
  placeholder** mechanism (not inline/base64 images): a grid of invisible placeholder codepoints
  paired with row/column combining diacritics (`src/render/rowcolumn-diacritics.ts`) is printed
  as ordinary text, so tmux's screen model can scroll/reflow/redraw it without knowing anything
  about images. Each frame is written to a temp PNG file and referenced via `t=t` transmission
  (not `t=d` base64-inline) specifically to keep tmux's control-socket traffic tiny. Requires
  tmux's `allow-passthrough` to be on when running inside tmux (`temu doctor --fix` sets it).
- `src/render/blocks.ts` — fallback renderer for terminals without Kitty graphics support: draws
  frames as colored upper-half-block characters (2 vertical "pixels" per cell via independent
  fg/bg SGR colors). Implements the same `renderFramePng`/`resize`/`dispose` shape as
  `KittyRenderer` so `stream.ts` doesn't care which one it's driving.
- `src/render/caps.ts` — all terminal/tmux capability detection (inside-tmux, allow-passthrough,
  cell pixel size, Kitty graphics support) lives here, via live escape-sequence queries with a
  heuristic (env-var-based) fallback when queries aren't possible (non-interactive, or tmux would
  swallow them). Nothing else in the codebase should be probing terminal capabilities directly.
- `src/render/geometry.ts` — pure math: fitting the device's native aspect ratio into the pane's
  available cell grid (`fitDeviceToCells`, also picks the capture resolution screenrecord should
  target), and converting between terminal cell coordinates and device pixel coordinates in both
  directions, including through an active zoom region.
- `src/render/png.ts` — a minimal dependency-free PNG encoder/decoder (no image library
  dependency). The encoder exists for `doctor`'s self-test pattern; the decoder exists only to
  back the block-renderer fallback, which needs raw pixels rather than an opaque PNG buffer.
- `src/render/chrome.ts` — the status bar (mode/crosshair/fps/toast, one line, always redrawn in
  place via save/restore cursor) and the key-binding help overlay (`?`). Deliberately plain
  ANSI/text, not passthrough-wrapped, since tmux needs to understand cursor movement natively —
  the opposite of Kitty's APC codes, which tmux doesn't understand at all.

### Input

- `src/input/mouse.ts` — decodes SGR mouse reports (`CSI < Cb;Cx;Cy M/m`) into
  tap/drag-start/drag-move/drag-end/wheel/right-click callbacks, in terminal cell coordinates.
  Buffers a possibly-split escape sequence across `feed()` calls.
- `src/input/keymap.ts` — a small modal keyboard state machine (`normal` / `text` / `hint`
  modes) decoding raw stdin bytes left over after `MouseTracker` takes its share. Handles the
  ESC-vs-CSI-prefix ambiguity with a short timeout rather than guessing.
- `src/input/hints.ts` — hint mode (`f`): dumps the live accessibility tree via
  `adb exec-out uiautomator dump /dev/tty`, parses clickable element bounds, and assigns short
  letter labels so the caller can tap a labeled element's exact center in device pixels —
  sidesteps the coarse cell-grid resolution of mouse-driven tapping entirely.
- `src/input/adbshell.ts` — `AdbShellInputBackend`, the one production `InputBackend`
  (`src/input/backend.ts`). Drives Android's `input` command through one persistent `adb shell`
  session rather than spawning a process per call (a naive per-call approach measured
  ~250-600ms/tap from adb transport overhead alone; a persistent shell amortizes that to
  ~21ms/call). Raw evdev injection was the original design but is blocked by SELinux under stock
  AOSP policy — not just slow, actually denied — so don't reintroduce that path without solving
  that first.

### Entry points

- `src/cli.ts` — argv dispatch only (`temu`, `temu doctor`, `temu tmux`); no logic of its own.
- `src/stream.ts` — default command (streaming/interactive session).
- `src/doctor.ts` — environment/capability checks (adb/ffmpeg/tmux presence, tmux
  allow-passthrough, terminal cell size, Kitty graphics support) plus an interactive render
  self-test; `--fix` offers to turn on tmux's `allow-passthrough`.
- `src/tmuxlayout.ts` — `temu tmux`: splits the current tmux window and re-execs the same
  node binary/script in the new pane with the same argv shape (not a shell string — the target
  pane's shell may not be POSIX sh, so args are passed as an argv array to avoid quoting bugs).

## Conventions worth knowing

- TypeScript strict mode plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` — array
  indexing and optional properties are typed accordingly; don't add `!` assertions to work around
  it, handle the `undefined` case.
- ESM throughout (`"type": "module"`, `verbatimModuleSyntax`, NodeNext resolution) — internal
  imports use explicit `.js` extensions even though the source is `.ts`.
- No runtime dependencies (`package.json` `dependencies` is empty) — this is intentional
  (self-contained, `adb` + `ffmpeg` on `PATH` is the whole external surface). Think twice before
  adding one, especially for something (like PNG encode/decode) this codebase already implements
  itself for exactly that reason.
- Prettier: single quotes, semicolons, trailing commas, 100-char print width.
