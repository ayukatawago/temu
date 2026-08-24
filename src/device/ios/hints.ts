// Hint mode's iOS data source: `sim-use ui`'s accessibility outline, mapped onto the same
// HintTarget shape src/input/hints.ts already defines for Android's uiautomator dump — so
// stream.ts, generateLabels, and renderHintOverlay stay platform-agnostic.

import { generateLabels, type DeviceBounds, type HintTarget } from '../../input/hints.js';
import { runSimUse } from './simuse.js';

interface SimUseUiEntry {
  frame: { x: number; y: number; width: number; height: number };
  label?: string;
  role: string;
  states?: string[];
  uniqueId?: string;
  value?: string;
}

interface SimUseUiData {
  entries: SimUseUiEntry[];
  // Scrollable-list cells sim-use surfaces separately from `entries` (see the sim-use cheatsheet's
  // `#N`/`#N@M` list-cell aliases) — shape not pinned down against a live populated list, so this
  // is read defensively below rather than assumed.
  lists?: unknown[];
}

// Roles known to be directly actionable. Anything else is included only if it carries a
// `uniqueId` (AXUniqueId / a stable accessibility identifier) — e.g. a status-bar icon that
// happens to expose one alongside plain `GenericElement` entries that don't. That can produce an
// occasional false positive (a labeled-but-inert status icon), which is harmless: hint mode taps
// it and nothing happens, the same risk Android's uiautomator-based hint mode already accepts.
const INTERACTIVE_ROLES = new Set([
  'Button',
  'Link',
  'TextField',
  'SearchField',
  'Switch',
  'Cell',
  'Slider',
]);

function isInteractive(entry: SimUseUiEntry): boolean {
  return INTERACTIVE_ROLES.has(entry.role) || entry.uniqueId !== undefined;
}

function toBounds(entry: SimUseUiEntry): DeviceBounds {
  const { x, y, width, height } = entry.frame;
  return { x1: x, y1: y, x2: x + width, y2: y + height };
}

/** Extracts whatever cell entries a list object carries, tolerating shapes we haven't seen live. */
function listCells(list: unknown): SimUseUiEntry[] {
  if (typeof list !== 'object' || list === null) {
    return [];
  }
  const shaped = list as { cells?: unknown; entries?: unknown };
  const candidate = shaped.cells ?? shaped.entries;
  return Array.isArray(candidate) ? (candidate as SimUseUiEntry[]) : [];
}

/**
 * Fetches the current accessibility outline and turns every interactive, non-degenerate element
 * into a labeled {@link HintTarget}, in points (the same coordinate space sim-use's own
 * `tap`/`swipe` expect) — mirrors parseHintTargets' dedup-by-bounds behavior (src/input/hints.ts)
 * since sim-use's outline has the same "nested wrapper reports its clickable child's own frame"
 * duplication uiautomator dumps do.
 */
export async function getIosHintTargets(udid: string): Promise<HintTarget[]> {
  const data = await runSimUse<SimUseUiData>(['ui', '--device', udid, '--no-raw']);
  const candidates = [...data.entries, ...(data.lists ?? []).flatMap(listCells)];

  const seenBounds = new Set<string>();
  const targets: Omit<HintTarget, 'label'>[] = [];
  for (const entry of candidates) {
    if (!isInteractive(entry)) continue;
    const bounds = toBounds(entry);
    if (bounds.x2 <= bounds.x1 || bounds.y2 <= bounds.y1) continue;
    const key = `${String(bounds.x1)},${String(bounds.y1)},${String(bounds.x2)},${String(bounds.y2)}`;
    if (seenBounds.has(key)) continue;
    seenBounds.add(key);
    targets.push({
      bounds,
      text: entry.label ?? '',
      resourceId: entry.uniqueId ?? '',
      contentDesc: entry.value ?? '',
    });
  }

  const labels = generateLabels(targets.length);
  return targets.map((target, i) => ({ ...target, label: labels[i] as string }));
}
