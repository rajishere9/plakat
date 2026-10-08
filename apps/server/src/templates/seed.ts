import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { normalizeDocument, parseDocument, PORTABLE_FILE_EXTENSION } from '@plakat/schema';
import type { Db } from '../db/index.ts';
import { documentSummary, internalizeDocumentAssets } from '../documents.ts';
import type { UploadStore } from '../storage/uploads.ts';

export interface SeedLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface SeedResult {
  /** Template ids upserted as built-ins. */
  loaded: string[];
  /** Files skipped, with the reason. */
  skipped: { file: string; reason: string }[];
  /** Built-in ids removed because their file disappeared. */
  removed: string[];
}

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile() && e.name.endsWith(PORTABLE_FILE_EXTENSION)) yield full;
  }
}

/**
 * Loads every `**\/*.plakat.json` under `dir`, validates it with the schema loader
 * (kind must be "template"), moves embedded images into uploads and upserts it as a
 * built-in row keyed by document id. Invalid files are skipped (logged), never fatal.
 * Built-in rows whose file is gone are removed. A thumbnail is kept only while the
 * file content is unchanged.
 */
export async function seedBuiltInTemplates(
  db: Db,
  uploads: UploadStore,
  dir: string,
  log: SeedLogger = { info: () => {}, warn: () => {} },
): Promise<SeedResult> {
  const result: SeedResult = { loaded: [], skipped: [], removed: [] };
  try {
    if (!(await stat(dir)).isDirectory()) throw new Error('not a directory');
  } catch {
    log.warn(`Templates directory ${dir} not found; no built-in templates loaded`);
    return result;
  }
  const seen = new Set<string>();
  for await (const file of walk(dir)) {
    const rel = path.relative(dir, file);
    try {
      const text = await readFile(file, 'utf8');
      const parsed = normalizeDocument(parseDocument(text));
      if (parsed.kind !== 'template' || !parsed.template) throw new Error('kind must be "template"');
      if (seen.has(parsed.id)) throw new Error(`duplicate template id "${parsed.id}"`);
      const doc = await internalizeDocumentAssets(parsed, uploads);
      const s = documentSummary(doc);
      const hash = createHash('sha256').update(text).digest('hex');
      const { rows } = await db.query(
        `INSERT INTO templates (id, title, category, document, schema_version, version, built_in, content_hash, search_text, size, page_count, slot_count)
         VALUES ($1, $2, $3, $4::jsonb, $5, 1, true, $6, $7, $8::jsonb, $9, $10)
         ON CONFLICT (id) DO UPDATE SET
           title = EXCLUDED.title, category = EXCLUDED.category, document = EXCLUDED.document,
           schema_version = EXCLUDED.schema_version, search_text = EXCLUDED.search_text, size = EXCLUDED.size,
           page_count = EXCLUDED.page_count, slot_count = EXCLUDED.slot_count, content_hash = EXCLUDED.content_hash,
           version = CASE WHEN templates.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN templates.version + 1 ELSE templates.version END,
           updated_at = CASE WHEN templates.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN now() ELSE templates.updated_at END,
           thumbnail = CASE WHEN templates.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN NULL ELSE templates.thumbnail END,
           thumbnail_updated_at = CASE WHEN templates.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN NULL ELSE templates.thumbnail_updated_at END
         WHERE templates.built_in = true
         RETURNING id`,
        [doc.id, s.title, s.category, JSON.stringify(doc), s.schemaVersion, hash, s.searchText, JSON.stringify(s.size), s.pageCount, s.slotCount],
      );
      if (!rows[0]) throw new Error(`id "${doc.id}" is already used by a user template`);
      seen.add(doc.id);
      result.loaded.push(doc.id);
    } catch (error) {
      const reason = error instanceof Error ? error.message.split('\n').slice(0, 4).join(' ') : String(error);
      result.skipped.push({ file: rel, reason });
      log.warn(`Skipping built-in template ${rel}: ${reason}`);
    }
  }
  const { rows } = await db.query<{ id: string }>(
    'DELETE FROM templates WHERE built_in = true AND NOT (id = ANY($1::text[])) RETURNING id',
    [[...seen]],
  );
  result.removed = rows.map((r) => r.id);
  log.info(`Loaded ${result.loaded.length} built-in template(s) from ${dir}${result.skipped.length ? `, skipped ${result.skipped.length}` : ''}`);
  return result;
}
