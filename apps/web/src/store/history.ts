/**
 * Patch-based undo/redo history (immer produceWithPatches). Only the document is in
 * history; each entry also remembers the selection before/after so undo/redo restore it.
 */
import type { Patch } from 'immer';
import type { Id } from '@plakat/schema';

export interface SelectionSnapshot {
  ids: Id[];
  pageId: Id;
}

export interface HistoryEntry {
  label: string;
  patches: Patch[];
  inversePatches: Patch[];
  selectionBefore: SelectionSnapshot;
  selectionAfter: SelectionSnapshot;
  coalesceKey: string | null;
  /** ms timestamp of the LAST commit merged into this entry. */
  time: number;
}

export const HISTORY_LIMIT = 200;
/** Default coalescing window for commits sharing a coalesceKey. */
export const COALESCE_WINDOW_MS = 1000;

export interface PushOptions {
  coalesceKey?: string | null;
  /** Window for coalesceKey merging (default COALESCE_WINDOW_MS; Infinity = same gesture always merges). */
  coalesceWindowMs?: number;
  /** Merge into the previous entry unconditionally (follow-up fixes such as text auto-height). */
  merge?: boolean;
}

const pathKey = (p: Patch) => JSON.stringify(p.path);

/**
 * Concatenates two patch lists of a coalesced entry. When both consist only of
 * `replace` ops on paths that are not prefixes of one another, duplicates are folded
 * (the last one in application order wins) so typing 1 000
 * characters does not keep 1 000 patches.
 */
function mergePatches(first: Patch[], second: Patch[], forward: boolean): Patch[] {
  const all = forward ? [...first, ...second] : [...second, ...first];
  if (!all.every((p) => p.op === 'replace' && p.path.length > 0)) return all;
  const keys = [...new Set(all.map(pathKey))];
  const paths = keys.map((k) => JSON.parse(k) as (string | number)[]);
  for (let i = 0; i < paths.length; i++) {
    for (let j = 0; j < paths.length; j++) {
      if (i === j) continue;
      const a = paths[i]!;
      const b = paths[j]!;
      if (a.length < b.length && a.every((seg, k) => seg === b[k])) return all;
    }
  }
  // In application order the last patch per path determines the result (forward: the
  // newest value; inverse, which applies the newer commit's inverse first: the original).
  const byKey = new Map<string, Patch>();
  for (const p of all) byKey.set(pathKey(p), p);
  return keys.map((k) => byKey.get(k)!);
}

export class History {
  past: HistoryEntry[] = [];
  future: HistoryEntry[] = [];
  /** Set after undo/redo/breakCoalescing so the next commit never merges. */
  private sealed = true;

  constructor(readonly limit = HISTORY_LIMIT) {}

  /** Records a commit; returns true when it was merged into the previous entry. */
  push(entry: HistoryEntry, opts: PushOptions = {}): boolean {
    this.future = [];
    const last = this.past[this.past.length - 1];
    const window = opts.coalesceWindowMs ?? COALESCE_WINDOW_MS;
    const canMerge =
      !!last &&
      !this.sealed &&
      (opts.merge === true || (!!entry.coalesceKey && entry.coalesceKey === last.coalesceKey && entry.time - last.time <= window));
    this.sealed = false;
    if (canMerge && last) {
      last.patches = mergePatches(last.patches, entry.patches, true);
      last.inversePatches = mergePatches(last.inversePatches, entry.inversePatches, false);
      last.selectionAfter = entry.selectionAfter;
      last.time = entry.time;
      if (opts.merge !== true) last.coalesceKey = entry.coalesceKey;
      return true;
    }
    this.past.push(entry);
    if (this.past.length > this.limit) this.past.splice(0, this.past.length - this.limit);
    return false;
  }

  /** Pops the entry to undo (caller applies inversePatches). */
  undo(): HistoryEntry | null {
    const e = this.past.pop();
    if (!e) return null;
    this.future.push(e);
    this.sealed = true;
    return e;
  }

  redo(): HistoryEntry | null {
    const e = this.future.pop();
    if (!e) return null;
    this.past.push(e);
    this.sealed = true;
    return e;
  }

  /** Ends the current coalescing run (e.g. on blur / pointerup). */
  seal(): void {
    this.sealed = true;
  }

  clear(): void {
    this.past = [];
    this.future = [];
    this.sealed = true;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }
  get undoLabel(): string | null {
    return this.past[this.past.length - 1]?.label ?? null;
  }
  get redoLabel(): string | null {
    return this.future[this.future.length - 1]?.label ?? null;
  }
}
