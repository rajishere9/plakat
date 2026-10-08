/**
 * Generates the placeholder artwork used by the built-in templates
 * (templates/assets/*.jpg|png). Everything here is procedural, original work
 * released under CC0, so templates stay self-contained and license-clean.
 *
 *   npx tsx templates/scripts/placeholders.ts
 *
 * The outputs are committed; build-templates.ts embeds them as data URIs. You
 * only need to re-run this when changing the artwork. Drawing is seeded, so a
 * re-run reproduces the same pictures (bytes may differ across cairo versions).
 */
import { createCanvas, type CanvasRenderingContext2D } from 'canvas';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSET_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const JPEG_QUALITY = 0.8;

type Ctx = CanvasRenderingContext2D;

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function linear(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, stops: [number, string][]) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  for (const [o, c] of stops) g.addColorStop(o, c);
  return g;
}

function radial(ctx: Ctx, x: number, y: number, r: number, stops: [number, string][]) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  for (const [o, c] of stops) g.addColorStop(o, c);
  return g;
}

/** Soft colour blob (a radial gradient fading to transparent). */
function blob(ctx: Ctx, x: number, y: number, r: number, rgb: string, alpha = 1) {
  ctx.fillStyle = radial(ctx, x, y, r, [
    [0, `rgba(${rgb},${alpha})`],
    [0.55, `rgba(${rgb},${alpha * 0.45})`],
    [1, `rgba(${rgb},0)`],
  ]);
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

/** Very light luminance noise so large gradients do not band after JPEG. */
function grain(ctx: Ctx, w: number, h: number, amount: number, seed: number) {
  const rand = rng(seed);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rand() - 0.5) * amount;
    d[i] = Math.max(0, Math.min(255, d[i]! + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1]! + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2]! + n));
  }
  ctx.putImageData(img, 0, 0);
}

function ridge(ctx: Ctx, w: number, baseY: number, amp: number, seed: number, fill: string | CanvasGradient) {
  const rand = rng(seed);
  // Midpoint displacement: a jagged but natural mountain ridge.
  let pts: number[] = [baseY - amp * rand(), baseY - amp * rand()];
  let disp = amp * 0.9;
  for (let level = 0; level < 7; level++) {
    const next: number[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      next.push(pts[i]!, (pts[i]! + pts[i + 1]!) / 2 + (rand() - 0.5) * disp);
    }
    next.push(pts[pts.length - 1]!);
    pts = next;
    disp *= 0.55;
  }
  ctx.beginPath();
  ctx.moveTo(0, ctx.canvas.height);
  pts.forEach((y, i) => ctx.lineTo((i / (pts.length - 1)) * w, Math.min(baseY + amp * 0.2, Math.max(baseY - amp * 1.2, y))));
  ctx.lineTo(w, ctx.canvas.height);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

// ---------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------

/** Dusk mountains — landscape travel photo stand-in (vlog thumbnail, menu fallbacks). */
function landscape(w = 1280, h = 720) {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = linear(ctx, 0, 0, 0, h, [
    [0, '#1f2a5a'],
    [0.38, '#7a4b8c'],
    [0.62, '#f0806a'],
    [0.8, '#ffc58a'],
    [1, '#ffe3b0'],
  ]);
  ctx.fillRect(0, 0, w, h);
  blob(ctx, w * 0.68, h * 0.5, h * 0.6, '255,214,150', 0.75);
  ctx.fillStyle = radial(ctx, w * 0.68, h * 0.5, h * 0.11, [
    [0, '#fff6dc'],
    [0.85, '#ffe6b0'],
    [1, 'rgba(255,230,176,0)'],
  ]);
  ctx.beginPath();
  ctx.arc(w * 0.68, h * 0.5, h * 0.11, 0, Math.PI * 2);
  ctx.fill();
  const layers: [number, number, string, string][] = [
    [0.66, 0.22, '#c7768c', '#a8607f'],
    [0.76, 0.22, '#83507c', '#6b436f'],
    [0.86, 0.2, '#4c3262', '#3e2955'],
    [0.97, 0.18, '#231a3b', '#1b142e'],
  ];
  layers.forEach(([base, amp, top, bottom], i) => {
    ridge(ctx, w, h * base, h * amp, 11 + i * 7, linear(ctx, 0, h * (base - amp), 0, h, [[0, top], [1, bottom]]));
  });
  grain(ctx, w, h, 3, 1);
  return c;
}

/** Studio product shot: a cosmetic bottle on a plinth. */
function product(w = 900, h = 900) {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = linear(ctx, 0, 0, 0, h * 0.7, [[0, '#f3d9cf'], [1, '#e9c3b5']]);
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = linear(ctx, 0, h * 0.7, 0, h, [[0, '#dcae9e'], [1, '#c99484']]);
  ctx.fillRect(0, h * 0.7, w, h * 0.3);
  blob(ctx, w * 0.3, h * 0.25, w * 0.5, '255,240,232', 0.8);
  // plinth
  const px = w * 0.24;
  const pw = w * 0.52;
  const py = h * 0.66;
  ctx.fillStyle = linear(ctx, px, 0, px + pw, 0, [[0, '#f4e4dc'], [0.5, '#fbf1ec'], [1, '#dcc2b6']]);
  ctx.fillRect(px, py, pw, h * 0.22);
  ctx.fillStyle = '#fff7f3';
  ctx.beginPath();
  ctx.ellipse(w / 2, py, pw / 2, h * 0.045, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(160,110,95,0.35)';
  ctx.beginPath();
  ctx.ellipse(w / 2, py + h * 0.22, pw / 2, h * 0.03, 0, 0, Math.PI);
  ctx.fill();
  // shadow under bottle
  ctx.fillStyle = radial(ctx, w * 0.52, py + 4, w * 0.16, [[0, 'rgba(120,70,60,0.35)'], [1, 'rgba(120,70,60,0)']]);
  ctx.beginPath();
  ctx.ellipse(w * 0.52, py + 4, w * 0.17, h * 0.03, 0, 0, Math.PI * 2);
  ctx.fill();
  // bottle body
  const bw = w * 0.2;
  const bh = h * 0.36;
  const bx = w / 2 - bw / 2;
  const by = py - bh;
  ctx.fillStyle = linear(ctx, bx, 0, bx + bw, 0, [
    [0, '#c46b4f'],
    [0.25, '#e58f6f'],
    [0.42, '#f8b79c'],
    [0.6, '#df8564'],
    [1, '#a8553c'],
  ]);
  ctx.beginPath();
  ctx.roundRect(bx, by, bw, bh, [bw * 0.32, bw * 0.32, 10, 10]);
  ctx.fill();
  // label
  ctx.fillStyle = 'rgba(255,248,242,0.92)';
  ctx.fillRect(bx + bw * 0.14, by + bh * 0.42, bw * 0.72, bh * 0.3);
  ctx.fillStyle = 'rgba(150,80,60,0.6)';
  ctx.fillRect(bx + bw * 0.3, by + bh * 0.5, bw * 0.4, 5);
  ctx.fillRect(bx + bw * 0.36, by + bh * 0.58, bw * 0.28, 3);
  // neck + cap
  ctx.fillStyle = linear(ctx, w / 2 - bw * 0.18, 0, w / 2 + bw * 0.18, 0, [[0, '#3b2a26'], [0.4, '#6b5049'], [1, '#2a1d1a']]);
  ctx.beginPath();
  ctx.roundRect(w / 2 - bw * 0.18, by - bh * 0.22, bw * 0.36, bh * 0.24, 6);
  ctx.fill();
  // highlight
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath();
  ctx.roundRect(bx + bw * 0.2, by + bh * 0.08, bw * 0.07, bh * 0.28, 8);
  ctx.fill();
  // a sphere prop
  const sx = w * 0.7;
  const sr = w * 0.07;
  const sy = py - sr;
  ctx.fillStyle = radial(ctx, sx - sr * 0.35, sy - sr * 0.35, sr * 1.4, [[0, '#ffffff'], [0.35, '#f6d2c2'], [1, '#c58d79']]);
  ctx.beginPath();
  ctx.arc(sx, sy, sr, 0, Math.PI * 2);
  ctx.fill();
  grain(ctx, w, h, 3, 2);
  return c;
}

/** Friendly creator portrait stand-in: abstract silhouette on a gradient. */
function portrait(w = 800, h = 1000) {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = linear(ctx, 0, 0, w, h, [[0, '#8ec5fc'], [1, '#e0c3fc']]);
  ctx.fillRect(0, 0, w, h);
  blob(ctx, w * 0.75, h * 0.2, w * 0.6, '255,255,255', 0.5);
  blob(ctx, w * 0.1, h * 0.9, w * 0.6, '160,120,240', 0.35);
  const cx = w / 2;
  // shoulders
  ctx.fillStyle = linear(ctx, 0, h * 0.6, 0, h, [[0, '#5b4b8a'], [1, '#3d3266']]);
  ctx.beginPath();
  ctx.moveTo(cx - w * 0.42, h);
  ctx.bezierCurveTo(cx - w * 0.42, h * 0.72, cx - w * 0.25, h * 0.64, cx, h * 0.64);
  ctx.bezierCurveTo(cx + w * 0.25, h * 0.64, cx + w * 0.42, h * 0.72, cx + w * 0.42, h);
  ctx.closePath();
  ctx.fill();
  // neck
  ctx.fillStyle = '#c99a86';
  ctx.fillRect(cx - w * 0.07, h * 0.5, w * 0.14, h * 0.16);
  // head
  ctx.fillStyle = radial(ctx, cx - w * 0.06, h * 0.33, w * 0.26, [[0, '#f2c9b4'], [1, '#d9a690']]);
  ctx.beginPath();
  ctx.ellipse(cx, h * 0.38, w * 0.16, h * 0.15, 0, 0, Math.PI * 2);
  ctx.fill();
  // hair
  ctx.fillStyle = '#2d2340';
  ctx.beginPath();
  ctx.moveTo(cx - w * 0.17, h * 0.42);
  ctx.bezierCurveTo(cx - w * 0.2, h * 0.2, cx + w * 0.12, h * 0.14, cx + w * 0.17, h * 0.3);
  ctx.bezierCurveTo(cx + w * 0.19, h * 0.36, cx + w * 0.17, h * 0.4, cx + w * 0.165, h * 0.42);
  ctx.bezierCurveTo(cx + w * 0.12, h * 0.3, cx - w * 0.02, h * 0.33, cx - w * 0.1, h * 0.28);
  ctx.bezierCurveTo(cx - w * 0.13, h * 0.32, cx - w * 0.15, h * 0.37, cx - w * 0.17, h * 0.42);
  ctx.closePath();
  ctx.fill();
  grain(ctx, w, h, 3, 3);
  return c;
}

/** Concert / nightlife artwork: stage beams and neon rings. */
function concert(w = 720, h = 900) {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = linear(ctx, 0, 0, 0, h, [[0, '#0b0820'], [0.6, '#1a0b33'], [1, '#2a0a2e']]);
  ctx.fillRect(0, 0, w, h);
  blob(ctx, w * 0.5, h * 0.62, w * 0.75, '255,46,136', 0.55);
  blob(ctx, w * 0.2, h * 0.3, w * 0.5, '80,70,255', 0.45);
  blob(ctx, w * 0.85, h * 0.2, w * 0.45, '0,200,255', 0.3);
  // beams
  ctx.globalCompositeOperation = 'lighter';
  const sources: [number, string][] = [[0.15, '120,160,255'], [0.5, '255,120,200'], [0.85, '120,230,255']];
  sources.forEach(([sx, rgb], i) => {
    for (let k = -1; k <= 1; k++) {
      const ang = (k * 0.22 + (i - 1) * 0.12) as number;
      const len = h * 1.1;
      const ex = w * sx + Math.sin(ang) * len;
      const ey = Math.cos(ang) * len;
      ctx.fillStyle = linear(ctx, w * sx, 0, ex, ey, [[0, `rgba(${rgb},0.35)`], [1, `rgba(${rgb},0)`]]);
      ctx.beginPath();
      ctx.moveTo(w * sx - 4, 0);
      ctx.lineTo(ex - w * 0.08, ey);
      ctx.lineTo(ex + w * 0.08, ey);
      ctx.lineTo(w * sx + 4, 0);
      ctx.closePath();
      ctx.fill();
    }
  });
  ctx.globalCompositeOperation = 'source-over';
  // neon rings
  for (let i = 0; i < 6; i++) {
    ctx.strokeStyle = `rgba(255,${120 + i * 20},${200 - i * 10},${0.55 - i * 0.07})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(w * 0.5, h * 0.62, w * (0.16 + i * 0.07), 0, Math.PI * 2);
    ctx.stroke();
  }
  // crowd silhouette
  const rand = rng(42);
  ctx.fillStyle = '#07040f';
  ctx.beginPath();
  ctx.moveTo(0, h);
  let x = 0;
  while (x < w) {
    const r = 22 + rand() * 18;
    const y = h * 0.9 - rand() * 30;
    ctx.lineTo(x, y + r);
    ctx.arc(x + r, y + r * 0.2, r, Math.PI, 0);
    x += r * 2 - 4;
  }
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fill();
  grain(ctx, w, h, 3, 4);
  return c;
}

/** Soft mesh-gradient backdrop (event story). */
function mesh(w = 1080, h = 1200) {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffb38a';
  ctx.fillRect(0, 0, w, h);
  blob(ctx, w * 0.1, h * 0.1, w * 0.9, '255,94,98', 0.9);
  blob(ctx, w * 0.95, h * 0.25, w * 0.8, '255,195,113', 0.95);
  blob(ctx, w * 0.25, h * 0.85, w * 0.9, '124,77,255', 0.85);
  blob(ctx, w * 0.9, h * 0.95, w * 0.7, '255,111,177', 0.8);
  blob(ctx, w * 0.55, h * 0.5, w * 0.45, '255,236,210', 0.6);
  grain(ctx, w, h, 3, 5);
  return c;
}

/** Overhead café flat-lay: latte, croissant-ish pastry and leaves on linen. */
function cafe(w = 900, h = 1100) {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = linear(ctx, 0, 0, w, h, [[0, '#e9dccb'], [1, '#d8c5ae']]);
  ctx.fillRect(0, 0, w, h);
  blob(ctx, w * 0.2, h * 0.15, w * 0.8, '255,250,240', 0.6);
  const shadow = (x: number, y: number, r: number) => {
    ctx.fillStyle = radial(ctx, x + r * 0.08, y + r * 0.1, r * 1.15, [[0.8, 'rgba(90,60,30,0.28)'], [1, 'rgba(90,60,30,0)']]);
    ctx.beginPath();
    ctx.arc(x + r * 0.08, y + r * 0.1, r * 1.15, 0, Math.PI * 2);
    ctx.fill();
  };
  // saucer + cup
  const cx = w * 0.58;
  const cy = h * 0.42;
  shadow(cx, cy, w * 0.3);
  ctx.fillStyle = radial(ctx, cx - 30, cy - 30, w * 0.32, [[0, '#ffffff'], [1, '#ece6de']]);
  ctx.beginPath();
  ctx.arc(cx, cy, w * 0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(160,140,120,0.35)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, w * 0.22, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#fbfaf7';
  ctx.beginPath();
  ctx.arc(cx, cy, w * 0.19, 0, Math.PI * 2);
  ctx.fill();
  // handle
  ctx.fillStyle = '#f4f0ea';
  ctx.beginPath();
  ctx.roundRect(cx + w * 0.17, cy - 22, w * 0.11, 44, 22);
  ctx.fill();
  // coffee
  ctx.fillStyle = radial(ctx, cx, cy, w * 0.16, [[0, '#b07a4f'], [0.75, '#8a5530'], [1, '#5e3519']]);
  ctx.beginPath();
  ctx.arc(cx, cy, w * 0.16, 0, Math.PI * 2);
  ctx.fill();
  // latte art (heart-ish)
  ctx.fillStyle = 'rgba(250,236,214,0.92)';
  ctx.beginPath();
  ctx.moveTo(cx, cy + w * 0.08);
  ctx.bezierCurveTo(cx - w * 0.13, cy - w * 0.01, cx - w * 0.06, cy - w * 0.1, cx, cy - w * 0.04);
  ctx.bezierCurveTo(cx + w * 0.06, cy - w * 0.1, cx + w * 0.13, cy - w * 0.01, cx, cy + w * 0.08);
  ctx.fill();
  // pastry plate
  const px = w * 0.27;
  const py = h * 0.78;
  shadow(px, py, w * 0.21);
  ctx.fillStyle = radial(ctx, px - 20, py - 20, w * 0.24, [[0, '#ffffff'], [1, '#e9e2d8']]);
  ctx.beginPath();
  ctx.arc(px, py, w * 0.21, 0, Math.PI * 2);
  ctx.fill();
  // croissant: overlapping lobes
  const lobes = [-0.5, -0.25, 0, 0.25, 0.5];
  lobes.forEach((t, i) => {
    const r = w * (0.075 - Math.abs(t) * 0.05);
    const lx = px + t * w * 0.24;
    const ly = py + Math.abs(t) * w * 0.07;
    ctx.fillStyle = radial(ctx, lx - r * 0.3, ly - r * 0.4, r * 1.5, [[0, '#f7c77a'], [0.6, '#d98f3c'], [1, '#a65e1f']]);
    ctx.beginPath();
    ctx.ellipse(lx, ly, r, r * 1.15, t * 0.8, 0, Math.PI * 2);
    ctx.fill();
    if (i > 0) {
      ctx.strokeStyle = 'rgba(120,60,20,0.35)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(lx, ly, r * 0.9, Math.PI * 0.6, Math.PI * 1.4);
      ctx.stroke();
    }
  });
  // leaves
  const leaf = (x: number, y: number, len: number, ang: number, col: string) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(len * 0.5, -len * 0.28, len, 0);
    ctx.quadraticCurveTo(len * 0.5, len * 0.28, 0, 0);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(4, 0);
    ctx.lineTo(len * 0.9, 0);
    ctx.stroke();
    ctx.restore();
  };
  leaf(w * 0.05, h * 0.12, w * 0.26, 0.5, '#7d9a6a');
  leaf(w * 0.1, h * 0.2, w * 0.22, 0.05, '#93ad7c');
  leaf(w * 0.82, h * 0.86, w * 0.24, -2.6, '#7d9a6a');
  leaf(w * 0.9, h * 0.78, w * 0.2, -2.1, '#a2b98b');
  // coffee beans
  const rand = rng(9);
  for (let i = 0; i < 7; i++) {
    const bx = w * (0.72 + rand() * 0.22);
    const by = h * (0.08 + rand() * 0.12);
    ctx.save();
    ctx.translate(bx, by);
    ctx.rotate(rand() * Math.PI);
    ctx.fillStyle = '#4a2a17';
    ctx.beginPath();
    ctx.ellipse(0, 0, 16, 11, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#2b170b';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-12, 0);
    ctx.quadraticCurveTo(0, 4, 12, 0);
    ctx.stroke();
    ctx.restore();
  }
  grain(ctx, w, h, 3, 6);
  return c;
}

/** Geometric "orbit" logo mark on a transparent background. */
function logoMark(color: string, size = 256) {
  const c = createCanvas(size, size);
  const ctx = c.getContext('2d');
  const s = size;
  ctx.strokeStyle = color;
  ctx.lineWidth = s * 0.085;
  ctx.beginPath();
  ctx.arc(s * 0.46, s * 0.54, s * 0.3, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(s * 0.76, s * 0.26, s * 0.12, 0, Math.PI * 2);
  ctx.fill();
  return c;
}

// ---------------------------------------------------------------------------

interface Output {
  file: string;
  canvas: ReturnType<typeof createCanvas>;
}

const outputs: Output[] = [
  { file: 'photo-landscape.jpg', canvas: landscape() },
  { file: 'photo-product.jpg', canvas: product() },
  { file: 'photo-portrait.jpg', canvas: portrait() },
  { file: 'art-concert.jpg', canvas: concert() },
  { file: 'art-mesh.jpg', canvas: mesh() },
  { file: 'photo-cafe.jpg', canvas: cafe() },
  { file: 'logo-mark-dark.png', canvas: logoMark('#1c1c28') },
  { file: 'logo-mark-light.png', canvas: logoMark('#ffffff') },
];

mkdirSync(ASSET_DIR, { recursive: true });
for (const { file, canvas } of outputs) {
  const buf = file.endsWith('.png')
    ? canvas.toBuffer('image/png', { compressionLevel: 9 })
    : canvas.toBuffer('image/jpeg', { quality: JPEG_QUALITY, progressive: false, chromaSubsampling: true });
  writeFileSync(join(ASSET_DIR, file), buf);
  console.log(`${file.padEnd(24)} ${canvas.width}x${canvas.height}  ${(buf.length / 1024).toFixed(1)} KB`);
}
