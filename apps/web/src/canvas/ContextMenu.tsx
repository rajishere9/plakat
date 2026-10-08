/** Right-click menu of the workspace (duplicate, delete, arrange, lock, clipboard). */
import { useEffect, useRef, type CSSProperties } from 'react';
import type { EditorStore } from '../store/editor-store.ts';
import { useEditor } from '../store/editor-store.ts';
import { selectSelectedElements } from '../store/selectors.ts';
import { formatCombo, SHORTCUTS_BY_ID, detectPlatform, type ShortcutId } from '../lib/shortcuts.ts';

export interface ContextMenuState {
  /** Container-relative position. */
  x: number;
  y: number;
}

export interface ContextMenuItem {
  id: string;
  label: string;
  shortcut?: ShortcutId;
  disabled?: boolean;
  separatorBefore?: boolean;
  run: () => void;
}

/** Items for the current selection (pure apart from reading the store). */
export function buildContextMenuItems(store: EditorStore): ContextMenuItem[] {
  const s = store.getState();
  const a = s.actions;
  const selected = selectSelectedElements(s);
  const has = selected.length > 0;
  const allLocked = has && selected.every((e) => e.locked);
  const grouped = selected.some((e) => e.groupId !== null);
  const items: ContextMenuItem[] = [];
  if (has) {
    items.push(
      { id: 'copy', label: 'Copy', shortcut: 'copy', run: () => void a.copy() },
      { id: 'cut', label: 'Cut', shortcut: 'cut', disabled: allLocked, run: () => void a.cut() },
    );
  }
  items.push({ id: 'paste', label: 'Paste', shortcut: 'paste', disabled: !s.clipboard, run: () => void a.paste() });
  if (has) {
    items.push(
      { id: 'duplicate', label: 'Duplicate', shortcut: 'duplicate', run: () => void a.duplicateElements() },
      { id: 'delete', label: 'Delete', shortcut: 'delete', disabled: allLocked, run: () => a.deleteElements() },
      { id: 'bringForward', label: 'Bring forward', shortcut: 'bringForward', separatorBefore: true, run: () => a.bringForward() },
      { id: 'bringToFront', label: 'Bring to front', shortcut: 'bringToFront', run: () => a.bringToFront() },
      { id: 'sendBackward', label: 'Send backward', shortcut: 'sendBackward', run: () => a.sendBackward() },
      { id: 'sendToBack', label: 'Send to back', shortcut: 'sendToBack', run: () => a.sendToBack() },
    );
    if (selected.length > 1 && !grouped) items.push({ id: 'group', label: 'Group', shortcut: 'group', separatorBefore: true, run: () => void a.group() });
    if (grouped) items.push({ id: 'ungroup', label: 'Ungroup', shortcut: 'ungroup', separatorBefore: true, run: () => a.ungroup() });
    items.push({
      id: 'lock',
      label: allLocked ? 'Unlock' : 'Lock',
      shortcut: 'toggleLock',
      separatorBefore: !(selected.length > 1 || grouped),
      run: () => a.toggleLock(),
    });
  } else {
    items.push({ id: 'selectAll', label: 'Select all', shortcut: 'selectAll', run: () => a.selectAll() });
  }
  return items;
}

const menuStyle: CSSProperties = {
  position: 'absolute',
  zIndex: 20,
  minWidth: 200,
  padding: '4px 0',
  background: 'var(--plakat-menu-bg, #ffffff)',
  color: 'var(--plakat-menu-fg, #1f2330)',
  border: '1px solid var(--plakat-menu-border, rgba(15, 23, 42, 0.12))',
  borderRadius: 8,
  boxShadow: '0 8px 24px rgba(15, 23, 42, 0.16)',
  font: '13px/1.2 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  userSelect: 'none',
};

const itemStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 24,
  width: '100%',
  padding: '7px 12px',
  border: 0,
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
};

export function WorkspaceContextMenu({ state, store, onClose }: { state: ContextMenuState; store: EditorStore; onClose: () => void }) {
  // Re-render when the selection/clipboard changes while open.
  useEditor((s) => s.selectedIds, store);
  useEditor((s) => s.clipboard, store);
  const ref = useRef<HTMLDivElement>(null);
  const platform = detectPlatform();

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  const items = buildContextMenuItems(store);
  return (
    <div ref={ref} role="menu" data-plakat-context-menu="" style={{ ...menuStyle, left: state.x, top: state.y }} onContextMenu={(e) => e.preventDefault()}>
      {items.map((item) => {
        const combo = item.shortcut ? SHORTCUTS_BY_ID[item.shortcut]?.combos[0] : undefined;
        return (
          <div key={item.id}>
            {item.separatorBefore && <div role="separator" style={{ height: 1, margin: '4px 0', background: 'var(--plakat-menu-border, rgba(15, 23, 42, 0.1))' }} />}
            <button
              type="button"
              role="menuitem"
              data-action={item.id}
              disabled={item.disabled}
              style={{ ...itemStyle, opacity: item.disabled ? 0.45 : 1, cursor: item.disabled ? 'default' : 'pointer' }}
              onMouseEnter={(e) => {
                if (!item.disabled) e.currentTarget.style.background = 'var(--plakat-menu-hover, rgba(109, 74, 255, 0.08))';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
              }}
              onClick={() => {
                if (item.disabled) return;
                item.run();
                onClose();
              }}
            >
              <span>{item.label}</span>
              {combo && <span style={{ opacity: 0.55 }}>{formatCombo(combo, platform)}</span>}
            </button>
          </div>
        );
      })}
    </div>
  );
}
