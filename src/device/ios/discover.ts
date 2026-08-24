// Finding a booted iOS Simulator to talk to, and working out its geometry — the iOS counterpart
// of src/device/discover.ts. Kept just as narrow: not a general simctl/sim-use wrapper, only what
// temu itself needs to get started.

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSimUseAvailable, runSimUse } from './simuse.js';

export interface IosDeviceInfo {
  udid: string;
  name: string;
  runtime: string;
}

interface SimUseDeviceEntry {
  deviceId: string;
  name: string;
  platform: string;
  state: string;
  runtime: string;
}

/** Booted iOS Simulators only — `sim-use devices` already filters to "usable right now" by default. */
export async function listBootedSimulators(): Promise<IosDeviceInfo[]> {
  const data = await runSimUse<{ devices: SimUseDeviceEntry[] }>(['devices', '--platform', 'ios']);
  return data.devices
    .filter((device) => device.platform === 'ios')
    .map((device) => ({ udid: device.deviceId, name: device.name, runtime: device.runtime }));
}

export { isSimUseAvailable };

/**
 * Resolves which booted simulator to attach to when no `--device` was given: the sole one, or an
 * actionable error — the iOS counterpart of src/device/discover.ts's `pickDefaultDevice`. Checks
 * `sim-use` is even installed first, so "no booted simulator" and "iOS support isn't installed
 * on this machine" produce two different, individually actionable messages instead of one
 * confusing failure from deeper inside sim-use's own error path.
 */
export async function pickDefaultSimulatorUdid(): Promise<string> {
  if (!(await isSimUseAvailable())) {
    throw new Error(
      'sim-use is required for iOS Simulator targets and was not found on PATH — install it, ' +
        'then re-run `temu doctor`',
    );
  }
  const devices = await listBootedSimulators();
  if (devices.length === 0) {
    throw new Error(
      'no booted iOS Simulator found — boot one from Xcode, or `xcrun simctl boot <udid>`',
    );
  }
  if (devices.length > 1) {
    const names = devices.map((device) => `${device.name} (${device.udid})`).join(', ');
    throw new Error(`multiple booted simulators (${names}) — pass --device <udid>`);
  }
  const [only] = devices;
  if (!only) {
    throw new Error('no booted iOS Simulator found');
  }
  return only.udid;
}

/**
 * Takes a screenshot via sim-use (writes a temp PNG file and reads it back — sim-use has no
 * `--output -`/stdout mode, and `xcrun simctl io screenshot --type=png -` was verified broken on
 * Xcode 26.6: it writes a file literally named `-` instead of writing to stdout). Used both to
 * seed geometry (see {@link getIosGeometry}) and as this platform's `DeviceTarget.snapshotPng`.
 */
export async function captureSimulatorScreenshot(udid: string): Promise<Buffer> {
  const path = join(tmpdir(), `temu-ios-screenshot-${randomUUID()}.png`);
  try {
    await runSimUse(['screenshot', '--device', udid, '--output', path]);
    return await readFile(path);
  } finally {
    await unlink(path).catch(() => undefined);
  }
}

/**
 * Reads just the IHDR chunk's width/height, without inflating IDAT — a screenshot PNG can be a
 * few MB, and all that's needed here is the 8 header bytes. IHDR is always the PNG's first chunk
 * (8-byte signature, 4-byte length, 4-byte type, then width/height as the first two 4-byte
 * big-endian fields of its data — see src/render/png.ts's encoder for the same layout written
 * the other way).
 */
function readPngPixelSize(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || png.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('not a recognizable PNG (missing IHDR as the first chunk)');
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function runXcrun(args: string[]): Promise<string> {
  return new Promise((resolveRun, rejectRun) => {
    execFile('xcrun', args, { timeout: 8000, maxBuffer: 20 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        rejectRun(new Error(error.message, { cause: error }));
        return;
      }
      resolveRun(stdout);
    });
  });
}

interface SimctlDeviceEntry {
  udid: string;
  deviceTypeIdentifier?: string;
}
interface SimctlDeviceType {
  identifier: string;
  bundlePath: string;
}

/**
 * `mainScreenScale` (the pt->px ratio: 3 for this project's iPhone 17 test simulator) lives in
 * the device type's own profile plist, not in anything `simctl`/`sim-use` prints directly.
 * Resolved via two `simctl list --json` calls (udid -> deviceTypeIdentifier -> bundlePath) plus
 * one `plutil -convert json` on the plist inside that bundle. Returns `null` on any failure —
 * callers fall back to asking `sim-use ui` for the point size directly instead.
 */
async function getMainScreenScale(udid: string): Promise<number | null> {
  try {
    const devicesJson = await runXcrun(['simctl', 'list', 'devices', '--json']);
    const parsedDevices = JSON.parse(devicesJson) as {
      devices: Record<string, SimctlDeviceEntry[]>;
    };
    let identifier: string | undefined;
    for (const entries of Object.values(parsedDevices.devices)) {
      const match = entries.find((entry) => entry.udid === udid);
      if (match?.deviceTypeIdentifier) {
        identifier = match.deviceTypeIdentifier;
        break;
      }
    }
    if (!identifier) {
      return null;
    }

    const typesJson = await runXcrun(['simctl', 'list', 'devicetypes', '--json']);
    const parsedTypes = JSON.parse(typesJson) as { devicetypes: SimctlDeviceType[] };
    const deviceType = parsedTypes.devicetypes.find((type) => type.identifier === identifier);
    if (!deviceType) {
      return null;
    }

    const plistPath = join(deviceType.bundlePath, 'Contents', 'Resources', 'profile.plist');
    const plistJson = await new Promise<string>((resolveRun, rejectRun) => {
      execFile(
        'plutil',
        ['-convert', 'json', '-o', '-', plistPath],
        { timeout: 5000, maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          if (error) {
            rejectRun(new Error(error.message, { cause: error }));
            return;
          }
          resolveRun(stdout);
        },
      );
    });
    const profile = JSON.parse(plistJson) as Record<string, unknown>;
    const scale = profile['mainScreenScale'];
    return typeof scale === 'number' && scale > 0 ? scale : null;
  } catch {
    return null;
  }
}

export interface IosGeometry {
  /** Native framebuffer pixels — what the `bgra` capture stream and ffmpeg sizing work in. */
  capturePx: { width: number; height: number };
  /** UIKit points — what `sim-use tap`/`swipe`/`ui` coordinates are expressed in. */
  pointSize: { width: number; height: number };
}

/**
 * `capturePx` comes from decoding the seed screenshot's own IHDR, so it's authoritative for
 * whatever the framebuffer's actual current size is (rather than trusting a device profile that
 * could be stale after e.g. a runtime change). `pointSize` prefers dividing by the profile's
 * `mainScreenScale`; if that lookup fails for any reason, falls back to asking `sim-use ui`
 * directly for `data.screen`, and if even that fails, assumes scale 1 (wrong on any Retina
 * simulator, but keeps hint-mode/tap coordinates in some sane space rather than throwing).
 */
export async function getIosGeometry(udid: string, seedPng: Buffer): Promise<IosGeometry> {
  const capturePx = readPngPixelSize(seedPng);
  const scale = await getMainScreenScale(udid);
  if (scale !== null) {
    return {
      capturePx,
      pointSize: { width: capturePx.width / scale, height: capturePx.height / scale },
    };
  }
  try {
    const data = await runSimUse<{ screen: { width: number; height: number } }>([
      'ui',
      '--device',
      udid,
      '--no-raw',
    ]);
    return { capturePx, pointSize: data.screen };
  } catch {
    return { capturePx, pointSize: capturePx };
  }
}
