# temu

Display and drive an Android emulator (and later, iOS Simulator) as live pixels inside a tmux
pane — so the device sits side by side with a CLI AI agent instead of in a separate GUI window.

Status: early scaffold. See `.claude/plans/` in the maintainer's Claude Code history for the
full design, or the milestone commits in this repo's history for what's landed so far.

## Requirements

- `adb` on `PATH`, with a running Android emulator or connected device
- `ffmpeg` on `PATH`
- A terminal with Kitty graphics protocol support (virtual placements), running inside tmux with
  `allow-passthrough on`

## Development

```sh
npm install
npm run dev       # run the CLI from source via tsx
npm run build     # compile to dist/
npm run lint
npm run format:check
```
