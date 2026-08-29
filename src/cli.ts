#!/usr/bin/env node

import { runDoctor } from './doctor.js';
import { runSplit } from './split.js';
import { runStream } from './stream.js';

function printUsage(): void {
  console.log('temu — display and drive an Android emulator or iOS Simulator in your terminal');
  console.log('(tmux optional — only needed for `temu split`)');
  console.log('');
  console.log('Usage: temu [--device <serial|udid>] [--platform ios|android] [--bitrate <rate>]');
  console.log('            [--renderer kitty|blocks]');
  console.log('       temu doctor [--fix] [--calibrate]');
  console.log(
    '       temu split [--device <serial|udid>] [--platform ios|android] [--percent <n>]',
  );
  console.log('');
  console.log('Commands:');
  console.log('  (none)  Attach to a device/simulator and stream its screen into this pane');
  console.log(
    '  doctor  Check environment: adb, ffmpeg, terminal graphics, tmux/sim-use (optional)',
  );
  console.log('  split   tmux only: split the current window and run temu in the new pane');
  console.log('          (alias: tmux)');
  console.log('');
  console.log('--device without --platform auto-detects: a UUID-shaped value is treated as an iOS');
  console.log(
    'Simulator UDID, anything else as an adb serial. With neither flag, temu attaches to the',
  );
  console.log('sole available device/simulator across both platforms.');
  console.log('');
  console.log(
    '--renderer manually picks which renderer to use instead of the automatic choice: `kitty`',
  );
  console.log(
    'shows real pixels via the Kitty graphics protocol (the default when supported); `blocks` is',
  );
  console.log(
    'the lower-quality plain-text fallback. Only useful for troubleshooting — try `blocks` if',
  );
  console.log('video ever looks wrong, or `kitty` to force it despite a negative autodetection.');
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;

  switch (command) {
    case 'doctor': {
      process.exitCode = await runDoctor(rest);
      break;
    }
    case 'split':
    case 'tmux': {
      process.exitCode = await runSplit(rest);
      break;
    }
    case undefined: {
      process.exitCode = await runStream([]);
      break;
    }
    case '--help':
    case '-h': {
      printUsage();
      break;
    }
    default: {
      // Any other leading token is assumed to be a flag for the default streaming command
      // (`--device`, `--platform`, `--bitrate`, ...) rather than an unrecognized subcommand —
      // runStream's own arg parser (src/stream.ts's parseStreamArgs) is the single source of
      // truth for which flags are actually valid; unknown ones are silently ignored there, same
      // as before this dispatch was widened past a fixed `--device`/`--bitrate` allowlist.
      if (command.startsWith('--')) {
        process.exitCode = await runStream(process.argv.slice(2));
        break;
      }
      printUsage();
      process.exitCode = 1;
      break;
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
