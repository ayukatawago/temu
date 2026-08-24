// Drives Android's `input` command through one persistent `adb shell` session, instead of
// spawning a fresh `adb shell input ...` process per call.
//
// This is not what the original design called for. The plan was raw evdev injection (writing
// input_event structs straight into /dev/input/eventN), since `shell` is in the `input` group
// and the device nodes are group-writable. That turns out not to matter: SELinux denies it
// outright on this device in enforcing mode —
//
//   avc: denied { write } for name="event11" ... scontext=u:r:shell:s0
//        tcontext=u:object_r:input_device:s0 tclass=chr_file permissive=0
//
// — which is standard AOSP policy, not an emulator quirk, and there's no way around it without
// root. The "~250-600ms per tap" that made a naive per-call `adb shell input tap` seem too slow
// for smooth use turned out to be host-side adb transport/process-spawn overhead, not the
// on-device command itself: `input tap` alone measures ~10-20ms on-device. A persistent shell
// session pays that transport cost once and amortizes it, measured at ~21ms/call end to end.
//
// The other piece this depends on: `input touchscreen motionevent DOWN/MOVE/UP` (undocumented
// in `input`'s own --help, but present and working) accepts a live sequence of intermediate
// positions, not just an atomic tap or a single canned swipe — verified by diffing screenshots
// before/after a multi-step DOWN/MOVE.../UP sequence and confirming the screen actually
// scrolled. That's what gives live dragging real velocity instead of a canned gesture.

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { InputBackend } from './backend.js';

type ShellChild = ChildProcessByStdio<Writable, Readable, Readable>;

const RESPAWN_BACKOFF_MS = 200;

export class AdbShellInputBackend implements InputBackend {
  private child: ShellChild | null = null;
  private stopped = false;
  private restartCount = 0;
  private readonly onLog: (message: string) => void;

  constructor(
    private readonly serial: string,
    onLog?: (message: string) => void,
  ) {
    this.onLog = onLog ?? ((): void => undefined);
    this.spawnChild();
  }

  private spawnChild(): void {
    if (this.stopped) {
      return;
    }
    const child = spawn('adb', ['-s', this.serial, 'shell'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    // We don't read command output back — `input` produces none on success, and reading it
    // would just be one more thing to keep draining.
    child.stdout.on('data', () => undefined);
    child.stderr.on('data', (chunk: Buffer) => {
      this.onLog(`adb shell: ${chunk.toString('utf8').trim()}`);
    });
    child.stdin.on('error', () => undefined); // surfaced via 'exit' below instead
    child.on('exit', () => {
      this.child = null;
      if (this.stopped) {
        return;
      }
      this.restartCount++;
      this.onLog(`input shell restarted (attempt ${this.restartCount})`);
      setTimeout(() => this.spawnChild(), RESPAWN_BACKOFF_MS);
    });
  }

  private send(command: string): void {
    // Dropped silently when no shell is attached: a respawn is already in flight, and queuing
    // stale commands behind it would just replay old input out of order once it's back.
    this.child?.stdin.write(command + '\n');
  }

  tap(x: number, y: number): void {
    this.send(`input tap ${String(Math.round(x))} ${String(Math.round(y))}`);
  }

  touchDown(x: number, y: number): void {
    this.send(
      `input touchscreen motionevent DOWN ${String(Math.round(x))} ${String(Math.round(y))}`,
    );
  }

  touchMove(x: number, y: number): void {
    this.send(
      `input touchscreen motionevent MOVE ${String(Math.round(x))} ${String(Math.round(y))}`,
    );
  }

  touchUp(x: number, y: number): void {
    this.send(`input touchscreen motionevent UP ${String(Math.round(x))} ${String(Math.round(y))}`);
  }

  swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): void {
    const [rx1, ry1, rx2, ry2, rd] = [x1, y1, x2, y2, durationMs].map((n) => String(Math.round(n)));
    this.send(`input swipe ${rx1} ${ry1} ${rx2} ${ry2} ${rd}`);
  }

  private keyevent(code: string): void {
    this.send(`input keyevent ${code}`);
  }

  back(): void {
    this.keyevent('KEYCODE_BACK');
  }

  home(): void {
    this.keyevent('KEYCODE_HOME');
  }

  recents(): void {
    this.keyevent('KEYCODE_APP_SWITCH');
  }

  power(): void {
    this.keyevent('KEYCODE_POWER');
  }

  volumeUp(): void {
    this.keyevent('KEYCODE_VOLUME_UP');
  }

  volumeDown(): void {
    this.keyevent('KEYCODE_VOLUME_DOWN');
  }

  enter(): void {
    this.keyevent('KEYCODE_ENTER');
  }

  backspace(): void {
    this.keyevent('KEYCODE_DEL');
  }

  text(value: string): void {
    // This string crosses two shells: the local one spawning `adb shell`, handled by us passing
    // an argv array (no local quoting concerns), and the remote one adb runs the joined command
    // line through on the device — which does need real quoting, since it sees plain text.
    // Verified against this device: a double-quoted string with literal spaces survives intact.
    const escaped = value.replaceAll(/(["\\$`])/g, '\\$1');
    this.send(`input text "${escaped}"`);
  }

  dispose(): void {
    this.stopped = true;
    this.child?.stdin.end();
    this.child?.kill();
    this.child = null;
  }
}
