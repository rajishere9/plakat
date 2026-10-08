/**
 * Renders every page of the built-in templates to PNG for a quick visual check.
 *
 *   npx tsx templates/scripts/preview-templates.ts [--out DIR] [--fonts DIR]
 *        [--width PX] [--stress] [filter ...]
 *
 * --out     output directory (default: <tmp>/plakat-template-previews)
 * --fonts   font cache directory (default: <tmp>/plakat-font-cache); fonts are
 *           downloaded from Google Fonts on first use (network required)
 * --width   output width of each page in px (default 1080)
 * --stress  also render each template instantiated with max-length text fills,
 *           to check that layouts survive long input
 * filter    substrings of template paths to render (default: all)
 *
 * This is an APPROXIMATE stand-alone preview (node-canvas + Konva) that follows
 * docs/render-export-pipeline.md §3 closely enough to judge a layout; the
 * pixel-exact renderer is @plakat/renderer.
 */
import Konva from 'konva';
import 'konva/canvas-backend';
import { loadImage, registerFont, type Image as CanvasImage } from 'canvas';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import {
  applyTextTransform,
  collectFonts,
  computeImageLayout,
  getShapePoints,
  instantiateTemplate,
  parseDocument,
  type PlakatDocument,
  type SlotFills,
} from '@plakat/schema';
import { TEMPLATES_ROOT, findTemplateFiles } from './lib.ts';

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}
const outDir = flag('--out') ?? join(tmpdir(), 'plakat-template-previews');
const fontDir = flag('--fonts') ?? join(tmpdir(), 'plakat-font-cache');
const targetWidth = Number(flag('--width') ?? 1080);
const stress = args.includes('--stress');
const filters = args.filter((a) => !a.startsWith('--'));

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

const registered = new Set<string>();

async function ensureFont(family: string, weight: number, style: 'normal' | 'italic'): Promise<void> {
  const key = `${family}|${weight}|${style}`;
  if (registered.has(key)) return;
  mkdirSync(fontDir, { recursive: true });
  const file = join(fontDir, `${family.replace(/ /g, '_')}-${style}-${weight}.ttf`);
  if (!existsSync(file)) {
    const axis = `ital,wght@${style === 'italic' ? 1 : 0},${weight}`;
    const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:${axis}`;
    const css = await (await fetch(cssUrl)).text();
    const url = /url\((https:[^)]+\.ttf)\)/.exec(css)?.[1];
    if (!url) throw new Error(`No TTF for ${key} (${cssUrl})`);
    writeFileSync(file, Buffer.from(await (await fetch(url)).arrayBuffer()));
  }
  registerFont(file, { family, weight: String(weight), style });
  registered.add(key);
}

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

async function renderPage(doc: PlakatDocument, pageIndex: number, pixelRatio: number): Promise<Buffer> {
  const page = doc.pages[pageIndex]!;
  const { width, height } = doc.size;
  const stage = new Konva.Stage({ width, height } as Konva.StageConfig);
  const layer = new Konva.Layer();
  stage.add(layer);

  const images = new Map<string, CanvasImage>();
  const image = async (assetId: string) => {
    const hit = images.get(assetId);
    if (hit) return hit;
    const img = await loadImage(doc.assets[assetId]!.src);
    images.set(assetId, img);
    return img;
  };

  if (page.background.color) layer.add(new Konva.Rect({ width, height, fill: page.background.color }));
  if (page.background.image) {
    const asset = doc.assets[page.background.image.assetId]!;
    const img = await image(page.background.image.assetId);
    const layout = computeImageLayout(
      { width, height, crop: null, objectFit: 'cover' },
      asset,
      { width: img.width, height: img.height },
    );
    layer.add(new Konva.Image({ image: img as never, crop: layout.crop, ...layout.dest }));
  }

  for (const el of page.elements) {
    if (el.hidden) continue;
    const group = new Konva.Group({ x: el.x, y: el.y, rotation: el.rotation, opacity: el.opacity });
    layer.add(group);
    if (el.type === 'text') {
      const node = new Konva.Text({
        text: applyTextTransform(el.content, el.textTransform),
        fontFamily: el.fontFamily,
        fontStyle: `${el.fontStyle} ${el.fontWeight}`,
        fontSize: el.fontSize,
        lineHeight: el.lineHeight,
        letterSpacing: el.letterSpacing * el.fontSize,
        align: el.align,
        fill: el.fill,
        textDecoration: el.textDecoration === 'none' ? '' : el.textDecoration,
        width: el.width,
        wrap: 'word',
      });
      const h = node.height();
      const offset = h >= el.height ? 0 : el.verticalAlign === 'middle' ? (el.height - h) / 2 : el.verticalAlign === 'bottom' ? el.height - h : 0;
      node.y(offset);
      group.add(node);
    } else if (el.type === 'shape') {
      const common = {
        fill: el.fill ?? undefined,
        stroke: el.stroke ?? undefined,
        strokeWidth: el.strokeWidth,
        dash: el.dash,
        lineJoin: 'miter' as const,
      };
      if (el.shape === 'rect') group.add(new Konva.Rect({ width: el.width, height: el.height, cornerRadius: el.cornerRadius, ...common }));
      else if (el.shape === 'ellipse') {
        group.add(new Konva.Ellipse({ x: el.width / 2, y: el.height / 2, radiusX: el.width / 2, radiusY: el.height / 2, ...common }));
      } else if (el.shape === 'line') {
        group.add(new Konva.Line({ points: getShapePoints('line', el.width, el.height) ?? [], ...common, fill: undefined, lineCap: 'butt' }));
      } else {
        group.add(new Konva.Line({ points: getShapePoints(el.shape, el.width, el.height, el.sides, el.innerRadius) ?? [], closed: true, ...common }));
      }
    } else {
      const asset = doc.assets[el.assetId]!;
      const img = await image(el.assetId);
      const layout = computeImageLayout(el, asset, { width: img.width, height: img.height });
      const node = new Konva.Image({ image: img as never, crop: layout.crop, cornerRadius: el.cornerRadius, ...layout.dest });
      const f = el.filters;
      const list = [];
      if (f.brightness) list.push(Konva.Filters.Brighten), node.brightness(f.brightness / 100);
      if (f.contrast) list.push(Konva.Filters.Contrast), node.contrast(f.contrast);
      if (f.saturation) list.push(Konva.Filters.HSL), node.saturation(Math.log2(Math.max(1 + f.saturation / 100, 2 ** -10)));
      if (f.grayscale) list.push(Konva.Filters.Grayscale);
      if (f.sepia) list.push(Konva.Filters.Sepia);
      if (f.invert) list.push(Konva.Filters.Invert);
      if (f.blur) list.push(Konva.Filters.Blur), node.blurRadius(f.blur);
      if (el.flipX || el.flipY) {
        const flip = new Konva.Group({ scaleX: el.flipX ? -1 : 1, x: el.flipX ? el.width : 0, scaleY: el.flipY ? -1 : 1, y: el.flipY ? el.height : 0 });
        flip.add(node);
        group.add(flip);
      } else group.add(node);
      if (list.length) {
        node.cache({ pixelRatio, offset: Math.max(1, Math.ceil(1 / pixelRatio)) });
        node.filters(list);
      }
    }
  }
  const canvas = layer.toCanvas({ pixelRatio, x: 0, y: 0, width, height }) as unknown as { toBuffer(mime: 'image/png'): Buffer };
  const buf = canvas.toBuffer('image/png');
  stage.destroy();
  return buf;
}

function stressFills(doc: PlakatDocument): SlotFills {
  const words = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore'.split(' ');
  const fills: SlotFills = {};
  for (const slot of doc.template?.slots ?? []) {
    if (slot.kind !== 'text' || slot.maxLength === null) continue;
    let s = '';
    for (let i = 0; s.length < slot.maxLength; i++) s += (s ? ' ' : '') + words[i % words.length]!;
    fills[slot.id] = { text: s.slice(0, slot.maxLength).trimEnd() };
  }
  return fills;
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const files = findTemplateFiles().filter((f) => filters.length === 0 || filters.some((s) => f.includes(s)));
  const jobs: { file: string; suffix: string; doc: PlakatDocument }[] = [];
  for (const file of files) {
    const template = parseDocument(readFileSync(file, 'utf8'));
    jobs.push({ file, suffix: '', doc: template });
    if (stress) jobs.push({ file, suffix: '.stress', doc: instantiateTemplate(template, stressFills(template)) });
  }
  // node-canvas wants every font registered before text is measured: do them all first.
  for (const { doc } of jobs) {
    for (const font of collectFonts(doc)) {
      for (const v of font.variants) await ensureFont(font.family, v.weight, v.style);
    }
  }
  for (const { file, suffix, doc } of jobs) {
    const pixelRatio = Math.max(targetWidth / doc.size.width, 1);
    for (let i = 0; i < doc.pages.length; i++) {
      const name = `${relative(TEMPLATES_ROOT, file).replace(/[\\/]/g, '__').replace(/\.plakat\.json$/, '')}${suffix}.p${i + 1}.png`;
      writeFileSync(join(outDir, name), await renderPage(doc, i, pixelRatio));
      console.log(join(outDir, name));
    }
  }
  if (files.length === 0) console.log(`No templates matched under ${basename(TEMPLATES_ROOT)}/`);
}

await main();
