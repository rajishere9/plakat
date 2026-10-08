/**
 * "Use template" fill step (document-schema.md §10): a form built from the template's
 * slots (text with max length / single-line rules, image pickers, color swatches from the
 * slot palette, required checks) with a live preview. The fills go to
 * `persistence.createProject({ template, fills })` → schema instantiateTemplate, which
 * validates them again. An empty field keeps the template's own content. Templates without
 * slots skip the form.
 */
import { useCallback, useMemo, useRef, useState, type JSX } from 'react';
import {
  applySlotFill,
  createImageAsset,
  listSlots,
  type Asset,
  type Id,
  type PlakatDocument,
  type SlotFills,
  type TemplateSlot,
} from '@plakat/schema';
import { PageThumbnail } from '../components/PageThumbnail.tsx';
import { Dialog } from '../components/Dialog.tsx';
import { Button, Field, Notice, cx } from '../components/ui.tsx';
import { uploadImageFile } from '../panels/uploads.ts';
import { navigate } from './router.ts';
import { useServices } from './services.tsx';
import { errorMessage, toast } from './toasts.tsx';

/** What the user entered per slot; empty values keep the template content. */
export type FillValue =
  | { kind: 'text'; text: string }
  | { kind: 'image'; image: { assetId: Id; asset: Asset } | null }
  | { kind: 'color'; color: string | null };

export type FillValues = Record<Id, FillValue>;

export function emptyFillValues(template: PlakatDocument): FillValues {
  const out: FillValues = {};
  for (const slot of template.template?.slots ?? []) {
    out[slot.id] = slot.kind === 'text' ? { kind: 'text', text: '' } : slot.kind === 'image' ? { kind: 'image', image: null } : { kind: 'color', color: null };
  }
  return out;
}

const chars = (s: string) => [...s].length;

/** Per-slot problems (slot id → message); empty when the form can be submitted. */
export function validateFillValues(slots: readonly TemplateSlot[], values: FillValues): Record<Id, string> {
  const errors: Record<Id, string> = {};
  for (const slot of slots) {
    const v = values[slot.id];
    if (slot.kind === 'text') {
      const text = v?.kind === 'text' ? v.text : '';
      if (slot.required && !text.trim()) errors[slot.id] = 'Required';
      else if (slot.maxLength !== null && chars(text) > slot.maxLength) errors[slot.id] = `At most ${slot.maxLength} characters`;
      else if (!slot.multiline && /[\r\n]/.test(text)) errors[slot.id] = 'Line breaks are not allowed';
    } else if (slot.kind === 'image') {
      if (slot.required && !(v?.kind === 'image' && v.image)) errors[slot.id] = 'Choose an image';
    } else if (slot.required && !(v?.kind === 'color' && v.color)) {
      errors[slot.id] = 'Choose a color';
    }
  }
  return errors;
}

/** SlotFills for instantiateTemplate: only the slots the user changed. */
export function buildSlotFills(slots: readonly TemplateSlot[], values: FillValues): SlotFills {
  const fills: SlotFills = {};
  for (const slot of slots) {
    const v = values[slot.id];
    if (!v) continue;
    if (slot.kind === 'text' && v.kind === 'text' && v.text.trim()) fills[slot.id] = { text: v.text };
    else if (slot.kind === 'image' && v.kind === 'image' && v.image) fills[slot.id] = { assetId: v.image.assetId, asset: v.image.asset };
    else if (slot.kind === 'color' && v.kind === 'color' && v.color) fills[slot.id] = { color: v.color };
  }
  return fills;
}

/** The template with every valid fill applied (preview only; invalid fills are skipped). */
export function previewDocument(template: PlakatDocument, fills: SlotFills): PlakatDocument {
  let doc = template;
  for (const [slotId, fill] of Object.entries(fills)) {
    try {
      doc = applySlotFill(doc, slotId, fill);
    } catch {
      /* shown as a field error instead */
    }
  }
  return doc;
}

export interface UseTemplateDialogProps {
  template: PlakatDocument | null;
  onClose: () => void;
  /** Creates the design (default flow: createProject + open it). */
  onCreate: (fills: SlotFills) => Promise<void>;
}

export function UseTemplateDialog({ template, onClose, onCreate }: UseTemplateDialogProps): JSX.Element | null {
  const services = useServices();
  const [values, setValues] = useState<FillValues>(() => (template ? emptyFillValues(template) : {}));
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<Id | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const fileInputs = useRef(new Map<Id, HTMLInputElement>());

  const slots = useMemo(() => (template ? listSlots(template) : []), [template]);
  const slotDefs = useMemo(() => slots.map((s) => s.slot), [slots]);
  const fills = useMemo(() => buildSlotFills(slotDefs, values), [slotDefs, values]);
  const preview = useMemo(() => (template ? previewDocument(template, fills) : null), [template, fills]);
  const errors = validateFillValues(slotDefs, values);
  const hasErrors = Object.keys(errors).length > 0;

  const set = useCallback((id: Id, v: FillValue) => setValues((vs) => ({ ...vs, [id]: v })), []);

  if (!template || !preview) return null;
  const page = preview.pages[Math.min(pageIndex, preview.pages.length - 1)]!;

  const pickImage = async (slotId: Id, file: File) => {
    setUploading(slotId);
    try {
      const uploaded = await uploadImageFile(file, services.api);
      const { id, asset } = createImageAsset(uploaded);
      set(slotId, { kind: 'image', image: { assetId: id, asset } });
    } catch (e) {
      toast.error('Upload failed', { detail: errorMessage(e) });
    } finally {
      setUploading(null);
    }
  };

  /** `asIs`: skip the form (required fields too) and keep the template's placeholders. */
  const submit = async (asIs = false) => {
    if (!asIs) {
      setTouched(true);
      if (hasErrors) return;
    }
    setBusy(true);
    setError(null);
    try {
      await onCreate(asIs ? {} : fills);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={`Use “${template.meta.title}”`}
      description="Fill in your content. Empty fields keep the template’s text and images, and you can change everything later in the editor."
      dismissible={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit(true)} disabled={busy || uploading !== null} title="Create the design with the template’s own text and images">
            Use as is
          </Button>
          <Button variant="primary" icon="sparkle" busy={busy} disabled={busy || uploading !== null || (touched && hasErrors)} onClick={() => void submit()}>
            Create design
          </Button>
        </>
      }
    >
      <form
        className="fill-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="fill-dialog__fields" role="group" aria-label="Template fields">
          {error && <Notice tone="error">{error}</Notice>}
          {slots.map(({ slot, value }, i) => {
            const v = values[slot.id];
            const err = touched ? errors[slot.id] : undefined;
            const label = (
              <>
                {slot.label || `Field ${i + 1}`}
                {slot.required && (
                  <span className="fill-dialog__req" aria-label="required">
                    {' '}
                    *
                  </span>
                )}
              </>
            );
            const hintFor = (extra?: string | null) =>
              slot.description || err || extra ? (
                <>
                  {slot.description && <span>{slot.description}</span>}
                  {err && (
                    <span className="fill-dialog__error" role="alert">
                      {err}
                    </span>
                  )}
                  {extra && <span className="fill-dialog__counter">{extra}</span>}
                </>
              ) : undefined;
            if (slot.kind === 'text') {
              const text = v?.kind === 'text' ? v.text : '';
              const counter = slot.maxLength !== null ? `${chars(text)} / ${slot.maxLength}` : null;
              const common = {
                className: cx('input', err && 'is-invalid'),
                value: text,
                placeholder: value ?? '',
                'aria-invalid': err ? true : undefined,
                'data-slot-id': slot.id,
                ...(i === 0 ? { 'data-autofocus': '' } : {}),
              };
              return (
                <Field key={slot.id} label={label} hint={hintFor(counter)}>
                  {(id) =>
                    slot.multiline ? (
                      <textarea id={id} rows={Math.min(4, Math.max(2, (value ?? '').split('\n').length))} {...common} onChange={(e) => set(slot.id, { kind: 'text', text: e.target.value })} />
                    ) : (
                      <input id={id} type="text" {...common} onChange={(e) => set(slot.id, { kind: 'text', text: e.target.value.replace(/[\r\n]+/g, ' ') })} />
                    )
                  }
                </Field>
              );
            }
            if (slot.kind === 'image') {
              const img = v?.kind === 'image' ? v.image : null;
              const current = img?.asset ?? (value && Object.hasOwn(template.assets, value) ? template.assets[value] : undefined);
              return (
                <Field key={slot.id} label={label} hint={hintFor()}>
                  {(id) => (
                    <div className="fill-dialog__image">
                      {current && <img src={current.src} alt="" className="fill-dialog__thumb" />}
                      <input
                        id={id}
                        ref={(el) => {
                          if (el) fileInputs.current.set(slot.id, el);
                          else fileInputs.current.delete(slot.id);
                        }}
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                        className="sr-only"
                        aria-label={`Image for ${slot.label || `field ${i + 1}`}`}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          e.target.value = '';
                          if (f) void pickImage(slot.id, f);
                        }}
                      />
                      <Button size="sm" icon="upload" busy={uploading === slot.id} disabled={uploading !== null} onClick={() => fileInputs.current.get(slot.id)?.click()}>
                        {img ? 'Choose another image' : 'Choose image…'}
                      </Button>
                      {img && (
                        <Button size="sm" variant="ghost" onClick={() => set(slot.id, { kind: 'image', image: null })}>
                          Keep template image
                        </Button>
                      )}
                    </div>
                  )}
                </Field>
              );
            }
            const color = v?.kind === 'color' ? v.color : null;
            const shown = color ?? value ?? '#000000';
            return (
              <Field key={slot.id} label={label} hint={hintFor()}>
                {(id) => (
                  <div className="fill-dialog__colors" role="group" aria-label={slot.label || `Color ${i + 1}`}>
                    {slot.palette.map((c) => (
                      <button
                        key={c}
                        type="button"
                        className={cx('fill-dialog__swatch', shown.toLowerCase() === c.toLowerCase() && 'is-active')}
                        style={{ background: c }}
                        aria-label={`Use color ${c}`}
                        aria-pressed={color?.toLowerCase() === c.toLowerCase()}
                        onClick={() => set(slot.id, { kind: 'color', color: c })}
                      />
                    ))}
                    <input
                      id={id}
                      type="color"
                      className="fill-dialog__color-input"
                      aria-label={`Custom color for ${slot.label || `color ${i + 1}`}`}
                      value={/^#[0-9a-f]{6}$/i.test(shown) ? shown : '#000000'}
                      onChange={(e) => set(slot.id, { kind: 'color', color: e.target.value })}
                    />
                  </div>
                )}
              </Field>
            );
          })}
          <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
        </div>
        <div className="fill-dialog__preview" aria-label="Preview">
          <PageThumbnail doc={preview} page={page} maxSide={360} delay={250} alt={`Preview of page ${pageIndex + 1}`} />
          {preview.pages.length > 1 && (
            <div className="fill-dialog__pages">
              {preview.pages.map((p, pi) => (
                <button key={p.id} type="button" className={cx('chip', pi === pageIndex && 'is-active')} aria-pressed={pi === pageIndex} onClick={() => setPageIndex(pi)}>
                  Page {pi + 1}
                </button>
              ))}
            </div>
          )}
        </div>
      </form>
    </Dialog>
  );
}

export type UseTemplateSource = { templateId: string } | { template: PlakatDocument };

/**
 * "Use template" entry point for Home / panels / the read-only template editor: loads the
 * template, shows the fill form when it has slots (else creates right away), then creates
 * the design and opens it. Render `element` once.
 */
export function useUseTemplate(): { start: (source: UseTemplateSource, key?: string) => Promise<void>; busyKey: string | null; element: JSX.Element | null } {
  const { api, persistence } = useServices();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [template, setTemplate] = useState<PlakatDocument | null>(null);

  const create = useCallback(
    async (doc: PlakatDocument, fills: SlotFills) => {
      const id = await persistence.createProject({ template: doc, fills });
      setTemplate(null);
      navigate({ name: 'design', id });
    },
    [persistence],
  );

  const start = useCallback(
    async (source: UseTemplateSource, key = 'use-template') => {
      setBusyKey(key);
      try {
        const doc = 'template' in source ? source.template : (await api.getTemplate(source.templateId)).document;
        if ((doc.template?.slots.length ?? 0) === 0) await create(doc, {});
        else setTemplate(doc);
      } catch (e) {
        toast.error('Could not create a design from this template', { detail: errorMessage(e) });
      } finally {
        setBusyKey(null);
      }
    },
    [api, create],
  );

  const element = template ? <UseTemplateDialog key={template.id} template={template} onClose={() => setTemplate(null)} onCreate={(fills) => create(template, fills)} /> : null;
  return { start, busyKey, element };
}
