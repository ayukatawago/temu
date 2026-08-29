// `temu split` (alias: `temu tmux`): splits the current tmux window and launches temu in the new
// pane, sized to leave the agent's pane (this one) as the primary working area. This is the one
// feature that's genuinely tmux-only — temu itself runs fine in any terminal (see CLAUDE.md and
// src/render/caps.ts), but "split my current pane" only has a defined meaning with a multiplexer
// backing it, and tmux is the only one this project can verify. Outside tmux this just tells the
// user to open a second window/pane themselves and run `temu` there.
//
// Builds the new pane's command as a plain argv array (node binary, this script's own path, then
// flags) rather than a shell-quoted string. Verified directly against a real tmux instance: both
// `new-session` and `split-window` pass trailing arguments straight through to the pane's
// process, unquoted — there's no intermediate shell parsing to worry about, which matters because
// the target pane's shell is configurable (this machine's tmux `default-shell` is fish, whose
// quoting rules differ from POSIX sh) and getting that wrong would silently break argument
// passing on some machines but not others.

import { execFile } from 'node:child_process';
import { isInsideTmux } from './render/caps.js';

export interface SplitOptions {
  /** Width the new (video) pane takes, as a percentage of the current window. */
  percent: number;
  /**
   * Everything else (`--device`, `--platform`, `--renderer`, `--bitrate`, ...), forwarded
   * verbatim to the new pane's temu invocation — stream.ts's own arg parser is the single
   * source of truth for which of these are valid, same design as cli.ts's default-command
   * dispatch. This file used to re-list only `--device`/`--platform` explicitly and silently
   * drop everything else, which meant `--renderer` (a real workaround for a terminal
   * compatibility bug specific to split panes — see CLAUDE.md) had no effect when combined with
   * `split`. Forwarding generically, rather than maintaining a duplicate allowlist here that has
   * to be kept in sync with parseStreamArgs, is what actually fixes that class of bug for good.
   */
  forwardedArgs: string[];
}

const DEFAULT_PANE_PERCENT = 40;

export function parseSplitArgs(argv: string[]): SplitOptions {
  let percent = DEFAULT_PANE_PERCENT;
  const forwardedArgs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === '--percent') {
      const value = Number(argv[++i]);
      if (Number.isFinite(value) && value > 0 && value < 100) {
        percent = value;
      }
      continue; // split-only flag — not meaningful to runStream, so not forwarded
    }
    forwardedArgs.push(arg);
  }
  return { percent, forwardedArgs };
}

function runTmux(args: string[]): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolveRun) => {
    execFile('tmux', args, (error, _stdout, stderr) => {
      resolveRun({ ok: !error, stderr });
    });
  });
}

export async function runSplit(argv: string[]): Promise<number> {
  if (!isInsideTmux()) {
    console.error(
      'temu split needs a multiplexer that can split panes; none detected. tmux is supported ' +
        'today.\nJust run `temu` in a second terminal window/split instead.',
    );
    return 1;
  }

  const options = parseSplitArgs(argv);

  // Re-invoke the exact same script via the exact same node binary that's running right now,
  // rather than relying on a `temu` command being resolvable on the new pane's PATH — the same
  // approach works whether temu is installed globally, run via `npm link`, or run from source
  // via tsx during development.
  const args = [
    'split-window',
    '-h',
    '-p',
    String(options.percent),
    process.execPath,
    process.argv[1] ?? 'temu',
    ...options.forwardedArgs,
  ];

  const result = await runTmux(args);
  if (!result.ok) {
    console.error(`tmux split-window failed: ${result.stderr.trim()}`);
    return 1;
  }
  return 0;
}
