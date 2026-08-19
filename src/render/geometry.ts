// Maps a device's native pixel resolution onto a terminal pane's cell grid, preserving aspect
// ratio, and picks a matching capture resolution for screenrecord so the device encodes only
// what we can actually display instead of full resolution that then gets downscaled.

import type { CellPixelSize } from './caps.js';

export interface FitResult {
  cols: number;
  rows: number;
  capturePx: { width: number; height: number };
}

function roundToMultiple(value: number, multiple: number): number {
  return Math.max(multiple, Math.round(value / multiple) * multiple);
}

/**
 * Given the pane's available size in cells, the device's native pixel resolution, and the
 * physical pixel size of one cell, computes the largest cols x rows grid that fits within the
 * available cells while preserving the device's aspect ratio (cells are rarely square, so this
 * accounts for the cell's own aspect ratio too), plus a capture pixel size rounded to a multiple
 * of 16 (a common encoder macroblock size) for screenrecord to target directly.
 */
export function fitDeviceToCells(
  availableCols: number,
  availableRows: number,
  deviceWidthPx: number,
  deviceHeightPx: number,
  cellSize: CellPixelSize,
): FitResult {
  const deviceAspect = deviceWidthPx / deviceHeightPx;
  const maxWidthPx = availableCols * cellSize.width;
  const maxHeightPx = availableRows * cellSize.height;
  const maxAspect = maxWidthPx / maxHeightPx;

  let widthPx: number;
  let heightPx: number;
  if (deviceAspect > maxAspect) {
    // Wider than the available box allows at full height — constrained by width.
    widthPx = maxWidthPx;
    heightPx = widthPx / deviceAspect;
  } else {
    heightPx = maxHeightPx;
    widthPx = heightPx * deviceAspect;
  }

  const cols = Math.max(1, Math.floor(widthPx / cellSize.width));
  const rows = Math.max(1, Math.floor(heightPx / cellSize.height));

  const captureWidth = Math.min(deviceWidthPx, roundToMultiple(cols * cellSize.width, 16));
  const captureHeight = Math.min(deviceHeightPx, roundToMultiple(rows * cellSize.height, 16));

  return { cols, rows, capturePx: { width: captureWidth, height: captureHeight } };
}
