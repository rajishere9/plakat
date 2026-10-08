/** Shape properties: kind, fill, stroke (color, width, dash), corner radius, sides, inner radius. */
import type { JSX } from 'react';
import type { ShapeElement, ShapeKind } from '@plakat/schema';
import { useColorPalettes } from '../../app/hooks.ts';
import { useStoreApi } from '../../app/services.tsx';
import { ColorPicker } from '../../components/ColorPicker.tsx';
import { NumberField } from '../../components/NumberField.tsx';
import { Slider } from '../../components/Slider.tsx';
import { Section, Segmented, Select } from '../../components/ui.tsx';
import { commonValue, patchElements, PropRow } from './shared.tsx';

const KIND_OPTIONS: { value: ShapeKind; label: string }[] = [
  { value: 'rect', label: 'Rectangle' },
  { value: 'ellipse', label: 'Ellipse' },
  { value: 'triangle', label: 'Triangle' },
  { value: 'polygon', label: 'Polygon' },
  { value: 'star', label: 'Star' },
  { value: 'line', label: 'Line' },
];

export type DashStyle = 'solid' | 'dashed' | 'dotted';

/** Dash pattern for a style, proportional to the stroke width. */
export function dashFor(style: DashStyle, strokeWidth: number): number[] {
  const w = Math.max(1, strokeWidth);
  if (style === 'dashed') return [w * 4, w * 3];
  if (style === 'dotted') return [w, w * 1.5];
  return [];
}

export function dashStyleOf(dash: readonly number[], strokeWidth: number): DashStyle | null {
  if (dash.length === 0) return 'solid';
  const w = Math.max(1, strokeWidth);
  if (dash.length === 2 && dash[0]! > w * 2) return 'dashed';
  if (dash.length === 2) return 'dotted';
  return null;
}

export function ShapeSection({ elements }: { elements: ShapeElement[] }): JSX.Element {
  const store = useStoreApi();
  const palettes = useColorPalettes();
  const actions = () => store.getState().actions;
  const ids = elements.map((e) => e.id);
  const patch = (field: string, p: Parameters<typeof patchElements>[3], label?: string) => patchElements(actions(), ids, field, p, label);

  const kind = commonValue(elements, (e) => e.shape);
  const fill = commonValue(elements, (e) => e.fill);
  const stroke = commonValue(elements, (e) => e.stroke);
  const strokeWidth = commonValue(elements, (e) => e.strokeWidth);
  const dashStyle = commonValue(elements, (e) => dashStyleOf(e.dash, e.strokeWidth));
  const cornerRadius = commonValue(elements, (e) => e.cornerRadius);
  const sides = commonValue(elements, (e) => e.sides);
  const innerRadius = commonValue(elements, (e) => e.innerRadius);
  const allLines = elements.every((e) => e.shape === 'line');
  const allRects = elements.every((e) => e.shape === 'rect');
  const polyOrStar = elements.every((e) => e.shape === 'polygon' || e.shape === 'star');
  const allStars = elements.every((e) => e.shape === 'star');
  const fillMixed = elements.length > 1 && fill === null && elements.some((e) => e.fill !== null);
  const strokeMixed = elements.length > 1 && stroke === null && elements.some((e) => e.stroke !== null);

  return (
    <Section title={allLines ? 'Line' : 'Shape'}>
      <Select
        aria-label="Shape type"
        value={kind ?? ''}
        onChange={(e) => e.target.value && patch('shape', { shape: e.target.value as ShapeKind }, 'Shape type')}
        options={[...(kind === null ? [{ value: '', label: 'Mixed' }] : []), ...KIND_OPTIONS]}
      />
      {!allLines && (
        <PropRow label="Fill">
          <ColorPicker label="Fill color" value={fill} mixed={fillMixed} allowNone noneLabel="No fill" palettes={palettes} showValue onChange={(c) => patch('fill', { fill: c }, 'Fill')} />
        </PropRow>
      )}
      <PropRow label="Stroke">
        <ColorPicker
          label="Stroke color"
          value={stroke}
          mixed={strokeMixed}
          allowNone
          noneLabel="No stroke"
          palettes={palettes}
          showValue
          onChange={(c) =>
            patch('stroke', c && elements.every((e) => e.strokeWidth === 0) ? { stroke: c, strokeWidth: 2 } : { stroke: c }, 'Stroke')
          }
        />
      </PropRow>
      {(stroke !== null || strokeMixed) && (
        <>
          <PropRow label="Stroke width">
            <NumberField label="Stroke width" suffix="px" value={strokeWidth} min={0} max={1000} step={1} precision={1} onChange={(v) => patch('strokeWidth', { strokeWidth: v }, 'Stroke width')} />
          </PropRow>
          <Segmented<DashStyle>
            label="Stroke style"
            size="sm"
            value={dashStyle}
            options={[
              { value: 'solid', label: 'Solid' },
              { value: 'dashed', label: 'Dashed' },
              { value: 'dotted', label: 'Dotted' },
            ]}
            onChange={(v) => actions().updateElements(ids, (el) => (el.type === 'shape' ? { dash: dashFor(v, el.strokeWidth) } : null), { label: 'Stroke style' })}
          />
        </>
      )}
      {allRects && (
        <Slider label="Corner radius" value={cornerRadius ?? 0} min={0} max={Math.max(1, Math.round(Math.min(...elements.map((e) => Math.min(e.width, e.height))) / 2))} onChange={(v) => patch('cornerRadius', { cornerRadius: v }, 'Corner radius')} onCommit={() => actions().breakCoalescing()} />
      )}
      {polyOrStar && (
        <Slider label={allStars ? 'Points' : 'Sides'} value={sides ?? 5} min={3} max={64} onChange={(v) => patch('sides', { sides: Math.round(v) }, allStars ? 'Points' : 'Sides')} onCommit={() => actions().breakCoalescing()} />
      )}
      {allStars && (
        <Slider
          label="Inner radius"
          value={innerRadius ?? 0.5}
          min={0.05}
          max={0.95}
          step={1}
          displayScale={100}
          suffix="%"
          onChange={(v) => patch('innerRadius', { innerRadius: v }, 'Inner radius')}
          onCommit={() => actions().breakCoalescing()}
        />
      )}
    </Section>
  );
}
