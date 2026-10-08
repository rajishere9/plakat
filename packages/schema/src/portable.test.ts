import { describe, expect, it } from 'vitest';
import { createDocument, createImageAsset, createImageElement } from './factory.ts';
import { DocumentValidationError, loadDocument } from './load.ts';
import {
  bundleAssets,
  bytesToBase64,
  dataUriToBytes,
  isPortable,
  parseDocument,
  serializeDocument,
} from './portable.ts';
import { readExampleJson } from './test-utils.ts';
import { base64DataUriLength, MAX_ASSET_BYTES, MAX_ASSET_SRC_LENGTH } from './validation.ts';
import type { PlakatDocument } from './types.ts';

describe('portable .plakat.json files', () => {
  it('round-trips the worked example byte-stably', () => {
    const doc = loadDocument(readExampleJson());
    const text = serializeDocument(doc);
    const back = parseDocument(text);
    expect(back).toEqual(doc);
    expect(serializeDocument(back)).toBe(text);
    expect(text.endsWith('}\n')).toBe(true);
    expect(serializeDocument(doc, { pretty: false })).not.toContain('\n  ');
  });

  it('round-trips factory-made documents for every element type', () => {
    const doc = createDocument('a4-poster', { pageCount: 2 });
    const { id, asset } = createImageAsset({ src: 'https://example.com/a.jpg', width: 800, height: 600, mimeType: 'image/jpeg' });
    doc.assets[id] = asset;
    doc.pages[1]!.elements.push(createImageElement(id, asset));
    const back = parseDocument(serializeDocument(doc));
    expect(back.pages[1]!.elements[0]).toEqual(doc.pages[1]!.elements[0]);
    expect(back.size).toEqual(doc.size);
  });

  it('syncs the fonts cache when serializing', () => {
    const doc = loadDocument(readExampleJson());
    const stale: PlakatDocument = { ...doc, fonts: [] };
    expect(parseDocument(serializeDocument(stale)).fonts).toEqual(doc.fonts);
  });

  it('refuses to serialize invalid documents and reports bad JSON', () => {
    const doc = createDocument();
    (doc.pages[0]!.background as { color: string | null }).color = 'blue';
    expect(() => serializeDocument(doc)).toThrow(DocumentValidationError);
    expect(() => parseDocument('{ nope')).toThrow(/Not valid JSON/);
  });

  it('bundles remote assets into data: URIs via an injected fetcher', async () => {
    const doc = loadDocument(readExampleJson());
    doc.assets['as_remote'] = { ...doc.assets['as_placeholder']!, src: '/api/uploads/abc.png' };
    expect(isPortable(doc)).toBe(false);
    const seen: string[] = [];
    const bundled = await bundleAssets(doc, async (src) => {
      seen.push(src);
      return { bytes: new Uint8Array([1, 2, 3, 250]) };
    });
    expect(seen).toEqual(['/api/uploads/abc.png']); // data: srcs are left alone
    expect(isPortable(bundled)).toBe(true);
    expect(bundled.assets['as_remote']!.src).toBe(`data:image/png;base64,${bytesToBase64(new Uint8Array([1, 2, 3, 250]))}`);
    expect(Array.from(dataUriToBytes(bundled.assets['as_remote']!.src).bytes)).toEqual([1, 2, 3, 250]);
    expect(doc.assets['as_remote']!.src).toBe('/api/uploads/abc.png'); // input untouched
  });

  it('the largest accepted asset (MAX_ASSET_BYTES) still round-trips as a portable file', async () => {
    const doc = createDocument();
    const { id, asset } = createImageAsset({ src: '/uploads/big.svg', width: 10, height: 10, mimeType: 'image/svg+xml' });
    doc.assets[id] = asset;
    const bytes = new Uint8Array(MAX_ASSET_BYTES).fill(0x41);
    const bundled = await bundleAssets(doc, async () => ({ bytes }));
    expect(bundled.assets[id]!.src.length).toBe(base64DataUriLength(MAX_ASSET_BYTES, 'image/svg+xml'));
    expect(bundled.assets[id]!.src.length).toBeLessThanOrEqual(MAX_ASSET_SRC_LENGTH);
    const text = serializeDocument(bundled);
    expect(parseDocument(text).assets[id]!.src.length).toBe(bundled.assets[id]!.src.length);
  }, 60_000);

  it('propagates fetch failures', async () => {
    const doc = createDocument();
    const { id, asset } = createImageAsset({ src: 'https://x.test/a.png', width: 1, height: 1, mimeType: 'image/png' });
    doc.assets[id] = asset;
    await expect(bundleAssets(doc, async () => Promise.reject(new Error('offline')))).rejects.toThrow('offline');
  });

  it('decodes base64 and percent-encoded data URIs', () => {
    expect(dataUriToBytes('data:image/svg+xml,%3Csvg%2F%3E')).toEqual({
      mimeType: 'image/svg+xml',
      bytes: new TextEncoder().encode('<svg/>'),
    });
    const big = new Uint8Array(100_000).map((_, i) => i % 256);
    expect(dataUriToBytes(`data:image/png;base64,${bytesToBase64(big)}`).bytes).toEqual(big);
  });
});
