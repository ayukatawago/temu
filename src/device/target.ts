// The platform-agnostic device abstraction stream.ts drives. Everything Android-specific lives
// behind src/device/android-target.ts, everything iOS-specific behind src/device/ios/*` — this
// file only defines the shared shape and `resolveTarget`, which decides which one to build.

import type { Readable } from 'node:stream';
import { createAndroidTarget } from './android-target.js';
import { listAdbDevices, pickDefaultDevice } from './discover.js';
import { createIosTarget } from './ios/target.js';
import { listBootedSimulators, pickDefaultSimulatorUdid } from './ios/discover.js';
import type { InputBackend } from '../input/backend.js';
import type { HintTarget } from '../input/hints.js';

export type Platform = 'android' | 'ios';

export interface PixelSize {
  width: number;
  height: number;
}

/**
 * What ffmpeg needs to know about the raw stream `createCapture` hands it. `h264` carries no
 * dimensions of its own (ffmpeg reads them out of the SPS NAL, same as today); `rawvideo` has no
 * container at all, so ffmpeg has to be told the frame size up front via `-video_size`.
 */
export type FrameSourceDescriptor =
  { kind: 'h264' } | { kind: 'rawvideo'; pixelFormat: 'bgra'; width: number; height: number };

/**
 * What `DeviceTarget.createCapture` hands back to `Pipeline` (src/stream.ts) — deliberately not
 * "just an EventEmitter", so Pipeline never needs to know which concrete source class (
 * ScreenrecordSource, BgraFramebufferSource) it's holding.
 */
export interface CaptureHandle {
  readonly readable: Readable;
  readonly format: FrameSourceDescriptor;
  onRestart(listener: (event: { code: number | null; count: number }) => void): void;
  onLog(listener: (message: string) => void): void;
  stop(): void;
}

/**
 * Input capabilities that don't exist on every platform, so callers (stream.ts) can show an
 * honest "not available" toast instead of silently sending a command with no effect. `liveDrag`
 * is false on iOS: dragging still works, just as one coalesced swipe on release rather than
 * tracked motion (see src/device/ios/input.ts) — reported so stream.ts's UI can be honest about
 * that difference if it ever matters to a caller, even though today nothing branches on it.
 */
export type InputFeature = 'back' | 'home' | 'recents' | 'power' | 'volume' | 'liveDrag';

export interface DeviceTarget {
  readonly platform: Platform;
  /** adb serial or simulator UDID. */
  readonly id: string;
  /** Human-readable banner/status-bar text. */
  readonly label: string;
  /** Native framebuffer pixels — what capture/ffmpeg/rendering size against. */
  readonly capturePx: PixelSize;
  /** Input coordinate space — equals `capturePx` on Android; UIKit points on iOS. */
  readonly inputSize: PixelSize;
  createCapture(options: { requestedPx: PixelSize; bitrate: string }): CaptureHandle;
  createInput(onLog?: (message: string) => void): InputBackend;
  snapshotPng(): Promise<Buffer>;
  hintTargets(): Promise<HintTarget[]>;
  isDisplayOn(): Promise<boolean>;
  supports(feature: InputFeature): boolean;
}

interface Candidate {
  platform: Platform;
  id: string;
  label: string;
}

// Canonical UUID shape (8-4-4-4-12 hex), the form every `xcrun simctl`/`sim-use` UDID takes —
// used to tell an explicit `--device` value apart from an adb serial (which is never dash-
// delimited hex in this exact shape) without asking the user to also pass `--platform`.
const IOS_UDID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function scanAndroidCandidates(): Promise<Candidate[]> {
  try {
    const devices = await listAdbDevices();
    return devices
      .filter((device) => device.state === 'device')
      .map((device) => ({ platform: 'android' as const, id: device.serial, label: device.serial }));
  } catch {
    // adb missing or erroring shouldn't block an iOS-only machine from working — same "fail
    // soft" reasoning as the iOS scan below.
    return [];
  }
}

async function scanIosCandidates(): Promise<Candidate[]> {
  try {
    const devices = await listBootedSimulators();
    return devices.map((device) => ({
      platform: 'ios' as const,
      id: device.udid,
      label: `${device.name} (${device.udid})`,
    }));
  } catch {
    // sim-use not installed, not on PATH, or this isn't macOS — none of that should block
    // Android-only machines from working exactly as they did before this feature existed.
    return [];
  }
}

/**
 * Resolves which device to attach to, across both platforms:
 *
 * - `device` + `platform` both given: use them as-is, no detection.
 * - `device` given, no `platform`: shape-detect (UUID -> iOS, else -> Android adb serial).
 * - no `device`, `platform` given: the sole target on that platform, or an actionable error.
 * - neither given: scan both platforms; attach if exactly one candidate exists anywhere,
 *   otherwise throw listing every candidate found (mirrors src/device/discover.ts's
 *   `pickDefaultDevice`, widened across platforms).
 */
export async function resolveTarget(device?: string, platform?: Platform): Promise<DeviceTarget> {
  return createTarget(await resolveDeviceRef(device, platform));
}

export interface DeviceRef {
  platform: Platform;
  id: string;
}

function createTarget(ref: DeviceRef): Promise<DeviceTarget> {
  return ref.platform === 'ios' ? createIosTarget(ref.id) : createAndroidTarget(ref.id);
}

/**
 * The device-choosing half of `resolveTarget`, without building the full `DeviceTarget` — log
 * mode only needs to know which device on which platform, and building an iOS target would also
 * look up framebuffer geometry through the helper for no reason.
 */
export async function resolveDeviceRef(device?: string, platform?: Platform): Promise<DeviceRef> {
  if (device && platform) {
    return { platform, id: device };
  }

  if (device) {
    return { platform: IOS_UDID_PATTERN.test(device) ? 'ios' : 'android', id: device };
  }

  if (platform === 'android') {
    return { platform, id: await pickDefaultDevice() };
  }

  if (platform === 'ios') {
    return { platform, id: await pickDefaultSimulatorUdid() };
  }

  const [androidCandidates, iosCandidates] = await Promise.all([
    scanAndroidCandidates(),
    scanIosCandidates(),
  ]);
  const all = [...androidCandidates, ...iosCandidates];
  if (all.length === 0) {
    throw new Error(
      'no adb devices attached and no booted iOS Simulator found — check `adb devices`, ' +
        'start an emulator, or boot a simulator',
    );
  }
  if (all.length > 1) {
    const list = all.map((c) => `${c.label} [${c.platform}]`).join(', ');
    throw new Error(
      `multiple targets available (${list}) — pass --device <id> or --platform ios|android`,
    );
  }
  const [only] = all;
  // `all.length === 1` was just checked above, so this is unreachable, but noUncheckedIndexedAccess
  // still types `only` as possibly undefined.
  if (!only) {
    throw new Error('no target resolved');
  }
  return { platform: only.platform, id: only.id };
}
