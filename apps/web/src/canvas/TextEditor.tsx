/**
 * Inline text editing: a <textarea> laid exactly over the (hidden) Konva text node.
 * The draft is committed to the document while typing (debounced, one undo step per
 * session, so autosave and reload never lose it) and again on blur / Mod+Enter / page
 * hide / whenever editing ends by other means; Escape reverts the session.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { Id, TextElement } from '@plakat/schema';
import type { EditorStore } from '../store/editor-store.ts';
import { useEditor } from '../store/editor-store.ts';
import { selectElement } from '../store/selectors.ts';
import type { WorkspaceController } from './controller.ts';
import { computeTextOverlayStyle } from './text-overlay.ts';

/** Debounce for committing the draft while typing. */
export const LIVE_COMMIT_MS = 250;

const WORD_CHAR = /[\p{L}\p{N}_'’]/u;

/** [start, end) of the word around `offset`, or null when the caret is not in/next to a word. */
export function wordAt(text: string, offset: number): [number, number] | null {
  const at = (i: number) => i >= 0 && i < text.length && WORD_CHAR.test(text[i]!);
  if (!at(offset) && !at(offset - 1)) return null;
  let start = offset;
  let end = offset;
  while (at(start - 1)) start--;
  while (at(end)) end++;
  return start < end ? [start, end] : null;
}

type CaretDoc = Document & {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

/**
 * Character offset in the textarea under a client point: lays out an invisible mirror with
 * the textarea's exact inline style (same box, font and transform) and hit-tests its text.
 * Null when the browser cannot tell.
 */
export function caretOffsetAt(ta: HTMLTextAreaElement, clientX: number, clientY: number): number | null {
  const doc = ta.ownerDocument as CaretDoc;
  const parent = ta.parentElement;
  if (!parent || (!doc.caretPositionFromPoint && !doc.caretRangeFromPoint)) return null;
  const mirror = doc.createElement('div');
  mirror.style.cssText = ta.style.cssText;
  mirror.style.opacity = '0';
  mirror.style.pointerEvents = 'auto';
  mirror.style.zIndex = '2147483647';
  mirror.style.userSelect = 'text';
  const text = doc.createTextNode(ta.value.endsWith('\n') ? `${ta.value}\u200b` : ta.value);
  mirror.appendChild(text);
  parent.appendChild(mirror);
  try {
    let node: Node | null = null;
    let offset = 0;
    if (doc.caretPositionFromPoint) {
      const pos = doc.caretPositionFromPoint(clientX, clientY);
      node = pos?.offsetNode ?? null;
      offset = pos?.offset ?? 0;
    } else {
      const range = doc.caretRangeFromPoint!(clientX, clientY);
      node = range?.startContainer ?? null;
      offset = range?.startOffset ?? 0;
    }
    if (node === text) return Math.min(offset, ta.value.length);
    if (node === mirror) return offset === 0 ? 0 : ta.value.length;
    return null;
  } catch {
    return null;
  } finally {
    mirror.remove();
  }
}

export interface TextEditorOverlayProps {
  controller: WorkspaceController;
  store: EditorStore;
}

/** Mounts the editor for `textEditingId` (keyed, so each edit session starts fresh). */
export function TextEditorOverlay({ controller, store }: TextEditorOverlayProps) {
  const editingId = useEditor((s) => s.textEditingId, store);
  if (!editingId) return null;
  return <InlineTextEditor key={editingId} id={editingId} controller={controller} store={store} />;
}

function InlineTextEditor({ id, controller, store }: { id: Id; controller: WorkspaceController; store: EditorStore }) {
  const selector = useMemo(() => selectElement(id), [id]);
  const element = useEditor(selector, store);
  const text = element?.type === 'text' ? element : null;
  const [value, setValue] = useState(() => text?.content ?? '');
  const valueRef = useRef(value);
  const cancelled = useRef(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const [, bump] = useReducer((n: number) => n + 1, 0);

  useEffect(() => controller.onViewChange(bump), [controller]);

  const original = useRef(text?.content ?? '');
  /** A draft was written to the document during this session (Escape must revert it). */
  const committedLive = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const commit = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (cancelled.current) return;
    const current = selectElement(id)(store.getState());
    if (!current || current.type !== 'text' || current.locked) return;
    if (current.content !== valueRef.current) {
      store.getState().actions.setTextContent(id, valueRef.current);
      committedLive.current = true;
      controller.autoGrowText(id);
    }
  }, [controller, id, store]);

  // Whatever ends the session (blur, Escape-free exit, selection change, unmount) commits.
  useEffect(() => {
    cancelled.current = false;
    return () => commit();
  }, [commit]);

  // Leaving the page (reload, tab close, app switch on mobile) commits the draft first, so
  // autosave / the unsaved-changes prompt see it. Capture: runs before persistence's handler.
  useEffect(() => {
    const flush = () => commit();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') commit();
    };
    window.addEventListener('beforeunload', flush, true);
    window.addEventListener('pagehide', flush, true);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('beforeunload', flush, true);
      window.removeEventListener('pagehide', flush, true);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [commit]);

  useLayoutEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.focus({ preventScroll: true });
    // Double-click: caret (or the word) at the click point. T / Enter / Edit: select all.
    const caret = controller.takeTextEditCaret(id);
    if (!caret) {
      ta.select();
      return;
    }
    const host = ta.parentElement?.getBoundingClientRect();
    const offset = host ? caretOffsetAt(ta, host.left + caret.x, host.top + caret.y) : null;
    const at = offset ?? ta.value.length;
    const word = offset === null ? null : wordAt(ta.value, at);
    if (word) ta.setSelectionRange(word[0], word[1]);
    else ta.setSelectionRange(at, at);
  }, [controller, id]);

  if (!text) return null;
  const geometry = controller.getTextEditGeometry(id);
  if (!geometry) return null;
  const draft: TextElement = { ...text, content: value };
  const m = controller.measureText(draft);
  const style = computeTextOverlayStyle({
    element: text,
    pageOrigin: geometry.pageOrigin,
    zoom: geometry.zoom,
    textOffsetY: m.offsetY,
    textWidth: m.width,
    textHeight: m.height,
  }) as CSSProperties;

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelled.current = true;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      const st = store.getState();
      // Revert drafts already written while typing (they form this session's one undo step).
      if (committedLive.current) {
        const current = selectElement(id)(st);
        if (current?.type === 'text' && current.content !== original.current && st.undoLabel === 'Edit text') st.actions.undo();
      }
      store.getState().actions.stopTextEditing();
      return;
    }
    if (e.key === 'Enter' && mod) {
      e.preventDefault();
      e.stopPropagation();
      commit();
      cancelled.current = true; // already committed
      store.getState().actions.stopTextEditing();
      return;
    }
    // Keep editing keys away from the workspace shortcuts (Mod+S still bubbles to save).
    if (!(mod && (e.key === 's' || e.key === 'S'))) e.stopPropagation();
  };

  return (
    <textarea
      ref={ref}
      data-plakat-text-editor=""
      aria-label="Edit text"
      spellCheck={false}
      value={value}
      style={style}
      onChange={(e) => {
        valueRef.current = e.target.value;
        setValue(e.target.value);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          timer.current = null;
          commit();
        }, LIVE_COMMIT_MS);
      }}
      onKeyDown={onKeyDown}
      onBlur={() => {
        // The window losing focus (app switch) keeps the session open.
        if (typeof document !== 'undefined' && !document.hasFocus()) return;
        commit();
        cancelled.current = true;
        if (store.getState().textEditingId === id) store.getState().actions.stopTextEditing();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    />
  );
}
