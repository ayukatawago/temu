// The iOS DeviceTarget: wires together this directory's pieces (discover/capture/input/hints)
// into the same shape src/device/android-target.ts implements for Android, so src/stream.ts
// never branches on platform.

import { BgraFramebufferSource } from './capture.js';
import { captureSimulatorScreenshot, getIosGeometry } from './discover.js';
import { getIosHintTargets } from './hints.js';
import { SimUseInputBackend } from './input.js';
import type { CaptureHandle, DeviceTarget, InputFeature } from '../target.js';
import type { HintTarget } from '../../input/hints.js';

export async function createIosTarget(udid: string): Promise<DeviceTarget> {
  const seedPng = await captureSimulatorScreenshot(udid);
  const geometry = await getIosGeometry(udid, seedPng);
  const { capturePx, pointSize } = geometry;

  return {
    platform: 'ios',
    id: udid,
    label: `${udid} (iOS, ${String(Math.round(pointSize.width))}x${String(Math.round(pointSize.height))}pt)`,
    capturePx,
    inputSize: pointSize,

    createCapture(_options): CaptureHandle {
      // `requestedPx`/`bitrate` are ignored: the bgra framebuffer stream is always native
      // resolution (see src/device/ios/capture.ts on why `--scale` is deliberately unused —
      // ffmpeg does all the size adaptation downstream instead), and it has no bitrate knob.
      const source = new BgraFramebufferSource({ udid });
      return {
        readable: source.bgra,
        format: {
          kind: 'rawvideo',
          pixelFormat: 'bgra',
          width: capturePx.width,
          height: capturePx.height,
        },
        onRestart: (listener) => {
          source.on('restart', listener);
        },
        onLog: (listener) => {
          source.on('stderr', listener);
        },
        stop: () => source.stop(),
      };
    },

    createInput(onLog) {
      return new SimUseInputBackend(udid, pointSize, onLog);
    },

    snapshotPng(): Promise<Buffer> {
      return captureSimulatorScreenshot(udid);
    },

    hintTargets(): Promise<HintTarget[]> {
      return getIosHintTargets(udid);
    },

    isDisplayOn(): Promise<boolean> {
      // Unlike a real Android device, a simulator's framebuffer never goes fully dark the way a
      // sleeping display does — a locked simulator still renders a lock screen — so there's no
      // "did the pipe die, or did the display just sleep?" ambiguity to resolve here (see
      // src/device/discover.ts's isDisplayOn for why that distinction matters on Android).
      return Promise.resolve(true);
    },

    supports(feature: InputFeature): boolean {
      switch (feature) {
        case 'home':
        case 'power':
        case 'back':
          return true;
        case 'recents':
        case 'volume':
        case 'liveDrag':
          return false;
      }
    },
  };
}
