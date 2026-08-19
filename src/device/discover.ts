// Finding an adb device to talk to, and reading its native screen resolution. Kept intentionally
// tiny — this is not a general adb wrapper, just what temu itself needs to get started.

import { execFile } from 'node:child_process';

export interface AdbDevice {
  serial: string;
  state: string;
}

function runAdb(args: string[]): Promise<string> {
  return new Promise((resolveRun, rejectRun) => {
    execFile('adb', args, { timeout: 5000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        rejectRun(new Error(error.message, { cause: error }));
        return;
      }
      resolveRun(stdout);
    });
  });
}

export async function listAdbDevices(): Promise<AdbDevice[]> {
  const output = await runAdb(['devices']);
  return output
    .split('\n')
    .slice(1) // first line is "List of devices attached"
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [serial, state] = line.split(/\s+/);
      return { serial: serial ?? '', state: state ?? 'unknown' };
    })
    .filter((device) => device.serial.length > 0);
}

/**
 * Resolves which device to attach to: the explicit `--device` value if given, otherwise the
 * sole attached device. Throws with an actionable message when that's ambiguous.
 */
export async function pickDefaultDevice(preferred?: string): Promise<string> {
  if (preferred) {
    return preferred;
  }
  const devices = (await listAdbDevices()).filter((device) => device.state === 'device');
  if (devices.length === 0) {
    throw new Error('no adb devices attached — check `adb devices`, or start an emulator');
  }
  if (devices.length > 1) {
    const serials = devices.map((device) => device.serial).join(', ');
    throw new Error(`multiple devices attached (${serials}) — pass --device <serial>`);
  }
  const [only] = devices;
  if (!only) {
    throw new Error('no adb devices attached');
  }
  return only.serial;
}

export interface DeviceGeometry {
  width: number;
  height: number;
}

export async function getDeviceGeometry(serial: string): Promise<DeviceGeometry> {
  const output = await runAdb(['-s', serial, 'shell', 'wm', 'size']);
  const lines = output.split('\n');
  // An "Override size" line (set via `wm size WxH`) reflects the actual rendered resolution and
  // takes precedence over "Physical size" when both are present.
  const override = lines.map((line) => /Override size:\s*(\d+)x(\d+)/.exec(line)).find(Boolean);
  const physical = lines.map((line) => /Physical size:\s*(\d+)x(\d+)/.exec(line)).find(Boolean);
  const match = override ?? physical;
  const widthStr = match?.[1];
  const heightStr = match?.[2];
  if (!widthStr || !heightStr) {
    throw new Error(`could not parse \`adb shell wm size\` output:\n${output}`);
  }
  return { width: Number(widthStr), height: Number(heightStr) };
}
