/**
 * Home: create a design from a size preset or a custom size, browse the template
 * gallery, reopen / rename / delete recent designs, and import .plakat.json files.
 */
import { useRef, useState, type JSX } from 'react';
import { parseDocument, PAGE_PRESETS, type PagePreset, type PageSize, type PhysicalUnit } from '@plakat/schema';
import type { ProjectSummary, TemplateSummary } from '../api/index.ts';
import { Dialog } from '../components/Dialog.tsx';
import { Icon } from '../components/Icon.tsx';
import { Menu } from '../components/Menu.tsx';
import { NumberField } from '../components/NumberField.tsx';
import { TemplateCard } from '../components/TemplateCard.tsx';
import { Button, EmptyState, Field, Select, Spinner, cx } from '../components/ui.tsx';
import { downloadDocumentFile } from '../export/design-file.ts';
import { downloadBlob } from '../export/download.ts';
import { CategoryChips, SearchInput } from '../panels/TemplatesPanel.tsx';
import { sizeFromInputs } from '../panels/properties/PageSettings.tsx';
import { formatPageSize, formatPhysical, formatPx, formatRelativeTime } from './format.ts';
import { templateCategories, useAsync, useTemplates } from './hooks.ts';
import { navigate } from './router.ts';
import { useServices } from './services.tsx';
import { errorMessage, toast } from './toasts.tsx';
import { useUseTemplate } from './UseTemplateDialog.tsx';

/** Label lines for a preset card: physical size first for print formats. */
export function presetSizeLabel(p: Pick<PagePreset, 'width' | 'height' | 'physical'>): { primary: string; secondary: string | null } {
  return p.physical ? { primary: formatPhysical(p.physical), secondary: formatPx(p) } : { primary: formatPx(p), secondary: null };
}

function PresetShape({ width, height }: { width: number; height: number }): JSX.Element {
  const max = 64;
  const k = max / Math.max(width, height);
  return (
    <span className="preset-card__shape-wrap" aria-hidden="true">
      <span className="preset-card__shape" style={{ width: Math.max(14, width * k), height: Math.max(14, height * k) }} />
    </span>
  );
}

function CustomSizeDialog({ open, onClose, onCreate }: { open: boolean; onClose: () => void; onCreate: (size: PageSize) => Promise<void> }): JSX.Element | null {
  const [w, setW] = useState(1200);
  const [h, setH] = useState(800);
  const [unit, setUnit] = useState<'px' | PhysicalUnit>('px');
  const [busy, setBusy] = useState(false);
  const valid = w > 0 && h > 0;
  const size = valid ? sizeFromInputs(w, h, unit) : null;
  const tooBig = !!size && (size.width > 20000 || size.height > 20000 || size.width < 1 || size.height < 1);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Custom size"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={!size || tooBig}
            onClick={async () => {
              if (!size) return;
              setBusy(true);
              try {
                await onCreate(size);
              } finally {
                setBusy(false);
              }
            }}
          >
            Create design
          </Button>
        </>
      }
    >
      <div className="custom-size">
        <NumberField label="Width" showLabel value={w} min={unit === 'px' ? 1 : 0.1} max={20000} precision={unit === 'px' ? 0 : 2} onChange={setW} />
        <span className="custom-size__x" aria-hidden="true">
          ×
        </span>
        <NumberField label="Height" showLabel value={h} min={unit === 'px' ? 1 : 0.1} max={20000} precision={unit === 'px' ? 0 : 2} onChange={setH} />
        <Field label="Unit">
          {(id) => (
            <Select
              id={id}
              value={unit}
              onChange={(e) => setUnit(e.target.value as 'px' | PhysicalUnit)}
              options={[
                { value: 'px', label: 'Pixels' },
                { value: 'mm', label: 'Millimeters' },
                { value: 'in', label: 'Inches' },
              ]}
            />
          )}
        </Field>
      </div>
      {size && <p className="section__hint">{tooBig ? 'Sizes must be between 1 and 20,000 px per side.' : `${formatPageSize(size)}${size.physical ? ` · ${formatPx(size)} (print exports at 300 dpi)` : ''}`}</p>}
    </Dialog>
  );
}

function RenameDialog({ project, onClose, onRename }: { project: ProjectSummary | null; onClose: () => void; onRename: (title: string) => Promise<void> }): JSX.Element | null {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [lastId, setLastId] = useState<string | null>(null);
  if (project && project.id !== lastId) {
    setLastId(project.id);
    setTitle(project.title);
  }
  const submit = async () => {
    setBusy(true);
    try {
      await onRename(title.trim() || 'Untitled design');
      onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!project}
      onClose={onClose}
      title="Rename design"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} onClick={() => void submit()}>
            Rename
          </Button>
        </>
      }
    >
      <Field label="Title">
        {(id) => (
          <input
            id={id}
            className="input"
            value={title}
            maxLength={500}
            data-autofocus=""
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
          />
        )}
      </Field>
    </Dialog>
  );
}

function ConfirmDialog({ open, title, body, confirmLabel, onConfirm, onClose }: { open: boolean; title: string; body: string; confirmLabel: string; onConfirm: () => Promise<void>; onClose: () => void }): JSX.Element | null {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} data-autofocus="">
            Cancel
          </Button>
          <Button
            variant="danger"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p>{body}</p>
    </Dialog>
  );
}

function ProjectCard({ p, onRename, onDelete, onDownload }: { p: ProjectSummary; onRename: () => void; onDelete: () => void; onDownload: () => void }): JSX.Element {
  return (
    <div className="proj-card">
      <a className="proj-card__main" href={`#/design/${encodeURIComponent(p.id)}`} aria-label={`Open ${p.title || 'Untitled design'}`}>
        <div
          className="proj-card__thumb"
          style={{
            aspectRatio: `${p.size.width} / ${p.size.height}`,
            ...(p.size.width / p.size.height >= 4 / 3 ? { width: 'calc(100% - 28px)' } : { height: 'calc(100% - 28px)' }),
          }}
        >
          {p.thumbnailUrl ? <img src={p.thumbnailUrl} alt="" loading="lazy" /> : <Icon name="page" size={28} />}
        </div>
      </a>
      <div className="proj-card__meta">
        <div className="proj-card__text">
          <div className="proj-card__title" title={p.title}>
            {p.title || 'Untitled design'}
          </div>
          <div className="proj-card__sub">
            {formatPx(p.size)}
            {p.pageCount > 1 ? ` · ${p.pageCount} pages` : ''} · {formatRelativeTime(p.updatedAt)}
          </div>
        </div>
        <Menu
          label={`${p.title} actions`}
          placement="bottom-end"
          items={[
            { id: 'open', label: 'Open', icon: 'edit', onSelect: () => navigate({ name: 'design', id: p.id }) },
            { id: 'rename', label: 'Rename', icon: 'text', onSelect: onRename },
            { id: 'file', label: 'Download design file', icon: 'file', onSelect: onDownload },
            { id: 'sep', separator: true },
            { id: 'delete', label: 'Delete', icon: 'trash', danger: true, onSelect: onDelete },
          ]}
          trigger={(props) => (
            <button {...props} type="button" className="icon-btn icon-btn--sm icon-btn--ghost" aria-label={`More actions for ${p.title || 'Untitled design'}`} title="More actions">
              <Icon name="more" size={16} />
            </button>
          )}
        />
      </div>
    </div>
  );
}

export function Home(): JSX.Element {
  const services = useServices();
  const { api, persistence } = services;
  const [busy, setBusy] = useState<string | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [renaming, setRenaming] = useState<ProjectSummary | null>(null);
  const [deleting, setDeleting] = useState<{ kind: 'project' | 'template'; id: string; title: string } | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const projects = useAsync(() => api.listProjects(), [api]);
  const templates = useTemplates(category, query);
  const allTemplates = useAsync(() => api.listTemplates({}), [api]);
  const categories = templateCategories(allTemplates.data ?? []);

  const useTpl = useUseTemplate();
  const create = async (key: string, source: Parameters<typeof persistence.createProject>[0]) => {
    setBusy(key);
    try {
      const id = await persistence.createProject(source);
      navigate({ name: 'design', id });
    } catch (e) {
      toast.error('Could not create the design', { detail: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const importFile = async (file: File) => {
    setBusy('import');
    try {
      const text = await file.text();
      const doc = parseDocument(text);
      if (doc.kind === 'template') {
        await api.importTemplate(text);
        toast.success(`Imported template “${doc.meta.title}”`);
        templates.reload();
        allTemplates.reload();
      } else {
        const id = await persistence.createProject({ document: doc });
        navigate({ name: 'design', id });
      }
    } catch (e) {
      toast.error(`Could not import ${file.name}`, { detail: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const renameProject = async (p: ProjectSummary, title: string) => {
    try {
      const r = await api.getProject(p.id);
      await api.saveProject(p.id, { ...r.document, meta: { ...r.document.meta, title } }, r.version);
      projects.reload();
    } catch (e) {
      toast.error('Could not rename the design', { detail: errorMessage(e) });
      throw e;
    }
  };

  const downloadProjectFile = async (p: ProjectSummary) => {
    try {
      const r = await api.getProject(p.id);
      await downloadDocumentFile(r.document);
    } catch (e) {
      toast.error('Could not download the design file', { detail: errorMessage(e) });
    }
  };

  const downloadTemplate = async (t: TemplateSummary) => {
    try {
      const { blob, filename } = await api.downloadTemplateFile(t.id);
      downloadBlob(blob, filename, blob.type);
    } catch (e) {
      toast.error('Could not download the template', { detail: errorMessage(e) });
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      if (deleting.kind === 'project') {
        await api.deleteProject(deleting.id);
        projects.reload();
      } else {
        await api.deleteTemplate(deleting.id);
        templates.reload();
        allTemplates.reload();
      }
      toast.success(`Deleted “${deleting.title}”`);
    } catch (e) {
      toast.error('Could not delete', { detail: errorMessage(e) });
      throw e;
    }
  };

  const projectList = projects.data ?? [];

  return (
    <div className="home">
      <header className="home__bar">
        <a className="brandmark" href="#/" aria-label="Plakat home">
          <span className="brandmark__logo" aria-hidden="true">
            P
          </span>
          <span className="brandmark__name">Plakat</span>
        </a>
        <div className="home__bar-actions">
          <Button icon="upload" busy={busy === 'import'} onClick={() => fileRef.current?.click()}>
            Import file
          </Button>
          <input
            ref={fileRef}
            type="file"
            hidden
            accept=".json,.plakat.json,application/json,application/vnd.plakat+json"
            aria-label="Choose a .plakat.json file to import"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void importFile(f);
            }}
          />
        </div>
      </header>

      <main className="home__main">
        <section className="home__hero" aria-labelledby="create-title">
          <h1 id="create-title" className="home__title">
            What will you design today?
          </h1>
          <div className="preset-row" role="list">
            {PAGE_PRESETS.map((p) => {
              const label = presetSizeLabel(p);
              return (
                <div role="listitem" key={p.id}>
                  <button type="button" className={cx('preset-card', busy === p.id && 'is-busy')} onClick={() => void create(p.id, { preset: p.id })} disabled={busy !== null}>
                    {busy === p.id ? (
                      <span className="preset-card__shape-wrap">
                        <Spinner size={20} />
                      </span>
                    ) : (
                      <PresetShape width={p.width} height={p.height} />
                    )}
                    <span className="preset-card__label">{p.label.replace(/\s*\(([^,()]+),.*\)$/, ' ($1)').replace(/\s*\([^)]*×[^)]*\)$/, '')}</span>
                    <span className="preset-card__size">{label.primary}</span>
                    {label.secondary && <span className="preset-card__size preset-card__size--muted">{label.secondary}</span>}
                  </button>
                </div>
              );
            })}
            <div role="listitem">
              <button type="button" className="preset-card preset-card--custom" onClick={() => setCustomOpen(true)} disabled={busy !== null}>
                <span className="preset-card__shape-wrap">
                  <Icon name="plus" size={26} />
                </span>
                <span className="preset-card__label">Custom size</span>
                <span className="preset-card__size">px, mm or in</span>
              </button>
            </div>
          </div>
        </section>

        <section className="home__section" aria-labelledby="recent-title">
          <div className="home__section-head">
            <h2 id="recent-title">Recent designs</h2>
          </div>
          {projects.loading && !projects.data ? (
            <div className="panel__center">
              <Spinner label="Loading designs" />
            </div>
          ) : projects.error && !projects.data ? (
            <EmptyState tone="error" title="Could not reach the Plakat server" action={<Button onClick={projects.reload}>Retry</Button>}>
              {errorMessage(projects.error)}
            </EmptyState>
          ) : projectList.length === 0 ? (
            <EmptyState icon="page" title="No designs yet" compact>
              Pick a size or a template above to start your first design.
            </EmptyState>
          ) : (
            <div className="proj-grid">
              {projectList.map((p) => (
                <ProjectCard
                  key={p.id}
                  p={p}
                  onRename={() => setRenaming(p)}
                  onDelete={() => setDeleting({ kind: 'project', id: p.id, title: p.title || 'Untitled design' })}
                  onDownload={() => void downloadProjectFile(p)}
                />
              ))}
            </div>
          )}
        </section>

        <section className="home__section" aria-labelledby="templates-title">
          <div className="home__section-head">
            <h2 id="templates-title">Templates</h2>
            <div className="home__search">
              <SearchInput value={query} onChange={setQuery} label="Search templates" />
            </div>
          </div>
          <CategoryChips categories={categories} value={category} onChange={setCategory} />
          {templates.loading && !templates.data ? (
            <div className="panel__center">
              <Spinner label="Loading templates" />
            </div>
          ) : templates.error && !templates.data ? (
            <EmptyState tone="error" title="Templates could not be loaded" action={<Button onClick={templates.reload}>Retry</Button>}>
              {errorMessage(templates.error)}
            </EmptyState>
          ) : (templates.data ?? []).length === 0 ? (
            <EmptyState icon="templates" title={query || category ? 'No matching templates' : 'No templates yet'} compact>
              {query || category ? 'Try another search or category.' : 'Import a .plakat.json template or save a design as a template.'}
            </EmptyState>
          ) : (
            <div className="tpl-grid">
              {(templates.data ?? []).map((t) => (
                <TemplateCard
                  key={t.id}
                  summary={t}
                  busy={busy === `tpl:${t.id}` || useTpl.busyKey === `tpl:${t.id}`}
                  onOpen={() => void useTpl.start({ templateId: t.id }, `tpl:${t.id}`)}
                  menu={[
                    { id: 'use', label: 'Use template', icon: 'sparkle', onSelect: () => void useTpl.start({ templateId: t.id }, `tpl:${t.id}`) },
                    { id: 'edit', label: t.builtIn ? 'Open template (read-only)' : 'Edit template', icon: 'edit', onSelect: () => navigate({ name: 'template', id: t.id }) },
                    { id: 'file', label: 'Download template file', icon: 'file', onSelect: () => void downloadTemplate(t) },
                    ...(t.builtIn
                      ? []
                      : [
                          { id: 'sep', separator: true as const },
                          { id: 'delete', label: 'Delete template', icon: 'trash' as const, danger: true, onSelect: () => setDeleting({ kind: 'template', id: t.id, title: t.title }) },
                        ]),
                  ]}
                />
              ))}
            </div>
          )}
        </section>
      </main>

      {useTpl.element}
      <CustomSizeDialog open={customOpen} onClose={() => setCustomOpen(false)} onCreate={(size) => create('custom', { preset: size })} />
      <RenameDialog project={renaming} onClose={() => setRenaming(null)} onRename={(title) => (renaming ? renameProject(renaming, title) : Promise.resolve())} />
      <ConfirmDialog
        open={!!deleting}
        title={deleting?.kind === 'template' ? 'Delete template?' : 'Delete design?'}
        body={`“${deleting?.title ?? ''}” will be deleted permanently.`}
        confirmLabel="Delete"
        onConfirm={confirmDelete}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}
