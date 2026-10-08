/**
 * Templates flyout: browse/search the template library and apply a template to the
 * open design (see template-apply.ts for the behaviour), or start a new design from it.
 */
import { useState, type JSX } from 'react';
import type { TemplateSummary } from '../api/index.ts';
import { categoryLabel } from '../app/format.ts';
import { templateCategories, useAsync, useTemplates } from '../app/hooks.ts';
import { useServices, useStoreApi } from '../app/services.tsx';
import { useUseTemplate } from '../app/UseTemplateDialog.tsx';
import { errorMessage, toast } from '../app/toasts.tsx';
import { Icon } from '../components/Icon.tsx';
import { TemplateCard } from '../components/TemplateCard.tsx';
import { Button, EmptyState, Spinner, cx } from '../components/ui.tsx';
import { PanelShell } from './PanelShell.tsx';
import { applyTemplateToDocument, defaultApplyMode, sameSize, type ApplyTemplateMode } from './template-apply.ts';

export function SearchInput({ value, onChange, label, placeholder }: { value: string; onChange: (v: string) => void; label: string; placeholder?: string }): JSX.Element {
  return (
    <div className="search">
      <Icon name="search" size={16} />
      <input type="search" aria-label={label} placeholder={placeholder ?? label} value={value} onChange={(e) => onChange(e.target.value)} />
      {value && (
        <button type="button" className="search__clear" aria-label="Clear search" onClick={() => onChange('')}>
          <Icon name="close" size={14} />
        </button>
      )}
    </div>
  );
}

export function CategoryChips({ categories, value, onChange }: { categories: string[]; value: string | null; onChange: (c: string | null) => void }): JSX.Element | null {
  if (categories.length === 0) return null;
  return (
    <div className="chips" role="group" aria-label="Filter by category">
      <button type="button" className={cx('chip', value === null && 'is-active')} aria-pressed={value === null} onClick={() => onChange(null)}>
        All
      </button>
      {categories.map((c) => (
        <button key={c} type="button" className={cx('chip', value === c && 'is-active')} aria-pressed={value === c} onClick={() => onChange(value === c ? null : c)}>
          {categoryLabel(c)}
        </button>
      ))}
    </div>
  );
}

export function TemplatesPanel({ onClose }: { onClose?: () => void }): JSX.Element {
  const services = useServices();
  const store = useStoreApi();
  const [category, setCategory] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const list = useTemplates(category, query);
  const all = useAsync(() => services.api.listTemplates({}), [services.api]);
  const categories = templateCategories(all.data ?? []);

  const apply = async (t: TemplateSummary, mode?: ApplyTemplateMode) => {
    setBusyId(t.id);
    try {
      const { document: template } = await services.api.getTemplate(t.id);
      const s = store.getState();
      const m = mode ?? defaultApplyMode(s.document, s.activePageId);
      const activePageId = s.activePageId;
      let first: string | undefined;
      s.actions.commit(
        m === 'replace-page' ? 'Apply template' : 'Add template pages',
        (_d, base) => {
          const r = applyTemplateToDocument(base, template, activePageId, m);
          first = r.pageIds[0];
          return r.document;
        },
        { select: [] },
      );
      if (first) store.getState().actions.setActivePage(first);
      const scaled = !sameSize(template.size, s.document.size);
      toast.success(m === 'replace-page' ? `Applied “${t.title}”` : `Added “${t.title}” as new page${template.pages.length > 1 ? 's' : ''}`, {
        detail: scaled ? 'The template was scaled to fit this design’s size.' : undefined,
        actions: [{ label: 'Undo', onClick: () => store.getState().actions.undo() }],
      });
    } catch (e) {
      toast.error('Could not apply the template', { detail: errorMessage(e) });
    } finally {
      setBusyId(null);
    }
  };

  const useTpl = useUseTemplate();
  const useInNewDesign = (t: TemplateSummary) => useTpl.start({ templateId: t.id }, t.id);

  return (
    <PanelShell
      title="Templates"
      onClose={onClose}
      header={
        <>
          <SearchInput value={query} onChange={setQuery} label="Search templates" />
          <CategoryChips categories={categories} value={category} onChange={setCategory} />
        </>
      }
    >
      <p className="panel__hint">
        Click a template to apply it: an empty page is replaced, otherwise the template is added as new pages after the current one. Content is scaled to fit this design’s size.
      </p>
      {list.loading && !list.data ? (
        <div className="panel__center">
          <Spinner label="Loading templates" />
        </div>
      ) : list.error && !list.data ? (
        <EmptyState tone="error" title="Templates could not be loaded" action={<Button onClick={list.reload}>Retry</Button>} compact>
          {errorMessage(list.error)}
        </EmptyState>
      ) : (list.data ?? []).length === 0 ? (
        <EmptyState icon="templates" title={query || category ? 'No matching templates' : 'No templates yet'} compact>
          {query || category ? 'Try another search or category.' : 'Save a design as a template to see it here.'}
        </EmptyState>
      ) : (
        <div className="tpl-grid tpl-grid--panel">
          {(list.data ?? []).map((t) => (
            <TemplateCard
              key={t.id}
              summary={t}
              compact
              busy={busyId === t.id || useTpl.busyKey === t.id}
              actionLabel="Apply template"
              onOpen={() => void apply(t)}
              menu={[
                { id: 'replace', label: 'Replace current page', icon: 'replace', onSelect: () => void apply(t, 'replace-page') },
                { id: 'add', label: 'Add as new page(s)', icon: 'plus', onSelect: () => void apply(t, 'add-pages') },
                { id: 'sep', separator: true },
                { id: 'new', label: 'Use in a new design', icon: 'external', onSelect: () => void useInNewDesign(t) },
              ]}
            />
          ))}
        </div>
      )}
      {useTpl.element}
    </PanelShell>
  );
}
