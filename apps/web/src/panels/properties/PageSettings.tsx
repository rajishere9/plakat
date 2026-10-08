/**
 * Shown when nothing is selected: page background (color / image), design size
 * (preset or custom, with optional content scaling) and, for templates, the slot list
 * and category.
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import { customPageSize, PAGE_PRESETS, type PageSize, type PhysicalUnit } from '@plakat/schema';
import { formatPageSize, formatPhysical, formatPx } from '../../app/format.ts';
import { useColorPalettes } from '../../app/hooks.ts';
import { useEd, useServices, useStoreApi } from '../../app/services.tsx';
import { errorMessage, toast } from '../../app/toasts.tsx';
import { ColorPicker } from '../../components/ColorPicker.tsx';
import { NumberField } from '../../components/NumberField.tsx';
import { Button, Checkbox, IconButton, Section, Select } from '../../components/ui.tsx';
import { IMAGE_ACCEPT } from '../../lib/images.ts';
import { getElementLabel, selectActivePage, selectActivePageIndex } from '../../store/index.ts';
import { uploadImageFile } from '../uploads.ts';
import { PropRow } from './shared.tsx';
import { SLOT_KIND_LABELS, SlotEditor } from './SlotSection.tsx';

type SizeUnit = 'px' | PhysicalUnit;

export function sizeFromInputs(width: number, height: number, unit: SizeUnit): PageSize {
  return customPageSize(width, height, unit);
}

export function PageSettings(): JSX.Element {
  const services = useServices();
  const store = useStoreApi();
  const page = useEd(selectActivePage);
  const pageIndex = useEd(selectActivePageIndex);
  const size = useEd((s) => s.document.size);
  const bgAsset = useEd((s) => (page.background.image && Object.hasOwn(s.document.assets, page.background.image.assetId) ? s.document.assets[page.background.image.assetId] : undefined));
  const palettes = useColorPalettes();
  const actions = () => store.getState().actions;
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const uploadBg = async (file: File) => {
    setUploading(true);
    try {
      const up = await uploadImageFile(file, services.api);
      actions().setPageBackground(page.id, { image: up });
    } catch (e) {
      toast.error('Background image upload failed', { detail: errorMessage(e) });
    } finally {
      setUploading(false);
    }
  };

  return (
    <>
      <Section title={`Page ${pageIndex + 1}`}>
        <PropRow label="Background">
          <ColorPicker
            label="Page background color"
            value={page.background.color}
            allowNone
            noneLabel="Transparent"
            palettes={palettes}
            showValue
            onChange={(c) => actions().setPageBackground(page.id, { color: c })}
          />
        </PropRow>
        <PropRow label="Image">
          {bgAsset ? (
            <div className="bg-image">
              <img src={bgAsset.src} alt="" />
              <IconButton label="Replace background image" icon="replace" size="sm" onClick={() => fileRef.current?.click()} />
              <IconButton label="Remove background image" icon="trash" size="sm" onClick={() => actions().setPageBackground(page.id, { image: null })} />
            </div>
          ) : (
            <Button size="sm" icon="upload" busy={uploading} onClick={() => fileRef.current?.click()}>
              Add image
            </Button>
          )}
          <input
            ref={fileRef}
            type="file"
            hidden
            accept={IMAGE_ACCEPT}
            aria-label="Choose a background image"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void uploadBg(f);
            }}
          />
        </PropRow>
      </Section>
      <DesignSizeSection size={size} />
      <TemplateSettings />
    </>
  );
}

export function DesignSizeSection({ size }: { size: PageSize }): JSX.Element {
  const store = useStoreApi();
  const [preset, setPreset] = useState<string>(size.presetId ?? 'custom');
  const [unit, setUnit] = useState<SizeUnit>(size.physical?.unit ?? 'px');
  const [w, setW] = useState<number>(size.physical?.width ?? size.width);
  const [h, setH] = useState<number>(size.physical?.height ?? size.height);
  const [scale, setScale] = useState(true);

  useEffect(() => {
    setPreset(size.presetId ?? 'custom');
    setUnit(size.physical?.unit ?? 'px');
    setW(size.physical?.width ?? Math.round(size.width));
    setH(size.physical?.height ?? Math.round(size.height));
  }, [size]);

  const target: PageSize | null =
    preset === 'custom' ? (w > 0 && h > 0 ? sizeFromInputs(w, h, unit) : null) : (() => {
      const p = PAGE_PRESETS.find((x) => x.id === preset);
      return p ? { width: p.width, height: p.height, presetId: p.id, physical: p.physical ? { ...p.physical } : null } : null;
    })();
  const unchanged = !!target && Math.abs(target.width - size.width) < 1e-6 && Math.abs(target.height - size.height) < 1e-6 && target.presetId === size.presetId;

  const apply = () => {
    if (!target) return;
    try {
      store.getState().actions.resizeDocument(target, { content: scale ? 'scale' : 'none' });
      toast.success(`Resized to ${formatPageSize(target)}`, { actions: [{ label: 'Undo', onClick: () => store.getState().actions.undo() }] });
    } catch (e) {
      toast.error('Could not resize the design', { detail: errorMessage(e) });
    }
  };

  return (
    <Section title="Design size">
      <p className="section__hint">
        {formatPageSize(size)}
        {size.physical ? ` · ${formatPx(size)}` : ''} · all pages
      </p>
      <Select
        aria-label="Size preset"
        value={preset}
        onChange={(e) => setPreset(e.target.value)}
        options={[
          ...PAGE_PRESETS.map((p) => ({ value: p.id, label: `${p.label}${p.physical ? '' : ` (${p.width} × ${p.height})`}` })),
          { value: 'custom', label: 'Custom size' },
        ]}
      />
      {preset === 'custom' && (
        <div className="prop-grid prop-grid--size">
          <NumberField label="Custom width" prefix="W" value={w} min={unit === 'px' ? 1 : 0.1} max={20000} precision={unit === 'px' ? 0 : 2} onChange={setW} />
          <NumberField label="Custom height" prefix="H" value={h} min={unit === 'px' ? 1 : 0.1} max={20000} precision={unit === 'px' ? 0 : 2} onChange={setH} />
          <Select
            aria-label="Unit"
            value={unit}
            onChange={(e) => setUnit(e.target.value as SizeUnit)}
            options={[
              { value: 'px', label: 'px' },
              { value: 'mm', label: 'mm' },
              { value: 'in', label: 'in' },
            ]}
          />
        </div>
      )}
      {target && !unchanged && (
        <>
          <p className="section__hint">
            New size: {target.physical ? `${formatPhysical(target.physical)} · ` : ''}
            {formatPx(target)}
          </p>
          <Checkbox label="Scale content to fit" checked={scale} onChange={setScale} />
          <Button size="sm" variant="primary" onClick={apply}>
            Resize design
          </Button>
        </>
      )}
    </Section>
  );
}

export function TemplateSettings(): JSX.Element {
  const store = useStoreApi();
  const doc = useEd((s) => s.document);
  const actions = () => store.getState().actions;
  const [category, setCategory] = useState(doc.template?.category ?? '');
  useEffect(() => setCategory(doc.template?.category ?? ''), [doc.template?.category]);

  if (doc.kind !== 'template' || !doc.template) {
    return (
      <Section title="Template">
        <p className="section__hint">
          Turn this design into an editable template: mark texts, images and colors as slots that people fill in when they use it. Use “Save as template” in the Share menu to keep this design and create a template copy.
        </p>
        <Button size="sm" icon="templates" onClick={() => actions().convertToTemplate()}>
          Convert to template
        </Button>
      </Section>
    );
  }

  const slots = doc.template.slots;
  const labelFor = (id: string) => {
    for (const p of doc.pages) {
      const el = p.elements.find((e) => e.id === id);
      if (el) return getElementLabel(el);
    }
    return id;
  };

  return (
    <Section title="Template">
      <label className="field">
        <span className="field__label">Category</span>
        <input
          className="input"
          value={category}
          placeholder="e.g. instagram-post"
          maxLength={100}
          onChange={(e) => setCategory(e.target.value)}
          onBlur={() => {
            const c = category.trim();
            if ((doc.template?.category ?? '') !== c) {
              try {
                actions().setTemplateCategory(c || null);
              } catch {
                /* toasted via lastError */
              }
            }
          }}
        />
      </label>
      <div className="section__subtitle">Slots ({slots.length})</div>
      {slots.length === 0 ? (
        <p className="section__hint">Select an element and choose “Mark as slot”.</p>
      ) : (
        <ol className="slot-list">
          {slots.map((s, i) => (
            <li key={s.id} className="slot-list__item">
              <button type="button" className="slot-list__main" onClick={() => actions().select(s.targets)} title="Select target elements">
                <span className={`badge badge--slot badge--${s.kind}`}>{SLOT_KIND_LABELS[s.kind]}</span>
                <span className="slot-list__label">{s.label || labelFor(s.targets[0] ?? '')}</span>
                {s.required && <span className="slot-list__req">Required</span>}
              </button>
              <IconButton label={`Move ${s.label} up`} icon="chevronUp" size="sm" disabled={i === 0} onClick={() => actions().moveSlot(s.id, i - 1)} />
              <IconButton label={`Move ${s.label} down`} icon="chevronDown" size="sm" disabled={i === slots.length - 1} onClick={() => actions().moveSlot(s.id, i + 1)} />
              <IconButton label={`Remove slot ${s.label}`} icon="trash" size="sm" onClick={() => actions().removeSlot(s.id)} />
            </li>
          ))}
        </ol>
      )}
      <Button size="sm" variant="ghost" onClick={() => actions().convertToDesign()}>
        Convert back to a design
      </Button>
    </Section>
  );
}

export { SlotEditor };
