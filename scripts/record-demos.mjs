#!/usr/bin/env node
/**
 * Records the README media in docs/media/ by driving a real Plakat instance with
 * Playwright: four short GIF demos and a static hero screenshot.
 *
 *   npm run build                          # the recorder serves apps/web/dist
 *   node scripts/record-demos.mjs          # all media
 *   node scripts/record-demos.mjs --only editing,export
 *   node scripts/record-demos.mjs --url http://127.0.0.1:8787   # use a running server
 *
 * Options
 *   --only <names>   comma-separated subset of: create, editing, image, export, hero
 *   --url <base>     record against this server instead of starting one. The demos
 *                    create designs and uploads there, so prefer a throwaway instance.
 *   --out <dir>      output directory (default docs/media)
 *   --keep           keep the intermediate .webm videos (printed at the end)
 *   --headed         show the browser while recording
 *
 * Without --url the script starts e2e/server.mjs (built SPA + real API server with an
 * in-memory PGlite database and a temporary upload directory) on a free port, and
 * stops it at the end, so your own data is never touched.
 *
 * Requirements: the Playwright Chromium browser (`npx playwright install chromium`),
 * ffmpeg on PATH (GIF conversion), network access to Google Fonts (template fonts).
 *
 * How it works: each demo runs in its own browser context with `recordVideo`
 * (1280×800). A fake cursor is drawn into the page, because headless video has no
 * mouse pointer, and every pointer movement is eased over several frames so the
 * result reads like a person using the editor. The video is then trimmed to the
 * demo and converted with ffmpeg's two-pass palettegen/paletteuse at ~12 fps and
 * 960 px wide. If a GIF ends up over the size budget (4 MB) it is re-encoded with a
 * lower frame rate and width.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { values: args } = parseArgs({
  options: {
    only: { type: 'string' },
    url: { type: 'string' },
    out: { type: 'string', default: path.join(root, 'docs/media') },
    keep: { type: 'boolean', default: false },
    headed: { type: 'boolean', default: false },
  },
});

const VIDEO = { width: 1280, height: 800 };
const GIF_MAX_BYTES = 4 * 1024 * 1024;
/** GIF encodings tried in order until one fits GIF_MAX_BYTES. */
const GIF_LADDER = [
  { fps: 12, width: 960 },
  { fps: 10, width: 960 },
  { fps: 10, width: 860 },
  { fps: 8, width: 800 },
];

const outDir = path.resolve(args.out);
const workDir = mkdtempSync(path.join(tmpdir(), 'plakat-demos-'));

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(base, timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server at ${base} did not become healthy`);
}

async function startServer() {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, 'e2e/server.mjs')], {
    cwd: root,
    env: { ...process.env, PLAKAT_E2E_PORT: String(port), LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const base = `http://127.0.0.1:${port}`;
  await waitForHealth(base);
  return { base, stop: () => child.kill('SIGTERM') };
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

/** Playwright's Chromium, or the newest cached headless shell (same fallback as playwright.config.ts). */
function chromiumExecutable() {
  if (process.env.PLAKAT_E2E_CHROMIUM) return process.env.PLAKAT_E2E_CHROMIUM;
  try {
    if (existsSync(chromium.executablePath())) return undefined;
  } catch {
    /* fall through */
  }
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright');
  if (!existsSync(cache)) return undefined;
  const shells = readdirSync(cache)
    .filter((d) => d.startsWith('chromium_headless_shell-'))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const d of shells) {
    for (const sub of ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell-mac-x64', 'chrome-headless-shell-linux64']) {
      const p = path.join(cache, d, sub, 'chrome-headless-shell');
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

/**
 * Draws a mouse pointer (headless recordings have none) that follows mouse and drag
 * events, plus a ripple on every press. pointer-events: none, so it never takes a hit.
 */
function installFakeCursor() {
  const install = () => {
    if (document.getElementById('__demo-cursor')) return;
    const style = document.createElement('style');
    style.textContent = `
      #__demo-cursor { position: fixed; left: 0; top: 0; width: 24px; height: 24px; z-index: 2147483647;
        pointer-events: none; transform: translate(-100px, -100px); will-change: transform; }
      #__demo-cursor svg { display: block; filter: drop-shadow(0 1px 1.5px rgba(0,0,0,.35)); }
      .__demo-ripple { position: fixed; z-index: 2147483646; pointer-events: none; width: 34px; height: 34px;
        margin: -17px 0 0 -17px; border-radius: 50%; background: rgba(124, 77, 255, .28);
        border: 2px solid rgba(124, 77, 255, .55); animation: __demo-ripple .45s ease-out forwards; }
      @keyframes __demo-ripple { from { transform: scale(.3); opacity: 1 } to { transform: scale(1); opacity: 0 } }`;
    document.head.appendChild(style);
    const cursor = document.createElement('div');
    cursor.id = '__demo-cursor';
    cursor.innerHTML =
      '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M5 2.5 L5 19.5 L9.3 15.4 L12.2 21.8 L15 20.6 L12.2 14.3 L18.2 14.3 Z" fill="#111" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    document.body.appendChild(cursor);
    const move = (e) => {
      if (e.clientX === 0 && e.clientY === 0) return; // 'drag' events end at (0,0)
      cursor.style.transform = `translate(${e.clientX - 5}px, ${e.clientY - 2}px)`;
    };
    for (const type of ['mousemove', 'pointermove', 'dragover', 'drag']) window.addEventListener(type, move, { capture: true, passive: true });
    window.addEventListener(
      'mousedown',
      (e) => {
        const r = document.createElement('div');
        r.className = '__demo-ripple';
        r.style.left = `${e.clientX}px`;
        r.style.top = `${e.clientY}px`;
        document.body.appendChild(r);
        setTimeout(() => r.remove(), 500);
      },
      { capture: true, passive: true },
    );
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
}

const sleep = (page, ms) => page.waitForTimeout(ms);
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** A person at the mouse: eased movements, short pauses around presses. */
class Hand {
  constructor(page) {
    this.page = page;
    this.x = VIDEO.width / 2;
    this.y = VIDEO.height / 2;
  }

  async moveTo(x, y, { duration } = {}) {
    const dist = Math.hypot(x - this.x, y - this.y);
    const ms = duration ?? Math.min(800, 220 + dist * 0.7);
    const x0 = this.x;
    const y0 = this.y;
    // Time-based easing: each step takes as long as the browser needs, the total stays ~ms.
    const t0 = Date.now();
    for (;;) {
      const t = Math.min(1, (Date.now() - t0) / ms);
      const k = ease(t);
      await this.page.mouse.move(x0 + (x - x0) * k, y0 + (y - y0) * k);
      if (t >= 1) break;
      await sleep(this.page, 10);
    }
    this.x = x;
    this.y = y;
  }

  async click(x, y, { pause = 140, clickCount = 1 } = {}) {
    await this.moveTo(x, y);
    await sleep(this.page, pause);
    await this.page.mouse.click(x, y, { clickCount, delay: 60 });
    await sleep(this.page, 160);
  }

  async dblclick(x, y) {
    await this.moveTo(x, y);
    await sleep(this.page, 160);
    await this.page.mouse.dblclick(x, y, { delay: 40 });
    await sleep(this.page, 200);
  }

  /** Press at the current point, travel to (x, y) and release (a drag). */
  async drag(fromX, fromY, x, y, { duration = 900 } = {}) {
    await this.moveTo(fromX, fromY);
    await sleep(this.page, 150);
    await this.page.mouse.down();
    await sleep(this.page, 120);
    await this.moveTo(x, y, { duration });
    await sleep(this.page, 250);
    await this.page.mouse.up();
    await sleep(this.page, 200);
  }

  async center(locator) {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    if (!box) throw new Error(`not visible: ${locator}`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
  }

  async clickOn(locator, opts) {
    const { x, y } = await this.center(locator);
    await this.click(x, y, opts);
  }

  async hover(locator) {
    const { x, y } = await this.center(locator);
    await this.moveTo(x, y);
  }

  async type(text, delay = 75) {
    await this.page.keyboard.type(text, { delay });
  }

  async scroll(deltaY, steps = 12) {
    for (let i = 0; i < steps; i++) {
      await this.page.mouse.wheel(0, deltaY / steps);
      await sleep(this.page, 30);
    }
  }
}

// ---------------------------------------------------------------------------
// Editor helpers (the same test hook the e2e suite uses)
// ---------------------------------------------------------------------------

async function waitForEditor(page) {
  await page.waitForFunction(() => !!window.__plakat, undefined, { timeout: 30_000 });
  await page.evaluate(() => window.__plakat.ready());
}

async function getDocument(page) {
  return page.evaluate(() => window.__plakat.getDocument());
}

/** Viewport coordinates of a page-space point of the current design. */
async function pageToClient(page, pageId, p) {
  const local = await page.evaluate(({ pageId, p }) => window.__plakat.controller.pageToScreenPoint(pageId, p), { pageId, p });
  const box = await page.locator('[data-plakat-stage]').boundingBox();
  return { x: box.x + local.x, y: box.y + local.y };
}

/** Viewport coordinates of `fx`,`fy` (0..1 fractions) inside the element named/matched. */
async function elementPoint(page, match, fx = 0.5, fy = 0.5) {
  const doc = await getDocument(page);
  for (const pg of doc.pages) {
    const el = pg.elements.find(match);
    if (el) return pageToClient(page, pg.id, { x: el.x + el.width * fx, y: el.y + el.height * fy });
  }
  throw new Error('element not found');
}

async function deleteAllDesigns(base) {
  const res = await fetch(`${base}/api/projects`);
  const { items } = await res.json();
  for (const it of items) await fetch(`${base}/api/projects/${encodeURIComponent(it.id)}`, { method: 'DELETE' });
}

/** Home → template → "Use as is" (no recording-worthy steps; used by setup code). */
async function openTemplate(page, title) {
  await page.goto('/');
  await page.getByRole('button', { name: `Use template: ${title}`, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await Promise.race([page.waitForURL(/#\/design\//), dialog.waitFor({ state: 'visible' })]);
  if (await dialog.isVisible()) await dialog.getByRole('button', { name: 'Use as is' }).click();
  await page.waitForURL(/#\/design\//);
  await waitForEditor(page);
}

/** Sets a range input by dragging its thumb, like a person would. */
async function dragSlider(hand, input, value) {
  const page = hand.page;
  await input.scrollIntoViewIfNeeded();
  const box = await input.boundingBox();
  const { min, max, cur } = await input.evaluate((el) => ({ min: Number(el.min), max: Number(el.max), cur: Number(el.value) }));
  const thumb = 8; // half the thumb width: the track is inset by it
  const at = (v) => box.x + thumb + ((v - min) / (max - min)) * (box.width - 2 * thumb);
  const y = box.y + box.height / 2;
  await hand.drag(at(cur), y, at(value), y, { duration: 700 });
  await sleep(page, 150);
}

// ---------------------------------------------------------------------------
// Test photo (generated, so the repo needs no third-party image)
// ---------------------------------------------------------------------------

async function makeTestPhoto(file) {
  const { createCanvas } = await import('canvas');
  const W = 1600;
  const H = 1067;
  const c = createCanvas(W, H);
  const g = c.getContext('2d');
  // Sky
  const sky = g.createLinearGradient(0, 0, 0, H * 0.62);
  sky.addColorStop(0, '#2b2d6e');
  sky.addColorStop(0.45, '#c8577a');
  sky.addColorStop(0.8, '#f59e5b');
  sky.addColorStop(1, '#ffd58a');
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);
  // Sun with glow
  const sx = W * 0.62;
  const sy = H * 0.5;
  const glow = g.createRadialGradient(sx, sy, 10, sx, sy, 420);
  glow.addColorStop(0, 'rgba(255, 240, 200, 0.95)');
  glow.addColorStop(0.15, 'rgba(255, 210, 140, 0.6)');
  glow.addColorStop(1, 'rgba(255, 170, 120, 0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#fff4dc';
  g.beginPath();
  g.arc(sx, sy, 70, 0, Math.PI * 2);
  g.fill();
  // Thin clouds
  g.globalAlpha = 0.35;
  g.fillStyle = '#ffe3c4';
  for (const [x, y, w] of [[180, 190, 420], [820, 140, 520], [1150, 260, 380], [420, 320, 300]]) {
    g.beginPath();
    g.ellipse(x, y, w / 2, 9, 0, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
  // Mountain ridges, far to near
  const ridge = (base, amp, seed, color) => {
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(0, H);
    for (let x = 0; x <= W; x += 8) {
      const y = base - amp * (0.55 * Math.sin(x / 210 + seed) + 0.3 * Math.sin(x / 83 + seed * 2.1) + 0.15 * Math.sin(x / 37 + seed * 3.7));
      g.lineTo(x, y);
    }
    g.lineTo(W, H);
    g.closePath();
    g.fill();
  };
  ridge(H * 0.6, 90, 1.2, '#8c4f78');
  ridge(H * 0.66, 70, 2.6, '#5e3a68');
  ridge(H * 0.72, 55, 4.1, '#3a2850');
  // Lake with reflection
  const lakeTop = H * 0.74;
  const lake = g.createLinearGradient(0, lakeTop, 0, H);
  lake.addColorStop(0, '#f2a066');
  lake.addColorStop(0.3, '#a2507a');
  lake.addColorStop(1, '#231a3a');
  g.fillStyle = lake;
  g.fillRect(0, lakeTop, W, H - lakeTop);
  g.fillStyle = 'rgba(255, 240, 200, 0.55)';
  for (let i = 0; i < 22; i++) {
    const y = lakeTop + 8 + i * 11;
    const w = 150 - i * 5 + (i % 3) * 18;
    g.fillRect(sx - w / 2 + ((i * 37) % 23) - 11, y, w, 3);
  }
  // Foreground shore with pines
  g.fillStyle = '#140f22';
  g.beginPath();
  g.moveTo(0, H);
  g.lineTo(0, H * 0.86);
  g.quadraticCurveTo(W * 0.2, H * 0.83, W * 0.38, H * 0.9);
  g.lineTo(W * 0.38, H);
  g.closePath();
  g.fill();
  for (const [x, h] of [[60, 230], [130, 300], [205, 210], [270, 260], [340, 180], [1460, 280], [1530, 220]]) {
    const base = x > 1000 ? H : H * 0.88;
    g.beginPath();
    g.moveTo(x, base - h);
    g.lineTo(x - h * 0.22, base);
    g.lineTo(x + h * 0.22, base);
    g.closePath();
    g.fill();
  }
  // Film grain, so it reads as a photo
  const img = g.getImageData(0, 0, W, H);
  let s = 1234567;
  for (let i = 0; i < img.data.length; i += 4) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const n = ((s >> 8) % 17) - 8;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  writeFileSync(file, c.toBuffer('image/jpeg', { quality: 0.9 }));
}

// ---------------------------------------------------------------------------
// Demos. Each returns after its last frame; `mark()` sets where the GIF starts.
// ---------------------------------------------------------------------------

/** (a) Home → template → edit the headline inline → change its font and color. */
async function demoCreate(page, hand, mark) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Use template: Product launch', exact: true }).waitFor();
  await sleep(page, 600);
  mark();
  await hand.moveTo(640, 300, { duration: 300 });
  await sleep(page, 700);
  await hand.scroll(560, 18);
  await sleep(page, 500);
  const card = page.getByRole('button', { name: 'Use template: Product launch', exact: true });
  await hand.hover(page.getByRole('button', { name: 'Use template: Concert poster', exact: true }));
  await sleep(page, 350);
  await hand.clickOn(card);
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ state: 'visible' });
  await sleep(page, 1300);
  await hand.clickOn(dialog.getByRole('button', { name: 'Use as is' }));
  await page.waitForURL(/#\/design\//);
  await waitForEditor(page);
  await sleep(page, 900);

  // Edit the headline in place.
  const head = await elementPoint(page, (e) => e.name === 'Headline', 0.45, 0.5);
  await hand.dblclick(head.x, head.y);
  await page.locator('textarea').waitFor({ state: 'visible' });
  await sleep(page, 400);
  await page.keyboard.press('ControlOrMeta+a');
  await sleep(page, 300);
  await hand.type('Meet the Night Serum', 85);
  await sleep(page, 500);
  await page.keyboard.press('ControlOrMeta+Enter');
  await waitForEditor(page);
  await sleep(page, 700);

  // Font: open the picker, search, pick.
  await hand.clickOn(page.getByRole('button', { name: /^Font: / }));
  await sleep(page, 500);
  await hand.type('abril', 110);
  await sleep(page, 500);
  await hand.clickOn(page.getByRole('option', { name: /Abril Fatface/ }).first());
  await waitForEditor(page);
  await sleep(page, 900);

  // Color: open the swatches and pick the template's coral accent.
  await hand.clickOn(page.getByRole('button', { name: /^Text color: / }));
  await sleep(page, 600);
  await hand.clickOn(page.getByRole('button', { name: '#ff7a59', exact: true }).first());
  await sleep(page, 700);
  await page.keyboard.press('Escape');
  await sleep(page, 300);
  // Deselect (click the empty canvas beside the page) to show the result.
  const box = await page.locator('[data-plakat-stage]').boundingBox();
  await hand.click(box.x + 60, box.y + box.height / 2);
  await sleep(page, 1800);
}

/** (b) Add shapes and text, drag with snapping guides, reorder layers, undo/redo. */
async function demoEditing(page, hand, mark) {
  await page.goto('/');
  await page.locator('.preset-card', { hasText: 'Instagram post' }).first().click();
  await page.waitForURL(/#\/design\//);
  await waitForEditor(page);
  await sleep(page, 500);
  mark();
  await hand.moveTo(560, 420, { duration: 200 });
  await sleep(page, 500);

  // Elements → a circle and a rectangle (orange).
  const rail = (name) => page.getByRole('button', { name, exact: true });
  await hand.clickOn(rail('Elements'));
  await sleep(page, 600);
  await hand.clickOn(page.getByRole('button', { name: 'Add circle', exact: true }));
  await sleep(page, 500);
  await hand.clickOn(page.getByRole('button', { name: 'Add rectangle', exact: true }));
  await sleep(page, 500);
  await hand.clickOn(rail('Elements')); // close the flyout
  await sleep(page, 400);
  await hand.clickOn(page.getByRole('button', { name: /^Fill color: / }));
  await sleep(page, 500);
  await hand.clickOn(page.getByRole('button', { name: '#ff914d', exact: true }).first());
  await sleep(page, 400);
  await page.keyboard.press('Escape');
  await sleep(page, 300);
  // Text → a heading.
  await hand.clickOn(rail('Text'));
  await sleep(page, 500);
  await hand.clickOn(page.locator('.text-preset').first());
  await waitForEditor(page);
  await sleep(page, 400);
  await hand.clickOn(rail('Text'));
  await sleep(page, 500);

  const doc = await getDocument(page);
  const pg = { ...doc.pages[0], width: doc.size.width, height: doc.size.height };
  const els = pg.elements;
  const text = els.find((e) => e.type === 'text');
  const circle = els.find((e) => e.type === 'shape' && e.shape === 'ellipse');
  const rect = els.find((e) => e.type === 'shape' && e.shape === 'rect');
  const at = (x, y) => pageToClient(page, pg.id, { x, y });
  const centerOf = (e) => at(e.x + e.width / 2, e.y + e.height / 2);

  /** Press on `from`, approach `to` with an overshoot, hover there so the guides show, release. */
  const dragSnap = async (from, to, overshoot) => {
    await hand.moveTo(from.x, from.y);
    await sleep(page, 150);
    await page.mouse.down();
    await hand.moveTo(to.x + overshoot.x, to.y + overshoot.y, { duration: 550 });
    await hand.moveTo(to.x + 2, to.y + 1, { duration: 500 });
    await sleep(page, 700); // snapping guides visible
    await page.mouse.up();
    await sleep(page, 400);
  };

  // The heading (on top) snaps to the page's vertical center line, near the top.
  await dragSnap(await centerOf(text), await at(pg.width / 2, pg.height * 0.17), { x: 70, y: 30 });
  // The rectangle moves down-right, the circle (now uncovered) snaps to the center line.
  await dragSnap(await centerOf(rect), await at(pg.width * 0.62, pg.height * 0.62), { x: 40, y: 50 });
  // Grab the circle by its visible left part; drop it with its center on the page's center line.
  const grabDx = -circle.width * 0.3;
  await dragSnap(
    await at(circle.x + circle.width / 2 + grabDx, circle.y + circle.height / 2),
    await at(pg.width / 2 + grabDx, pg.height * 0.46),
    { x: -60, y: -40 },
  );

  // Layers: drag the circle from the bottom of the stack to the top.
  await hand.clickOn(rail('Layers'));
  await sleep(page, 800);
  const rows = page.locator('ul.layers > li');
  const names = await rows.allInnerTexts();
  const idx = names.findIndex((n) => /ellipse|circle/i.test(n));
  const row = await hand.center(rows.nth(idx));
  const top = await rows.first().boundingBox();
  await hand.moveTo(row.x, row.y);
  await sleep(page, 250);
  await page.mouse.down();
  await hand.moveTo(row.x, row.y - 8, { duration: 150 });
  await hand.moveTo(row.x, top.y + 4, { duration: 800 });
  await sleep(page, 300);
  await page.mouse.up();
  await sleep(page, 1100);

  // Undo three steps, then redo them.
  const undo = page.getByRole('button', { name: /^Undo/ });
  const redo = page.getByRole('button', { name: /^Redo/ });
  for (let i = 0; i < 3; i++) {
    await hand.clickOn(undo, { pause: 60 });
    await sleep(page, 450);
  }
  for (let i = 0; i < 3; i++) {
    await hand.clickOn(redo, { pause: 60 });
    await sleep(page, 450);
  }
  await sleep(page, 1000);
}

/** (c) Upload a photo, insert and enlarge it, crop it, adjust contrast/saturation, try sepia. */
async function demoImage(page, hand, mark, { photo }) {
  await page.goto('/');
  await page.locator('.preset-card', { hasText: 'Instagram post' }).first().click();
  await page.waitForURL(/#\/design\//);
  await waitForEditor(page);
  await sleep(page, 500);
  mark();
  await hand.moveTo(560, 420, { duration: 200 });
  await sleep(page, 400);

  await hand.clickOn(page.getByRole('button', { name: 'Uploads', exact: true }));
  await sleep(page, 600);
  const chooser = page.waitForEvent('filechooser');
  await hand.clickOn(page.getByRole('button', { name: 'Upload files', exact: true }));
  await (await chooser).setFiles(photo);
  const tile = page.locator('.media-tile').first();
  await tile.waitFor({ state: 'visible', timeout: 30_000 });
  await sleep(page, 900);
  await hand.clickOn(tile);
  await waitForEditor(page);
  await sleep(page, 700);
  await hand.clickOn(page.getByRole('button', { name: 'Uploads', exact: true })); // close the flyout
  await waitForEditor(page);
  await sleep(page, 400);

  // Make it larger: move it to the top-left, then pull the bottom-right handle out.
  let doc = await getDocument(page);
  const pg = { ...doc.pages[0], width: doc.size.width, height: doc.size.height };
  let img = pg.elements.find((e) => e.type === 'image');
  const at = (x, y) => pageToClient(page, pg.id, { x, y });
  const margin = 60;
  const grab = await at(img.x + img.width / 2, img.y + img.height / 2);
  const drop = await at(margin + img.width / 2, margin + 80 + img.height / 2);
  await hand.drag(grab.x, grab.y, drop.x, drop.y, { duration: 700 });
  doc = await getDocument(page);
  img = doc.pages[0].elements.find((e) => e.id === img.id);
  const corner = await at(img.x + img.width, img.y + img.height);
  const targetW = pg.width - 2 * margin;
  const pull = await at(img.x + targetW, img.y + targetW * (img.height / img.width));
  await hand.drag(corner.x, corner.y, pull.x, pull.y, { duration: 900 });
  await waitForEditor(page);
  await sleep(page, 500);

  // Crop: shrink from the bottom-right corner, then slide the frame onto the sun.
  doc = await getDocument(page);
  img = doc.pages[0].elements.find((e) => e.id === img.id);
  await hand.clickOn(page.getByRole('button', { name: 'Crop', exact: true }));
  await sleep(page, 700);
  const br = await pageToClient(page, pg.id, { x: img.x + img.width, y: img.y + img.height });
  const tl = await pageToClient(page, pg.id, { x: img.x, y: img.y });
  const w = br.x - tl.x;
  const h = br.y - tl.y;
  await hand.drag(br.x, br.y, br.x - w * 0.38, br.y - h * 0.38, { duration: 900 });
  await sleep(page, 400);
  // Move the crop frame right/down (towards the sun and the lake).
  const fx = tl.x + w * 0.31;
  const fy = tl.y + h * 0.31;
  await hand.drag(fx, fy, fx + w * 0.3, fy + h * 0.22, { duration: 900 });
  await sleep(page, 600);
  await hand.clickOn(page.getByRole('button', { name: 'Done cropping' }));
  await waitForEditor(page);
  await sleep(page, 800);

  // Filters.
  const panel = page.locator('.props');
  await dragSlider(hand, panel.getByRole('slider', { name: 'Contrast' }), 28);
  await sleep(page, 300);
  await dragSlider(hand, panel.getByRole('slider', { name: 'Saturation' }), 45);
  await sleep(page, 400);
  const sepia = panel.getByRole('switch', { name: 'Sepia' });
  await hand.clickOn(sepia.locator('xpath=ancestor::label[1]'));
  await waitForEditor(page);
  await sleep(page, 1000);
  await hand.clickOn(sepia.locator('xpath=ancestor::label[1]'));
  await waitForEditor(page);
  await sleep(page, 500);
  await sleep(page, 1200);
}

/** (d) Export dialog: PNG at 2x, then PDF at print, with the pixel dimensions shown. */
async function demoExport(page, hand, mark) {
  await openTemplate(page, 'Concert poster');
  await sleep(page, 500);
  mark();
  await hand.moveTo(700, 360, { duration: 200 });
  await sleep(page, 600);
  await hand.clickOn(page.locator('.topbar').getByRole('button', { name: 'Share' }));
  await sleep(page, 600);
  await hand.clickOn(page.getByRole('menuitem', { name: /Download PNG, JPG or PDF/ }));
  const dialog = page.getByRole('dialog', { name: 'Download' });
  await dialog.waitFor({ state: 'visible' });
  await sleep(page, 900);
  const pick = async (name, value) => {
    const input = dialog.locator(`input[name="${name}"][value="${value}"]`);
    await hand.clickOn(input.locator('xpath=ancestor::label[1]'));
    await sleep(page, 700);
  };
  await pick('export-format', 'png');
  await pick('export-scale', '2x');
  await sleep(page, 600);
  await pick('export-scale', 'print');
  await sleep(page, 500);
  await pick('export-format', 'pdf');
  await sleep(page, 900);
  const download = page.waitForEvent('download', { timeout: 60_000 });
  await hand.clickOn(dialog.getByRole('button', { name: 'Download', exact: true }));
  await download;
  await sleep(page, 1500);
}

/** Static hero screenshot (1440×900): a template open with a text element selected. */
async function hero(browser, base) {
  const context = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await openTemplate(page, 'Product launch');
  const p = await elementPoint(page, (e) => e.name === 'Headline', 0.4, 0.5);
  await page.mouse.click(p.x, p.y);
  await page.getByRole('button', { name: 'Layers', exact: true }).click();
  await waitForEditor(page);
  await sleep(page, 800);
  await page.mouse.move(1, 1);
  const file = path.join(outDir, 'editor.png');
  await page.screenshot({ path: file });
  await context.close();
  console.log(`[record-demos] ${path.relative(root, file)} (${(statSync(file).size / 1024).toFixed(0)} KB)`);
}

// ---------------------------------------------------------------------------
// Recording + GIF conversion
// ---------------------------------------------------------------------------

function ffmpeg(argv) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...argv], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ffmpeg ${argv.join(' ')}`);
}

function toGif(video, out, start, duration) {
  const palette = path.join(workDir, 'palette.png');
  for (const { fps, width } of GIF_LADDER) {
    const filters = `fps=${fps},scale=${width}:-1:flags=lanczos`;
    const trim = ['-ss', start.toFixed(2), '-t', duration.toFixed(2), '-i', video];
    ffmpeg([...trim, '-vf', `${filters},palettegen=max_colors=200:stats_mode=full`, palette]);
    ffmpeg([...trim, '-i', palette, '-lavfi', `${filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`, '-loop', '0', out]);
    const size = statSync(out).size;
    if (size <= GIF_MAX_BYTES) return { fps, width, size };
    console.log(`[record-demos] ${path.basename(out)}: ${(size / 1e6).toFixed(1)} MB at ${fps} fps/${width}px, retrying smaller`);
  }
  return { size: statSync(out).size, fps: GIF_LADDER.at(-1).fps, width: GIF_LADDER.at(-1).width };
}

async function record(browser, base, name, demo, extra) {
  const videoDir = path.join(workDir, name);
  const context = await browser.newContext({
    baseURL: base,
    viewport: VIDEO,
    deviceScaleFactor: 1,
    recordVideo: { dir: videoDir, size: VIDEO },
    acceptDownloads: true,
  });
  await context.addInitScript(installFakeCursor);
  const page = await context.newPage();
  const t0 = Date.now();
  let start = 0;
  const hand = new Hand(page);
  try {
    await demo(page, hand, () => (start = (Date.now() - t0) / 1000), extra);
  } catch (error) {
    await page.screenshot({ path: path.join(workDir, `${name}-failure.png`) }).catch(() => {});
    throw error;
  }
  const end = (Date.now() - t0) / 1000;
  const video = page.video();
  await context.close();
  const webm = await video.path();
  const out = path.join(outDir, `${name}.gif`);
  const result = toGif(webm, out, start + 0.1, end - start - 0.1);
  console.log(`[record-demos] ${path.relative(root, out)}: ${(result.size / 1e6).toFixed(2)} MB, ${(end - start).toFixed(1)} s, ${result.fps} fps, ${result.width}px`);
  return webm;
}

const DEMOS = {
  create: { file: 'create-from-template', run: demoCreate },
  editing: { file: 'editing', run: demoEditing },
  image: { file: 'image-crop-filters', run: demoImage },
  export: { file: 'export', run: demoExport },
};

async function main() {
  const only = args.only ? new Set(args.only.split(',').map((s) => s.trim())) : null;
  const unknown = only ? [...only].filter((n) => n !== 'hero' && !DEMOS[n]) : [];
  if (unknown.length) throw new Error(`unknown demo(s): ${unknown.join(', ')}`);
  if (spawnSync('ffmpeg', ['-version']).status !== 0) throw new Error('ffmpeg is required on PATH');
  mkdirSync(outDir, { recursive: true });

  const server = args.url ? { base: args.url.replace(/\/+$/, ''), stop: () => {} } : await startServer();
  const executablePath = chromiumExecutable();
  const browser = await chromium.launch({ headless: !args.headed, ...(executablePath ? { executablePath } : {}) });
  const videos = [];
  let failed = false;
  try {
    const photo = path.join(workDir, 'lake-at-dusk.jpg');
    await makeTestPhoto(photo);
    for (const [key, { file, run }] of Object.entries(DEMOS)) {
      if (only && !only.has(key)) continue;
      if (!args.url) await deleteAllDesigns(server.base);
      videos.push(await record(browser, server.base, file, run, { photo }));
    }
    if (!only || only.has('hero')) {
      if (!args.url) await deleteAllDesigns(server.base);
      await hero(browser, server.base);
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await browser.close();
    server.stop();
    if (args.keep || failed) console.log(`[record-demos] intermediate files kept in ${workDir}`);
    else rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
