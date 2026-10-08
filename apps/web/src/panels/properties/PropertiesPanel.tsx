/**
 * Right-hand contextual properties panel. Nothing selected → page settings; otherwise
 * layout, arrange and the type-specific sections for the selection (mixed selections
 * show only the shared sections). Locked selections are read-only until unlocked.
 */
import type { JSX } from 'react';
import type { ImageElement, ShapeElement, TextElement } from '@plakat/schema';
import { useEd, useStoreApi } from '../../app/services.tsx';
import { Button, IconButton, Notice } from '../../components/ui.tsx';
import { getElementLabel, selectIsTemplate, selectSelectedElements } from '../../store/index.ts';
import { ImageSection } from './ImageSection.tsx';
import { ArrangeSection, LayoutSection } from './LayoutSection.tsx';
import { PageSettings } from './PageSettings.tsx';
import { ShapeSection } from './ShapeSection.tsx';
import { SlotSection } from './SlotSection.tsx';
import { TextSection } from './TextSection.tsx';

export function PropertiesPanel(): JSX.Element {
  const store = useStoreApi();
  const elements = useEd(selectSelectedElements);
  const isTemplate = useEd(selectIsTemplate);
  const readonly = useEd((s) => s.saveStatus === 'readonly');
  const actions = () => store.getState().actions;

  if (elements.length === 0) {
    return (
      <aside className="props" aria-label="Page properties">
        <div className="props__head">
          <h2 className="props__title">Page</h2>
        </div>
        <fieldset className="props__body" disabled={readonly}>
          <PageSettings />
        </fieldset>
      </aside>
    );
  }

  const ids = elements.map((e) => e.id);
  const locked = elements.every((e) => e.locked);
  const type = elements.every((e) => e.type === elements[0]!.type) ? elements[0]!.type : 'mixed';
  const title = elements.length === 1 ? getElementLabel(elements[0]!) : `${elements.length} elements`;

  return (
    <aside className="props" aria-label="Element properties">
      <div className="props__head">
        <h2 className="props__title" title={title}>
          {title}
        </h2>
        <div className="props__head-actions">
          <IconButton label={locked ? 'Unlock' : 'Lock'} icon={locked ? 'lock' : 'unlock'} size="sm" pressed={locked} onClick={() => actions().setLocked(ids, !locked)} />
          <IconButton label="Duplicate" tooltip="Duplicate (Mod+D)" icon="duplicate" size="sm" disabled={readonly} onClick={() => actions().duplicateElements(ids)} />
          <IconButton label="Delete" tooltip="Delete (Del)" icon="trash" size="sm" disabled={locked || readonly} onClick={() => actions().deleteElements(ids)} />
        </div>
      </div>
      {locked && (
        <div className="props__notice">
          <Notice tone="info" icon="lock">
            {elements.length === 1 ? 'This element is locked.' : 'These elements are locked.'}{' '}
            <Button size="sm" variant="ghost" onClick={() => actions().setLocked(ids, false)}>
              Unlock
            </Button>
          </Notice>
        </div>
      )}
      <fieldset className="props__body" disabled={locked || readonly}>
        {type === 'text' && <TextSection elements={elements as TextElement[]} />}
        {type === 'shape' && <ShapeSection elements={elements as ShapeElement[]} />}
        {type === 'image' && <ImageSection elements={elements as ImageElement[]} />}
        <LayoutSection elements={elements} />
        <ArrangeSection elements={elements} />
        {isTemplate && elements.length === 1 && <SlotSection element={elements[0]!} />}
      </fieldset>
    </aside>
  );
}
