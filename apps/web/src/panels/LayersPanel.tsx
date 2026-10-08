/**
 * Layers flyout: elements of the active page in visual order (topmost first). Drag a
 * row (or Alt+Arrow keys) to reorder, double-click / F2 to rename, lock and hide
 * toggles, selection kept in sync with the canvas (Shift/Cmd/Ctrl-click to multi-select).
 */
import { useState, type DragEvent, type JSX, type KeyboardEvent } from 'react';
import type { Id, PlakatElement } from '@plakat/schema';
import { useEd, useStoreApi } from '../app/services.tsx';
import { Icon, type IconName } from '../components/Icon.tsx';
import { EmptyState, IconButton, cx } from '../components/ui.tsx';
import { getElementLabel, selectActivePage, selectSlotsByElement } from '../store/index.ts';
import { PanelShell } from './PanelShell.tsx';

/**
 * Final array index (bottom-first z-order, as moveElementToIndex expects) for dropping
 * the element at array index `from` before/after the row at visual index `targetVisual`
 * (visual order = topmost first).
 */
export function visualDropToIndex(count: number, from: number, targetVisual: number, position: 'before' | 'after'): number {
  const targetIndex = count - 1 - targetVisual;
  // "before" a row visually = above it = higher z = right after it in the array.
  const insertAt = position === 'before' ? targetIndex + 1 : targetIndex;
  const final = insertAt > from ? insertAt - 1 : insertAt;
  return Math.min(Math.max(final, 0), count - 1);
}

function typeIcon(el: PlakatElement): IconName {
  if (el.type === 'text') return 'text';
  if (el.type === 'image') return 'image';
  return 'shape';
}

function ElementThumb({ el }: { el: PlakatElement }): JSX.Element {
  const asset = useEd((s) => (el.type === 'image' && Object.hasOwn(s.document.assets, el.assetId) ? s.document.assets[el.assetId] : undefined));
  if (el.type === 'image' && asset) return <img className="layer__thumb" src={asset.src} alt="" draggable={false} />;
  if (el.type === 'shape') {
    const fill = el.shape === 'line' ? el.stroke : el.fill;
    return (
      <span className="layer__thumb layer__thumb--icon" style={fill ? { color: fill } : undefined}>
        <Icon name={el.shape === 'ellipse' ? 'opacity' : 'shape'} size={16} />
      </span>
    );
  }
  if (el.type === 'text')
    return (
      <span className="layer__thumb layer__thumb--icon layer__thumb--text">
        T
        <span className="layer__swatch" style={{ background: el.fill }} />
      </span>
    );
  return (
    <span className="layer__thumb layer__thumb--icon">
      <Icon name={typeIcon(el)} size={16} />
    </span>
  );
}

export function LayersPanel({ onClose }: { onClose?: () => void }): JSX.Element {
  const store = useStoreApi();
  const page = useEd(selectActivePage);
  const selectedIds = useEd((s) => s.selectedIds);
  const hoveredId = useEd((s) => s.hoveredId);
  const slots = useEd(selectSlotsByElement);
  const [dragId, setDragId] = useState<Id | null>(null);
  const [drop, setDrop] = useState<{ id: Id; pos: 'before' | 'after' } | null>(null);
  const [renaming, setRenaming] = useState<Id | null>(null);

  const actions = () => store.getState().actions;
  const visual = [...page.elements].reverse();
  const n = page.elements.length;

  const moveTo = (id: Id, targetVisual: number, pos: 'before' | 'after') => {
    const from = page.elements.findIndex((e) => e.id === id);
    if (from === -1) return;
    const to = visualDropToIndex(n, from, targetVisual, pos);
    if (to !== from) actions().moveElementToIndex(id, to);
  };

  const onRowKeyDown = (e: KeyboardEvent, el: PlakatElement, vIndex: number) => {
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      e.stopPropagation();
      const target = e.key === 'ArrowUp' ? vIndex - 1 : vIndex + 1;
      if (target < 0 || target >= n) return;
      moveTo(el.id, target, e.key === 'ArrowUp' ? 'before' : 'after');
      requestAnimationFrame(() => [...document.querySelectorAll<HTMLElement>('[data-layer-id]')].find((n) => n.dataset['layerId'] === el.id)?.querySelector<HTMLElement>('.layer__main')?.focus());
    } else if (e.key === 'F2') {
      e.preventDefault();
      setRenaming(el.id);
    }
  };

  const onDragOver = (e: DragEvent, id: Id) => {
    if (!dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const pos = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    if (drop?.id !== id || drop.pos !== pos) setDrop({ id, pos });
  };

  const onDrop = (e: DragEvent, vIndex: number) => {
    e.preventDefault();
    const id = dragId ?? e.dataTransfer.getData('application/x-plakat-layer');
    if (id && drop) moveTo(id, vIndex, drop.pos);
    setDragId(null);
    setDrop(null);
  };

  return (
    <PanelShell title="Layers" onClose={onClose}>
      {visual.length === 0 ? (
        <EmptyState icon="layers" title="This page is empty" compact>
          Add text, shapes or images and they will be listed here, topmost first.
        </EmptyState>
      ) : (
        <>
          <p id="layers-help" className="sr-only">
            Press Alt plus Arrow Up or Arrow Down to move a layer. Press F2 to rename.
          </p>
          <ul className="layers" aria-label={`Layers of ${page.name || 'the current page'}`}>
            {visual.map((el, vIndex) => {
              const selected = selectedIds.includes(el.id);
              const slotList = slots.get(el.id);
              const label = getElementLabel(el);
              return (
                <li
                  key={el.id}
                  data-layer-id={el.id}
                  className={cx(
                    'layer',
                    selected && 'is-selected',
                    hoveredId === el.id && 'is-hovered',
                    el.hidden && 'is-hidden',
                    dragId === el.id && 'is-dragging',
                    drop?.id === el.id && `drop-${drop.pos}`,
                  )}
                  draggable={renaming !== el.id}
                  onDragStart={(e) => {
                    setDragId(el.id);
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('application/x-plakat-layer', el.id);
                  }}
                  onDragEnd={() => {
                    setDragId(null);
                    setDrop(null);
                  }}
                  onDragOver={(e) => onDragOver(e, el.id)}
                  onDrop={(e) => onDrop(e, vIndex)}
                  onMouseEnter={() => actions().setHovered(el.id)}
                  onMouseLeave={() => actions().setHovered(null)}
                >
                  <span className="layer__grip" aria-hidden="true">
                    <Icon name="grip" size={14} />
                  </span>
                  <ElementThumb el={el} />
                  {renaming === el.id ? (
                    <input
                      className="input layer__rename"
                      aria-label={`Rename ${label}`}
                      defaultValue={el.name}
                      placeholder={label}
                      autoFocus
                      maxLength={200}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') {
                          actions().rename(el.id, e.currentTarget.value.trim());
                          setRenaming(null);
                        } else if (e.key === 'Escape') setRenaming(null);
                      }}
                      onBlur={(e) => {
                        if (renaming === el.id) actions().rename(el.id, e.currentTarget.value.trim());
                        setRenaming(null);
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="layer__main"
                      aria-pressed={selected}
                      aria-describedby="layers-help"
                      onClick={(e) => actions().select([el.id], { mode: e.shiftKey || e.metaKey || e.ctrlKey ? 'toggle' : 'replace' })}
                      onDoubleClick={() => setRenaming(el.id)}
                      onKeyDown={(e) => onRowKeyDown(e, el, vIndex)}
                    >
                      <span className="layer__label">{label}</span>
                      {slotList && slotList.length > 0 && (
                        <span className="badge badge--slot" title={`Template slot: ${slotList.map((s) => s.label).join(', ')}`}>
                          Slot
                        </span>
                      )}
                      {el.groupId && (
                        <span className="badge" title="Grouped">
                          <Icon name="group" size={12} />
                        </span>
                      )}
                    </button>
                  )}
                  <span className="layer__toggles">
                    <IconButton
                      size="sm"
                      label={el.locked ? `Unlock ${label}` : `Lock ${label}`}
                      icon={el.locked ? 'lock' : 'unlock'}
                      pressed={el.locked}
                      className={cx('layer__toggle', el.locked && 'is-on')}
                      onClick={() => actions().setLocked([el.id], !el.locked)}
                    />
                    <IconButton
                      size="sm"
                      label={el.hidden ? `Show ${label}` : `Hide ${label}`}
                      icon={el.hidden ? 'eyeOff' : 'eye'}
                      pressed={el.hidden}
                      className={cx('layer__toggle', el.hidden && 'is-on')}
                      onClick={() => actions().setHidden([el.id], !el.hidden)}
                    />
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </PanelShell>
  );
}
