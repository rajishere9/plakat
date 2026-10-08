/**
 * Portable round trip (document-schema.md §14): "Download design file" on one Plakat
 * instance → "Import file" on Home of a SECOND, independent instance (own database and
 * uploads) → every page renders pixel-identically (editor snapshots at 1x and 2x).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { PlakatDocument } from '@plakat/schema';
import { captureDownload, comparePngs, createDesignFromTemplate, getDocument, openShareMenu, snapshotPage, trackPageErrors, waitForEditor } from './helpers.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

async function startSecondInstance(): Promise<{ url: string; stop: () => Promise<void> }> {
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, [path.join(root, 'e2e/server.mjs')], {
    cwd: root,
    env: { ...process.env, PLAKAT_E2E_PORT: String(port), PLAKAT_E2E_BUILD: '0' },
    stdio: 'ignore',
  });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`second instance exited with ${child.exitCode}`);
    try {
      if ((await fetch(`${url}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      child.kill('SIGTERM');
      throw new Error('second instance did not start');
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return {
    url,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      }),
  };
}

test('design file downloaded on one instance imports on another and renders identically', async ({ page, context }) => {
  test.setTimeout(180_000);
  const errors = trackPageErrors(page);
  await createDesignFromTemplate(page, 'Café menu');
  const source = await getDocument(page);
  expect(source.pages.length).toBeGreaterThan(1);
  const before: Buffer[][] = [];
  for (const p of source.pages) before.push([await snapshotPage(page, p.id, '1x'), await snapshotPage(page, p.id, '2x')]);

  const menu = await openShareMenu(page);
  const file = await captureDownload(page, () => menu.getByRole('menuitem', { name: /Download design file/ }).click());
  expect(file.filename).toMatch(/\.plakat\.json$/);
  const portable = JSON.parse(file.bytes.toString('utf8')) as PlakatDocument;
  expect(Object.values(portable.assets).every((a) => a.src.startsWith('data:'))).toBe(true);

  const other = await startSecondInstance();
  try {
    const page2 = await context.newPage();
    const errors2 = trackPageErrors(page2);
    await page2.goto(`${other.url}/`);
    await page2.getByLabel('Choose a .plakat.json file to import').setInputFiles({ name: file.filename, mimeType: 'application/json', buffer: file.bytes });
    await page2.waitForURL(/#\/design\//);
    await waitForEditor(page2);
    const imported = await getDocument(page2);
    expect(imported.pages.length).toBe(source.pages.length);
    // Served by the second instance (embedded or moved into its own uploads), never by the first.
    expect(Object.values(imported.assets).every((a) => a.src.startsWith('data:') || a.src.startsWith('/uploads/'))).toBe(true);
    expect(await page2.evaluate(() => window.__plakat!.getStatus())).toMatchObject({ missingAssets: [], missingFonts: [] });
    for (let i = 0; i < imported.pages.length; i++) {
      const id = imported.pages[i]!.id;
      for (const [k, scale] of (['1x', '2x'] as const).entries()) {
        const r = comparePngs(before[i]![k]!, await snapshotPage(page2, id, scale));
        expect(r.diff, `page ${i + 1} at ${scale}`).toBe(0);
      }
    }
    expect(errors2).toEqual([]);
    await page2.close();
  } finally {
    await other.stop();
  }
  expect(errors).toEqual([]);
});
