#!/usr/bin/env node

function main(): void {
  const [, , command] = process.argv;

  switch (command) {
    default:
      console.log('temu — display and drive an Android emulator inside a tmux pane');
      console.log('(scaffold only — commands land in later milestones)');
      break;
  }
}

main();
