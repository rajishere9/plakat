/** Position / size / rotation / opacity, align & distribute, z-order and grouping. */
import { useState, type JSX } from 'react';
import type { PlakatElement } from '@plakat/schema';
import { useEd, useStoreApi } from '../../app/services.tsx';
import { NumberField } from '../../components/NumberField.tsx';
import { Slider } from '../../components/Slider.tsx';
import { IconButton, Section } from '../../components/ui.tsx';
import { toAlignUnits } from '../../lib/align.ts';
import { selectSelectionBounds } from '../../store/index.ts';
import { commonValue, patchElements } from './shared.tsx';

export function LayoutSection({ elements }: { elements: PlakatElement[] }): JSX.Element {
  const store = useStoreApi();
  const bounds = useEd(selectSelectionBounds);
  const actions = () => store.getState().actions;
  const ids = elements.map((e) => e.id);
  const single = elements.length === 1 ? elements[0]! : null;
  const [keepRatio, setKeepRatio] = useState(true);
  const opacity = commonValue(elements, (e) => e.opacity);

  const setSize = (dim: 'width' | 'height', v: number) => {
    if (!single) return;
    const ratio = single.height > 0 && single.width > 0 ? single.width / single.height : 1;
    const patch =
      dim === 'width'
        ? { width: v, ...(keepRatio && single.type !== 'text' ? { height: v / ratio } : {}) }
        : { height: v, ...(keepRatio && single.type !== 'text' ? { width: v * ratio } : {}) };
    patchElements(store.getState().actions, ids, 'size', patch, 'Resize');
  };

  return (
    <Section title={single ? 'Position & size' : `Position · ${elements.length} elements`}>
      {single ? (
        <div className="prop-grid">
          <NumberField label="X position" prefix="X" value={single.x} precision={1} onChange={(v) => patchElements(actions(), ids, 'x', { x: v }, 'Move')} />
          <NumberField label="Y position" prefix="Y" value={single.y} precision={1} onChange={(v) => patchElements(actions(), ids, 'y', { y: v }, 'Move')} />
          <NumberField label="Width" prefix="W" value={single.width} min={1} precision={1} onChange={(v) => setSize('width', v)} />
          <NumberField label="Height" prefix="H" value={single.height} min={single.type === 'shape' && single.shape === 'line' ? 0 : 1} precision={1} onChange={(v) => setSize('height', v)} />
          <NumberField
            label="Rotation"
            prefix="↻"
            suffix="°"
            value={single.rotation}
            precision={1}
            onChange={(v) => actions().setRotation(ids, ((v % 360) + 360) % 360, { coalesceKey: `prop:rotation:${ids.join(',')}` })}
          />
          <IconButton
            label={keepRatio ? 'Unlock aspect ratio' : 'Lock aspect ratio'}
            icon={keepRatio ? 'link' : 'unlock'}
            size="sm"
            pressed={keepRatio && single.type !== 'text'}
            disabled={single.type === 'text'}
            onClick={() => setKeepRatio((k) => !k)}
          />
        </div>
      ) : (
        bounds && (
          <div className="prop-grid">
            <NumberField label="Selection X" prefix="X" value={bounds.x} precision={1} onChange={(v) => actions().moveElements(ids, v - bounds.x, 0, { label: 'Move' })} />
            <NumberField label="Selection Y" prefix="Y" value={bounds.y} precision={1} onChange={(v) => actions().moveElements(ids, 0, v - bounds.y, { label: 'Move' })} />
          </div>
        )
      )}
      <Slider
        label="Opacity"
        value={opacity ?? 1}
        min={0}
        max={1}
        step={1}
        displayScale={100}
        suffix="%"
        onChange={(v) => patchElements(actions(), ids, 'opacity', { opacity: v }, 'Opacity')}
        onCommit={() => actions().breakCoalescing()}
      />
    </Section>
  );
}

export function ArrangeSection({ elements }: { elements: PlakatElement[] }): JSX.Element {
  const store = useStoreApi();
  const actions = () => store.getState().actions;
  const units = toAlignUnits(elements).length;
  const relative = units <= 1 ? 'page' : 'selection';
  const canGroup = elements.length >= 2;
  const canUngroup = elements.some((e) => e.groupId);
  return (
    <Section title="Arrange">
      <div className="btn-row" role="group" aria-label={`Align to ${relative}`}>
        <IconButton label={`Align left (${relative})`} icon="alignLeft" onClick={() => actions().align('left')} />
        <IconButton label={`Align center (${relative})`} icon="alignCenterH" onClick={() => actions().align('center')} />
        <IconButton label={`Align right (${relative})`} icon="alignRight" onClick={() => actions().align('right')} />
        <IconButton label={`Align top (${relative})`} icon="alignTop" onClick={() => actions().align('top')} />
        <IconButton label={`Align middle (${relative})`} icon="alignMiddleV" onClick={() => actions().align('middle')} />
        <IconButton label={`Align bottom (${relative})`} icon="alignBottom" onClick={() => actions().align('bottom')} />
      </div>
      <div className="btn-row" role="group" aria-label="Distribute and layer order">
        <IconButton label="Distribute horizontally" icon="distributeH" disabled={units < 3} onClick={() => actions().distribute('horizontal')} />
        <IconButton label="Distribute vertically" icon="distributeV" disabled={units < 3} onClick={() => actions().distribute('vertical')} />
        <span className="btn-row__sep" aria-hidden="true" />
        <IconButton label="Bring forward" tooltip="Bring forward (Mod+])" icon="bringForward" onClick={() => actions().bringForward()} />
        <IconButton label="Send backward" tooltip="Send backward (Mod+[)" icon="sendBackward" onClick={() => actions().sendBackward()} />
        <IconButton label="Bring to front" icon="bringToFront" onClick={() => actions().bringToFront()} />
        <IconButton label="Send to back" icon="sendToBack" onClick={() => actions().sendToBack()} />
      </div>
      {(canGroup || canUngroup) && (
        <div className="btn-row">
          {canGroup && (
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => actions().group()}>
              Group
            </button>
          )}
          {canUngroup && (
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => actions().ungroup()}>
              Ungroup
            </button>
          )}
        </div>
      )}
    </Section>
  );
}
