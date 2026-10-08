/**
 * Validates every built-in template under templates/ (see docs/templates.md).
 * Run: npx vitest run templates
 */
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findElement,
  getFontInfo,
  hasFontVariant,
  instantiateTemplate,
  isPortable,
  listSlots,
  loadDocument,
  serializeDocument,
  type ImageAsset,
  type PlakatDocument,
  type SlotFills,
} from '@plakat/schema';
import { SLUG_PATTERN, TEMPLATE_SUFFIX, TEMPLATES_ROOT, findTemplateFiles } from './scripts/lib.ts';

const MAX_FILE_BYTES = 1.5 * 1024 * 1024;
/** Per-asset budget in decoded bytes (docs/templates.md "Asset rules"). */
const MAX_ASSET_BYTES = 80 * 1024;

const files = findTemplateFiles();

/** 1x1 transparent PNG used as an image fill. */
const FILL_ASSET: ImageAsset = {
  type: 'image',
  mimeType: 'image/png',
  width: 1,
  height: 1,
  src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==',
  name: 'Fill',
  source: null,
};

function fillsFor(doc: PlakatDocument): SlotFills {
  const fills: SlotFills = {};
  for (const slot of doc.template!.slots) {
    if (slot.kind === 'text') {
      const text = 'Filled'.slice(0, slot.maxLength ?? 6);
      fills[slot.id] = { text };
    } else if (slot.kind === 'image') fills[slot.id] = { assetId: 'as_fill', asset: FILL_ASSET };
    else fills[slot.id] = { color: '#123456' };
  }
  return fills;
}

describe('built-in templates', () => {
  it('finds the starter library', () => {
    expect(files.length).toBeGreaterThanOrEqual(9);
  });

  it('uses unique document ids (the server upserts built-ins by id)', () => {
    const ids = files.map((f) => (JSON.parse(readFileSync(f, 'utf8')) as { id: string }).id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe.each(files.map((f) => [relative(TEMPLATES_ROOT, f), f] as const))('%s', (_rel, file) => {
  const text = readFileSync(file, 'utf8');
  const doc = loadDocument(JSON.parse(text));
  const category = basename(dirname(file));
  const slug = basename(file, TEMPLATE_SUFFIX);

  it('lives at templates/<category>/<slug>.plakat.json with kebab-case names', () => {
    expect(dirname(dirname(file))).toBe(TEMPLATES_ROOT);
    expect(category).toMatch(SLUG_PATTERN);
    expect(slug).toMatch(SLUG_PATTERN);
  });

  it('is a valid, canonical template', () => {
    expect(doc.kind).toBe('template');
    expect(doc.template).not.toBeNull();
    expect(doc.template!.category).toBe(category);
    expect(doc.meta.title.trim()).not.toBe('');
    expect(doc.meta.description.trim()).not.toBe('');
    expect(doc.meta.tags.length).toBeGreaterThan(0);
    // Stored exactly as serializeDocument() writes it (stable diffs, fonts cache in sync).
    expect(serializeDocument(doc)).toBe(text);
  });

  it('is portable and within the size budget', () => {
    expect(isPortable(doc)).toBe(true);
    expect(statSync(file).size).toBeLessThan(MAX_FILE_BYTES);
    for (const [id, asset] of Object.entries(doc.assets)) {
      const payload = asset.src.slice(asset.src.indexOf(',') + 1);
      expect(Math.floor((payload.length * 3) / 4), `asset ${id}`).toBeLessThanOrEqual(MAX_ASSET_BYTES);
    }
  });

  it('records license provenance for every asset', () => {
    for (const [id, asset] of Object.entries(doc.assets)) {
      expect(asset.source?.license, `asset ${id}`).toBeTruthy();
      expect(asset.source?.author ?? asset.source?.attribution, `asset ${id}`).toBeTruthy();
    }
  });

  it('only references assets that are used (no dead weight)', () => {
    const used = new Set<string>();
    for (const page of doc.pages) {
      if (page.background.image) used.add(page.background.image.assetId);
      for (const el of page.elements) if (el.type === 'image') used.add(el.assetId);
    }
    expect(Object.keys(doc.assets).sort()).toEqual([...used].sort());
  });

  it('has slots whose targets exist and whose placeholders respect the slot rules', () => {
    const slots = doc.template!.slots;
    expect(slots.length).toBeGreaterThanOrEqual(1);
    for (const info of listSlots(doc)) {
      const { slot } = info;
      expect(slot.label.trim(), slot.id).not.toBe('');
      expect(info.targets.length, slot.id).toBe(slot.targets.length);
      for (const id of slot.targets) expect(findElement(doc, id), `${slot.id} -> ${id}`).not.toBeNull();
      if (slot.kind === 'text') {
        for (const t of info.targets) {
          const content = t.element.type === 'text' ? t.element.content : '';
          if (slot.maxLength !== null) expect([...content].length, `${slot.id} placeholder length`).toBeLessThanOrEqual(slot.maxLength);
          if (!slot.multiline) expect(content, `${slot.id} placeholder has a line break`).not.toMatch(/[\r\n]/);
        }
      }
    }
  });

  it('uses only catalogued Google Fonts variants', () => {
    for (const page of doc.pages) {
      for (const el of page.elements) {
        if (el.type !== 'text') continue;
        expect(getFontInfo(el.fontFamily), `${el.id}: ${el.fontFamily}`).toBeDefined();
        expect(hasFontVariant(el.fontFamily, el.fontWeight, el.fontStyle), `${el.id}: ${el.fontFamily} ${el.fontStyle} ${el.fontWeight}`).toBe(true);
      }
    }
    expect(doc.fonts.length).toBeGreaterThan(0);
  });

  it('instantiates with and without fills', () => {
    const plain = instantiateTemplate(doc, {}, { now: () => new Date('2026-01-01T00:00:00.000Z') });
    expect(plain.kind).toBe('design');
    expect(plain.template).toBeNull();
    expect(plain.meta.sourceTemplateId).toBe(doc.id);
    expect(plain.pages.length).toBe(doc.pages.length);

    const fills = fillsFor(doc);
    const filled = instantiateTemplate(doc, fills, { enforceRequired: true });
    expect(isPortable(filled)).toBe(true);
    // Every target of every slot received its fill.
    for (const slot of doc.template!.slots) {
      for (const targetId of slot.targets) {
        const original = findElement(doc, targetId)!;
        const el = filled.pages[original.pageIndex]!.elements[original.index]!;
        const fill = fills[slot.id]!;
        if ('text' in fill) expect(el.type === 'text' && el.content).toBe(fill.text);
        else if ('assetId' in fill) expect(el.type === 'image' && filled.assets[el.assetId]).toEqual(FILL_ASSET);
        else if (slot.kind === 'color') {
          const value = slot.property === 'stroke' ? (el.type === 'shape' ? el.stroke : null) : el.type === 'image' ? null : el.fill;
          expect(value).toBe(fill.color);
        }
      }
    }
  });
});
