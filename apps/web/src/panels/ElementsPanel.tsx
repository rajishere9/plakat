/** Elements flyout: basic shapes (click to add, centered on the active page). */
import type { JSX } from 'react';
import { getShapePoints, type ShapeElement, type ShapeKind } from '@plakat/schema';
import { useEd, useStoreApi } from '../app/services.tsx';
import { selectActiveBrandKit } from '../store/index.ts';
import { PanelShell } from './PanelShell.tsx';

export interface ShapePreset {
  id: string;
  label: string;
  shape: ShapeKind;
  /** Extra fields; `cornerRadiusFraction` is relative to the shape's short side. */
  partial?: Partial<Omit<ShapeElement, 'id' | 'type' | 'shape'>>;
  cornerRadiusFraction?: number;
  dashed?: boolean;
}

export const SHAPE_PRESETS: readonly ShapePreset[] = [
  { id: 'rect', label: 'Rectangle', shape: 'rect' },
  { id: 'rounded-rect', label: 'Rounded rectangle', shape: 'rect', cornerRadiusFraction: 0.16 },
  { id: 'ellipse', label: 'Circle', shape: 'ellipse' },
  { id: 'triangle', label: 'Triangle', shape: 'triangle' },
  { id: 'pentagon', label: 'Pentagon', shape: 'polygon', partial: { sides: 5 } },
  { id: 'hexagon', label: 'Hexagon', shape: 'polygon', partial: { sides: 6 } },
  { id: 'star', label: 'Star', shape: 'star', partial: { sides: 5, innerRadius: 0.45 } },
  { id: 'burst', label: 'Burst', shape: 'star', partial: { sides: 12, innerRadius: 0.72 } },
  { id: 'line', label: 'Line', shape: 'line' },
  { id: 'dashed-line', label: 'Dashed line', shape: 'line', dashed: true },
];

export const DEFAULT_SHAPE_FILL = '#8b7cf6';

function ShapeGlyph({ preset }: { preset: ShapePreset }): JSX.Element {
  const s = 40;
  const common = { fill: 'currentColor', stroke: 'none' } as const;
  let body: JSX.Element;
  switch (preset.shape) {
    case 'rect':
      body = <rect x={4} y={4} width={s - 8} height={s - 8} rx={preset.cornerRadiusFraction ? 7 : 1} {...common} />;
      break;
    case 'ellipse':
      body = <circle cx={s / 2} cy={s / 2} r={s / 2 - 4} {...common} />;
      break;
    case 'line':
      body = <line x1={4} y1={s / 2} x2={s - 4} y2={s / 2} stroke="currentColor" strokeWidth={3} strokeDasharray={preset.dashed ? '6 4' : undefined} strokeLinecap="butt" />;
      break;
    default: {
      const pts = getShapePoints(preset.shape, s - 8, s - 8, preset.partial?.sides ?? 5, preset.partial?.innerRadius ?? 0.5) ?? [];
      const d: string[] = [];
      for (let i = 0; i < pts.length; i += 2) d.push(`${(pts[i] ?? 0) + 4},${(pts[i + 1] ?? 0) + 4}`);
      body = <polygon points={d.join(' ')} {...common} />;
    }
  }
  return (
    <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} aria-hidden="true">
      {body}
    </svg>
  );
}

export function ElementsPanel({ onClose }: { onClose?: () => void }): JSX.Element {
  const store = useStoreApi();
  const kit = useEd(selectActiveBrandKit);
  const fill = kit?.colors[0]?.value ?? DEFAULT_SHAPE_FILL;

  const add = (p: ShapePreset) => {
    const { document, actions } = store.getState();
    const short = Math.min(document.size.width, document.size.height);
    const side = Math.max(1, Math.round(short * 0.3));
    const partial: Partial<Omit<ShapeElement, 'id' | 'type' | 'shape'>> = { ...p.partial };
    if (p.shape === 'line') {
      partial.stroke = kit?.colors[0]?.value ?? '#1f2430';
      if (p.dashed) {
        const sw = Math.max(1, Math.round(short * 0.004));
        partial.dash = [sw * 4, sw * 3];
      }
    } else {
      partial.fill = fill;
    }
    if (p.cornerRadiusFraction) partial.cornerRadius = Math.round(side * p.cornerRadiusFraction);
    actions.addShape(p.shape, partial);
  };

  return (
    <PanelShell title="Elements" onClose={onClose}>
      <h3 className="panel__section-title">Shapes</h3>
      <div className="shape-grid">
        {SHAPE_PRESETS.map((p) => (
          <button key={p.id} type="button" className="shape-tile" onClick={() => add(p)} aria-label={`Add ${p.label.toLowerCase()}`} title={p.label}>
            <ShapeGlyph preset={p} />
            <span className="shape-tile__label">{p.label}</span>
          </button>
        ))}
      </div>
      <p className="panel__hint">Shapes use your brand’s first color when a brand kit is active. Change fill, stroke and corners in the properties panel.</p>
    </PanelShell>
  );
}
