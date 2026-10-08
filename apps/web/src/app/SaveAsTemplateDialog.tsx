/**
 * "Save as template": choose which elements become slots (with labels, required flag,
 * text max length), a title and a category, then save a template COPY to the library
 * (persistence.saveAsTemplate → schema saveAsTemplate, fresh ids) or download it as a
 * portable .plakat.json file. The open design is not changed.
 */
import { useEffect, useMemo, useState, type JSX } from 'react';
import type { Id, PlakatDocument, PlakatElement, SlotSpec } from '@plakat/schema';
import { Dialog } from '../components/Dialog.tsx';
import { Button, Checkbox, Field, Notice } from '../components/ui.tsx';
import { downloadAsTemplateFile } from '../export/design-file.ts';
import { getElementLabel } from '../store/index.ts';
import { categoryLabel } from './format.ts';
import { useServices } from './services.tsx';
import { errorMessage, toast } from './toasts.tsx';

export interface SlotRow {
  elementId: Id;
  pageIndex: number;
  checked: boolean;
  kind: SlotSpec['kind'];
  label: string;
  required: boolean;
  /** Text slots only; null = unlimited. */
  maxLength: number | null;
  /** Color slots only. */
  property: 'fill' | 'stroke';
  /** Display only. */
  elementLabel: string;
  /** Text slots: characters of the current (placeholder) text, checked against maxLength. */
  textLength?: number;
}

/** Rows whose placeholder text is longer than their own maxLength (the template would be unusable as is). */
export function slotRowProblems(rows: readonly SlotRow[]): string[] {
  return rows
    .filter((r) => r.checked && r.kind === 'text' && r.maxLength !== null && (r.textLength ?? 0) > r.maxLength)
    .map((r) => `“${r.label.trim() || r.elementLabel}” has ${r.textLength} characters but allows at most ${r.maxLength}. Shorten the text or raise the limit.`);
}

function kindOf(el: PlakatElement): SlotSpec['kind'] {
  return el.type === 'text' ? 'text' : el.type === 'image' ? 'image' : 'color';
}

/**
 * Initial rows: every element of every page. Existing slots (when the document is a
 * template) are pre-checked with their settings; otherwise unlocked text and images are
 * pre-checked and shapes are not.
 */
export function initialSlotRows(doc: PlakatDocument): SlotRow[] {
  const existing = new Map<Id, NonNullable<PlakatDocument['template']>['slots'][number]>();
  for (const s of doc.template?.slots ?? []) for (const t of s.targets) if (!existing.has(t)) existing.set(t, s);
  const rows: SlotRow[] = [];
  doc.pages.forEach((page, pageIndex) => {
    for (const el of [...page.elements].reverse()) {
      const slot = existing.get(el.id);
      const kind = slot?.kind ?? kindOf(el);
      rows.push({
        elementId: el.id,
        pageIndex,
        checked: slot ? true : doc.template?.slots.length ? false : !el.locked && el.type !== 'shape',
        kind,
        label: slot?.label ?? (el.name || getElementLabel(el)),
        required: slot?.required ?? false,
        maxLength: slot?.kind === 'text' ? slot.maxLength : null,
        property: slot?.kind === 'color' ? slot.property : el.type === 'shape' && (el.shape === 'line' || (el.fill === null && el.stroke !== null)) ? 'stroke' : 'fill',
        elementLabel: getElementLabel(el),
        textLength: el.type === 'text' ? [...el.content].length : 0,
      });
    }
  });
  return rows;
}

/** Slot specs for saveAsTemplate(), in row order, from the checked rows. */
export function buildSlotSpecs(rows: readonly SlotRow[]): SlotSpec[] {
  return rows
    .filter((r) => r.checked)
    .map((r): SlotSpec => {
      const common = { targets: [r.elementId], label: r.label.trim() || r.elementLabel, required: r.required };
      if (r.kind === 'text') return { ...common, kind: 'text', maxLength: r.maxLength };
      if (r.kind === 'image') return { ...common, kind: 'image' };
      return { ...common, kind: 'color', property: r.property };
    });
}

export interface SaveAsTemplateInput {
  slots: SlotSpec[];
  title: string;
  category: string | null;
}

export interface SaveAsTemplateDialogProps {
  open: boolean;
  onClose: () => void;
  document: PlakatDocument;
  /** Default: persistence.saveAsTemplate. */
  onSave?: (input: SaveAsTemplateInput) => Promise<unknown>;
  /** Default: bundle + download a .plakat.json file. */
  onDownload?: (input: SaveAsTemplateInput) => Promise<unknown>;
  /** Known categories for suggestions. */
  categories?: string[];
}

export function SaveAsTemplateDialog({ open, onClose, document: doc, onSave, onDownload, categories = [] }: SaveAsTemplateDialogProps): JSX.Element | null {
  const services = useServices();
  const [rows, setRows] = useState<SlotRow[]>([]);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [busy, setBusy] = useState<'save' | 'download' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setRows(initialSlotRows(doc));
    setTitle(doc.meta.title || 'Untitled template');
    setCategory(doc.template?.category ?? doc.size.presetId ?? '');
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const patch = (id: Id, p: Partial<SlotRow>) => setRows((rs) => rs.map((r) => (r.elementId === id ? { ...r, ...p } : r)));
  const input = (): SaveAsTemplateInput => ({ slots: buildSlotSpecs(rows), title: title.trim() || 'Untitled template', category: category.trim() || null });
  const checkedCount = rows.filter((r) => r.checked).length;
  const pages = useMemo(() => [...new Set(rows.map((r) => r.pageIndex))], [rows]);
  const suggestions = useMemo(() => [...new Set([...(doc.size.presetId ? [doc.size.presetId] : []), ...categories])], [categories, doc.size.presetId]);

  const run = async (kind: 'save' | 'download') => {
    const problems = slotRowProblems(rows);
    if (problems.length) {
      setError(problems.join(' '));
      return;
    }
    setBusy(kind);
    setError(null);
    try {
      if (kind === 'save') {
        await (onSave ?? ((i) => services.persistence.saveAsTemplate(i)))(input());
        toast.success(`Saved “${input().title}” to your templates`);
      } else {
        await (onDownload ?? ((i) => downloadAsTemplateFile(doc, i)))(input());
      }
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Save as template"
      description="Choose the parts people can change when they use this template. A copy is saved; your design stays as it is."
      dismissible={busy === null}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy !== null}>
            Cancel
          </Button>
          <Button icon="download" busy={busy === 'download'} disabled={busy !== null} onClick={() => void run('download')}>
            Download template file
          </Button>
          <Button variant="primary" icon="templates" busy={busy === 'save'} disabled={busy !== null} onClick={() => void run('save')}>
            Save to templates
          </Button>
        </>
      }
    >
      <div className="tpl-dialog">
        <div className="tpl-dialog__meta">
          <Field label="Template name">
            {(id) => <input id={id} className="input" value={title} maxLength={500} onChange={(e) => setTitle(e.target.value)} data-autofocus="" />}
          </Field>
          <Field label="Category" hint={category ? categoryLabel(category) : 'Optional; used for the gallery filter'}>
            {(id) => (
              <>
                <input id={id} className="input" list={`${id}-list`} value={category} maxLength={100} placeholder="e.g. instagram-post" onChange={(e) => setCategory(e.target.value)} />
                <datalist id={`${id}-list`}>
                  {suggestions.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              </>
            )}
          </Field>
        </div>
        <div className="tpl-dialog__slots" role="group" aria-label="Editable elements">
          <div className="tpl-dialog__count">
            {checkedCount} editable element{checkedCount === 1 ? '' : 's'}
          </div>
          {rows.length === 0 && <p className="section__hint">This design has no elements yet.</p>}
          {pages.map((pi) => (
            <div key={pi} className="tpl-dialog__page">
              {doc.pages.length > 1 && <div className="tpl-dialog__page-title">Page {pi + 1}</div>}
              {rows
                .filter((r) => r.pageIndex === pi)
                .map((r) => (
                  <div key={r.elementId} className={`slot-row${r.checked ? ' is-checked' : ''}`} data-testid={`slot-row-${r.elementId}`}>
                    <Checkbox label={<span className="sr-only">Editable: {r.elementLabel}</span>} checked={r.checked} onChange={(v) => patch(r.elementId, { checked: v })} />
                    <span className={`badge badge--slot badge--${r.kind}`}>{r.kind === 'color' ? 'Color' : r.kind === 'text' ? 'Text' : 'Image'}</span>
                    <input
                      className="input slot-row__label"
                      aria-label={`Slot label for ${r.elementLabel}`}
                      value={r.label}
                      maxLength={200}
                      disabled={!r.checked}
                      onChange={(e) => patch(r.elementId, { label: e.target.value })}
                    />
                    {r.kind === 'text' && (
                      <input
                        className={`input slot-row__max${r.checked && r.maxLength !== null && (r.textLength ?? 0) > r.maxLength ? ' is-invalid' : ''}`}
                        aria-label={`Maximum characters for ${r.elementLabel}`}
                        placeholder="Max"
                        inputMode="numeric"
                        disabled={!r.checked}
                        value={r.maxLength ?? ''}
                        onChange={(e) => {
                          const n = parseInt(e.target.value, 10);
                          patch(r.elementId, { maxLength: Number.isFinite(n) && n > 0 ? n : null });
                        }}
                      />
                    )}
                    <Checkbox label="Required" checked={r.required} disabled={!r.checked} onChange={(v) => patch(r.elementId, { required: v })} aria-label={`Required: ${r.elementLabel}`} />
                  </div>
                ))}
            </div>
          ))}
        </div>
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Dialog>
  );
}
