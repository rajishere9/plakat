/**
 * Template slots: mark the selected element as a slot (kind inferred from the element
 * type) and edit its settings; the full slot list lives in the page settings view.
 */
import type { JSX } from 'react';
import type { PlakatElement, SlotSpec, TemplateSlot } from '@plakat/schema';
import { useEd, useStoreApi } from '../../app/services.tsx';
import { NumberField } from '../../components/NumberField.tsx';
import { Button, Checkbox, IconButton, Section, Select } from '../../components/ui.tsx';
import { selectSlotsByElement } from '../../store/index.ts';

export const SLOT_KIND_LABELS: Record<TemplateSlot['kind'], string> = { text: 'Text', image: 'Image', color: 'Color' };

/** The slot spec inferred for an element (text→text, image→image, shape→color). */
export function inferSlotSpec(el: PlakatElement, label?: string): SlotSpec {
  const base = { targets: [el.id], ...(label ? { label } : {}) };
  if (el.type === 'text') return { ...base, kind: 'text' };
  if (el.type === 'image') return { ...base, kind: 'image' };
  return { ...base, kind: 'color', property: el.shape === 'line' || (el.fill === null && el.stroke !== null) ? 'stroke' : 'fill' };
}

export function SlotEditor({ slot }: { slot: TemplateSlot }): JSX.Element {
  const store = useStoreApi();
  const actions = () => store.getState().actions;
  const guard = (fn: () => void) => {
    try {
      fn();
    } catch {
      /* lastError is set by the store and toasted by the shell */
    }
  };
  return (
    <div className="slot-editor">
      <div className="slot-editor__head">
        <span className={`badge badge--slot badge--${slot.kind}`}>{SLOT_KIND_LABELS[slot.kind]} slot</span>
        <IconButton label={`Remove slot ${slot.label}`} icon="trash" size="sm" onClick={() => guard(() => actions().removeSlot(slot.id))} />
      </div>
      <label className="field">
        <span className="field__label">Label</span>
        <input className="input" value={slot.label} maxLength={200} onChange={(e) => guard(() => actions().updateSlot(slot.id, { label: e.target.value }))} />
      </label>
      <Checkbox label="Required" checked={slot.required} onChange={(v) => guard(() => actions().updateSlot(slot.id, { required: v }))} />
      {slot.kind === 'text' && (
        <>
          <div className="prop-row">
            <span className="prop-row__label">Max length</span>
            <NumberField
              label="Maximum characters (empty = unlimited)"
              value={slot.maxLength}
              min={1}
              max={100000}
              onChange={(v) => guard(() => actions().updateSlot(slot.id, { maxLength: Math.round(v) }))}
            />
            {slot.maxLength !== null && (
              <IconButton label="Remove length limit" icon="close" size="sm" onClick={() => guard(() => actions().updateSlot(slot.id, { maxLength: null }))} />
            )}
          </div>
          <Checkbox label="Allow line breaks" checked={slot.multiline} onChange={(v) => guard(() => actions().updateSlot(slot.id, { multiline: v }))} />
        </>
      )}
      {slot.kind === 'image' && (
        <Select
          aria-label="Image slot fit"
          value={slot.fit}
          onChange={(e) => guard(() => actions().updateSlot(slot.id, { fit: e.target.value as 'cover' | 'contain' }))}
          options={[
            { value: 'cover', label: 'Fill the frame (crop)' },
            { value: 'contain', label: 'Fit inside the frame' },
          ]}
        />
      )}
      {slot.kind === 'color' && (
        <Select
          aria-label="Color slot property"
          value={slot.property}
          onChange={(e) => guard(() => actions().updateSlot(slot.id, { property: e.target.value as 'fill' | 'stroke' }))}
          options={[
            { value: 'fill', label: 'Fill color' },
            { value: 'stroke', label: 'Stroke color' },
          ]}
        />
      )}
    </div>
  );
}

export function SlotSection({ element }: { element: PlakatElement }): JSX.Element {
  const store = useStoreApi();
  const slots = useEd(selectSlotsByElement).get(element.id) ?? [];
  return (
    <Section title="Template slot">
      {slots.length === 0 ? (
        <>
          <p className="section__hint">Make this element editable when someone uses the template.</p>
          <Button
            size="sm"
            icon="slot"
            onClick={() => {
              try {
                store.getState().actions.addSlot(inferSlotSpec(element));
              } catch {
                /* toasted via lastError */
              }
            }}
          >
            Mark as {element.type === 'shape' ? 'color' : element.type} slot
          </Button>
        </>
      ) : (
        slots.map((s) => <SlotEditor key={s.id} slot={s} />)
      )}
    </Section>
  );
}
