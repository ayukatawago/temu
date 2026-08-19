// `temu doctor`: checks that the tools and terminal capabilities temu depends on are actually
// present and working, since almost every failure mode here is silent otherwise (a missing
// `allow-passthrough` setting doesn't error, it just makes images never appear).

import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
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

function runCommand(
  command: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveP) => {
    execFile(command, args, { timeout: 5000 }, (error, stdout, stderr) => {
      resolveP({ code: error ? (error.code as number | null) : 0, stdout, stderr });
    });
  });
}

async function checkBinaryVersion(name: string, versionArgs: string[]): Promise<CheckResult> {
  try {
    const { stdout, stderr } = await runCommand(name, versionArgs);
    const firstLine = (stdout || stderr).split('\n')[0]?.trim();
    return {
      label: name,
      status: 'ok',
      detail: firstLine && firstLine.length > 0 ? firstLine : 'present',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { label: name, status: 'fail', detail: `not found on PATH (${message})` };
  }
}

async function checkAdbDevices(): Promise<CheckResult> {
  try {
    const { stdout } = await runCommand('adb', ['devices', '-l']);
    const lines = stdout
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { label: 'adb devices', status: 'fail', detail: `could not list devices (${message})` };
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

async function runRenderTest(): Promise<boolean> {
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
      console.log('  Now try switching panes and back, then resizing this pane — the image');
      console.log('  should survive both. This is the real test of the placeholder approach.');
      const survived = await askYesNo('Did it survive pane-switch and resize?', false);
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

  record(await checkBinaryVersion('adb', ['version']));
  record(await checkAdbDevices());
  record(await checkBinaryVersion('ffmpeg', ['-version']));
  record(await checkBinaryVersion('tmux', ['-V']));

  const insideTmux = isInsideTmux();
  record({
    label: 'tmux session',
    status: insideTmux ? 'ok' : 'info',
    detail: insideTmux
      ? 'running inside tmux'
      : 'not running inside tmux — passthrough wrapping is skipped entirely',
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
    const passed = await runRenderTest();
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
