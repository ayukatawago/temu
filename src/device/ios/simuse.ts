// The one place that spawns `sim-use` — every other file under src/device/ios goes through this,
// the same "narrow wrapper, not a general CLI wrapper" shape as src/device/discover.ts's `runAdb`.
//
// Two things every call needs, verified against sim-use v0.12.0 on this project's dev machine:
//
// - `SIM_USE_NO_DAEMON=1` is always set. Without it, sim-use auto-spawns a background daemon to
//   amortise its own init cost across calls — but the *first* call against a cold daemon still
//   pays that cost, and measured here it's a flat ~5s (a no-op HID call: 5.1s daemon vs 0.15s
//   without). temu issues one input command at a time rather than a rapid-fire sequence, so
//   there's no repeated-call volume for a warm daemon to amortise against — every call would hit
//   close to that 5s tax. Bypassing the daemon entirely is faster in every case that matters here.
// - `--json` gets a real envelope even on failure: `{"ok":false,"error":"...","hint":"..."}`,
//   with a non-zero exit code. The `hint` field (e.g. candidate labels on a failed `--label`
//   match) is worth surfacing in the thrown error rather than discarding it.

import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

export interface SimUseEnvelope<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  hint?: string;
}

function withNoDaemonEnv(): NodeJS.ProcessEnv {
  return { ...process.env, SIM_USE_NO_DAEMON: '1' };
}

/** Thrown when a `sim-use ... --json` call returns `ok:false` or a non-JSON/exec failure. */
export class SimUseError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(hint ? `${message} (hint: ${hint})` : message);
    this.name = 'SimUseError';
  }
}

/**
 * Runs a one-shot `sim-use` command with `--json` and returns its parsed `data`. Callers pass
 * the subcommand and its own flags; `--json` is appended here so every call goes through the
 * same envelope-parsing path.
 */
export function runSimUse<T = unknown>(
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<T> {
  return new Promise((resolveRun, rejectRun) => {
    execFile(
      'sim-use',
      [...args, '--json'],
      { env: withNoDaemonEnv(), timeout: options.timeoutMs ?? 15000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && stdout.trim().length === 0) {
          rejectRun(
            new SimUseError(`sim-use ${args.join(' ')} failed: ${stderr || error.message}`),
          );
          return;
        }
        let envelope: SimUseEnvelope<T>;
        try {
          envelope = JSON.parse(stdout) as SimUseEnvelope<T>;
        } catch {
          rejectRun(
            new SimUseError(
              `sim-use ${args.join(' ')} produced non-JSON output: ${stdout.slice(0, 200)}`,
            ),
          );
          return;
        }
        if (!envelope.ok) {
          rejectRun(new SimUseError(envelope.error ?? 'sim-use reported failure', envelope.hint));
          return;
        }
        resolveRun(envelope.data as T);
      },
    );
  });
}

/** A child process spawned with stdin ignored and stdout/stderr piped (no stdin to write to). */
type ChildWithPipedOutput = ChildProcessByStdio<null, Readable, Readable>;

/**
 * Spawns a long-lived `sim-use` subcommand (only `stream-video` needs this) without waiting for
 * it to exit or parsing its stdout as JSON — the stream itself *is* the payload.
 */
export function spawnSimUseStream(args: string[]): ChildWithPipedOutput {
  return spawn('sim-use', args, { env: withNoDaemonEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Whether `sim-use` is reachable on PATH at all — used by `temu doctor` and by target resolution
 * to distinguish "no iOS devices right now" from "iOS support isn't installed on this machine". */
export function isSimUseAvailable(): Promise<boolean> {
  return new Promise((resolveRun) => {
    execFile('sim-use', ['--version'], { timeout: 5000 }, (error) => {
      resolveRun(!error);
    });
  });
}
