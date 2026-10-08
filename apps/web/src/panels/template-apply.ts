/**
 * Applying a template inside the editor (Templates panel).
 *
 * Behaviour (Canva-like, never destroys work silently):
 *  - 'replace-page': the active page is replaced by the template's pages (an empty page
 *    is the typical target). Undoable in one step.
 *  - 'add-pages': the template's pages are inserted after the active page.
 *  - Default click: 'replace-page' when the active page is empty, else 'add-pages'.
 *  - Documents share one page size, so when the template's size differs its content is
 *    scaled uniformly to fit and centered (resizeDocumentPure, the same rule as
 *    "Resize design"). Template slots are not imported (the result is plain design
 *    content); assets are merged safely (importPages → mergeAssets).
 *  - "Use in a new design" (instantiateTemplate → new project) is offered separately.
 */
import { importPages, removePage, type Id, type PlakatDocument } from '@plakat/schema';
import { resizeDocumentPure } from '../store/index.ts';

export type ApplyTemplateMode = 'replace-page' | 'add-pages';

export function defaultApplyMode(doc: PlakatDocument, activePageId: Id): ApplyTemplateMode {
  const page = doc.pages.find((p) => p.id === activePageId);
  return page && page.elements.length === 0 ? 'replace-page' : 'add-pages';
}

export function sameSize(a: { width: number; height: number }, b: { width: number; height: number }): boolean {
  return Math.abs(a.width - b.width) < 1e-6 && Math.abs(a.height - b.height) < 1e-6;
}

/** Pure: returns the new document and the ids of the inserted pages. */
export function applyTemplateToDocument(
  doc: PlakatDocument,
  template: PlakatDocument,
  activePageId: Id,
  mode: ApplyTemplateMode,
): { document: PlakatDocument; pageIds: Id[] } {
  const source = sameSize(template.size, doc.size) ? template : resizeDocumentPure(template, doc.size, { content: 'scale' });
  const activeIndex = Math.max(0, doc.pages.findIndex((p) => p.id === activePageId));
  const index = mode === 'replace-page' ? activeIndex : activeIndex + 1;
  const { document, pageIds } = importPages(doc, source, { index });
  if (mode === 'replace-page' && document.pages.some((p) => p.id === activePageId)) {
    return { document: removePage(document, activePageId), pageIds };
  }
  return { document, pageIds };
}
