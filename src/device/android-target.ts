// The Android DeviceTarget: a thin adapter over pieces that already existed before this
// abstraction did (ScreenrecordSource, captureScreencapPng, getDeviceGeometry, isDisplayOn,
// AdbShellInputBackend, dumpUiHierarchy/parseHintTargets) — none of their own logic changes here.

import { captureScreencapPng, ScreenrecordSource } from './capture.js';
import { getDeviceGeometry, isDisplayOn } from './discover.js';
import type { CaptureHandle, DeviceTarget, InputFeature } from './target.js';
import { AdbShellInputBackend } from '../input/adbshell.js';
import { dumpUiHierarchy, parseHintTargets, type HintTarget } from '../input/hints.js';

export async function createAndroidTarget(serial: string): Promise<DeviceTarget> {
  const geometry = await getDeviceGeometry(serial);
  const size = { width: geometry.width, height: geometry.height };

  return {
    platform: 'android',
    id: serial,
    label: `${serial} (${String(size.width)}x${String(size.height)})`,
    capturePx: size,
    // Android's `input` coordinates are already in the display's native pixel space — no
    // separate point/pixel scale to account for, unlike iOS (src/device/ios/target.ts).
    inputSize: size,

    createCapture({ requestedPx, bitrate }): CaptureHandle {
      const source = new ScreenrecordSource({
        serial,
        width: requestedPx.width,
        height: requestedPx.height,
        bitrate,
      });
      return {
        readable: source.h264,
        format: { kind: 'h264' },
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
      return new AdbShellInputBackend(serial, onLog);
    },

    snapshotPng(): Promise<Buffer> {
      return captureScreencapPng(serial);
    },

    async hintTargets(): Promise<HintTarget[]> {
      const xml = await dumpUiHierarchy(serial);
      return parseHintTargets(xml);
    },

    isDisplayOn(): Promise<boolean> {
      return isDisplayOn(serial);
    },

    supports(_feature: InputFeature): boolean {
      // Every InputFeature has a real Android primitive (KEYCODE_BACK/HOME/APP_SWITCH/POWER,
      // KEYCODE_VOLUME_UP/DOWN, and genuine tracked DOWN/MOVE/UP dragging).
      return true;
    },
  };
}
