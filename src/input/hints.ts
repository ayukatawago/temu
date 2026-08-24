// Hint mode (`f`): the actual answer to "cells are too coarse to click precisely." Dumps the
// live accessibility tree, finds every clickable element's exact bounds, and overlays a short
// letter label on each — press the label to tap that element's center in real device pixels,
// sidestepping the cell grid (and its ~tens-of-device-pixels-per-cell resolution) entirely.

import { spawn } from 'node:child_process';
import type { GridOrigin } from '../render/geometry.js';
import { devicePixelToCell, type FitResult } from '../render/geometry.js';

export interface DeviceBounds {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface HintTarget {
  label: string;
  bounds: DeviceBounds;
  text: string;
  resourceId: string;
  contentDesc: string;
}

/** `adb exec-out uiautomator dump /dev/tty` streams the XML straight back rather than writing
 * it to a device-side file and needing a separate `adb pull` — `/dev/tty` here is the exec-out
 * shell's own stdout pipe back to us. Verified against a live device: ~2s (uiautomator walking
 * the real accessibility tree is what dominates, not the transport), and the tool appends its
 * own "UI hierchary dumped to: ..." confirmation line straight after `</hierarchy>` with no
 * separator — harmless for the tag-scanning parser below, which simply stops matching there. */
export function dumpUiHierarchy(serial: string): Promise<string> {
  return new Promise((resolveDump, rejectDump) => {
    const child = spawn('adb', ['-s', serial, 'exec-out', 'uiautomator', 'dump', '/dev/tty'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', rejectDump);
    child.on('exit', (code) => {
      if (code !== 0) {
        rejectDump(new Error(`uiautomator dump exited with code ${String(code)}`));
        return;
      }
      resolveDump(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

const NODE_TAG_PATTERN = /<node\b([^>]*)\/?>/g;
const ATTR_PATTERN = /([\w-]+)="([^"]*)"/g;
const BOUNDS_PATTERN = /\[(\d+),(\d+)]\[(\d+),(\d+)]/;

function parseAttrs(tagBody: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR_PATTERN.exec(tagBody))) {
    const name = match[1];
    const value = match[2];
    if (name !== undefined && value !== undefined) {
      attrs[name] = value;
    }
  }
  return attrs;
}

function parseBounds(boundsStr: string): DeviceBounds | null {
  const match = BOUNDS_PATTERN.exec(boundsStr);
  if (!match) return null;
  const [x1, y1, x2, y2] = [match[1], match[2], match[3], match[4]].map(Number);
  if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) return null;
  return { x1, y1, x2, y2 };
}

/**
 * Single letters (a-z) if that's enough, otherwise *all* two-letter combinations (aa-zz, up to
 * 676). Deliberately never mixes the two lengths: if it did, a single-letter label like "a" would
 * be an unresolvable prefix of a two-letter one like "ab", since hint selection resolves as soon
 * as the typed buffer exactly matches a label. Keeping every label in one run the same length
 * makes that ambiguity structurally impossible.
 *
 * Exported so src/device/ios/hints.ts (sim-use's accessibility tree, rather than uiautomator's)
 * can assign labels the exact same way instead of re-implementing this.
 */
export function generateLabels(count: number): string[] {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  if (count <= alphabet.length) {
    return alphabet.slice(0, count).split('');
  }
  const labels: string[] = [];
  for (let i = 0; i < count; i++) {
    const first = alphabet[Math.floor(i / alphabet.length) % alphabet.length] as string;
    const second = alphabet[i % alphabet.length] as string;
    labels.push(first + second);
  }
  return labels;
}

/**
 * Parses every clickable, enabled, non-degenerate element out of a uiautomator XML dump and
 * assigns each a short label. Identical bounds (nested wrapper views reporting the same
 * rectangle as their clickable child — common in this dump format) are deduplicated to one
 * target, keeping the first occurrence.
 */
export function parseHintTargets(xml: string): HintTarget[] {
  const seenBounds = new Set<string>();
  const targets: Omit<HintTarget, 'label'>[] = [];

  NODE_TAG_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NODE_TAG_PATTERN.exec(xml))) {
    const tagBody = match[1];
    if (tagBody === undefined) continue;
    const attrs = parseAttrs(tagBody);
    if (attrs['clickable'] !== 'true' || attrs['enabled'] === 'false') continue;
    const boundsStr = attrs['bounds'];
    if (!boundsStr || seenBounds.has(boundsStr)) continue;
    const bounds = parseBounds(boundsStr);
    if (!bounds || bounds.x2 <= bounds.x1 || bounds.y2 <= bounds.y1) continue;
    seenBounds.add(boundsStr);
    targets.push({
      bounds,
      text: attrs['text'] ?? '',
      resourceId: attrs['resource-id'] ?? '',
      contentDesc: attrs['content-desc'] ?? '',
    });
  }

  const labels = generateLabels(targets.length);
  return targets.map((target, i) => ({ ...target, label: labels[i] as string }));
}

const HINT_FG = 30; // black
const HINT_BG = 43; // yellow

/** Overlays each target's label at its bounds' center, converted to the nearest terminal cell. */
export function renderHintOverlay(
  targets: readonly HintTarget[],
  origin: GridOrigin,
  fit: Pick<FitResult, 'cols' | 'rows'>,
  deviceWidthPx: number,
  deviceHeightPx: number,
): void {
  let out = '\x1b7'; // save cursor
  for (const target of targets) {
    const cx = (target.bounds.x1 + target.bounds.x2) / 2;
    const cy = (target.bounds.y1 + target.bounds.y2) / 2;
    const { col, row } = devicePixelToCell(cx, cy, origin, fit, deviceWidthPx, deviceHeightPx);
    out += `\x1b[${String(row)};${String(col)}H\x1b[${String(HINT_FG)};${String(HINT_BG)}m${target.label}\x1b[0m`;
  }
  out += '\x1b8'; // restore cursor
  process.stdout.write(out);
}
