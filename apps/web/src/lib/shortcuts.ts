/**
 * Keyboard shortcut map. `Mod` = Cmd on macOS, Ctrl elsewhere. Pure: matchShortcut()
 * takes a KeyboardEvent-like object; the store binding (store/shortcut-handler.ts)
 * maps the returned id to editor actions.
 */

export type Platform = 'mac' | 'other';

export type ShortcutId =
  | 'undo'
  | 'redo'
  | 'copy'
  | 'cut'
  | 'paste'
  | 'duplicate'
  | 'delete'
  | 'selectAll'
  | 'escape'
  | 'nudge'
  | 'bringForward'
  | 'sendBackward'
  | 'bringToFront'
  | 'sendToBack'
  | 'group'
  | 'ungroup'
  | 'toggleLock'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomToFit'
  | 'zoomTo100'
  | 'addText'
  | 'addRect'
  | 'addEllipse'
  | 'addLine'
  | 'save'
  | 'export'
  | 'toggleShortcutsHelp';

export type ShortcutGroup = 'Edit' | 'Selection' | 'Arrange' | 'Insert' | 'View' | 'File' | 'Help';

/**
 * One key combination. `key` is compared with the event's `key` (single characters
 * lower-cased); `code` (physical key) is an alternative match so bracket / digit /
 * =/- shortcuts work with Shift held and on non-US layouts.
 */
export interface KeyCombo {
  key: string;
  code?: string;
  mod?: boolean;
  /** true/false = must (not) be held; 'any' = ignored. Default false. */
  shift?: boolean | 'any';
  alt?: boolean;
}

export interface ShortcutDef {
  id: ShortcutId;
  label: string;
  group: ShortcutGroup;
  combos: KeyCombo[];
  /** Fires even when focus is in an input/textarea/contenteditable (Escape, Mod+S). */
  allowInInput?: boolean;
  /** Fires on auto-repeat keydown (default true). */
  repeat?: boolean;
}

export interface ShortcutMatch {
  id: ShortcutId;
  def: ShortcutDef;
  /** For 'nudge': the offset in page px (1, or 10 with Shift). */
  args?: { dx: number; dy: number };
}

/** The subset of KeyboardEvent read by matchShortcut. */
export interface KeyEventLike {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  target?: unknown;
}

export const NUDGE_STEP = 1;
export const NUDGE_STEP_LARGE = 10;

const mod = (key: string, extra: Partial<KeyCombo> = {}): KeyCombo => ({ key, mod: true, ...extra });

export const SHORTCUTS: readonly ShortcutDef[] = [
  { id: 'undo', label: 'Undo', group: 'Edit', combos: [mod('z', { code: 'KeyZ' })] },
  { id: 'redo', label: 'Redo', group: 'Edit', combos: [mod('z', { code: 'KeyZ', shift: true }), mod('y', { code: 'KeyY' })] },
  { id: 'copy', label: 'Copy', group: 'Edit', combos: [mod('c', { code: 'KeyC' })] },
  { id: 'cut', label: 'Cut', group: 'Edit', combos: [mod('x', { code: 'KeyX' })] },
  { id: 'paste', label: 'Paste', group: 'Edit', combos: [mod('v', { code: 'KeyV' })] },
  { id: 'duplicate', label: 'Duplicate', group: 'Edit', combos: [mod('d', { code: 'KeyD' })] },
  { id: 'delete', label: 'Delete', group: 'Edit', combos: [{ key: 'Backspace' }, { key: 'Delete' }] },
  { id: 'selectAll', label: 'Select all', group: 'Selection', combos: [mod('a', { code: 'KeyA' })] },
  {
    id: 'escape',
    label: 'Deselect / exit text or crop editing',
    group: 'Selection',
    combos: [{ key: 'Escape', shift: 'any' }],
    allowInInput: true,
    repeat: false,
  },
  {
    id: 'nudge',
    label: 'Nudge (hold Shift for 10 px)',
    group: 'Arrange',
    combos: [
      { key: 'ArrowLeft', shift: 'any' },
      { key: 'ArrowRight', shift: 'any' },
      { key: 'ArrowUp', shift: 'any' },
      { key: 'ArrowDown', shift: 'any' },
    ],
  },
  { id: 'bringForward', label: 'Bring forward', group: 'Arrange', combos: [mod(']', { code: 'BracketRight' })] },
  { id: 'sendBackward', label: 'Send backward', group: 'Arrange', combos: [mod('[', { code: 'BracketLeft' })] },
  { id: 'bringToFront', label: 'Bring to front', group: 'Arrange', combos: [mod(']', { code: 'BracketRight', shift: true })] },
  { id: 'sendToBack', label: 'Send to back', group: 'Arrange', combos: [mod('[', { code: 'BracketLeft', shift: true })] },
  { id: 'group', label: 'Group', group: 'Arrange', combos: [mod('g', { code: 'KeyG' })], repeat: false },
  { id: 'ungroup', label: 'Ungroup', group: 'Arrange', combos: [mod('g', { code: 'KeyG', shift: true })], repeat: false },
  { id: 'toggleLock', label: 'Lock / unlock', group: 'Arrange', combos: [mod('l', { code: 'KeyL', shift: true })], repeat: false },
  {
    id: 'zoomIn',
    label: 'Zoom in',
    group: 'View',
    combos: [mod('=', { code: 'Equal', shift: 'any' }), mod('+', { code: 'NumpadAdd', shift: 'any' })],
  },
  { id: 'zoomOut', label: 'Zoom out', group: 'View', combos: [mod('-', { code: 'Minus', shift: 'any' }), mod('-', { code: 'NumpadSubtract' })] },
  { id: 'zoomToFit', label: 'Zoom to fit', group: 'View', combos: [mod('0', { code: 'Digit0' })], repeat: false },
  { id: 'zoomTo100', label: 'Zoom to 100 %', group: 'View', combos: [mod('1', { code: 'Digit1' })], repeat: false },
  { id: 'addText', label: 'Add text', group: 'Insert', combos: [{ key: 't', code: 'KeyT' }], repeat: false },
  { id: 'addRect', label: 'Add rectangle', group: 'Insert', combos: [{ key: 'r', code: 'KeyR' }], repeat: false },
  { id: 'addEllipse', label: 'Add ellipse', group: 'Insert', combos: [{ key: 'o', code: 'KeyO' }], repeat: false },
  { id: 'addLine', label: 'Add line', group: 'Insert', combos: [{ key: 'l', code: 'KeyL' }], repeat: false },
  { id: 'save', label: 'Save now', group: 'File', combos: [mod('s', { code: 'KeyS' })], allowInInput: true, repeat: false },
  { id: 'export', label: 'Export / download', group: 'File', combos: [mod('e', { code: 'KeyE' })], repeat: false },
  { id: 'toggleShortcutsHelp', label: 'Keyboard shortcuts', group: 'Help', combos: [{ key: '?', shift: 'any' }], repeat: false },
];

export const SHORTCUTS_BY_ID: Readonly<Record<ShortcutId, ShortcutDef>> = Object.fromEntries(SHORTCUTS.map((s) => [s.id, s])) as Record<
  ShortcutId,
  ShortcutDef
>;

export function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'other';
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const p = nav.userAgentData?.platform || nav.platform || nav.userAgent || '';
  return /mac|iphone|ipad|ipod/i.test(p) ? 'mac' : 'other';
}

/** True for inputs, textareas, selects and contenteditable elements (and their descendants). */
export function isEditableTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as { tagName?: unknown; isContentEditable?: unknown; closest?: (sel: string) => unknown };
  if (typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable === true) return true;
  if (typeof el.closest === 'function') {
    const hit = el.closest('[contenteditable]:not([contenteditable="false"])');
    if (hit) return true;
  }
  return false;
}

function normalizeKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

function comboMatches(combo: KeyCombo, e: KeyEventLike, platform: Platform): boolean {
  const modHeld = platform === 'mac' ? !!e.metaKey : !!e.ctrlKey;
  const otherHeld = platform === 'mac' ? !!e.ctrlKey : !!e.metaKey;
  if (otherHeld) return false;
  if (!!combo.mod !== modHeld) return false;
  if (!!combo.alt !== !!e.altKey) return false;
  const shift = combo.shift ?? false;
  if (shift !== 'any' && shift !== !!e.shiftKey) return false;
  if (normalizeKey(e.key) === normalizeKey(combo.key)) return true;
  return !!combo.code && e.code === combo.code;
}

export interface MatchOptions {
  platform?: Platform;
  /** Override for the focus check (default: isEditableTarget(event.target)). */
  inEditable?: boolean;
}

/**
 * Maps a keydown to a shortcut, or null. Ignored when composing (IME) and, except
 * for `allowInInput` shortcuts (Escape, Mod+S), when focus is in an editable field.
 */
export function matchShortcut(e: KeyEventLike, options: MatchOptions = {}): ShortcutMatch | null {
  if (e.isComposing) return null;
  const platform = options.platform ?? detectPlatform();
  const inEditable = options.inEditable ?? isEditableTarget(e.target);
  for (const def of SHORTCUTS) {
    if (inEditable && !def.allowInInput) continue;
    if (e.repeat && def.repeat === false) continue;
    if (!def.combos.some((c) => comboMatches(c, e, platform))) continue;
    if (def.id === 'nudge') {
      const step = e.shiftKey ? NUDGE_STEP_LARGE : NUDGE_STEP;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      return { id: def.id, def, args: { dx, dy } };
    }
    return { id: def.id, def };
  }
  return null;
}

const MAC_KEY_LABELS: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Backspace: '⌫',
  Delete: '⌦',
  Escape: 'Esc',
};
const OTHER_KEY_LABELS: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Escape: 'Esc',
};

/** Display string for a combo, e.g. "⌘⇧Z" (mac) or "Ctrl+Shift+Z". */
export function formatCombo(combo: KeyCombo, platform: Platform = detectPlatform()): string {
  const labels = platform === 'mac' ? MAC_KEY_LABELS : OTHER_KEY_LABELS;
  const key = labels[combo.key] ?? (combo.key.length === 1 ? combo.key.toUpperCase() : combo.key);
  if (platform === 'mac') {
    return `${combo.mod ? '⌘' : ''}${combo.alt ? '⌥' : ''}${combo.shift === true ? '⇧' : ''}${key}`;
  }
  return [combo.mod ? 'Ctrl' : '', combo.alt ? 'Alt' : '', combo.shift === true ? 'Shift' : '', key].filter(Boolean).join('+');
}

/** Help-dialog rows: label + formatted key strings, in SHORTCUTS order, grouped. */
export function getShortcutHelp(platform: Platform = detectPlatform()): { group: ShortcutGroup; items: { id: ShortcutId; label: string; keys: string[] }[] }[] {
  const groups: { group: ShortcutGroup; items: { id: ShortcutId; label: string; keys: string[] }[] }[] = [];
  for (const def of SHORTCUTS) {
    let g = groups.find((x) => x.group === def.group);
    if (!g) groups.push((g = { group: def.group, items: [] }));
    const keys = [...new Set(def.combos.filter((c) => !(c.code ?? '').startsWith('Numpad')).map((c) => formatCombo(c, platform)))];
    g.items.push({ id: def.id, label: def.label, keys });
  }
  return groups;
}
