#!/usr/bin/env node

import { runDoctor } from './doctor.js';
import { runStream } from './stream.js';
import { runTmuxLayout } from './tmuxlayout.js';

function printUsage(): void {
  console.log('temu — display and drive an Android emulator inside a tmux pane');
  console.log('');
  console.log('Usage: temu [--device <serial>] [--bitrate <rate>]');
  console.log('       temu doctor [--fix] [--calibrate]');
  console.log('       temu tmux [--device <serial>] [--percent <n>]');
  console.log('');
  console.log('Commands:');
  console.log('  (none)  Attach to a device and stream its screen into this pane');
  console.log('  doctor  Check environment: adb, ffmpeg, tmux, terminal graphics');
  console.log('  tmux    Split the current tmux window and run temu in the new pane');
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;

  switch (command) {
    case 'doctor': {
      process.exitCode = await runDoctor(rest);
      break;
    }
    case 'tmux': {
      process.exitCode = await runTmuxLayout(rest);
      break;
    }
    case undefined: {
      process.exitCode = await runStream([]);
      break;
    }
    case '--device':
    case '--bitrate': {
      process.exitCode = await runStream(process.argv.slice(2));
      break;
    }
    case '--help':
    case '-h': {
      printUsage();
      break;
    }
    default: {
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
