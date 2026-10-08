/**
 * Binds lib/shortcuts.ts to the store. Usage:
 *   const onKeyDown = createShortcutHandler({ onSave, onExport });
 *   window.addEventListener('keydown', onKeyDown);
 * Optional system-clipboard integration: createClipboardEventHandlers().
 */
import { CLIPBOARD_MIME, parseClipboard, serializeClipboard } from '../lib/clipboard.ts';
import { matchShortcut, type Platform, type ShortcutId, type ShortcutMatch } from '../lib/shortcuts.ts';
import { editorStore, type EditorStore } from './editor-store.ts';

export interface ShortcutHandlerOptions {
  store?: EditorStore;
  platform?: Platform;
  /** Mod+S (default: nothing; wire persistence.saveNow). */
  onSave?: () => void;
  /** Mod+E (default: nothing; open the export dialog). */
  onExport?: () => void;
  /**
   * true: Mod+C/X/V are NOT handled on keydown (the browser then fires native
   * copy/cut/paste events; handle them with createClipboardEventHandlers()).
   * false (default): internal clipboard only.
   */
  nativeClipboard?: boolean;
  /** Veto hook: return false to ignore a match (e.g. while a modal is open). */
  filter?: (match: ShortcutMatch, event: KeyboardEvent) => boolean;
  /** Override / extend handling per id; return true when handled. */
  overrides?: Partial<Record<ShortcutId, (match: ShortcutMatch) => boolean | void>>;
}

/** Returns a keydown listener; it returns true (and preventDefaults) when a shortcut ran. */
export function createShortcutHandler(options: ShortcutHandlerOptions = {}): (event: KeyboardEvent) => boolean {
  const store = options.store ?? editorStore;
  return (event) => {
    const match = matchShortcut(event, options.platform ? { platform: options.platform } : {});
    if (!match) return false;
    if (options.filter && !options.filter(match, event)) return false;
    if (options.nativeClipboard && (match.id === 'copy' || match.id === 'cut' || match.id === 'paste')) return false;
    const override = options.overrides?.[match.id];
    if (override) {
      const r = override(match);
      if (r !== false) {
        event.preventDefault();
        return true;
      }
    }
    const handled = runShortcut(store, match, options);
    if (handled) event.preventDefault();
    return handled;
  };
}

/** Executes a matched shortcut against a store. Returns false when it did not apply. */
export function runShortcut(store: EditorStore, match: ShortcutMatch, options: Pick<ShortcutHandlerOptions, 'onSave' | 'onExport'> = {}): boolean {
  const s = store.getState();
  const a = s.actions;
  const hasSel = s.selectedIds.length > 0;
  switch (match.id) {
    case 'undo':
      a.undo();
      return true;
    case 'redo':
      a.redo();
      return true;
    case 'copy':
      return hasSel ? (a.copy(), true) : false;
    case 'cut':
      return hasSel ? (a.cut(), true) : false;
    case 'paste':
      return s.clipboard ? (a.paste(), true) : false;
    case 'duplicate':
      if (hasSel) a.duplicateElements();
      return true; // also blocks the browser bookmark dialog
    case 'delete':
      if (hasSel) a.deleteElements();
      return true;
    case 'selectAll':
      a.selectAll();
      return true;
    case 'escape':
      a.escape();
      return true;
    case 'nudge':
      if (!hasSel || !match.args) return false;
      a.nudge(match.args.dx, match.args.dy);
      return true;
    case 'bringForward':
      a.bringForward();
      return true;
    case 'sendBackward':
      a.sendBackward();
      return true;
    case 'bringToFront':
      a.bringToFront();
      return true;
    case 'sendToBack':
      a.sendToBack();
      return true;
    case 'group':
      a.group();
      return true;
    case 'ungroup':
      a.ungroup();
      return true;
    case 'toggleLock':
      a.toggleLock();
      return true;
    case 'zoomIn':
      a.zoomIn();
      return true;
    case 'zoomOut':
      a.zoomOut();
      return true;
    case 'zoomToFit':
      a.zoomToFit();
      return true;
    case 'zoomTo100':
      a.zoomTo100();
      return true;
    case 'addText': {
      const id = a.addText({ preset: 'heading' });
      a.startTextEditing(id);
      return true;
    }
    case 'addRect':
      a.addShape('rect');
      return true;
    case 'addEllipse':
      a.addShape('ellipse');
      return true;
    case 'addLine':
      a.addShape('line');
      return true;
    case 'save':
      options.onSave?.();
      return true;
    case 'export':
      options.onExport?.();
      return true;
    case 'toggleShortcutsHelp':
      a.toggleShortcutsHelp();
      return true;
  }
}

export interface ClipboardEventHandlerOptions {
  store?: EditorStore;
  /** Image files pasted from the OS (screenshots, copied files): upload + addImage them. */
  onPasteFiles?: (files: File[]) => void;
  /** Ignore events whose target is editable (default true). */
  ignoreEditable?: boolean;
}

/**
 * document-level copy/cut/paste listeners that sync the internal clipboard with the
 * system clipboard (custom MIME + text/plain JSON), so elements paste across tabs and
 * documents. Use together with `createShortcutHandler({ nativeClipboard: true })`.
 */
export function createClipboardEventHandlers(options: ClipboardEventHandlerOptions = {}): {
  onCopy: (e: ClipboardEvent) => void;
  onCut: (e: ClipboardEvent) => void;
  onPaste: (e: ClipboardEvent) => void;
} {
  const store = options.store ?? editorStore;
  const editable = (e: Event) => {
    if (options.ignoreEditable === false) return false;
    const t = e.target as { tagName?: string; isContentEditable?: boolean } | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable === true);
  };
  const write = (e: ClipboardEvent, cut: boolean) => {
    if (editable(e)) return;
    const a = store.getState().actions;
    const data = cut ? a.cut() : a.copy();
    if (!data || !e.clipboardData) return;
    const text = serializeClipboard(data);
    e.clipboardData.setData(CLIPBOARD_MIME, text);
    e.clipboardData.setData('text/plain', text);
    e.preventDefault();
  };
  return {
    onCopy: (e) => write(e, false),
    onCut: (e) => write(e, true),
    onPaste: (e) => {
      if (editable(e) || !e.clipboardData) return;
      const files = Array.from(e.clipboardData.files ?? []).filter((f) => f.type.startsWith('image/'));
      if (files.length && options.onPasteFiles) {
        e.preventDefault();
        options.onPasteFiles(files);
        return;
      }
      const text = e.clipboardData.getData(CLIPBOARD_MIME) || e.clipboardData.getData('text/plain');
      const data = text ? parseClipboard(text) : null;
      const a = store.getState().actions;
      if (data) {
        e.preventDefault();
        a.paste(data);
      } else if (store.getState().clipboard) {
        e.preventDefault();
        a.paste();
      }
    },
  };
}
