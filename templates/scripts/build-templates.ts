/**
 * Builds Plakat's built-in starter templates (templates/<category>/<slug>.plakat.json).
 *
 *   npx tsx templates/scripts/build-templates.ts            # (re)write every file
 *   npx tsx templates/scripts/build-templates.ts --check    # exit 1 if a file is stale
 *   npx tsx templates/scripts/build-templates.ts quote      # only slugs containing "quote"
 *
 * Every template is an ordinary design built with the @plakat/schema factories,
 * turned into a template with convertToTemplate() + addSlot(), validated, and
 * serialized with serializeDocument(). Ids and timestamps are fixed, so the
 * output is byte-for-byte reproducible and diffs stay readable.
 *
 * This file doubles as an example for contributors: copy one `defineTemplate`
 * block, change it, run this script, preview it, run the tests (docs/templates.md).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import {
  addSlot,
  convertToTemplate,
  createDocument,
  createImageElement,
  createPage,
  createShapeElement,
  createTextElement,
  loadDocument,
  serializeDocument,
  type Asset,
  type Color,
  type Id,
  type ImageElement,
  type PageSize,
  type PlakatDocument,
  type PlakatElement,
  type PresetId,
  type ShapeElement,
  type ShapeKind,
  type SlotSpec,
  type TextElement,
} from '@plakat/schema';
import { loadTemplateAsset, SLUG_PATTERN, TEMPLATE_SUFFIX, TEMPLATES_ROOT } from './lib.ts';

/** Fixed timestamp for reproducible output. Bump it when a template changes meaningfully. */
const TIMESTAMP = '2026-10-08T00:00:00.000Z';

// ---------------------------------------------------------------------------
// Asset library (templates/assets, CC0 — see placeholders.ts)
// ---------------------------------------------------------------------------

const ASSETS = {
  as_photo_landscape: () => loadTemplateAsset('photo-landscape.jpg', 'Placeholder landscape'),
  as_photo_product: () => loadTemplateAsset('photo-product.jpg', 'Placeholder product shot'),
  as_photo_portrait: () => loadTemplateAsset('photo-portrait.jpg', 'Placeholder portrait'),
  as_photo_cafe: () => loadTemplateAsset('photo-cafe.jpg', 'Placeholder café flat-lay'),
  as_art_concert: () => loadTemplateAsset('art-concert.jpg', 'Placeholder concert artwork'),
  as_art_mesh: () => loadTemplateAsset('art-mesh.jpg', 'Placeholder gradient artwork'),
  as_logo_dark: () => loadTemplateAsset('logo-mark-dark.png', 'Placeholder logo (dark)'),
  as_logo_light: () => loadTemplateAsset('logo-mark-light.png', 'Placeholder logo (light)'),
} satisfies Record<string, () => Asset>;
type AssetKey = keyof typeof ASSETS;

const assetCache = new Map<AssetKey, Asset>();
function asset(key: AssetKey): Asset {
  let a = assetCache.get(key);
  if (!a) assetCache.set(key, (a = ASSETS[key]()));
  return a;
}

// ---------------------------------------------------------------------------
// Element helpers: thin wrappers over the schema factories with stable ids
// ---------------------------------------------------------------------------

type Box = [x: number, y: number, width: number, height: number];
type TextStyle = Partial<Omit<TextElement, 'type' | 'id' | 'content'>>;
type ShapeStyle = Partial<Omit<ShapeElement, 'type' | 'id' | 'shape'>>;

/**
 * Text box. Omit the height (pass `[x, y, w]`) to size it to the hard line count;
 * give it explicitly when the box should reserve room (verticalAlign, wrapping).
 */
function text(id: Id, name: string, box: [number, number, number, number?], content: string, style: TextStyle): TextElement {
  const [x, y, width, height] = box;
  const fontSize = style.fontSize ?? 32;
  const lineHeight = style.lineHeight ?? 1.2;
  const lines = content.split('\n').length;
  return createTextElement({
    ...style,
    id,
    name,
    x,
    y,
    width,
    height: height ?? Math.ceil(lines * fontSize * lineHeight),
    content,
  });
}

function shape(kind: ShapeKind, id: Id, name: string, box: Box, style: ShapeStyle): ShapeElement {
  const [x, y, width, height] = box;
  return createShapeElement(kind, { fill: null, stroke: null, strokeWidth: 0, ...style, id, name, x, y, width, height });
}
const rect = (id: Id, name: string, box: Box, fill: Color, style: ShapeStyle = {}) => shape('rect', id, name, box, { fill, ...style });
const ellipse = (id: Id, name: string, box: Box, fill: Color | null, style: ShapeStyle = {}) => shape('ellipse', id, name, box, { fill, ...style });

function image(id: Id, name: string, box: Box, key: AssetKey, extra: Partial<Omit<ImageElement, 'type' | 'id' | 'assetId'>> = {}): ImageElement {
  const [x, y, width, height] = box;
  return createImageElement(key, asset(key), { ...extra, id, name, x, y, width, height });
}

/**
 * Position of a child that shares its parent's rotation: (dx, dy) is the child's
 * origin in the parent's unrotated frame (rotation is about the top-left origin).
 */
function attach(parent: { x: number; y: number; rotation: number }, dx: number, dy: number): { x: number; y: number; rotation: number } {
  const r = (parent.rotation * Math.PI) / 180;
  return {
    x: parent.x + dx * Math.cos(r) - dy * Math.sin(r),
    y: parent.y + dx * Math.sin(r) + dy * Math.cos(r),
    rotation: parent.rotation,
  };
}

/** Locks decorative elements so a stray click selects the content above them. */
const locked = <E extends PlakatElement>(el: E): E => ({ ...el, locked: true });
const grouped = (groupId: Id, ...els: PlakatElement[]): PlakatElement[] => els.map((el) => ({ ...el, groupId }));

// ---------------------------------------------------------------------------
// Template definition -> document
// ---------------------------------------------------------------------------

interface PageDef {
  id: Id;
  name: string;
  background: Color | null;
  elements: PlakatElement[];
}

type SlotDef = SlotSpec & { id: Id };

interface TemplateDef {
  /** Directory under templates/ and `template.category`. */
  category: string;
  /** File name stem (kebab-case). */
  slug: string;
  preset: PresetId;
  title: string;
  description: string;
  tags: string[];
  /** Called with the page size so layouts can use fractional print sizes. */
  pages: (size: PageSize) => PageDef[];
  /** Fill-form order. Ids are stable (`slot_<name>`). */
  slots: SlotDef[];
}

const definitions: TemplateDef[] = [];
const defineTemplate = (def: TemplateDef) => definitions.push(def);

function buildTemplate(def: TemplateDef): PlakatDocument {
  if (!SLUG_PATTERN.test(def.slug) || !SLUG_PATTERN.test(def.category)) throw new Error(`Bad slug/category: ${def.category}/${def.slug}`);
  const now = () => new Date(TIMESTAMP);
  const base = createDocument(def.preset, { title: def.title, now });
  const pages = def.pages(base.size).map((p) => ({
    ...createPage({ name: p.name, background: { color: p.background, image: null }, elements: p.elements }),
    id: p.id,
  }));
  const assets: Record<Id, Asset> = {};
  for (const page of pages) {
    for (const el of page.elements) if (el.type === 'image') assets[el.assetId] = asset(el.assetId as AssetKey);
  }
  let doc: PlakatDocument = convertToTemplate(
    {
      ...base,
      id: `tpl_${def.category}_${def.slug}`,
      meta: { ...base.meta, description: def.description, tags: def.tags },
      pages,
      assets,
    },
    { category: def.category },
  );
  for (const { id, ...spec } of def.slots) {
    const added = addSlot(doc, spec);
    // addSlot() mints a random id; templates keep readable, stable ones.
    doc = {
      ...added.document,
      template: {
        ...added.document.template!,
        slots: added.document.template!.slots.map((s) => (s.id === added.slot.id ? { ...s, id } : s)),
      },
    };
  }
  // Round-trip through the strict loader: the file we write is exactly what the server will read.
  return loadDocument(JSON.parse(serializeDocument(doc)));
}

// ===========================================================================
// Templates
// ===========================================================================

// --- Instagram post: Quote card ---------------------------------------------

defineTemplate({
  category: 'instagram-post',
  slug: 'quote-card',
  preset: 'instagram-post',
  title: 'Quote card',
  description: 'Editorial quote card with a large serif quotation and an accent color.',
  tags: ['quote', 'editorial', 'minimal', 'instagram'],
  pages: () => {
    const ink = '#1f2a2e';
    const accent = '#d9623b';
    return [
      {
        id: 'pg_quote',
        name: 'Quote',
        background: '#f4eee4',
        elements: [
          locked(ellipse('el_halo', 'Halo', [64, 70, 240, 240], '#eadfcd')),
          locked(ellipse('el_corner', 'Corner circle', [820, 820, 420, 420], '#eadfcd')),
          locked(shape('rect', 'el_frame', 'Frame', [48, 48, 984, 984], { stroke: '#1f2a2e', strokeWidth: 2 })),
          text('el_mark', 'Quotation mark', [104, 40, 300, 300], '“', {
            fontFamily: 'Playfair Display',
            fontWeight: 900,
            fontSize: 360,
            lineHeight: 1,
            fill: accent,
          }),
          text('el_quote', 'Quote', [112, 320, 856, 420], 'Small steps every day add up to a life you are proud of. Start where you are.', {
            fontFamily: 'Playfair Display',
            fontStyle: 'italic',
            fontWeight: 500,
            fontSize: 64,
            lineHeight: 1.2,
            letterSpacing: -0.01,
            verticalAlign: 'middle',
            fill: ink,
          }),
          rect('el_rule', 'Accent rule', [112, 800, 72, 6], accent),
          text('el_author', 'Author', [112, 836, 760], 'Maya Ellison', {
            fontFamily: 'Montserrat',
            fontWeight: 700,
            fontSize: 30,
            letterSpacing: 0.14,
            textTransform: 'uppercase',
            fill: ink,
          }),
          text('el_source', 'Source', [112, 882, 760], 'Author of Slow Mornings', {
            fontFamily: 'Montserrat',
            fontWeight: 400,
            fontSize: 24,
            letterSpacing: 0.02,
            fill: '#6b6f6a',
          }),
        ],
      },
    ];
  },
  slots: [
    { id: 'slot_quote', kind: 'text', targets: ['el_quote'], label: 'Quote', description: 'Up to about 120 characters reads best.', required: true, maxLength: 120, multiline: true },
    { id: 'slot_author', kind: 'text', targets: ['el_author'], label: 'Author', required: true, maxLength: 32, multiline: false },
    { id: 'slot_source', kind: 'text', targets: ['el_source'], label: 'Role or source', description: 'Job title, book or @handle.', maxLength: 48, multiline: false },
    {
      id: 'slot_accent',
      kind: 'color',
      targets: ['el_mark', 'el_rule'],
      label: 'Accent color',
      property: 'fill',
      palette: ['#d9623b', '#2f6f62', '#3b5bdb', '#b5306b', '#1f2a2e'],
    },
  ],
});

// --- Instagram post: Product launch -------------------------------------------

defineTemplate({
  category: 'instagram-post',
  slug: 'product-launch',
  preset: 'instagram-post',
  title: 'Product launch',
  description: 'Dark, premium product announcement with a framed photo, badge and call to action.',
  tags: ['product', 'launch', 'shop', 'ecommerce', 'instagram'],
  pages: () => {
    const bg = '#14141c';
    const accent = '#ff7a59';
    const badge = shape('star', 'el_badge', 'Badge', [404, 118, 176, 176], { fill: accent, sides: 12, innerRadius: 0.84, rotation: -12 });
    const badgeText = { ...text('el_badgeText', 'Badge label', [0, 0, 128, 128], 'NEW', {
      fontFamily: 'Montserrat', fontWeight: 800, fontSize: 34, letterSpacing: 0.06, align: 'center', verticalAlign: 'middle', fill: bg,
    }), ...attach(badge, 24, 24) };
    const cta = rect('el_ctaButton', 'Button', [60, 900, 248, 76], '#ffffff', { cornerRadius: 38 });
    const ctaText = text('el_cta', 'Button label', [60, 900, 248, 76], 'Shop now', {
      fontFamily: 'DM Sans', fontWeight: 700, fontSize: 26, align: 'center', verticalAlign: 'middle', fill: bg,
    });
    return [
      {
        id: 'pg_launch',
        name: 'Launch',
        background: bg,
        elements: [
          locked(rect('el_offset', 'Offset block', [476, 84, 544, 960], accent, { cornerRadius: 40 })),
          image('el_photo', 'Product photo', [500, 60, 520, 960], 'as_photo_product', { cornerRadius: 40 }),
          image('el_logo', 'Logo', [60, 64, 52, 52], 'as_logo_light', { objectFit: 'contain' }),
          text('el_brand', 'Brand name', [128, 74, 330], 'Aura', {
            fontFamily: 'Montserrat', fontWeight: 700, fontSize: 26, letterSpacing: 0.35, textTransform: 'uppercase', fill: '#ffffff',
          }),
          text('el_eyebrow', 'Eyebrow', [60, 292, 420], 'Limited edition', {
            fontFamily: 'Montserrat', fontWeight: 600, fontSize: 20, letterSpacing: 0.24, textTransform: 'uppercase', fill: accent,
          }),
          text('el_headline', 'Headline', [60, 334, 410, 340], 'Meet the Glow Serum', {
            fontFamily: 'Playfair Display', fontWeight: 700, fontSize: 80, lineHeight: 1.04, letterSpacing: -0.01, fill: '#ffffff',
          }),
          text('el_body', 'Description', [60, 690, 400, 114], 'Vitamin C and hyaluronic acid for skin that glows all day long.', {
            fontFamily: 'DM Sans', fontWeight: 400, fontSize: 26, lineHeight: 1.45, fill: '#a9a9b8',
          }),
          text('el_price', 'Price', [60, 816, 400], '$39.00', {
            fontFamily: 'DM Sans', fontWeight: 700, fontSize: 44, letterSpacing: -0.01, fill: '#ffffff',
          }),
          ...grouped('grp_cta', cta, ctaText),
          ...grouped('grp_badge', badge, badgeText),
        ],
      },
    ];
  },
  slots: [
    { id: 'slot_photo', kind: 'image', targets: ['el_photo'], label: 'Product photo', description: 'Portrait or square photos work best.', required: true, fit: 'cover' },
    { id: 'slot_headline', kind: 'text', targets: ['el_headline'], label: 'Headline', description: 'Wraps onto up to four lines.', required: true, maxLength: 22, multiline: true },
    { id: 'slot_body', kind: 'text', targets: ['el_body'], label: 'Description', maxLength: 70, multiline: true },
    { id: 'slot_price', kind: 'text', targets: ['el_price'], label: 'Price', maxLength: 12, multiline: false },
    { id: 'slot_cta', kind: 'text', targets: ['el_cta'], label: 'Button label', maxLength: 14, multiline: false },
    { id: 'slot_eyebrow', kind: 'text', targets: ['el_eyebrow'], label: 'Eyebrow', description: 'Short line above the headline.', maxLength: 22, multiline: false },
    { id: 'slot_badge', kind: 'text', targets: ['el_badgeText'], label: 'Badge', maxLength: 5, multiline: false },
    { id: 'slot_brand', kind: 'text', targets: ['el_brand'], label: 'Brand name', maxLength: 12, multiline: false },
    { id: 'slot_logo', kind: 'image', targets: ['el_logo'], label: 'Logo', description: 'Light logo on a transparent background.', fit: 'contain' },
    {
      id: 'slot_accent', kind: 'color', targets: ['el_offset', 'el_badge', 'el_eyebrow'], label: 'Accent color', property: 'fill',
      palette: ['#ff7a59', '#f2c14e', '#7bdcb5', '#8c7bff', '#ff5d8f'],
    },
  ],
});

// --- Instagram story: Event announcement -------------------------------------

defineTemplate({
  category: 'instagram-story',
  slug: 'event-announcement',
  preset: 'instagram-story',
  title: 'Event announcement',
  description: 'Vibrant story with a big display title, a date card and an RSVP button. Key content stays inside the story safe zone.',
  tags: ['event', 'party', 'invitation', 'story', 'instagram'],
  pages: () => {
    const plum = '#1e1532';
    const accent = '#ff6f61';
    const sans = { fontFamily: 'Montserrat' } as const;
    const button = rect('el_ctaButton', 'RSVP button', [64, 1520, 952, 120], accent, { cornerRadius: 60 });
    const buttonText = text('el_cta', 'RSVP label', [64, 1520, 952, 120], 'RSVP — link in bio', {
      ...sans, fontWeight: 700, fontSize: 36, letterSpacing: 0.12, textTransform: 'uppercase', align: 'center', verticalAlign: 'middle', fill: '#ffffff',
    });
    return [
      {
        id: 'pg_story',
        name: 'Story',
        background: plum,
        elements: [
          image('el_art', 'Artwork', [0, 0, 1080, 1220], 'as_art_mesh'),
          locked(ellipse('el_ring1', 'Ring', [700, 170, 300, 300], null, { stroke: '#ffffff', strokeWidth: 3, opacity: 0.7 })),
          locked(ellipse('el_ring2', 'Ring', [760, 230, 180, 180], null, { stroke: '#ffffff', strokeWidth: 2, opacity: 0.5 })),
          locked(shape('star', 'el_sparkle', 'Sparkle', [96, 270, 72, 72], { fill: '#ffffff', sides: 4, innerRadius: 0.28 })),
          text('el_eyebrow', 'Eyebrow', [80, 500, 920], 'You’re invited', {
            ...sans, fontWeight: 600, fontSize: 34, letterSpacing: 0.3, textTransform: 'uppercase', fill: '#ffffff',
          }),
          text('el_title', 'Title', [72, 556, 936, 500], 'Summer\nSounds', {
            fontFamily: 'Bebas Neue', fontWeight: 400, fontSize: 284, lineHeight: 0.88, fill: '#ffffff',
          }),
          locked(rect('el_card', 'Date card', [64, 1100, 952, 360], '#fff8f1', { cornerRadius: 36 })),
          text('el_day', 'Day', [96, 1140, 250, 200], '24', {
            fontFamily: 'Bebas Neue', fontWeight: 400, fontSize: 210, lineHeight: 1, align: 'center', verticalAlign: 'middle', fill: accent,
          }),
          text('el_month', 'Month', [96, 1346, 250], 'August', {
            ...sans, fontWeight: 700, fontSize: 28, letterSpacing: 0.24, textTransform: 'uppercase', align: 'center', fill: plum,
          }),
          locked(rect('el_divider', 'Divider', [372, 1150, 3, 260], '#eadccf')),
          text('el_when', 'Day and time', [412, 1160, 570], 'Saturday, 7 PM', {
            ...sans, fontWeight: 700, fontSize: 40, fill: plum,
          }),
          text('el_venue', 'Venue', [412, 1236, 570], 'Rooftop Garden', {
            ...sans, fontWeight: 600, fontSize: 32, fill: plum,
          }),
          text('el_address', 'Address', [412, 1286, 570, 120], '21 Harbour Street\nLisbon', {
            ...sans, fontWeight: 400, fontSize: 28, lineHeight: 1.4, fill: '#6c5f80',
          }),
          ...grouped('grp_cta', button, buttonText),
          text('el_host', 'Host', [64, 1680, 952], 'Hosted by @studio.north', {
            ...sans, fontWeight: 500, fontSize: 28, letterSpacing: 0.04, align: 'center', fill: '#b9a9d6',
          }),
        ],
      },
    ];
  },
  slots: [
    { id: 'slot_title', kind: 'text', targets: ['el_title'], label: 'Event name', description: 'Two short words, one per line (about 7 letters each).', required: true, maxLength: 14, multiline: true },
    { id: 'slot_eyebrow', kind: 'text', targets: ['el_eyebrow'], label: 'Intro line', maxLength: 28, multiline: false },
    { id: 'slot_day', kind: 'text', targets: ['el_day'], label: 'Day of month', required: true, maxLength: 2, multiline: false },
    { id: 'slot_month', kind: 'text', targets: ['el_month'], label: 'Month', required: true, maxLength: 9, multiline: false },
    { id: 'slot_when', kind: 'text', targets: ['el_when'], label: 'Weekday and time', maxLength: 22, multiline: false },
    { id: 'slot_venue', kind: 'text', targets: ['el_venue'], label: 'Venue', maxLength: 28, multiline: false },
    { id: 'slot_address', kind: 'text', targets: ['el_address'], label: 'Address', maxLength: 60, multiline: true },
    { id: 'slot_cta', kind: 'text', targets: ['el_cta'], label: 'Button label', maxLength: 26, multiline: false },
    { id: 'slot_host', kind: 'text', targets: ['el_host'], label: 'Host', maxLength: 40, multiline: false },
    { id: 'slot_art', kind: 'image', targets: ['el_art'], label: 'Background photo', description: 'Shown behind the title; bright, simple images work best.', fit: 'cover' },
    {
      id: 'slot_accent', kind: 'color', targets: ['el_ctaButton', 'el_day'], label: 'Accent color', property: 'fill',
      palette: ['#ff6f61', '#7c4dff', '#00a389', '#ff9f1c', '#e83f6f'],
    },
  ],
});

// --- YouTube thumbnail: Bold tutorial -----------------------------------------

defineTemplate({
  category: 'youtube-thumbnail',
  slug: 'bold-tutorial',
  preset: 'youtube-thumbnail',
  title: 'Bold tutorial',
  description: 'High-contrast tutorial thumbnail: huge condensed title, highlighted promise and a slanted host photo.',
  tags: ['youtube', 'tutorial', 'how-to', 'education', 'thumbnail'],
  pages: () => {
    const yellow = '#ffd23f';
    const ink = '#111111';
    const accent = '#ff3b5c';
    const mask = rect('el_mask', 'Slant mask', [556, -40, 150, 820], yellow, { rotation: 8 });
    const stripe = { ...rect('el_stripe', 'Slant stripe', [0, 0, 14, 820], ink), ...attach(mask, 150, 0) };
    const highlight = rect('el_highlight', 'Highlight', [44, 372, 560, 150], accent, { rotation: -3 });
    const highlightText = { ...text('el_promise', 'Promise', [0, 0, 560, 150], 'In 10 min', {
      fontFamily: 'Anton', fontWeight: 400, fontSize: 104, lineHeight: 1, textTransform: 'uppercase', align: 'center', verticalAlign: 'middle', fill: '#ffffff',
    }), ...attach(highlight, 0, 0) };
    const tag = rect('el_tagPill', 'Tag pill', [56, 582, 372, 66], ink, { cornerRadius: 33 });
    const tagText = text('el_tag', 'Tag', [56, 582, 372, 66], 'Beginner friendly', {
      fontFamily: 'Montserrat', fontWeight: 800, fontSize: 24, letterSpacing: 0.12, textTransform: 'uppercase', align: 'center', verticalAlign: 'middle', fill: yellow,
    });
    const badge = ellipse('el_badge', 'Episode badge', [1112, 36, 132, 132], '#ffffff');
    const badgeText = text('el_episode', 'Episode', [1112, 36, 132, 132], 'EP.\n12', {
      fontFamily: 'Anton', fontWeight: 400, fontSize: 40, lineHeight: 0.95, align: 'center', verticalAlign: 'middle', fill: ink,
    });
    return [
      {
        id: 'pg_thumb',
        name: 'Thumbnail',
        background: yellow,
        elements: [
          locked(rect('el_bg', 'Background', [0, 0, 1280, 720], yellow)),
          image('el_photo', 'Host photo', [600, 0, 680, 720], 'as_photo_portrait'),
          locked(mask),
          locked(stripe),
          text('el_title', 'Title', [52, 44, 640, 330], 'Learn\nFigma', {
            fontFamily: 'Anton', fontWeight: 400, fontSize: 158, lineHeight: 0.98, textTransform: 'uppercase', fill: ink,
          }),
          ...grouped('grp_promise', highlight, highlightText),
          ...grouped('grp_tag', tag, tagText),
          ...grouped('grp_badge', badge, badgeText),
        ],
      },
    ];
  },
  slots: [
    { id: 'slot_title', kind: 'text', targets: ['el_title'], label: 'Title', description: 'Two very short words, one per line.', required: true, maxLength: 12, multiline: true },
    { id: 'slot_promise', kind: 'text', targets: ['el_promise'], label: 'Highlighted promise', maxLength: 11, multiline: false },
    { id: 'slot_photo', kind: 'image', targets: ['el_photo'], label: 'Host photo', description: 'A portrait with the face in the upper middle.', required: true, fit: 'cover' },
    { id: 'slot_tag', kind: 'text', targets: ['el_tag'], label: 'Tag', maxLength: 17, multiline: false },
    { id: 'slot_episode', kind: 'text', targets: ['el_episode'], label: 'Episode badge', maxLength: 8, multiline: true },
    {
      id: 'slot_accent', kind: 'color', targets: ['el_highlight'], label: 'Highlight color', property: 'fill',
      palette: ['#ff3b5c', '#2f6bff', '#00b37e', '#7b2ff7', '#111111'],
    },
    {
      id: 'slot_background', kind: 'color', targets: ['el_bg', 'el_mask', 'el_tag'], label: 'Background color', property: 'fill',
      palette: ['#ffd23f', '#3ddc97', '#4cc9f0', '#ff9f1c', '#f1f1f1'],
    },
  ],
});

// --- YouTube thumbnail: Vlog --------------------------------------------------

defineTemplate({
  category: 'youtube-thumbnail',
  slug: 'vlog',
  preset: 'youtube-thumbnail',
  title: 'Travel vlog',
  description: 'Full-bleed travel photo with a handwritten tape label and a sticker-style destination title.',
  tags: ['youtube', 'vlog', 'travel', 'lifestyle', 'thumbnail'],
  pages: () => {
    const ink = '#1d1530';
    const accent = '#ff5c8a';
    const card = rect('el_card', 'Title card', [64, 404, 720, 236], '#fffaf0', { rotation: -2 });
    const title = { ...text('el_title', 'Destination', [0, 0, 720, 236], 'Kyoto', {
      fontFamily: 'Bebas Neue', fontWeight: 400, fontSize: 210, lineHeight: 1, letterSpacing: 0.02, textTransform: 'uppercase', align: 'center', verticalAlign: 'middle', fill: ink,
    }), ...attach(card, 0, 8) };
    const tape = rect('el_tape', 'Tape', [92, 352, 380, 86], accent, { rotation: -6 });
    const script = { ...text('el_script', 'Script line', [0, 0, 380, 86], 'a weekend in', {
      fontFamily: 'Caveat', fontWeight: 700, fontSize: 62, lineHeight: 1, align: 'center', verticalAlign: 'middle', fill: '#ffffff',
    }), ...attach(tape, 0, -2) };
    const pill = rect('el_pill', 'Episode pill', [48, 44, 206, 54], '#ffffff', { cornerRadius: 27, opacity: 0.94 });
    const pillText = text('el_episode', 'Episode', [48, 44, 206, 54], 'Vlog #24', {
      fontFamily: 'Montserrat', fontWeight: 700, fontSize: 22, letterSpacing: 0.18, textTransform: 'uppercase', align: 'center', verticalAlign: 'middle', fill: ink,
    });
    return [
      {
        id: 'pg_thumb',
        name: 'Thumbnail',
        background: '#1d1530',
        elements: [
          image('el_photo', 'Photo', [0, 0, 1280, 720], 'as_photo_landscape', { filters: { brightness: 0, contrast: 6, saturation: 12, blur: 0, grayscale: false, sepia: false, invert: false } }),
          ...grouped('grp_title', card, title),
          ...grouped('grp_script', tape, script),
          ...grouped('grp_episode', pill, pillText),
        ],
      },
    ];
  },
  slots: [
    { id: 'slot_photo', kind: 'image', targets: ['el_photo'], label: 'Photo', description: 'Landscape photo; keep the left half calm for the title.', required: true, fit: 'cover' },
    { id: 'slot_title', kind: 'text', targets: ['el_title'], label: 'Destination', required: true, maxLength: 8, multiline: false },
    { id: 'slot_script', kind: 'text', targets: ['el_script'], label: 'Handwritten line', maxLength: 16, multiline: false },
    { id: 'slot_episode', kind: 'text', targets: ['el_episode'], label: 'Episode', maxLength: 9, multiline: false },
    {
      id: 'slot_accent', kind: 'color', targets: ['el_tape'], label: 'Tape color', property: 'fill',
      palette: ['#ff5c8a', '#ffb703', '#2ec4b6', '#8338ec', '#1d1530'],
    },
  ],
});

// --- A4 poster: Concert -------------------------------------------------------

defineTemplate({
  category: 'poster',
  slug: 'concert-poster',
  preset: 'a4-poster',
  title: 'Concert poster',
  description: 'Gig poster with neon artwork, a towering band name, event details grid and a ticket bar.',
  tags: ['poster', 'concert', 'music', 'event', 'gig', 'print'],
  pages: ({ width: W, height: H }) => {
    const cream = '#f2ece4';
    const night = '#0c0b10';
    const accent = '#ff2e88';
    const sans = { fontFamily: 'Montserrat' } as const;
    const label = { ...sans, fontWeight: 700, fontSize: 11, letterSpacing: 0.3, textTransform: 'uppercase', fill: accent } as const;
    const value = { ...sans, fontWeight: 700, fontSize: 21, lineHeight: 1.25, fill: cream } as const;
    const col = (W - 72) / 3;
    return [
      {
        id: 'pg_poster',
        name: 'Poster',
        background: night,
        elements: [
          image('el_art', 'Artwork', [0, 0, W, 730], 'as_art_concert'),
          text('el_kicker', 'Kicker', [36, 34, 360], 'Live in concert', {
            ...sans, fontWeight: 700, fontSize: 13, letterSpacing: 0.4, textTransform: 'uppercase', fill: cream,
          }),
          text('el_tour', 'Tour', [W - 396, 34, 360], 'World tour 2026', {
            ...sans, fontWeight: 700, fontSize: 13, letterSpacing: 0.4, textTransform: 'uppercase', align: 'right', fill: cream,
          }),
          locked(rect('el_topRule', 'Top rule', [36, 62, W - 72, 1], cream, { opacity: 0.45 })),
          locked(shape('star', 'el_sparkle', 'Sparkle', [W - 116, 104, 56, 56], { fill: cream, sides: 4, innerRadius: 0.25 })),
          text('el_artist', 'Artist', [30, 486, W - 60, 350], 'Neon\nTides', {
            fontFamily: 'Anton', fontWeight: 400, fontSize: 196, lineHeight: 0.88, letterSpacing: 0.01, textTransform: 'uppercase', fill: cream,
          }),
          text('el_serial', 'Serial', [W - 40, 1010, 300, 16], 'No. 0142 — Admit one', {
            ...sans, fontWeight: 600, fontSize: 10, letterSpacing: 0.4, textTransform: 'uppercase', fill: cream, opacity: 0.6, rotation: -90,
          }),
          rect('el_stripe', 'Accent stripe', [36, 852, 90, 8], accent),
          text('el_dateLabel', 'Date label', [36, 884, col - 12], 'Date', label),
          text('el_date', 'Date', [36, 906, col - 12], 'Fri 14 Nov', value),
          text('el_venueLabel', 'Venue label', [36 + col, 884, col - 12], 'Venue', label),
          text('el_venue', 'Venue', [36 + col, 906, col - 12], 'The Roundhouse', value),
          text('el_doorsLabel', 'Doors label', [36 + col * 2, 884, col - 12], 'Doors', label),
          text('el_doors', 'Doors', [36 + col * 2, 906, col - 12], '7:00 PM', value),
          text('el_guestsIntro', 'Guests intro', [36, 960, W - 110], 'with special guests', {
            fontFamily: 'Playfair Display', fontStyle: 'italic', fontWeight: 400, fontSize: 19, fill: '#a7a3b5',
          }),
          text('el_guests', 'Guests', [36, 988, W - 110], 'Glass Harbor · Kaia · Moon Club', {
            ...sans, fontWeight: 600, fontSize: 19, letterSpacing: 0.02, fill: cream,
          }),
          rect('el_bar', 'Ticket bar', [0, H - 80, W, 80], accent),
          text('el_tickets', 'Tickets', [36, H - 80, 480, 80], 'Tickets · neontides.com', {
            ...sans, fontWeight: 800, fontSize: 17, letterSpacing: 0.2, textTransform: 'uppercase', verticalAlign: 'middle', fill: night,
          }),
          text('el_price', 'Price', [W - 276, H - 80, 240, 80], 'From $45', {
            ...sans, fontWeight: 800, fontSize: 17, letterSpacing: 0.2, textTransform: 'uppercase', align: 'right', verticalAlign: 'middle', fill: night,
          }),
        ],
      },
    ];
  },
  slots: [
    { id: 'slot_artist', kind: 'text', targets: ['el_artist'], label: 'Artist / band', description: 'One or two short words, one per line (about 6 letters each).', required: true, maxLength: 12, multiline: true },
    { id: 'slot_art', kind: 'image', targets: ['el_art'], label: 'Artwork or photo', required: true, fit: 'cover' },
    { id: 'slot_date', kind: 'text', targets: ['el_date'], label: 'Date', required: true, maxLength: 14, multiline: false },
    { id: 'slot_venue', kind: 'text', targets: ['el_venue'], label: 'Venue', required: true, maxLength: 14, multiline: false },
    { id: 'slot_doors', kind: 'text', targets: ['el_doors'], label: 'Doors', maxLength: 14, multiline: false },
    { id: 'slot_guestsIntro', kind: 'text', targets: ['el_guestsIntro'], label: 'Support intro', maxLength: 30, multiline: false },
    { id: 'slot_guests', kind: 'text', targets: ['el_guests'], label: 'Support acts', maxLength: 56, multiline: false },
    { id: 'slot_kicker', kind: 'text', targets: ['el_kicker'], label: 'Top left', maxLength: 22, multiline: false },
    { id: 'slot_tour', kind: 'text', targets: ['el_tour'], label: 'Top right', maxLength: 22, multiline: false },
    { id: 'slot_tickets', kind: 'text', targets: ['el_tickets'], label: 'Ticket info', maxLength: 30, multiline: false },
    { id: 'slot_price', kind: 'text', targets: ['el_price'], label: 'Price', maxLength: 12, multiline: false },
    {
      id: 'slot_accent', kind: 'color', targets: ['el_stripe', 'el_dateLabel', 'el_venueLabel', 'el_doorsLabel', 'el_bar'], label: 'Accent color', property: 'fill',
      palette: ['#ff2e88', '#ffd60a', '#3cf0c5', '#4d5bff', '#ff6b35'],
    },
  ],
});

// --- A4 poster, 2 pages: Café menu ---------------------------------------------

defineTemplate({
  category: 'poster',
  slug: 'cafe-menu',
  preset: 'a4-poster',
  title: 'Café menu',
  description: 'Two-page café menu: an arched-photo cover and a menu page with three sections and a daily special.',
  tags: ['menu', 'cafe', 'restaurant', 'food', 'print', 'multi-page'],
  pages: ({ width: W, height: H }) => {
    const cream = '#f5efe6';
    const espresso = '#2b1d14';
    const accent = '#c4683f';
    const muted = '#8a7a6c';
    const sans = { fontFamily: 'Montserrat' } as const;
    const ornament = (prefix: string, y: number): PlakatElement[] => [
      locked(rect(`el_${prefix}RuleL`, 'Ornament rule', [W / 2 - 104, y + 6, 80, 1.5], espresso, { opacity: 0.35 })),
      locked(rect(`el_${prefix}RuleR`, 'Ornament rule', [W / 2 + 24, y + 6, 80, 1.5], espresso, { opacity: 0.35 })),
      shape('polygon', `el_${prefix}Diamond`, 'Ornament diamond', [W / 2 - 7, y - 0.5, 14, 14], { fill: accent, sides: 4 }),
    ];
    const capW = 500;
    const capH = 640;
    const section = (n: number, y: number, title: string, items: string, prices: string): PlakatElement[] => [
      text(`el_s${n}Title`, `Section ${n} title`, [96, y, 400], title, {
        ...sans, fontWeight: 700, fontSize: 14, letterSpacing: 0.32, textTransform: 'uppercase', fill: accent,
      }),
      locked(rect(`el_s${n}Rule`, `Section ${n} rule`, [96, y + 28, W - 192, 1], '#d9cbb8')),
      text(`el_s${n}Items`, `Section ${n} items`, [96, y + 42, 480, 122], items, {
        fontFamily: 'Playfair Display', fontWeight: 500, fontSize: 21, lineHeight: 1.85, fill: espresso,
      }),
      text(`el_s${n}Prices`, `Section ${n} prices`, [W - 256, y + 42, 160, 122], prices, {
        ...sans, fontWeight: 600, fontSize: 16, lineHeight: (21 * 1.85) / 16, align: 'right', fill: espresso,
      }),
    ];
    const special = rect('el_specialBox', 'Special box', [96, 868, W - 192, 150], espresso, { cornerRadius: 6 });
    return [
      {
        id: 'pg_cover',
        name: 'Cover',
        background: cream,
        elements: [
          locked(shape('rect', 'el_capsuleOutline', 'Capsule outline', [W / 2 - capW / 2 - 14, 50, capW + 28, capH + 28], { stroke: accent, strokeWidth: 1.5, cornerRadius: capW / 2 + 14 })),
          image('el_coverPhoto', 'Cover photo', [W / 2 - capW / 2, 64, capW, capH], 'as_photo_cafe', { cornerRadius: capW / 2 }),
          text('el_name', 'Café name', [60, 740, W - 120], 'Little Fig', {
            fontFamily: 'Playfair Display', fontStyle: 'italic', fontWeight: 600, fontSize: 96, lineHeight: 1.1, align: 'center', fill: espresso,
          }),
          text('el_tagline', 'Tagline', [60, 870, W - 120], 'Bakery · Coffee · Brunch', {
            ...sans, fontWeight: 600, fontSize: 14, letterSpacing: 0.4, textTransform: 'uppercase', align: 'center', fill: accent,
          }),
          ...ornament('c', 918),
          text('el_info', 'Opening hours & address', [60, 980, W - 120, 60], 'Open daily 8:00 – 16:00\n14 Rue des Lilas, Lyon', {
            ...sans, fontWeight: 400, fontSize: 14, lineHeight: 1.6, align: 'center', fill: muted,
          }),
        ],
      },
      {
        id: 'pg_menu',
        name: 'Menu',
        background: cream,
        elements: [
          text('el_menuName', 'Café name (small)', [60, 58, W - 120], 'Little Fig', {
            ...sans, fontWeight: 600, fontSize: 13, letterSpacing: 0.4, textTransform: 'uppercase', align: 'center', fill: accent,
          }),
          text('el_menuTitle', 'Menu title', [60, 78, W - 120], 'Menu', {
            fontFamily: 'Playfair Display', fontStyle: 'italic', fontWeight: 600, fontSize: 76, lineHeight: 1.15, align: 'center', fill: espresso,
          }),
          ...ornament('m', 182),
          ...section(1, 232, 'Coffee', 'Espresso\nFlat white\nOat milk latte', '2.80\n4.20\n4.60'),
          ...section(2, 442, 'Brunch', 'Sourdough & smashed avocado\nButtermilk pancakes\nGranola, yoghurt & berries', '11.50\n10.00\n8.50'),
          ...section(3, 652, 'Pastries', 'Butter croissant\nCardamom bun\nFig & almond tart', '3.20\n3.80\n5.40'),
          ...grouped(
            'grp_special',
            special,
            text('el_specialLabel', 'Special label', [128, 896, 400], 'Today’s special', {
              ...sans, fontWeight: 700, fontSize: 12, letterSpacing: 0.32, textTransform: 'uppercase', fill: '#e8a77f',
            }),
            text('el_special', 'Special', [128, 920, W - 400, 76], 'Shakshuka with feta and warm sourdough', {
              fontFamily: 'Playfair Display', fontStyle: 'italic', fontWeight: 500, fontSize: 25, lineHeight: 1.3, fill: cream,
            }),
            text('el_specialPrice', 'Special price', [W - 248, 968, 120], '12.50', {
              ...sans, fontWeight: 700, fontSize: 20, align: 'right', fill: cream,
            }),
          ),
          locked(ellipse('el_photoRing', 'Photo ring', [W - 196, 806, 128, 128], null, { stroke: accent, strokeWidth: 1.5 })),
          image('el_menuPhoto', 'Menu photo', [W - 188, 814, 112, 112], 'as_photo_cafe', { cornerRadius: 56 }),
          text('el_footer', 'Footer', [60, H - 64, W - 120], 'Prices in EUR · Please tell us about any allergies', {
            ...sans, fontWeight: 400, fontSize: 11, letterSpacing: 0.04, align: 'center', fill: muted,
          }),
        ],
      },
    ];
  },
  slots: [
    { id: 'slot_name', kind: 'text', targets: ['el_name', 'el_menuName'], label: 'Café name', description: 'Used on the cover and the menu page.', required: true, maxLength: 12, multiline: false },
    { id: 'slot_tagline', kind: 'text', targets: ['el_tagline'], label: 'Tagline', maxLength: 36, multiline: false },
    { id: 'slot_photo', kind: 'image', targets: ['el_coverPhoto', 'el_menuPhoto'], label: 'Photo', description: 'Portrait photo; used on the cover and as a small round photo on the menu.', required: true, fit: 'cover' },
    { id: 'slot_info', kind: 'text', targets: ['el_info'], label: 'Hours & address', maxLength: 80, multiline: true },
    { id: 'slot_s1Title', kind: 'text', targets: ['el_s1Title'], label: 'Section 1 title', maxLength: 24, multiline: false },
    { id: 'slot_s1Items', kind: 'text', targets: ['el_s1Items'], label: 'Section 1 dishes', description: 'One dish per line (3 lines, up to ~28 characters each).', maxLength: 90, multiline: true },
    { id: 'slot_s1Prices', kind: 'text', targets: ['el_s1Prices'], label: 'Section 1 prices', description: 'One price per line, in the same order.', maxLength: 18, multiline: true },
    { id: 'slot_s2Title', kind: 'text', targets: ['el_s2Title'], label: 'Section 2 title', maxLength: 24, multiline: false },
    { id: 'slot_s2Items', kind: 'text', targets: ['el_s2Items'], label: 'Section 2 dishes', description: 'One dish per line (3 lines, up to ~28 characters each).', maxLength: 90, multiline: true },
    { id: 'slot_s2Prices', kind: 'text', targets: ['el_s2Prices'], label: 'Section 2 prices', description: 'One price per line, in the same order.', maxLength: 18, multiline: true },
    { id: 'slot_s3Title', kind: 'text', targets: ['el_s3Title'], label: 'Section 3 title', maxLength: 24, multiline: false },
    { id: 'slot_s3Items', kind: 'text', targets: ['el_s3Items'], label: 'Section 3 dishes', description: 'One dish per line (3 lines, up to ~28 characters each).', maxLength: 90, multiline: true },
    { id: 'slot_s3Prices', kind: 'text', targets: ['el_s3Prices'], label: 'Section 3 prices', description: 'One price per line, in the same order.', maxLength: 18, multiline: true },
    { id: 'slot_special', kind: 'text', targets: ['el_special'], label: 'Today’s special', maxLength: 48, multiline: false },
    { id: 'slot_specialPrice', kind: 'text', targets: ['el_specialPrice'], label: 'Special price', maxLength: 8, multiline: false },
    {
      id: 'slot_accent', kind: 'color', targets: ['el_tagline', 'el_cDiamond', 'el_mDiamond', 'el_menuName', 'el_s1Title', 'el_s2Title', 'el_s3Title'], label: 'Accent color', property: 'fill',
      palette: ['#c4683f', '#7d9a6a', '#b23a48', '#3d5a80', '#2b1d14'],
    },
  ],
});

// --- Business card (US 3.5 x 2 in) ----------------------------------------------

defineTemplate({
  category: 'business-card',
  slug: 'minimal-us',
  preset: 'business-card',
  title: 'Minimal business card (US)',
  description: 'Clean two-sided US business card: name and logo on a light front, contact details on a dark back.',
  tags: ['business card', 'print', 'minimal', 'corporate', 'contact'],
  pages: ({ width: W, height: H }) => {
    const ink = '#1c1c28';
    const accent = '#4361ee';
    const sans = { fontFamily: 'DM Sans' } as const;
    const contact = (n: number, y: number, content: string, name: string): PlakatElement[] => [
      ellipse(`el_dot${n}`, 'Bullet', [30, y + 5, 6, 6], accent),
      text(`el_contact${n}`, name, [46, y, 200], content, { ...sans, fontWeight: 400, fontSize: 11, lineHeight: 1.45, fill: '#e9e9f2' }),
    ];
    return [
      {
        id: 'pg_front',
        name: 'Front',
        background: '#ffffff',
        elements: [
          ellipse('el_circle', 'Accent circle', [W - 104, -78, 190, 190], accent),
          locked(ellipse('el_ring', 'Ring', [W - 136, 64, 72, 72], null, { stroke: ink, strokeWidth: 1, opacity: 0.18 })),
          image('el_logo', 'Logo', [24, 24, 30, 30], 'as_logo_dark', { objectFit: 'contain' }),
          text('el_company', 'Company', [62, 30, 170], 'Orbit Studio', { ...sans, fontWeight: 700, fontSize: 13, letterSpacing: 0.02, fill: ink }),
          text('el_name', 'Name', [24, 114, 240], 'Alex Morgan', { ...sans, fontWeight: 700, fontSize: 22, letterSpacing: -0.01, fill: ink }),
          text('el_title', 'Job title', [24, 146, 240], 'Product Designer', {
            ...sans, fontWeight: 500, fontSize: 9, letterSpacing: 0.2, textTransform: 'uppercase', fill: '#6b6b7b',
          }),
        ],
      },
      {
        id: 'pg_back',
        name: 'Back',
        background: ink,
        elements: [
          rect('el_bar', 'Accent bar', [0, 0, 8, H], accent),
          text('el_backCompany', 'Company (back)', [30, 26, 240], 'Orbit Studio', {
            ...sans, fontWeight: 700, fontSize: 9, letterSpacing: 0.24, textTransform: 'uppercase', fill: '#8d8da3',
          }),
          ...contact(1, 62, '+1 (555) 014-2290', 'Phone'),
          ...contact(2, 88, 'alex@orbit.studio', 'Email'),
          ...contact(3, 114, 'orbit.studio', 'Website'),
          ...contact(4, 140, 'Brooklyn, New York', 'Address'),
          locked(ellipse('el_backRing', 'Ring', [W - 92, H - 92, 120, 120], null, { stroke: '#ffffff', strokeWidth: 1, opacity: 0.12 })),
        ],
      },
    ];
  },
  slots: [
    { id: 'slot_name', kind: 'text', targets: ['el_name'], label: 'Full name', required: true, maxLength: 22, multiline: false },
    { id: 'slot_title', kind: 'text', targets: ['el_title'], label: 'Job title', maxLength: 32, multiline: false },
    { id: 'slot_company', kind: 'text', targets: ['el_company', 'el_backCompany'], label: 'Company', maxLength: 24, multiline: false },
    { id: 'slot_logo', kind: 'image', targets: ['el_logo'], label: 'Logo', description: 'Dark logo on a transparent background (PNG or SVG).', fit: 'contain' },
    { id: 'slot_phone', kind: 'text', targets: ['el_contact1'], label: 'Phone', maxLength: 28, multiline: false },
    { id: 'slot_email', kind: 'text', targets: ['el_contact2'], label: 'Email', maxLength: 32, multiline: false },
    { id: 'slot_website', kind: 'text', targets: ['el_contact3'], label: 'Website', maxLength: 32, multiline: false },
    { id: 'slot_address', kind: 'text', targets: ['el_contact4'], label: 'Address', maxLength: 32, multiline: false },
    {
      id: 'slot_accent', kind: 'color', targets: ['el_circle', 'el_bar', 'el_dot1', 'el_dot2', 'el_dot3', 'el_dot4'], label: 'Accent color', property: 'fill',
      palette: ['#4361ee', '#ef476f', '#06d6a0', '#ff9f1c', '#1c1c28'],
    },
  ],
});

// --- Business card (EU 85 x 55 mm) ----------------------------------------------

defineTemplate({
  category: 'business-card',
  slug: 'classic-eu',
  preset: 'business-card-eu',
  title: 'Classic business card (EU)',
  description: 'Elegant two-sided EU business card: forest-green front with a centered mark, cream back with serif name.',
  tags: ['business card', 'print', 'elegant', 'architecture', 'contact'],
  pages: ({ width: W, height: H }) => {
    const forest = '#1f3d36';
    const cream = '#f1ead8';
    const gold = '#c8a96a';
    const sans = { fontFamily: 'Montserrat' } as const;
    const line = (n: number, y: number, content: string, name: string) =>
      text(`el_contact${n}`, name, [24, y, 230], content, { ...sans, fontWeight: 400, fontSize: 8.5, lineHeight: 1.5, letterSpacing: 0.02, fill: forest });
    return [
      {
        id: 'pg_front',
        name: 'Front',
        background: forest,
        elements: [
          shape('rect', 'el_frame', 'Frame', [10, 10, W - 20, H - 20], { stroke: gold, strokeWidth: 0.75 }),
          image('el_logo', 'Logo', [W / 2 - 20, 40, 40, 40], 'as_logo_light', { objectFit: 'contain' }),
          text('el_company', 'Company', [20, 96, W - 40], 'Studio Fern', {
            fontFamily: 'Cormorant Garamond', fontWeight: 600, fontSize: 32, lineHeight: 1.15, align: 'center', fill: cream,
          }),
          text('el_tagline', 'Tagline', [20, 140, W - 40], 'Architecture & Interiors', {
            ...sans, fontWeight: 500, fontSize: 7.5, letterSpacing: 0.32, textTransform: 'uppercase', align: 'center', fill: gold,
          }),
        ],
      },
      {
        id: 'pg_back',
        name: 'Back',
        background: cream,
        elements: [
          rect('el_bar', 'Accent bar', [W - 14, 0, 14, H], gold),
          text('el_name', 'Name', [24, 26, 250], 'Léa Fontaine', {
            fontFamily: 'Cormorant Garamond', fontWeight: 700, fontSize: 27, lineHeight: 1.15, fill: forest,
          }),
          text('el_role', 'Role', [24, 60, 250], 'Principal Architect', {
            ...sans, fontWeight: 600, fontSize: 7.5, letterSpacing: 0.26, textTransform: 'uppercase', fill: gold,
          }),
          rect('el_rule', 'Rule', [24, 84, 36, 1.5], gold),
          line(1, 102, '+33 6 12 34 56 78', 'Phone'),
          line(2, 118, 'lea@studiofern.fr', 'Email'),
          line(3, 134, 'studiofern.fr', 'Website'),
          line(4, 150, '8 Quai de la Tournelle, Paris', 'Address'),
        ],
      },
    ];
  },
  slots: [
    { id: 'slot_name', kind: 'text', targets: ['el_name'], label: 'Full name', required: true, maxLength: 22, multiline: false },
    { id: 'slot_role', kind: 'text', targets: ['el_role'], label: 'Role', maxLength: 32, multiline: false },
    { id: 'slot_company', kind: 'text', targets: ['el_company'], label: 'Company', required: true, maxLength: 18, multiline: false },
    { id: 'slot_tagline', kind: 'text', targets: ['el_tagline'], label: 'Tagline', maxLength: 34, multiline: false },
    { id: 'slot_logo', kind: 'image', targets: ['el_logo'], label: 'Logo', description: 'Light logo on a transparent background (PNG or SVG).', fit: 'contain' },
    { id: 'slot_phone', kind: 'text', targets: ['el_contact1'], label: 'Phone', maxLength: 28, multiline: false },
    { id: 'slot_email', kind: 'text', targets: ['el_contact2'], label: 'Email', maxLength: 34, multiline: false },
    { id: 'slot_website', kind: 'text', targets: ['el_contact3'], label: 'Website', maxLength: 34, multiline: false },
    { id: 'slot_address', kind: 'text', targets: ['el_contact4'], label: 'Address', maxLength: 40, multiline: false },
    {
      id: 'slot_accent', kind: 'color', targets: ['el_tagline', 'el_bar', 'el_role', 'el_rule'], label: 'Accent color', property: 'fill',
      palette: ['#c8a96a', '#d08c60', '#9fb8ad', '#e2c2b3'],
    },
    {
      id: 'slot_frame', kind: 'color', targets: ['el_frame'], label: 'Frame color', property: 'stroke',
      palette: ['#c8a96a', '#f1ead8', '#9fb8ad'],
    },
  ],
});

// ===========================================================================
// Main
// ===========================================================================

function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const filters = args.filter((a) => !a.startsWith('--'));
  const ids = new Set<string>();
  let stale = 0;
  for (const def of definitions) {
    if (filters.length && !filters.some((f) => `${def.category}/${def.slug}`.includes(f))) continue;
    const doc = buildTemplate(def);
    if (ids.has(doc.id)) throw new Error(`Duplicate template id ${doc.id}`);
    ids.add(doc.id);
    const file = join(TEMPLATES_ROOT, def.category, `${def.slug}${TEMPLATE_SUFFIX}`);
    const out = serializeDocument(doc);
    const rel = relative(TEMPLATES_ROOT, file);
    if (check) {
      if (!existsSync(file) || readFileSync(file, 'utf8') !== out) {
        console.error(`stale: templates/${rel}`);
        stale++;
      }
      continue;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, out);
    const slots = doc.template!.slots.length;
    console.log(`templates/${rel.padEnd(44)} ${String(doc.pages.length)}p ${String(slots).padStart(2)} slots ${(out.length / 1024).toFixed(0).padStart(4)} KB`);
  }
  if (check) {
    if (stale) {
      console.error(`${stale} template file(s) out of date: run npx tsx templates/scripts/build-templates.ts`);
      process.exit(1);
    }
    console.log('All template files are up to date.');
  }
}

main();
