import { describe, expect, it } from 'vitest';
import { createDocument, createShapeElement, createTextElement, type PlakatDocument } from '@plakat/schema';
import { applyTemplateToDocument, defaultApplyMode } from './template-apply.ts';

function template(size: 'instagram-post' | 'youtube-thumbnail' = 'instagram-post', pages = 1): PlakatDocument {
  const t = createDocument(size, { kind: 'template', pageCount: pages, title: 'T' });
  t.template = { category: null, slots: [] };
  t.pages[0]!.elements = [createTextElement({ id: 'tt', x: 100, y: 100, width: 400, height: 80, fontSize: 40, content: 'Hi' })];
  t.pages[0]!.background = { color: '#123456', image: null };
  return t;
}

describe('applyTemplateToDocument', () => {
  it('replaces an empty page by default', () => {
    const doc = createDocument('instagram-post', { pageCount: 2 });
    const active = doc.pages[1]!.id;
    expect(defaultApplyMode(doc, active)).toBe('replace-page');
    const r = applyTemplateToDocument(doc, template(), active, 'replace-page');
    expect(r.document.pages).toHaveLength(2);
    expect(r.document.pages[1]!.id).toBe(r.pageIds[0]);
    expect(r.document.pages[1]!.background.color).toBe('#123456');
    expect(r.document.pages.some((p) => p.id === active)).toBe(false);
    expect(r.document.pages[1]!.elements[0]!.id).not.toBe('tt'); // fresh ids
  });

  it('adds pages after the active page when it has content', () => {
    const doc = createDocument('instagram-post', { pageCount: 2 });
    doc.pages[0]!.elements = [createShapeElement('rect', { id: 'keep' })];
    const active = doc.pages[0]!.id;
    expect(defaultApplyMode(doc, active)).toBe('add-pages');
    const r = applyTemplateToDocument(doc, template('instagram-post', 2), active, 'add-pages');
    expect(r.document.pages.map((p) => p.id)).toEqual([active, ...r.pageIds, doc.pages[1]!.id]);
    expect(r.document.pages[0]!.elements[0]!.id).toBe('keep');
  });

  it('scales template content to the design size', () => {
    const doc = createDocument('youtube-thumbnail'); // 1280 x 720
    const r = applyTemplateToDocument(doc, template('instagram-post'), doc.pages[0]!.id, 'replace-page');
    const el = r.document.pages[0]!.elements[0]!;
    const k = 720 / 1080;
    expect(el.width).toBeCloseTo(400 * k);
    expect(el.x).toBeCloseTo(100 * k + (1280 - 1080 * k) / 2);
    expect(r.document.size.width).toBe(1280);
  });
});
