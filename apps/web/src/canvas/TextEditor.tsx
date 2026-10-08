/**
 * Inline text editing: a <textarea> laid exactly over the (hidden) Konva text node.
 * Commits on blur / Mod+Enter / whenever editing ends by other means (selection change,
 * Escape-free exit); Escape cancels.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { Id, TextElement } from '@plakat/schema';
import type { EditorStore } from '../store/editor-store.ts';
import { useEditor } from '../store/editor-store.ts';
import { selectElement } from '../store/selectors.ts';
import type { WorkspaceController } from './controller.ts';
import { computeTextOverlayStyle } from './text-overlay.ts';

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

  const commit = useCallback(() => {
    if (cancelled.current) return;
    const current = selectElement(id)(store.getState());
    if (!current || current.type !== 'text' || current.locked) return;
    if (current.content !== valueRef.current) {
      store.getState().actions.setTextContent(id, valueRef.current);
      controller.autoGrowText(id);
    }
  }, [controller, id, store]);

  // Whatever ends the session (blur, Escape-free exit, selection change, unmount) commits.
  useEffect(() => {
    cancelled.current = false;
    return () => commit();
  }, [commit]);

  useLayoutEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.focus({ preventScroll: true });
    ta.select();
  }, []);

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
