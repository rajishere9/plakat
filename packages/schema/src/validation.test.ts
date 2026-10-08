import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DocumentValidationError, loadDocument, safeLoadDocument } from './load.ts';
import { DocumentSchema } from './validation.ts';
import { readExampleJson } from './test-utils.ts';

const clone = <T>(v: T): T => structuredClone(v);

function issuesOf(input: unknown): string[] {
  const r = safeLoadDocument(input);
  if (r.ok) return [];
  return r.error instanceof DocumentValidationError ? r.error.issues.map((i) => `${i.path}: ${i.message}`) : [r.error.message];
}

describe('document validation', () => {
  it('accepts the worked example unchanged (it is already canonical)', () => {
    const json = readExampleJson();
    const doc = loadDocument(json);
    expect(doc).toEqual(json);
    expect(doc.kind).toBe('template');
    expect(doc.pages[0]!.elements).toHaveLength(6);
  });

  it('fills defaults for a minimal hand-written document', () => {
    const doc = loadDocument({
      format: 'plakat.document',
      schemaVersion: 1,
      id: 'doc_min',
      size: { width: 1080, height: 1080 },
      pages: [
        {
          id: 'pg_1',
          elements: [
            { id: 'el_t', type: 'text', x: 10, y: 10, width: 300, height: 40, content: 'Hi' },
            { id: 'el_s', type: 'shape', shape: 'ellipse', x: 0, y: 0, width: 50, height: 50 },
          ],
        },
      ],
    });
    expect(doc.kind).toBe('design');
    expect(doc.template).toBeNull();
    expect(doc.size).toEqual({ width: 1080, height: 1080, presetId: null, physical: null });
    expect(doc.pages[0]!.background).toEqual({ color: '#ffffff', image: null });
    const text = doc.pages[0]!.elements[0]!;
    expect(text).toMatchObject({ rotation: 0, opacity: 1, locked: false, fontFamily: 'Inter', fontWeight: 400, fill: '#000000' });
    expect(DocumentSchema.safeParse(doc).success).toBe(true);
  });

  it('rejects malformed documents with precise paths', () => {
    const base = readExampleJson() as any;

    const badColor = clone(base);
    badColor.pages[0].elements[1].fill = 'red';
    expect(issuesOf(badColor).join('\n')).toMatch(/pages\[0\]\.elements\[1\]\.fill: Invalid color/);

    const unknownKey = clone(base);
    unknownKey.pages[0].elements[0].shadow = { blur: 4 };
    expect(issuesOf(unknownKey).join('\n')).toMatch(/pages\[0\]\.elements\[0\]/);

    const dupId = clone(base);
    dupId.pages[0].elements[1].id = 'el_photo';
    expect(issuesOf(dupId).join('\n')).toMatch(/Duplicate id "el_photo"/);

    const missingAsset = clone(base);
    missingAsset.pages[0].elements[0].assetId = 'as_nope';
    expect(issuesOf(missingAsset).join('\n')).toMatch(/elements\[0\]\.assetId: Unknown asset "as_nope"/);

    const wrongSlotTarget = clone(base);
    wrongSlotTarget.template.slots[1].targets = ['el_photo'];
    expect(issuesOf(wrongSlotTarget).join('\n')).toMatch(/A text slot cannot target a image element/);

    const danglingSlot = clone(base);
    danglingSlot.template.slots[0].targets = ['el_gone'];
    expect(issuesOf(danglingSlot).join('\n')).toMatch(/not an element of this document/);

    const kindMismatch = clone(base);
    kindMismatch.kind = 'design';
    expect(issuesOf(kindMismatch).join('\n')).toMatch(/kind "design" must have template: null/);

    const noPages = clone(base);
    noPages.pages = [];
    expect(issuesOf(noPages).length).toBeGreaterThan(0);

    const badId = clone(base);
    badId.pages[0].id = 'has space';
    expect(issuesOf(badId).join('\n')).toMatch(/Invalid id/);

    const badSrc = clone(base);
    badSrc.assets.as_placeholder.src = 'javascript:alert(1)';
    expect(issuesOf(badSrc).join('\n')).toMatch(/Asset src must be/);

    const badWeight = clone(base);
    badWeight.pages[0].elements[3].fontWeight = 450;
    expect(issuesOf(badWeight).length).toBeGreaterThan(0);

    const badOpacity = clone(base);
    badOpacity.pages[0].elements[3].opacity = 2;
    expect(issuesOf(badOpacity).length).toBeGreaterThan(0);

    const unknownType = clone(base);
    unknownType.pages[0].elements[3].type = 'video';
    expect(issuesOf(unknownType).length).toBeGreaterThan(0);

    expect(issuesOf('not an object')).toEqual(['A Plakat document must be a JSON object']);
  });
});

describe('docs/document-schema.md', () => {
  const md = readFileSync(fileURLToPath(new URL('../../../docs/document-schema.md', import.meta.url)), 'utf8');
  const section = md.slice(md.indexOf('## 13. Worked example'));
  const blocks = [...section.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]!) as unknown);

  it('embeds the golden fixture verbatim', () => {
    expect(blocks[0]).toEqual(readExampleJson());
  });

  it('documents a minimal hand-written file that actually loads', () => {
    const doc = loadDocument(blocks[1]);
    expect(doc.pages[0]!.elements[0]).toMatchObject({ type: 'text', fontFamily: 'Inter', content: 'Hello' });
  });
});
