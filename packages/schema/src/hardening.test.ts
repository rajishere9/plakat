import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocument, createImageAsset, createImageElement } from './factory.ts';
import { fontLoadQuery } from './fonts.ts';
import { isValidId } from './ids.ts';
import { DocumentValidationError, loadDocument, safeLoadDocument } from './load.ts';
import { createFetchAssetFetcher, parseDocument, resolveAssetUrl } from './portable.ts';
import { applySlotFill, instantiateTemplate, TemplateError } from './templates.ts';
import { DocumentSchema, findReservedKey, MAX_ASSET_SRC_LENGTH, MAX_JSON_DEPTH, MAX_TOTAL_ELEMENTS } from './validation.ts';
import { assertValidDocument } from './load.ts';
import { loadBrandKit } from './brand.ts';
import { mmToPx } from './units.ts';
import { BRAND_KIT_FORMAT } from './types.ts';
import { readExampleJson } from './test-utils.ts';

const example = () => readExampleJson() as any;

function issuesOf(input: unknown): string {
  const r = safeLoadDocument(input);
  if (r.ok) return '';
  return r.error instanceof DocumentValidationError ? r.error.issues.map((i) => `${i.path}: ${i.message}`).join('\n') : r.error.message;
}

describe('prototype-key safety', () => {
  it('rejects inherited-property names as asset references', () => {
    const a = example();
    a.pages[0].elements[0].assetId = 'constructor';
    expect(issuesOf(a)).toMatch(/Reserved id|Unknown asset/);

    const b = example();
    b.pages[0].elements[0].assetId = 'toString';
    expect(issuesOf(b)).toMatch(/Unknown asset "toString"/);

    const c = example();
    c.pages[0].background.image = { assetId: '__proto__' };
    expect(issuesOf(c)).not.toBe('');

    const d = example();
    d.pages[0].background.image = { assetId: 'hasOwnProperty' };
    expect(issuesOf(d)).toMatch(/Unknown asset "hasOwnProperty"/);
  });

  it('refuses an own "__proto__" key instead of silently dropping it', () => {
    const text = JSON.stringify(example()).replace('"assets":{', '"assets":{"__proto__":{"type":"image"},');
    expect(() => parseDocument(text)).toThrow(/assets.__proto__: Reserved key/);
  });

  it('reserved names are not valid ids', () => {
    for (const id of ['__proto__', 'constructor', 'prototype']) expect(isValidId(id)).toBe(false);
    expect(isValidId('toString')).toBe(true); // harmless once lookups use Object.hasOwn
  });

  it('template fills cannot reference inherited properties', () => {
    const t = loadDocument(example());
    expect(() => instantiateTemplate(t, { slot_photo: { assetId: 'toString' } })).toThrow(/not in the registry/);
    expect(() => instantiateTemplate(t, { slot_photo: { assetId: 'constructor' } })).toThrow(/invalid asset id/);
    // required-slot check uses own keys only
    expect(() => instantiateTemplate(t, Object.create({ slot_photo: { text: 'x' } }), { enforceRequired: true })).toThrow(/Missing required slots/);
  });
});

describe('template fill validation', () => {
  it('rejects invalid fill assets and ids', () => {
    const t = loadDocument(example());
    expect(() =>
      applySlotFill(t, 'slot_photo', { assetId: 'bad id!!', asset: { type: 'image', mimeType: 'image/png', width: 1, height: 1, src: '/a.png', name: '', source: null } }),
    ).toThrow(/invalid asset id/);
    expect(() =>
      applySlotFill(t, 'slot_photo', { assetId: 'as_new', asset: { width: -5, src: 'javascript:alert(1)', evil: true } as never }),
    ).toThrow(TemplateError);
  });

  it('never overwrites a different registry record that other elements use', () => {
    const json = example();
    json.pages[0].background.image = { assetId: 'as_placeholder' };
    const t = loadDocument(json);
    const { asset } = createImageAsset({ src: '/new.png', width: 10, height: 10, mimeType: 'image/png' });
    const filled = applySlotFill(t, 'slot_photo', { assetId: 'as_placeholder', asset });
    expect(filled.assets['as_placeholder']).toEqual(t.assets['as_placeholder']);
    const photo = filled.pages[0]!.elements[0]!;
    expect(photo.type === 'image' && photo.assetId).not.toBe('as_placeholder');
    expect(filled.assets[(photo as { assetId: string }).assetId]!.src).toBe('/new.png');
    expect(filled.pages[0]!.background.image).toEqual({ assetId: 'as_placeholder' });
    expect(DocumentSchema.safeParse(filled).success).toBe(true);
    // an identical record keeps its id
    const same = applySlotFill(t, 'slot_photo', { assetId: 'as_placeholder', asset: t.assets['as_placeholder']! });
    expect((same.pages[0]!.elements[0] as { assetId: string }).assetId).toBe('as_placeholder');
  });

  it('instantiateTemplate validates its result', () => {
    const t = loadDocument(example());
    // a template edited in memory into an invalid state cannot produce a design
    const broken = { ...t, pages: [{ ...t.pages[0]!, background: { color: 'red' as never, image: null } }] };
    expect(() => instantiateTemplate(broken)).toThrow(DocumentValidationError);
  });
});

describe('asset src hardening', () => {
  const withSrc = (src: string, mimeType = 'image/png') => {
    const j = example();
    j.assets.as_placeholder.src = src;
    j.assets.as_placeholder.mimeType = mimeType;
    return issuesOf(j);
  };

  it('rejects host-escaping and malformed srcs', () => {
    expect(withSrc('/\\evil.example/x.png')).toMatch(/Asset src must be/);
    expect(withSrc('//evil.example/x.png')).toMatch(/Asset src must be/);
    expect(withSrc('/api/up loads/x.png')).toMatch(/Asset src must be/);
    expect(withSrc('https://a.test/x\\y.png')).toMatch(/Asset src must be/);
    expect(withSrc('/api/uploads/x.png\n')).toMatch(/Asset src must be/);
    expect(withSrc('/api/uploads/x.png')).toBe('');
    expect(withSrc('https://cdn.example/x.png?a=1')).toBe('');
  });

  it('checks data: URI mime type and payload', () => {
    expect(withSrc('data:image/svg+xml;base64,!!!notbase64')).toMatch(/does not match mimeType/);
    expect(withSrc('data:image/png;base64,!!!notbase64')).toMatch(/not valid base64/);
    expect(withSrc('data:image/png;base64,QUJD')).toBe('');
    expect(withSrc('data:image/svg+xml,%3Csvg%2F%3E', 'image/svg+xml')).toBe('');
    expect(withSrc('data:image/svg+xml,%E0%A4%A', 'image/svg+xml')).toMatch(/percent-encoding/);
  });

  it('caps the src length', () => {
    const prefix = 'data:image/png;base64,';
    expect(withSrc(`${prefix}${'A'.repeat(MAX_ASSET_SRC_LENGTH - prefix.length + 4)}`)).toMatch(/too big|<=|at most|Too big/i);
  });

  it('attribution URLs must be http(s)', () => {
    const j = example();
    j.assets.as_placeholder.source = { provider: 'openverse', pageUrl: 'javascript:alert(1)' };
    expect(issuesOf(j)).toMatch(/source\.pageUrl: Expected an http\(s\) URL/);
    j.assets.as_placeholder.source = { provider: 'openverse', licenseUrl: 'data:text/html,x' };
    expect(issuesOf(j)).toMatch(/licenseUrl: Expected an http\(s\) URL/);
    j.assets.as_placeholder.source = { provider: 'openverse', pageUrl: 'https://openverse.org/image/1', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/' };
    expect(issuesOf(j)).toBe('');
  });

  it('caps total elements per document', () => {
    const doc = createDocument();
    const many = Array.from({ length: 5_001 }, (_, i) => ({ id: `el_${i}`, type: 'shape', shape: 'rect', x: 0, y: 0, width: 1, height: 1 }));
    const json = { ...doc, pages: [0, 1, 2, 3].map((p) => ({ id: `pg_${p}`, elements: many.map((e) => ({ ...e, id: `${e.id}_${p}` })) })) };
    expect(issuesOf(json)).toMatch(new RegExp(`Too many elements \\(20004 > ${MAX_TOTAL_ELEMENTS}\\)`));
  });
});

describe('asset fetcher', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps root-relative srcs on the base origin', () => {
    expect(resolveAssetUrl('/api/uploads/a.png', 'https://plakat.local/app').href).toBe('https://plakat.local/api/uploads/a.png');
    expect(() => resolveAssetUrl('/\\evil.example/x.png', 'https://plakat.local/app')).toThrow(/escapes the server origin/);
    expect(() => resolveAssetUrl('//evil.example/x.png', 'https://plakat.local/app')).toThrow(/escapes the server origin/);
    expect(() => resolveAssetUrl('/a.png', undefined)).toThrow(/needs a baseUrl/);
  });

  it('applies the remote policy and refuses other schemes', async () => {
    expect(() => resolveAssetUrl('https://evil.example/x.png', 'https://plakat.local', { allowRemote: false })).toThrow(/not allowed/);
    expect(resolveAssetUrl('https://cdn.example/x.png', undefined, { allowRemote: (u) => u.hostname === 'cdn.example' }).href).toBe('https://cdn.example/x.png');
    expect(() => resolveAssetUrl('file:///etc/passwd', undefined)).toThrow(/Unsupported asset URL scheme/);

    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2])));
    vi.stubGlobal('fetch', fetchMock);
    const fetcher = createFetchAssetFetcher('https://plakat.local', { allowRemote: false });
    const asset = createImageAsset({ src: '/api/uploads/a.png', width: 1, height: 1, mimeType: 'image/png' }).asset;
    await expect(fetcher('/api/uploads/a.png', 'as_a', asset)).resolves.toEqual({ bytes: new Uint8Array([1, 2]) });
    await expect(fetcher('http://169.254.169.254/latest', 'as_a', asset)).rejects.toThrow(/not allowed/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('font family hardening', () => {
  it('restricts family names and escapes CSS strings', () => {
    const j = example();
    j.pages[0].elements[3].fontFamily = 'Evil\\';
    expect(issuesOf(j)).toMatch(/Invalid font family/);
    j.pages[0].elements[3].fontFamily = 'Inter\n';
    expect(issuesOf(j)).toMatch(/Invalid font family/);
    j.pages[0].elements[3].fontFamily = 'Source Sans 3';
    expect(issuesOf(j)).toBe('');
    expect(fontLoadQuery('A"b\\', 400, 'normal')).toBe('normal 400 16px "A\\"b\\\\"');
  });
});

describe('explicit crops vs the declared asset size', () => {
  it('rejects crops outside the asset', () => {
    const j = example();
    j.pages[0].elements[0].crop = { x: 1, y: 0, width: 4, height: 3 }; // asset is 4x3
    expect(issuesOf(j)).toMatch(/elements\[0\]\.crop: Crop exceeds the asset's declared size 4x3/);
    j.pages[0].elements[0].crop = { x: 0, y: 0, width: 4.005, height: 3 }; // within epsilon
    expect(issuesOf(j)).toBe('');
  });
});

describe('defaults are never shared between documents', () => {
  it('meta.tags and other defaulted containers are fresh per load', () => {
    const min = { format: 'plakat.document', schemaVersion: 1, id: 'doc_min', size: { width: 10, height: 10 }, pages: [{ id: 'pg_1' }] };
    const a = loadDocument(structuredClone(min));
    const b = loadDocument(structuredClone(min));
    expect(a.meta.tags).not.toBe(b.meta.tags);
    expect(a.pages[0]!.background).not.toBe(b.pages[0]!.background);
    expect(a.assets).not.toBe(b.assets);
    Object.freeze(a.meta.tags);
    b.meta.tags.push('ok');
    expect(b.meta.tags).toEqual(['ok']);
  });

  it('image filters default per element', () => {
    const doc = createDocument();
    const { id, asset } = createImageAsset({ src: '/a.png', width: 1, height: 1, mimeType: 'image/png' });
    const raw = JSON.parse(JSON.stringify({ ...doc, assets: { [id]: asset } }));
    const el = createImageElement(id, asset) as any;
    delete el.filters;
    raw.pages[0].elements = [el, { ...el, id: 'el_two' }];
    const loaded = loadDocument(raw);
    expect((loaded.pages[0]!.elements[0] as any).filters).not.toBe((loaded.pages[0]!.elements[1] as any).filters);
  });
});

describe('deeply nested JSON', () => {
  /** `depth` nested arrays around 0, built iteratively (JSON.parse handles any depth). */
  const nested = (depth: number): unknown => JSON.parse(`${'['.repeat(depth)}0${']'.repeat(depth)}`);

  it('is a validation error (never a RangeError from structuredClone or recursion)', () => {
    for (const depth of [MAX_JSON_DEPTH + 1, 5_000, 200_000]) {
      const doc = { ...example(), x: nested(depth) };
      const r = safeLoadDocument(doc);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toBeInstanceOf(DocumentValidationError);
      expect(issuesOf(doc)).toMatch(/^x(\[0\])+: Nested too deeply/);
      expect(() => loadDocument(doc)).toThrow(DocumentValidationError);
      expect(() => assertValidDocument(doc)).toThrow(DocumentValidationError);
      const text = JSON.stringify(example()).replace(/^\{/, `{"x":${'['.repeat(depth)}0${']'.repeat(depth)},`);
      expect(() => parseDocument(text)).toThrow(DocumentValidationError);
      expect(() => loadBrandKit({ format: BRAND_KIT_FORMAT, schemaVersion: 1, id: 'bk_1', x: nested(depth) })).toThrow(DocumentValidationError);
    }
  });

  it('leaves ordinary documents alone and reports unknown shallow keys as before', () => {
    expect(issuesOf(example())).toBe('');
    expect(issuesOf({ ...example(), x: nested(10) })).toMatch(/Unrecognized key/);
  });

  it('findReservedKey is iterative and keeps depth-first key order', () => {
    expect(findReservedKey(nested(200_000))).toBeNull();
    expect(findReservedKey(JSON.parse('{"a":{"b":{"__proto__":1}},"constructor":2}'))).toBe('a.b.__proto__');
    expect(findReservedKey(JSON.parse('{"a":[1,{"prototype":1}]}'))).toBe('a[1].prototype');
  });
});

describe('physical page size (D-4)', () => {
  const withSize = (size: unknown) => issuesOf({ ...example(), size });

  it('must agree with width/height (else the PDF image is stretched)', () => {
    expect(withSize({ width: 1080, height: 1080, physical: { width: 210, height: 297, unit: 'mm' } })).toMatch(
      /size\.physical: Physical size 210x297 mm is .* but size is 1080x1080 px/,
    );
    expect(withSize({ width: mmToPx(210), height: mmToPx(297), physical: { width: 210, height: 297, unit: 'mm' } })).toBe('');
    // within 0.01 px is fine (e.g. a value rounded when written by another tool)
    expect(withSize({ width: 793.705, height: 1122.515, physical: { width: 210, height: 297, unit: 'mm' } })).toBe('');
    expect(withSize({ width: 794, height: 1123, physical: { width: 210, height: 297, unit: 'mm' } })).toMatch(/size\.physical/);
    expect(withSize({ width: 336, height: 192, physical: { width: 3.5, height: 2, unit: 'in' } })).toBe('');
  });

  it('is capped at the 20 000 px page size', () => {
    expect(withSize({ width: 20_000, height: 100, physical: { width: 208.4, height: 100 / 96, unit: 'in' } })).toMatch(/physical\.width: Physical width exceeds/);
    expect(withSize({ width: 20_000, height: 96, physical: { width: 20_000 / 96, height: 1, unit: 'in' } })).toBe('');
  });
});
