/**
 * Editor top bar: home, editable title, save status (with conflict resolution), undo /
 * redo, zoom control and the Share/Export menu.
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import { Icon, type IconName } from '../components/Icon.tsx';
import { Menu, type MenuEntry } from '../components/Menu.tsx';
import { Button, IconButton, Spinner, cx } from '../components/ui.tsx';
import { detectPlatform, formatCombo, SHORTCUTS_BY_ID } from '../lib/shortcuts.ts';
import { clampZoom, formatZoom } from '../lib/zoom.ts';
import { formatRelativeTime } from './format.ts';
import { useEd, useServices, useStoreApi } from './services.tsx';
import { errorMessage, toast } from './toasts.tsx';

const platform = detectPlatform();
const hint = (id: keyof typeof SHORTCUTS_BY_ID) => {
  const c = SHORTCUTS_BY_ID[id]?.combos[0];
  return c ? formatCombo(c, platform) : undefined;
};

export function TitleInput(): JSX.Element {
  const store = useStoreApi();
  const title = useEd((s) => s.document.meta.title);
  const [draft, setDraft] = useState(title);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(title);
  }, [title]);
  const commit = () => {
    editing.current = false;
    const t = draft.trim() || 'Untitled design';
    if (t !== title) store.getState().actions.setTitle(t);
    setDraft(t);
  };
  return (
    <input
      className="title-input"
      aria-label="Design title"
      value={draft}
      maxLength={500}
      size={Math.min(40, Math.max(8, draft.length + 1))}
      onFocus={(e) => {
        editing.current = true;
        e.currentTarget.select();
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setDraft(title);
          editing.current = false;
          e.currentTarget.blur();
        }
      }}
    />
  );
}

export function SaveStatus(): JSX.Element | null {
  const services = useServices();
  const status = useEd((s) => s.saveStatus);
  const projectId = useEd((s) => s.projectId);
  const lastSavedAt = useEd((s) => s.lastSavedAt);
  const saveError = useEd((s) => s.saveError);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const resolve = (strategy: 'reload' | 'overwrite' | 'saveAsCopy') =>
    services.persistence.resolveConflict(strategy).catch((e) => toast.error('Could not resolve the conflict', { detail: errorMessage(e) }));

  if (status === 'conflict') {
    return (
      <Menu
        label="Resolve save conflict"
        items={[
          { heading: 'This design was changed elsewhere', id: 'h' },
          { id: 'reload', label: 'Load the other version (discard mine)', icon: 'reset', onSelect: () => void resolve('reload') },
          { id: 'overwrite', label: 'Keep my version (overwrite)', icon: 'upload', onSelect: () => void resolve('overwrite') },
          { id: 'copy', label: 'Save mine as a copy', icon: 'duplicate', onSelect: () => void resolve('saveAsCopy') },
        ]}
        trigger={(props) => (
          <button {...props} type="button" className="save-status save-status--conflict">
            <Icon name="warning" size={16} />
            <span>Edited elsewhere</span>
            <Icon name="chevronDown" size={14} />
          </button>
        )}
      />
    );
  }
  if (status === 'error') {
    return (
      <button type="button" className="save-status save-status--error" title={saveError ?? undefined} onClick={() => void services.persistence.saveNow()}>
        <Icon name="cloudOff" size={16} />
        <span>Not saved · Retry</span>
      </button>
    );
  }
  const map: Record<'idle' | 'unsaved' | 'saving' | 'saved' | 'readonly', { icon: IconName | null; text: string }> = {
    idle: projectId ? { icon: 'cloudCheck', text: 'Saved' } : { icon: 'cloud', text: 'Not saved yet' },
    unsaved: { icon: 'cloud', text: 'Unsaved changes' },
    saving: { icon: null, text: 'Saving…' },
    saved: { icon: 'cloudCheck', text: 'Saved' },
    readonly: { icon: 'lock', text: 'Read-only' },
  };
  const m = map[status];
  return (
    <span
      className={cx('save-status', `save-status--${status}`)}
      role="status"
      aria-live="polite"
      title={status === 'saved' && lastSavedAt ? `Saved ${formatRelativeTime(lastSavedAt)}` : undefined}
    >
      {m.icon ? <Icon name={m.icon} size={16} /> : <Spinner size={14} />}
      <span>{m.text}</span>
    </span>
  );
}

export function ZoomControl(): JSX.Element {
  const store = useStoreApi();
  const zoom = useEd((s) => s.zoom);
  const mode = useEd((s) => s.zoomMode);
  const [draft, setDraft] = useState(formatZoom(zoom));
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(formatZoom(zoom));
  }, [zoom]);
  const a = () => store.getState().actions;
  const commit = () => {
    editing.current = false;
    const n = parseFloat(draft.replace(',', '.'));
    if (Number.isFinite(n) && n > 0) a().setZoom(clampZoom(n / 100));
    else setDraft(formatZoom(zoom));
  };
  const items: MenuEntry[] = [
    { id: 'fit', label: 'Fit to screen', checked: mode === 'fit', hint: hint('zoomToFit'), onSelect: () => a().zoomToFit() },
    { id: 'sep', separator: true },
    ...[0.5, 1, 2].map((z) => ({
      id: `z${z}`,
      label: `${z * 100}%`,
      checked: mode === 'manual' && Math.abs(zoom - z) < 1e-6,
      hint: z === 1 ? hint('zoomTo100') : undefined,
      onSelect: () => (z === 1 ? a().zoomTo100() : a().setZoom(z)),
    })),
  ];
  return (
    <div className="zoom" role="group" aria-label="Zoom">
      <IconButton label="Zoom out" tooltip={`Zoom out (${hint('zoomOut') ?? ''})`} icon="zoomOut" size="sm" onClick={() => a().zoomOut()} />
      <input
        className="zoom__input"
        aria-label="Zoom level (percent)"
        value={draft}
        onFocus={(e) => {
          editing.current = true;
          setDraft(String(Math.round(zoom * 100)));
          requestAnimationFrame(() => e.target.select());
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            editing.current = false;
            setDraft(formatZoom(zoom));
            e.currentTarget.blur();
          }
        }}
      />
      <Menu
        label="Zoom presets"
        items={items}
        placement="bottom-end"
        trigger={(props) => (
          <button {...props} type="button" className="icon-btn icon-btn--sm icon-btn--ghost" aria-label="Zoom presets" title="Zoom presets">
            <Icon name="chevronDown" size={14} />
          </button>
        )}
      />
      <IconButton label="Zoom in" tooltip={`Zoom in (${hint('zoomIn') ?? ''})`} icon="zoomIn" size="sm" onClick={() => a().zoomIn()} />
    </div>
  );
}

export interface TopBarProps {
  onHome: () => void;
  onExport: () => void;
  onSaveAsTemplate: () => void;
  onDownloadFile: () => void;
  onShortcuts: () => void;
  /** Built-in template: "Use template" instead of editing. */
  onUseTemplate?: () => void;
}

export function TopBar({ onHome, onExport, onSaveAsTemplate, onDownloadFile, onShortcuts, onUseTemplate }: TopBarProps): JSX.Element {
  const store = useStoreApi();
  const canUndo = useEd((s) => s.canUndo);
  const canRedo = useEd((s) => s.canRedo);
  const undoLabel = useEd((s) => s.undoLabel);
  const redoLabel = useEd((s) => s.redoLabel);
  const isTemplate = useEd((s) => s.document.kind === 'template');
  const a = () => store.getState().actions;

  const shareItems: MenuEntry[] = [
    { id: 'download', label: 'Download PNG, JPG or PDF…', icon: 'download', hint: hint('export'), onSelect: onExport },
    { id: 'file', label: isTemplate ? 'Download template file (.plakat.json)' : 'Download design file (.plakat.json)', icon: 'file', onSelect: onDownloadFile },
    { id: 'sep', separator: true },
    { id: 'tpl', label: 'Save as template…', icon: 'templates', onSelect: onSaveAsTemplate },
  ];

  return (
    <header className="topbar">
      <div className="topbar__left">
        <IconButton label="Back to home" icon="home" onClick={onHome} />
        <span className="topbar__divider" aria-hidden="true" />
        <TitleInput />
        <SaveStatus />
      </div>
      <div className="topbar__center">
        <IconButton label={undoLabel ? `Undo ${undoLabel}` : 'Undo'} tooltip={`Undo${undoLabel ? ` ${undoLabel.toLowerCase()}` : ''} (${hint('undo') ?? ''})`} icon="undo" disabled={!canUndo} onClick={() => a().undo()} />
        <IconButton label={redoLabel ? `Redo ${redoLabel}` : 'Redo'} tooltip={`Redo${redoLabel ? ` ${redoLabel.toLowerCase()}` : ''} (${hint('redo') ?? ''})`} icon="redo" disabled={!canRedo} onClick={() => a().redo()} />
        <span className="topbar__divider" aria-hidden="true" />
        <ZoomControl />
      </div>
      <div className="topbar__right">
        <IconButton label="Keyboard shortcuts" tooltip={`Keyboard shortcuts (${hint('toggleShortcutsHelp') ?? '?'})`} icon="keyboard" onClick={onShortcuts} />
        {onUseTemplate && (
          <Button variant="secondary" icon="sparkle" onClick={onUseTemplate}>
            Use template
          </Button>
        )}
        <Menu
          label="Share and export"
          items={shareItems}
          placement="bottom-end"
          width={300}
          trigger={(props, open) => (
            <button {...props} type="button" className={cx('btn btn--primary btn--md', open && 'is-open')}>
              <Icon name="share" size={18} />
              <span className="btn__label">Share</span>
              <Icon name="chevronDown" size={14} />
            </button>
          )}
        />
      </div>
    </header>
  );
}
