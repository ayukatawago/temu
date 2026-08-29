// `temu doctor`: checks that the tools and terminal capabilities temu depends on are actually
// present and working, since almost every failure mode here is silent otherwise (a missing
// `allow-passthrough` setting doesn't error, it just makes images never appear).

import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { isSimUseAvailable, listBootedSimulators } from './device/ios/discover.js';
import {
  detectCaps,
  getTmuxAllowPassthrough,
  isInsideTmux,
  setTmuxAllowPassthroughOn,
  type PassthroughState,
} from './render/caps.js';
import { KittyRenderer } from './render/kitty.js';
import { encodePng, generateTestPattern } from './render/png.js';

type CheckStatus = 'ok' | 'warn' | 'fail' | 'info';

interface CheckResult {
  label: string;
  status: CheckStatus;
  detail: string;
}

function icon(status: CheckStatus): string {
  switch (status) {
    case 'ok':
      return '✓'; // ✓
    case 'warn':
      return '!';
    case 'fail':
      return '✗'; // ✗
    case 'info':
      return '·'; // ·
  }
}

function printResult(result: CheckResult): void {
  console.log(`  ${icon(result.status)} ${result.label}: ${result.detail}`);
}

interface CommandResult {
  /** Set when the binary itself couldn't be launched at all (e.g. `ENOENT` — not on PATH),
   * as opposed to the command running and exiting with a nonzero code. Node's `execFile`
   * surfaces both shapes through the same `error.code`, but a spawn failure's code is a string
   * ('ENOENT', 'EACCES', ...) while a nonzero-exit failure's code is the numeric exit status —
   * confirmed directly (`execFile('definitely-not-a-binary', ...)` yields `error.code === 'ENOENT'`
   * with empty stdout/stderr). Only the spawn-failure case means "not installed". */
  spawnError?: string;
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolveP) => {
    execFile(command, args, { timeout: 5000 }, (error, stdout, stderr) => {
      if (error && typeof error.code === 'string') {
        resolveP({ spawnError: error.code, code: null, stdout, stderr });
        return;
      }
      resolveP({ code: error ? ((error.code as number | undefined) ?? null) : 0, stdout, stderr });
    });
  });
}

async function checkBinaryVersion(name: string, versionArgs: string[]): Promise<CheckResult> {
  const result = await runCommand(name, versionArgs);
  if (result.spawnError) {
    return { label: name, status: 'fail', detail: `not found on PATH (${result.spawnError})` };
  }
  const firstLine = (result.stdout || result.stderr).split('\n')[0]?.trim();
  return {
    label: name,
    status: 'ok',
    detail: firstLine && firstLine.length > 0 ? firstLine : 'present',
  };
}

async function checkAdbDevices(): Promise<CheckResult> {
  const result = await runCommand('adb', ['devices', '-l']);
  if (result.spawnError) {
    return {
      label: 'adb devices',
      status: 'fail',
      detail: `could not list devices (${result.spawnError})`,
    };
  }
  const lines = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const deviceLines = lines.slice(1); // first line is "List of devices attached"
  if (deviceLines.length === 0) {
    return { label: 'adb devices', status: 'warn', detail: 'no devices or emulators attached' };
  }
  const serials = deviceLines.map((line) => line.split(/\s+/)[0] ?? '?');
  return {
    label: 'adb devices',
    status: 'ok',
    detail: `${deviceLines.length} attached: ${serials.join(', ')}`,
  };
}

/**
 * Like checkBinaryVersion, but reports a missing binary as `warn` rather than `fail`. Used for
 * anything temu can run entirely without: iOS Simulator support (xcrun/sim-use) on a machine
 * with only Android tooling, Android tooling (adb) on an iOS-only Mac, and tmux itself — temu
 * runs fine in a plain terminal (see CLAUDE.md), tmux is only needed for `temu split` and for
 * the `allow-passthrough` setting checked further down when temu happens to run inside one.
 */
async function checkOptionalBinaryVersion(
  name: string,
  versionArgs: string[],
): Promise<CheckResult> {
  const result = await checkBinaryVersion(name, versionArgs);
  return result.status === 'fail' ? { ...result, status: 'warn' } : result;
}

/**
 * `sim-use` is required for iOS Simulator targets (it's the only way to reach the private
 * SimulatorKit APIs both the bgra framebuffer capture and all input go through — see
 * src/device/ios/simuse.ts) — but is entirely unused for Android, so its absence is a `warn`,
 * not a `fail`.
 */
async function checkSimUse(): Promise<CheckResult> {
  const installed = await isSimUseAvailable();
  return {
    label: 'sim-use',
    status: installed ? 'ok' : 'warn',
    detail: installed
      ? 'present'
      : 'not found on PATH — required for iOS Simulator targets (Android is unaffected)',
  };
}

async function checkBootedSimulators(): Promise<CheckResult> {
  try {
    const sims = await listBootedSimulators();
    if (sims.length === 0) {
      return { label: 'booted iOS simulators', status: 'info', detail: 'none booted' };
    }
    return {
      label: 'booted iOS simulators',
      status: 'ok',
      detail: sims.map((sim) => `${sim.name} (${sim.udid})`).join(', '),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      label: 'booted iOS simulators',
      status: 'warn',
      detail: `could not list (${message})`,
    };
  }
}

function askYesNo(question: string, defaultYes: boolean): Promise<boolean> {
  return new Promise((resolveP) => {
    if (!process.stdin.isTTY) {
      resolveP(defaultYes);
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      if (normalized.length === 0) {
        resolveP(defaultYes);
        return;
      }
      resolveP(normalized === 'y' || normalized === 'yes');
    });
  });
}

async function runRenderTest(insideTmux: boolean): Promise<boolean> {
  console.log('\nRendering a test pattern via Kitty graphics...');
  const cols = 24;
  const rows = 12;
  const image = generateTestPattern(cols * 10, rows * 20);
  const png = encodePng(image);
  const renderer = new KittyRenderer({ cols, rows });
  try {
    await renderer.renderFramePng(png);
    console.log('A red / green / blue / near-white test pattern with a white border should now be');
    console.log('visible directly above this line.');
    const sawIt = await askYesNo('Did you see the test pattern correctly?', false);
    if (sawIt) {
      const survivalAction = insideTmux
        ? 'switching panes and back, then resizing this pane'
        : 'scrolling and back, then resizing this window';
      console.log(`  Now try ${survivalAction} — the image`);
      console.log('  should survive both. This is the real test of the placeholder approach.');
      const survived = await askYesNo('Did it survive that?', false);
      return survived;
    }
    return false;
  } finally {
    renderer.dispose();
  }
}

export interface DoctorOptions {
  fix: boolean;
  calibrate: boolean;
  renderTest: boolean;
}

export function parseDoctorArgs(argv: string[]): DoctorOptions {
  return {
    fix: argv.includes('--fix'),
    calibrate: argv.includes('--calibrate'),
    renderTest: !argv.includes('--no-render-test'),
  };
}

export async function runDoctor(argv: string[]): Promise<number> {
  const options = parseDoctorArgs(argv);
  console.log('temu doctor\n');

  let hadFailure = false;
  const record = (result: CheckResult): void => {
    printResult(result);
    if (result.status === 'fail') {
      hadFailure = true;
    }
  };

  // adb is required for Android targets but entirely unused for iOS-only setups (mirrors
  // checkSimUse's rationale below for the reverse case) — so its absence is a `warn`, and the
  // adb-devices check is skipped outright rather than reporting a misleading "no devices".
  const adb = await checkOptionalBinaryVersion('adb', ['version']);
  record(adb);
  if (adb.status === 'ok') {
    record(await checkAdbDevices());
  }
  record(await checkBinaryVersion('ffmpeg', ['-version'])); // required by every platform's pipeline
  record(await checkOptionalBinaryVersion('tmux', ['-V']));

  // iOS Simulator support only exists on macOS, and is optional even there — none of these
  // affect Android, so nothing here sets hadFailure.
  if (process.platform === 'darwin') {
    record(await checkOptionalBinaryVersion('xcrun', ['--version']));
    const simUse = await checkSimUse();
    record(simUse);
    if (simUse.status === 'ok') {
      record(await checkBootedSimulators());
    }
    console.log(
      '  · temu always runs sim-use with SIM_USE_NO_DAEMON=1 — measured on this dev machine, ' +
        'the sim-use background daemon adds a flat ~5s to every call, worse than the per-call ' +
        'cost it exists to amortise (a bare HID call: ~0.15s without it).',
    );
  } else {
    record({
      label: 'iOS Simulator support',
      status: 'info',
      detail: 'skipped — requires macOS',
    });
  }

  const insideTmux = isInsideTmux();
  record({
    label: 'tmux session',
    status: insideTmux ? 'ok' : 'info',
    detail: insideTmux
      ? 'running inside tmux'
      : 'not running inside tmux — temu runs fine here; passthrough wrapping is skipped entirely',
  });

  let passthrough: PassthroughState = 'unknown';
  if (insideTmux) {
    passthrough = await getTmuxAllowPassthrough();
    record({
      label: 'tmux allow-passthrough',
      status: passthrough === 'on' ? 'ok' : passthrough === 'off' ? 'warn' : 'info',
      detail: passthrough === 'unknown' ? 'could not determine' : passthrough,
    });

    if (passthrough === 'off') {
      if (options.fix) {
        const confirmed = await askYesNo(
          'Set tmux allow-passthrough on globally now (tmux set -g allow-passthrough on)?',
          false,
        );
        if (confirmed) {
          const ok = await setTmuxAllowPassthroughOn();
          record({
            label: 'tmux allow-passthrough --fix',
            status: ok ? 'ok' : 'fail',
            detail: ok ? 'set to on' : 'failed — run `tmux set -g allow-passthrough on` yourself',
          });
          if (ok) {
            passthrough = 'on';
          }
        } else {
          console.log(
            '  Skipped. Run `tmux set -g allow-passthrough on` yourself, or re-run with --fix.',
          );
        }
      } else {
        console.log('  Kitty graphics needs this on. Re-run `temu doctor --fix`, or run yourself:');
        console.log('    tmux set -g allow-passthrough on');
      }
    }
  }

  if (options.calibrate) {
    console.log(
      '\n--calibrate is not implemented yet — it lands with the evdev input backend (M2).',
    );
  }

  const caps = await detectCaps();
  record({
    label: 'terminal interactivity',
    status: caps.isInteractive ? 'ok' : 'warn',
    detail: caps.isInteractive
      ? 'stdin/stdout are a TTY'
      : 'not attached to a TTY — live capability queries and the render test are skipped',
  });
  record({
    label: 'cell pixel size',
    status: caps.cellSizeSource === 'default' ? 'warn' : 'ok',
    detail: `${caps.cellSize.width}x${caps.cellSize.height}px (source: ${caps.cellSizeSource})`,
  });
  record({
    label: 'kitty graphics support',
    status:
      caps.kittyGraphicsSupported === true
        ? 'ok'
        : caps.kittyGraphicsSupported === false
          ? 'fail'
          : 'warn',
    detail: `${String(caps.kittyGraphicsSupported)} (source: ${caps.kittyGraphicsSource})`,
  });

  const canRenderTest =
    options.renderTest &&
    caps.isInteractive &&
    caps.kittyGraphicsSupported !== false &&
    (!insideTmux || passthrough === 'on');

  if (canRenderTest) {
    const passed = await runRenderTest(insideTmux);
    record({
      label: 'render test',
      status: passed ? 'ok' : 'fail',
      detail: passed ? 'confirmed by user' : 'user reported it did not work',
    });
  } else if (options.renderTest) {
    const reason = !caps.isInteractive
      ? 'not attached to a TTY'
      : caps.kittyGraphicsSupported === false
        ? 'kitty graphics not supported'
        : 'tmux allow-passthrough is off';
    console.log(`\n(skipping live render test — ${reason})`);
  }

  console.log('');
  console.log(
    hadFailure ? 'temu doctor found problems above.' : 'temu doctor: all required checks passed.',
  );
  return hadFailure ? 1 : 0;
}
