#!/usr/bin/env node

import { runDoctor } from './doctor.js';

function printUsage(): void {
  console.log('temu — display and drive an Android emulator inside a tmux pane');
  console.log('');
  console.log('Usage: temu <command>');
  console.log('');
  console.log('Commands:');
  console.log(
    '  doctor [--fix] [--calibrate]   Check environment: adb, ffmpeg, tmux, terminal graphics',
  );
  console.log('');
  console.log('(more commands land in later milestones)');
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;

  switch (command) {
    case 'doctor': {
      process.exitCode = await runDoctor(rest);
      break;
    }
    case undefined: {
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
