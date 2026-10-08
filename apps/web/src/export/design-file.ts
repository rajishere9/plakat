/**
 * Portable `.plakat.json` downloads: every asset is embedded as a data: URI
 * (bundleAssets) and the document is written in canonical form (serializeDocument),
 * so the file opens anywhere with no server (Google Fonts aside).
 */
import { exportBaseName } from '@plakat/renderer';
import {
  bundleAssets,
  createFetchAssetFetcher,
  PORTABLE_FILE_EXTENSION,
  PORTABLE_MIME_TYPE,
  saveAsTemplate,
  serializeDocument,
  type AssetFetcher,
  type Id,
  type PlakatDocument,
  type SlotSpec,
} from '@plakat/schema';
import { downloadBlob } from './download.ts';

export function portableFileName(doc: Pick<PlakatDocument, 'meta'>): string {
  return `${exportBaseName(doc.meta.title)}${PORTABLE_FILE_EXTENSION}`;
}

/** Bundles + serializes a document; returns the file text and its name. */
export async function buildPortableFile(doc: PlakatDocument, fetchAsset: AssetFetcher = createFetchAssetFetcher()): Promise<{ text: string; filename: string }> {
  const bundled = await bundleAssets(doc, fetchAsset);
  return { text: serializeDocument(bundled), filename: portableFileName(doc) };
}

/** "Download design file" (or the open template as-is). */
export async function downloadDocumentFile(doc: PlakatDocument, fetchAsset?: AssetFetcher): Promise<string> {
  const { text, filename } = await buildPortableFile(doc, fetchAsset);
  downloadBlob(text, filename, PORTABLE_MIME_TYPE);
  return filename;
}

/** "Download template file" for a design: saveAsTemplate (fresh ids + slots) then bundle. */
export async function downloadAsTemplateFile(
  doc: PlakatDocument,
  input: { slots: ReadonlyArray<Id | SlotSpec>; title?: string; category?: string | null },
  fetchAsset?: AssetFetcher,
): Promise<string> {
  const tpl = saveAsTemplate(doc, input.slots, {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.category !== undefined ? { category: input.category } : {}),
  });
  return downloadDocumentFile(tpl, fetchAsset);
}
