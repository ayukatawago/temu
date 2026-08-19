// `temu tmux`: splits the current tmux window and launches temu in the new pane, sized to leave
// the agent's pane (this one) as the primary working area.
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

export interface TmuxLayoutOptions {
  device?: string | undefined;
  /** Width the new (video) pane takes, as a percentage of the current window. */
  percent: number;
}

const DEFAULT_PANE_PERCENT = 40;

export function parseTmuxArgs(argv: string[]): TmuxLayoutOptions {
  let device: string | undefined;
  let percent = DEFAULT_PANE_PERCENT;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--device') {
      device = argv[++i];
    } else if (argv[i] === '--percent') {
      const value = Number(argv[++i]);
      if (Number.isFinite(value) && value > 0 && value < 100) {
        percent = value;
      }
    }
  }
  return { device, percent };
}

function runTmux(args: string[]): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolveRun) => {
    execFile('tmux', args, (error, _stdout, stderr) => {
      resolveRun({ ok: !error, stderr });
    });
  });
}

export async function runTmuxLayout(argv: string[]): Promise<number> {
  if (!isInsideTmux()) {
    console.error('temu tmux must be run from inside a tmux session.');
    return 1;
  }

  const options = parseTmuxArgs(argv);

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
  ];
  if (options.device) {
    args.push('--device', options.device);
  }

  const result = await runTmux(args);
  if (!result.ok) {
    console.error(`tmux split-window failed: ${result.stderr.trim()}`);
    return 1;
  }
  return 0;
}
