/**
 * Documents from other schema versions on every write path (document-schema.md §11):
 * v0 (unversioned) input is migrated and stored canonical; input from a newer Plakat
 * is refused with 400 `unsupported_schema_version` and an "upgrade Plakat" message.
 */
import {
  addSlot,
  convertToTemplate,
  createDocument,
  createTextElement,
  CURRENT_SCHEMA_VERSION,
  DOCUMENT_FORMAT,
  loadDocument,
  serializeDocument,
  type PlakatDocument,
} from '@plakat/schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../test-utils.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t?.close();
});

type Json = Record<string, unknown>;

/** The canonical JSON of a v1 document, rewritten into the loose v0 shape (no envelope, top-level width/height). */
function toV0(doc: PlakatDocument): Json {
  const { format: _f, schemaVersion: _v, size, ...rest } = JSON.parse(serializeDocument(doc)) as Json & { size: { width: number; height: number } };
  return { ...rest, width: size.width, height: size.height };
}

function design(id: string): PlakatDocument {
  const doc = { ...createDocument({ width: 800, height: 600, presetId: null, physical: null }, { title: 'Legacy' }), id };
  doc.pages[0]!.elements.push(createTextElement({ id: 'el_text', content: 'Old file' }));
  return doc;
}

function template(id: string): PlakatDocument {
  let doc = { ...convertToTemplate(createDocument({ width: 640, height: 480, presetId: null, physical: null }, { title: 'Legacy template', kind: 'template' }), { category: 'legacy' }), id };
  doc.pages[0]!.elements.push(createTextElement({ id: 'el_headline', content: 'Headline' }));
  doc = addSlot(doc, 'el_headline').document;
  return doc;
}

const future = (doc: PlakatDocument): Json => ({ ...(JSON.parse(serializeDocument(doc)) as Json), schemaVersion: CURRENT_SCHEMA_VERSION + 98 });

/** The stored row is canonical current-version JSON (what serializeDocument would write). */
async function expectStoredCanonical(table: 'projects' | 'templates', id: string, size: { width: number; height: number }) {
  const { rows } = await t.app.plakat.db.query<{ document: Json; schema_version: number }>(`SELECT document, schema_version FROM ${table} WHERE id = $1`, [id]);
  const row = rows[0]!;
  expect(row.schema_version).toBe(CURRENT_SCHEMA_VERSION);
  expect(row.document).toMatchObject({ format: DOCUMENT_FORMAT, schemaVersion: CURRENT_SCHEMA_VERSION, size: { ...size, presetId: null, physical: null } });
  expect(row.document).not.toHaveProperty('width');
  expect(row.document).not.toHaveProperty('height');
  expect(JSON.parse(serializeDocument(loadDocument(row.document)))).toEqual(row.document);
}

function expectFutureRefused(res: { statusCode: number; json(): { error: Json } }) {
  expect(res.statusCode).toBe(400);
  const err = res.json().error;
  expect(err).toMatchObject({ code: 'unsupported_schema_version', found: CURRENT_SCHEMA_VERSION + 98, supported: CURRENT_SCHEMA_VERSION });
  expect(err['message']).toMatch(new RegExp(`schemaVersion ${CURRENT_SCHEMA_VERSION + 98}.*supports up to ${CURRENT_SCHEMA_VERSION}.*Upgrade Plakat`));
}

describe('schemaVersion 0 input is migrated and stored canonical', () => {
  it('POST /api/projects', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/projects', payload: { document: toV0(design('doc_v0post00001')) } });
    expect(res.statusCode).toBe(201);
    expect(res.json().document).toMatchObject({ format: DOCUMENT_FORMAT, schemaVersion: CURRENT_SCHEMA_VERSION, size: { width: 800, height: 600 } });
    await expectStoredCanonical('projects', res.json().id, { width: 800, height: 600 });
  });

  it('PUT /api/projects/:id', async () => {
    const doc = design('doc_v0put000001');
    const created = await t.app.inject({ method: 'POST', url: '/api/projects', payload: { document: doc } });
    expect(created.statusCode).toBe(201);
    const v0 = { ...toV0(doc), width: 1000, height: 500 };
    const res = await t.app.inject({ method: 'PUT', url: `/api/projects/${doc.id}`, payload: { document: v0, baseVersion: 1 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().version).toBe(2);
    await expectStoredCanonical('projects', doc.id, { width: 1000, height: 500 });
  });

  it.each(['application/json', 'application/vnd.plakat+json'])('POST /api/templates/import (raw text as %s)', async (contentType) => {
    const id = contentType === 'application/json' ? 'doc_v0tplj0001' : 'doc_v0tplv0001';
    const res = await t.app.inject({ method: 'POST', url: '/api/templates/import', headers: { 'content-type': contentType }, payload: JSON.stringify(toV0(template(id))) });
    expect(res.statusCode).toBe(201);
    expect(res.json().document).toMatchObject({ kind: 'template', schemaVersion: CURRENT_SCHEMA_VERSION, size: { width: 640, height: 480 } });
    await expectStoredCanonical('templates', res.json().id, { width: 640, height: 480 });
  });
});

describe('input from a newer Plakat is refused with 400', () => {
  it('POST and PUT /api/projects', async () => {
    const doc = design('doc_future00001');
    expectFutureRefused(await t.app.inject({ method: 'POST', url: '/api/projects', payload: { document: future(doc) } }));
    expect((await t.app.inject({ method: 'GET', url: `/api/projects/${doc.id}` })).statusCode).toBe(404);

    expect((await t.app.inject({ method: 'POST', url: '/api/projects', payload: { document: doc } })).statusCode).toBe(201);
    expectFutureRefused(await t.app.inject({ method: 'PUT', url: `/api/projects/${doc.id}`, payload: { document: future(doc), baseVersion: 1 } }));
    // Nothing was written.
    expect((await t.app.inject({ method: 'GET', url: `/api/projects/${doc.id}` })).json().version).toBe(1);
  });

  it.each(['application/json', 'application/vnd.plakat+json'])('POST /api/templates/import (raw text as %s)', async (contentType) => {
    const tpl = template('doc_futuretpl01');
    expectFutureRefused(await t.app.inject({ method: 'POST', url: '/api/templates/import', headers: { 'content-type': contentType }, payload: JSON.stringify(future(tpl)) }));
    expect((await t.app.inject({ method: 'GET', url: `/api/templates/${tpl.id}` })).statusCode).toBe(404);
  });

  it('a RangeError while loading input is a 400, not a 500', async () => {
    // Deeper than any stack: JSON.parse copes, the recursive loaders throw RangeError.
    let nested = '{}';
    for (let i = 0; i < 100_000; i++) nested = `{"a":${nested}}`;
    const body = `{"document":${JSON.stringify({ ...JSON.parse(serializeDocument(design('doc_deep0000001'))) }).replace('"meta":{', `"meta":{"x":${nested},`)}}`;
    const res = await t.app.inject({ method: 'POST', url: '/api/projects', headers: { 'content-type': 'application/json' }, payload: body });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'invalid_document', message: expect.stringMatching(/too deeply nested/) });
  });
});
