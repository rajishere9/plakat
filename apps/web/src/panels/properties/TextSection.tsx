/** Text properties: font family/weight/style, size, spacing, alignment, color, decoration, case. */
import type { JSX } from 'react';
import type { BrandFontRole, FontWeight, TextAlign, TextElement, TextTransform, VerticalAlign } from '@plakat/schema';
import { useColorPalettes } from '../../app/hooks.ts';
import { useEd, useStoreApi } from '../../app/services.tsx';
import { ColorPicker } from '../../components/ColorPicker.tsx';
import { FontPicker } from '../../components/FontPicker.tsx';
import { NumberField } from '../../components/NumberField.tsx';
import { Button, IconButton, Section, Segmented, Select } from '../../components/ui.tsx';
import { availableWeights, canItalic, canToggleBold, FONT_WEIGHT_NAMES, isBold } from '../../lib/fonts.ts';
import { selectActiveBrandKit } from '../../store/index.ts';
import { ROLE_LABELS } from '../TextPanel.tsx';
import { commonValue, patchElements } from './shared.tsx';

const ALIGN_OPTIONS = [
  { value: 'left', label: 'Align left', icon: 'textAlignLeft' },
  { value: 'center', label: 'Align center', icon: 'textAlignCenter' },
  { value: 'right', label: 'Align right', icon: 'textAlignRight' },
  { value: 'justify', label: 'Justify', icon: 'textAlignJustify' },
] as const;

const VALIGN_OPTIONS = [
  { value: 'top', label: 'Top', icon: 'vAlignTop' },
  { value: 'middle', label: 'Middle', icon: 'vAlignMiddle' },
  { value: 'bottom', label: 'Bottom', icon: 'vAlignBottom' },
] as const;

const TRANSFORM_OPTIONS: { value: TextTransform; label: string }[] = [
  { value: 'none', label: 'As typed' },
  { value: 'uppercase', label: 'UPPERCASE' },
  { value: 'lowercase', label: 'lowercase' },
  { value: 'capitalize', label: 'Capitalize Words' },
];

export function TextSection({ elements }: { elements: TextElement[] }): JSX.Element {
  const store = useStoreApi();
  const kit = useEd(selectActiveBrandKit);
  const docFonts = useEd((s) => s.document.fonts);
  const palettes = useColorPalettes();
  const actions = () => store.getState().actions;
  const ids = elements.map((e) => e.id);
  const patch = (field: string, p: Parameters<typeof patchElements>[3], label?: string) => patchElements(actions(), ids, field, p, label);

  const family = commonValue(elements, (e) => e.fontFamily);
  const weight = commonValue(elements, (e) => e.fontWeight);
  const style = commonValue(elements, (e) => e.fontStyle);
  const fontSize = commonValue(elements, (e) => e.fontSize);
  const lineHeight = commonValue(elements, (e) => e.lineHeight);
  const letterSpacing = commonValue(elements, (e) => e.letterSpacing);
  const align = commonValue(elements, (e) => e.align);
  const vAlign = commonValue(elements, (e) => e.verticalAlign);
  const fill = commonValue(elements, (e) => e.fill);
  const decoration = commonValue(elements, (e) => e.textDecoration);
  const transform = commonValue(elements, (e) => e.textTransform);
  const first = elements[0]!;
  const weights = availableWeights(family ?? first.fontFamily, style ?? 'normal');
  const bold = elements.every((e) => isBold(e.fontWeight));
  const italic = elements.every((e) => e.fontStyle === 'italic');
  const brandFonts = (kit?.fonts ?? []).map((f) => ({ family: f.family, role: ROLE_LABELS[f.role] }));
  const brandRoles = (kit?.fonts ?? []).map((f) => f.role as BrandFontRole);

  return (
    <Section
      title="Text"
      actions={
        elements.length === 1 ? (
          <Button size="sm" variant="ghost" icon="edit" onClick={() => actions().startTextEditing(first.id)}>
            Edit
          </Button>
        ) : undefined
      }
    >
      <FontPicker
        label="Font"
        value={family}
        brandFonts={brandFonts}
        documentFonts={docFonts.map((f) => f.family)}
        onChange={(f) => actions().setFontFamily(ids, f)}
        className="font-trigger--block"
      />
      <div className="prop-grid prop-grid--text">
        <Select
          aria-label="Font weight"
          value={weight === null ? '' : String(weight)}
          onChange={(e) => e.target.value && patch('fontWeight', { fontWeight: Number(e.target.value) as FontWeight }, 'Font weight')}
          options={[...(weight === null ? [{ value: '', label: 'Mixed' }] : []), ...weights.map((w) => ({ value: String(w), label: FONT_WEIGHT_NAMES[w] }))]}
        />
        <NumberField label="Font size" suffix="px" value={fontSize} min={1} max={5000} step={1} precision={1} onChange={(v) => patch('fontSize', { fontSize: v }, 'Font size')} />
      </div>
      <div className="btn-row" role="group" aria-label="Text style">
        <IconButton label="Bold" tooltip="Bold" icon="bold" pressed={bold} disabled={!elements.every((e) => canToggleBold(e.fontFamily, e.fontStyle))} onClick={() => actions().toggleBold(ids)} />
        <IconButton label="Italic" icon="italic" pressed={italic} disabled={!elements.every((e) => canItalic(e.fontFamily, e.fontWeight))} onClick={() => actions().toggleItalic(ids)} />
        <IconButton
          label="Underline"
          icon="underline"
          pressed={decoration === 'underline'}
          onClick={() => patch('textDecoration', { textDecoration: decoration === 'underline' ? 'none' : 'underline' }, 'Underline')}
        />
        <IconButton
          label="Strikethrough"
          icon="strikethrough"
          pressed={decoration === 'line-through'}
          onClick={() => patch('textDecoration', { textDecoration: decoration === 'line-through' ? 'none' : 'line-through' }, 'Strikethrough')}
        />
        <span className="btn-row__sep" aria-hidden="true" />
        <ColorPicker
          label="Text color"
          value={fill}
          mixed={fill === null}
          palettes={palettes}
          onChange={(c) => c && patch('fill', { fill: c }, 'Text color')}
        />
      </div>
      <Segmented<TextAlign> label="Text alignment" iconsOnly value={align} options={ALIGN_OPTIONS} onChange={(v) => patch('align', { align: v }, 'Text alignment')} />
      <Segmented<VerticalAlign>
        label="Vertical alignment"
        iconsOnly
        value={vAlign}
        options={VALIGN_OPTIONS}
        onChange={(v) => patch('verticalAlign', { verticalAlign: v }, 'Vertical alignment')}
      />
      <div className="prop-grid">
        <NumberField
          label="Line height"
          prefix="↕"
          value={lineHeight}
          min={0.5}
          max={5}
          step={0.05}
          precision={2}
          onChange={(v) => patch('lineHeight', { lineHeight: v }, 'Line height')}
        />
        <NumberField
          label="Letter spacing (em)"
          prefix="↔"
          suffix="em"
          value={letterSpacing}
          min={-1}
          max={5}
          step={0.01}
          precision={3}
          onChange={(v) => patch('letterSpacing', { letterSpacing: v }, 'Letter spacing')}
        />
      </div>
      <Select
        aria-label="Letter case"
        value={transform ?? ''}
        onChange={(e) => e.target.value && patch('textTransform', { textTransform: e.target.value as TextTransform }, 'Letter case')}
        options={[...(transform === null ? [{ value: '', label: 'Mixed' }] : []), ...TRANSFORM_OPTIONS]}
      />
      {brandRoles.length > 0 && (
        <div className="chips" role="group" aria-label="Apply brand font">
          {brandRoles.map((role) => (
            <button key={role} type="button" className="chip" onClick={() => actions().applyBrandFont(role, { ids })}>
              {ROLE_LABELS[role]}
            </button>
          ))}
        </div>
      )}
    </Section>
  );
}
