# temu

Display and drive an Android emulator (and later, iOS Simulator) as live pixels inside a tmux
pane — so the device sits side by side with a CLI AI agent instead of in a separate GUI window.

## Requirements

- `adb` on `PATH`, with a running Android emulator or connected device
- `ffmpeg` on `PATH`
- tmux, if run inside it (temu works outside tmux too)
- Ideally a terminal with Kitty graphics protocol support (virtual placements), for real pixels.
  Terminals without it get an automatic fallback to a lower-quality block-character renderer, so
  temu always displays something — run `temu doctor` to see which path you're on.

## Usage

```sh
temu                          # attach to the only connected device and stream its screen
temu --device <serial>        # attach to a specific device (adb serial)
temu tmux [--device <serial>] # split the current tmux window and run temu in the new pane
temu doctor [--fix]           # check adb/ffmpeg/tmux/terminal-graphics; --fix offers to turn
                               # on tmux's allow-passthrough if it's off
```

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

## Development

```sh
npm install
npm run dev       # run the CLI from source via tsx
npm run build     # compile to dist/
npm run lint
npm run format:check
```

Commits in this repo follow Conventional Commits — see `.claude/skills/commit/SKILL.md`.
