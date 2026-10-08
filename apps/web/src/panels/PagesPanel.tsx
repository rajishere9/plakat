/**
 * Pages flyout: live thumbnails of every page; add / duplicate / delete / reorder
 * (drag or Alt+Arrow keys), rename, and the active page's background color.
 */
import { useState, type DragEvent, type JSX } from 'react';
import type { Id } from '@plakat/schema';
import { useColorPalettes } from '../app/hooks.ts';
import { useEd, useStoreApi } from '../app/services.tsx';
import { ColorPicker } from '../components/ColorPicker.tsx';
import { PageThumbnail } from '../components/PageThumbnail.tsx';
import { Menu } from '../components/Menu.tsx';
import { Icon } from '../components/Icon.tsx';
import { Button, cx } from '../components/ui.tsx';
import { selectActivePage } from '../store/index.ts';
import { PanelShell } from './PanelShell.tsx';

/** Target index for movePage when dropping page `from` before/after page `target`. */
export function pageDropIndex(from: number, target: number, pos: 'before' | 'after', count: number): number {
  const insertAt = pos === 'before' ? target : target + 1;
  const final = insertAt > from ? insertAt - 1 : insertAt;
  return Math.min(Math.max(final, 0), count - 1);
}

export function PagesPanel({ onClose }: { onClose?: () => void }): JSX.Element {
  const store = useStoreApi();
  const doc = useEd((s) => s.document);
  const activePageId = useEd((s) => s.activePageId);
  const activePage = useEd(selectActivePage);
  const palettes = useColorPalettes();
  const [dragId, setDragId] = useState<Id | null>(null);
  const [drop, setDrop] = useState<{ id: Id; pos: 'before' | 'after' } | null>(null);
  const [renaming, setRenaming] = useState<Id | null>(null);
  const actions = () => store.getState().actions;
  const count = doc.pages.length;

  const move = (id: Id, to: number) => {
    const from = doc.pages.findIndex((p) => p.id === id);
    if (from !== -1 && to !== from) actions().movePage(id, to);
  };

  const onDrop = (e: DragEvent, targetIndex: number) => {
    e.preventDefault();
    const id = dragId;
    if (id && drop) {
      const from = doc.pages.findIndex((p) => p.id === id);
      move(id, pageDropIndex(from, targetIndex, drop.pos, count));
    }
    setDragId(null);
    setDrop(null);
  };

  return (
    <PanelShell
      title="Pages"
      onClose={onClose}
      footer={
        <Button variant="secondary" block icon="plus" onClick={() => actions().addPage()}>
          Add page
        </Button>
      }
    >
      <div className="page-bg-row">
        <span className="page-bg-row__label">Background of page {doc.pages.findIndex((p) => p.id === activePageId) + 1}</span>
        <ColorPicker
          label="Page background color"
          value={activePage.background.color}
          allowNone
          noneLabel="Transparent"
          palettes={palettes}
          showValue
          onChange={(c) => actions().setPageBackground(activePage.id, { color: c })}
        />
      </div>
      <p id="pages-help" className="sr-only">
        Press Alt plus Arrow Up or Arrow Down to move a page.
      </p>
      <ol className="pages" aria-label="Pages">
        {doc.pages.map((p, i) => {
          const active = p.id === activePageId;
          return (
            <li
              key={p.id}
              className={cx('page-item', active && 'is-active', dragId === p.id && 'is-dragging', drop?.id === p.id && `drop-${drop.pos}`)}
              draggable={renaming !== p.id}
              onDragStart={(e) => {
                setDragId(p.id);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('application/x-plakat-page', p.id);
              }}
              onDragEnd={() => {
                setDragId(null);
                setDrop(null);
              }}
              onDragOver={(e) => {
                if (!dragId) return;
                e.preventDefault();
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                const pos = e.clientY < r.top + r.height / 2 ? 'before' : 'after';
                if (drop?.id !== p.id || drop.pos !== pos) setDrop({ id: p.id, pos });
              }}
              onDrop={(e) => onDrop(e, i)}
            >
              <button
                type="button"
                className="page-item__thumb"
                aria-current={active ? 'page' : undefined}
                aria-label={`Page ${i + 1}${p.name ? `: ${p.name}` : ''}`}
                aria-describedby="pages-help"
                onClick={() => actions().setActivePage(p.id)}
                onKeyDown={(e) => {
                  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                    e.preventDefault();
                    e.stopPropagation();
                    move(p.id, Math.min(count - 1, Math.max(0, i + (e.key === 'ArrowUp' ? -1 : 1))));
                  }
                }}
              >
                <PageThumbnail doc={doc} page={p} maxSide={220} />
              </button>
              <div className="page-item__meta">
                <span className="page-item__num">{i + 1}</span>
                {renaming === p.id ? (
                  <input
                    className="input page-item__rename"
                    aria-label={`Rename page ${i + 1}`}
                    defaultValue={p.name}
                    autoFocus
                    maxLength={200}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') {
                        actions().renamePage(p.id, e.currentTarget.value.trim());
                        setRenaming(null);
                      } else if (e.key === 'Escape') setRenaming(null);
                    }}
                    onBlur={(e) => {
                      actions().renamePage(p.id, e.currentTarget.value.trim());
                      setRenaming(null);
                    }}
                  />
                ) : (
                  <span className="page-item__name" onDoubleClick={() => setRenaming(p.id)}>
                    {p.name || `Page ${i + 1}`}
                  </span>
                )}
                <Menu
                  label={`Page ${i + 1} actions`}
                  placement="bottom-end"
                  items={[
                    { id: 'rename', label: 'Rename', icon: 'edit', onSelect: () => setRenaming(p.id) },
                    { id: 'dup', label: 'Duplicate page', icon: 'duplicate', onSelect: () => actions().duplicatePage(p.id) },
                    { id: 'add', label: 'Add page after', icon: 'plus', onSelect: () => actions().addPage({ index: i + 1 }) },
                    { id: 'up', label: 'Move up', icon: 'chevronUp', disabled: i === 0, onSelect: () => move(p.id, i - 1) },
                    { id: 'down', label: 'Move down', icon: 'chevronDown', disabled: i === count - 1, onSelect: () => move(p.id, i + 1) },
                    { id: 'sep', separator: true },
                    { id: 'delete', label: 'Delete page', icon: 'trash', danger: true, disabled: count <= 1, onSelect: () => actions().deletePage(p.id) },
                  ]}
                  trigger={(props) => (
                    <button {...props} type="button" className="icon-btn icon-btn--sm icon-btn--ghost" aria-label={`Page ${i + 1} actions`} title="Page actions">
                      <Icon name="more" size={16} />
                    </button>
                  )}
                />
              </div>
            </li>
          );
        })}
      </ol>
    </PanelShell>
  );
}
