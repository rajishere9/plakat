import { z } from 'zod';
import { ID_PATTERN, RESERVED_IDS } from './ids.ts';
import type * as T from './types.ts';
import { BRAND_KIT_FORMAT, DOCUMENT_FORMAT } from './types.ts';
import { physicalToPx, toPx } from './units.ts';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const COLOR_PATTERN = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
/**
 * Allowed asset `src` forms:
 *  - `data:image/<png|jpeg|webp|gif|svg+xml>[;params],<payload>` (payload checked separately);
 *  - `http(s)://...` or root-relative `/...` (never `//` or `/\`, which URL parsers
 *    resolve to another host), with no whitespace, backslash or control character.
 */
export const ASSET_SRC_PATTERN =
  /^(?:data:image\/(?:png|jpeg|webp|gif|svg\+xml)(?:;[^,]*)?,|(?:https?:\/\/|\/(?![\/\\]))[^\s\\\x00-\x1f\x7f]*$)/;
/** Attribution links: absolute http(s) URLs only (never `javascript:` and friends). */
export const HTTP_URL_PATTERN = /^https?:\/\/[^\s\\\x00-\x1f\x7f]+$/i;
/**
 * Font family names: the character set Google Fonts family names use. Keeps CSS
 * font shorthands and css2 URLs well-formed for any validated document.
 */
export const FONT_FAMILY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ]{0,99}$/;

/**
 * Max bytes of one image asset file (25 MiB). THE limit for uploads, imported provider
 * images and embedded assets: servers and clients must import it instead of keeping
 * their own copy, so that every asset Plakat accepts can still be exported as a
 * portable `.plakat.json` (MAX_ASSET_SRC_LENGTH is derived from it).
 */
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;

/** Length of `data:<mimeType>;base64,<payload>` for `byteLength` bytes (what bundleAssets writes). */
export function base64DataUriLength(byteLength: number, mimeType: string): number {
  return `data:${mimeType};base64,`.length + 4 * Math.ceil(byteLength / 3);
}

/**
 * Max characters of one asset `src`: a base64 data: URI of MAX_ASSET_BYTES bytes with the
 * longest image mime type (34 952 562 characters), so any accepted asset can be embedded.
 */
export const MAX_ASSET_SRC_LENGTH = base64DataUriLength(MAX_ASSET_BYTES, 'image/svg+xml');
/** Max nesting depth of untrusted JSON (documents, brand kits). Real documents need < 10. */
export const MAX_JSON_DEPTH = 64;
/** Tolerance (px) between `size.width/height` and the px value of `size.physical` (D-4). */
export const PHYSICAL_SIZE_EPSILON = 0.01;
/** Max page side in document px. */
export const MAX_PAGE_SIDE_PX = 20_000;
/** Max elements across all pages of one document. */
export const MAX_TOTAL_ELEMENTS = 20_000;
/** Max characters of text content across all pages of one document. */
export const MAX_TOTAL_TEXT_LENGTH = 2_000_000;
/** Tolerance (px) when checking an explicit crop against the asset's declared size. */
export const CROP_EPSILON = 0.01;

const DEFAULT_TIMESTAMP = '1970-01-01T00:00:00.000Z';
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

export const IdSchema = z
  .string()
  .regex(ID_PATTERN, 'Invalid id (expected ^[A-Za-z0-9_-]{1,64}$)')
  .refine((v) => !RESERVED_IDS.has(v), 'Reserved id (__proto__, constructor and prototype are not allowed)');
export const ColorSchema = z.string().regex(COLOR_PATTERN, 'Invalid color (expected #rrggbb or #rrggbbaa)');
const coord = z.number().min(-1_000_000).max(1_000_000);
const length = z.number().min(0).max(100_000);
const FontWeightSchema = z.union([
  z.literal(100),
  z.literal(200),
  z.literal(300),
  z.literal(400),
  z.literal(500),
  z.literal(600),
  z.literal(700),
  z.literal(800),
  z.literal(900),
]);
const FontStyleSchema = z.enum(['normal', 'italic']);
export const FontFamilySchema = z
  .string()
  .regex(FONT_FAMILY_PATTERN, 'Invalid font family (letters, digits and spaces only, max 100)');

// ---------------------------------------------------------------------------
// Size & meta
// ---------------------------------------------------------------------------

export const PhysicalSizeSchema = z
  .strictObject({
    width: z.number().positive().max(10_000),
    height: z.number().positive().max(10_000),
    unit: z.enum(['mm', 'in']),
  })
  .superRefine((p, ctx) => {
    // The page px size is capped at MAX_PAGE_SIDE_PX; so is its physical size (≈ 5291.67 mm / 208.33 in).
    for (const side of ['width', 'height'] as const) {
      if (toPx(p[side], p.unit) > MAX_PAGE_SIDE_PX + PHYSICAL_SIZE_EPSILON) {
        ctx.addIssue({ code: 'custom', path: [side], message: `Physical ${side} exceeds the maximum page size of ${MAX_PAGE_SIDE_PX} px` });
      }
    }
  });

export const PageSizeSchema = z.strictObject({
  width: z.number().min(1).max(MAX_PAGE_SIDE_PX),
  height: z.number().min(1).max(MAX_PAGE_SIDE_PX),
  presetId: z.string().max(64).nullable().default(null),
  physical: PhysicalSizeSchema.nullable().default(null),
});

export const DocumentMetaSchema = z.strictObject({
  title: z.string().max(500).default('Untitled design'),
  description: z.string().max(10_000).default(''),
  tags: z.array(z.string().max(64)).max(64).default([]),
  createdAt: z.iso.datetime({ offset: true }).default(DEFAULT_TIMESTAMP),
  updatedAt: z.iso.datetime({ offset: true }).default(DEFAULT_TIMESTAMP),
  sourceTemplateId: IdSchema.nullable().default(null),
});

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

const elementBase = {
  id: IdSchema,
  name: z.string().max(200).default(''),
  x: coord,
  y: coord,
  width: length,
  height: length,
  rotation: z.number().min(-36_000).max(36_000).default(0),
  opacity: z.number().min(0).max(1).default(1),
  locked: z.boolean().default(false),
  hidden: z.boolean().default(false),
  groupId: IdSchema.nullable().default(null),
};

export const TextElementSchema = z.strictObject({
  ...elementBase,
  type: z.literal('text'),
  content: z.string().max(100_000),
  fontFamily: FontFamilySchema.default('Inter'),
  fontWeight: FontWeightSchema.default(400),
  fontStyle: FontStyleSchema.default('normal'),
  fontSize: z.number().positive().max(5_000).default(32),
  lineHeight: z.number().min(0.5).max(5).default(1.2),
  letterSpacing: z.number().min(-1).max(5).default(0),
  align: z.enum(['left', 'center', 'right', 'justify']).default('left'),
  verticalAlign: z.enum(['top', 'middle', 'bottom']).default('top'),
  fill: ColorSchema.default('#000000'),
  textDecoration: z.enum(['none', 'underline', 'line-through']).default('none'),
  textTransform: z.enum(['none', 'uppercase', 'lowercase', 'capitalize']).default('none'),
});

export const ShapeElementSchema = z.strictObject({
  ...elementBase,
  type: z.literal('shape'),
  shape: z.enum(['rect', 'ellipse', 'line', 'triangle', 'polygon', 'star']),
  fill: ColorSchema.nullable().default('#cccccc'),
  stroke: ColorSchema.nullable().default(null),
  strokeWidth: z.number().min(0).max(1_000).default(0),
  dash: z.array(z.number().min(0).max(10_000)).max(16).default([]),
  cornerRadius: z.number().min(0).max(100_000).default(0),
  sides: z.number().int().min(3).max(64).default(5),
  innerRadius: z.number().min(0.05).max(0.95).default(0.5),
});

export const CropRectSchema = z.strictObject({
  x: z.number().min(0),
  y: z.number().min(0),
  width: z.number().positive(),
  height: z.number().positive(),
});

export const ImageFiltersSchema = z.strictObject({
  brightness: z.number().min(-100).max(100).default(0),
  contrast: z.number().min(-100).max(100).default(0),
  saturation: z.number().min(-100).max(100).default(0),
  blur: z.number().min(0).max(100).default(0),
  grayscale: z.boolean().default(false),
  sepia: z.boolean().default(false),
  invert: z.boolean().default(false),
});

const DEFAULT_FILTERS: T.ImageFilters = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  blur: 0,
  grayscale: false,
  sepia: false,
  invert: false,
};

export const ImageElementSchema = z.strictObject({
  ...elementBase,
  type: z.literal('image'),
  assetId: IdSchema,
  crop: CropRectSchema.nullable().default(null),
  objectFit: z.enum(['cover', 'contain', 'fill']).default('cover'),
  flipX: z.boolean().default(false),
  flipY: z.boolean().default(false),
  cornerRadius: z.number().min(0).max(100_000).default(0),
  filters: ImageFiltersSchema.default(() => ({ ...DEFAULT_FILTERS })),
});

export const ElementSchema = z.discriminatedUnion('type', [
  TextElementSchema,
  ShapeElementSchema,
  ImageElementSchema,
]);

// ---------------------------------------------------------------------------
// Pages, assets, fonts, templates
// ---------------------------------------------------------------------------

export const PageBackgroundSchema = z.strictObject({
  color: ColorSchema.nullable().default('#ffffff'),
  image: z.strictObject({ assetId: IdSchema }).nullable().default(null),
});

export const PageSchema = z.strictObject({
  id: IdSchema,
  name: z.string().max(200).default(''),
  background: PageBackgroundSchema.default(() => ({ color: '#ffffff', image: null })),
  elements: z.array(ElementSchema).max(10_000).default([]),
});

export const AssetSourceSchema = z.strictObject({
  provider: z.string().min(1).max(64),
  externalId: z.string().max(500).nullable().default(null),
  pageUrl: z.string().max(2_000).regex(HTTP_URL_PATTERN, 'Expected an http(s) URL').nullable().default(null),
  author: z.string().max(500).nullable().default(null),
  license: z.string().max(200).nullable().default(null),
  licenseUrl: z.string().max(2_000).regex(HTTP_URL_PATTERN, 'Expected an http(s) URL').nullable().default(null),
  attribution: z.string().max(2_000).nullable().default(null),
});

/**
 * Returns a problem with a `data:` URI's payload or mime type, or null when it is
 * well-formed (base64 alphabet / percent-encoding) and declares `mimeType`.
 */
export function checkDataUri(src: string, mimeType: string): string | null {
  const comma = src.indexOf(',');
  const header = src.slice(5, comma); // after "data:"
  const [mime = '', ...params] = header.split(';');
  if (mime.toLowerCase() !== mimeType) return `data: URI mime type "${mime}" does not match mimeType "${mimeType}"`;
  const payload = src.slice(comma + 1);
  if (params.some((p) => p.toLowerCase() === 'base64')) {
    if (!BASE64_PATTERN.test(payload) || payload.length % 4 === 1) return 'data: URI payload is not valid base64';
    return null;
  }
  try {
    decodeURIComponent(payload);
  } catch {
    return 'data: URI payload is not valid percent-encoding';
  }
  return null;
}

export const ImageAssetSchema = z
  .strictObject({
    type: z.literal('image'),
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml']),
    width: z.number().int().positive().max(100_000),
    height: z.number().int().positive().max(100_000),
    src: z
      .string()
      .max(MAX_ASSET_SRC_LENGTH)
      .regex(ASSET_SRC_PATTERN, 'Asset src must be a data:image URI, an http(s) URL or a root-relative path'),
    name: z.string().max(500).default(''),
    source: AssetSourceSchema.nullable().default(null),
  })
  .superRefine((asset, ctx) => {
    if (!asset.src.startsWith('data:')) return;
    const problem = checkDataUri(asset.src, asset.mimeType);
    if (problem) ctx.addIssue({ code: 'custom', path: ['src'], message: problem });
  });

export const AssetSchema = ImageAssetSchema;

export const FontRefSchema = z.strictObject({
  family: FontFamilySchema,
  source: z.literal('google').default('google'),
  variants: z
    .array(z.strictObject({ weight: FontWeightSchema, style: FontStyleSchema }))
    .min(1)
    .max(18)
    .default((): T.FontVariant[] => [{ weight: 400, style: 'normal' }]),
});

const slotBase = {
  id: IdSchema,
  label: z.string().max(200).default(''),
  description: z.string().max(2_000).default(''),
  required: z.boolean().default(false),
  targets: z.array(IdSchema).min(1).max(100),
};

export const TextSlotSchema = z.strictObject({
  ...slotBase,
  kind: z.literal('text'),
  maxLength: z.number().int().positive().nullable().default(null),
  multiline: z.boolean().default(true),
});

export const ImageSlotSchema = z.strictObject({
  ...slotBase,
  kind: z.literal('image'),
  fit: z.enum(['cover', 'contain']).default('cover'),
});

export const ColorSlotSchema = z.strictObject({
  ...slotBase,
  kind: z.literal('color'),
  property: z.enum(['fill', 'stroke']).default('fill'),
  palette: z.array(ColorSchema).max(64).default([]),
});

export const TemplateSlotSchema = z.discriminatedUnion('kind', [TextSlotSchema, ImageSlotSchema, ColorSlotSchema]);

export const TemplateInfoSchema = z.strictObject({
  category: z.string().max(100).nullable().default(null),
  slots: z.array(TemplateSlotSchema).max(500).default([]),
});

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

const DocumentObjectSchema = z.strictObject({
  format: z.literal(DOCUMENT_FORMAT),
  schemaVersion: z.literal(1),
  kind: z.enum(['design', 'template']).default('design'),
  id: IdSchema,
  // Function defaults: a literal object would be shared (and its arrays aliased)
  // between every document parsed without the field.
  meta: DocumentMetaSchema.default(() => ({
    title: 'Untitled design',
    description: '',
    tags: [],
    createdAt: DEFAULT_TIMESTAMP,
    updatedAt: DEFAULT_TIMESTAMP,
    sourceTemplateId: null,
  })),
  size: PageSizeSchema,
  pages: z.array(PageSchema).min(1).max(500),
  assets: z.record(IdSchema, AssetSchema).default(() => ({})),
  fonts: z.array(FontRefSchema).max(200).default(() => []),
  template: TemplateInfoSchema.nullable().default(null),
});

type Ctx = z.core.$RefinementCtx<z.output<typeof DocumentObjectSchema>>;

function issue(ctx: Ctx, path: (string | number)[], message: string): void {
  ctx.addIssue({ code: 'custom', message, path });
}

type SlotOut = z.output<typeof TemplateSlotSchema>;
type ElementOut = z.output<typeof ElementSchema>;

/** Whether `slot` may write to `el` (the target-compatibility table of document-schema.md §10). */
export function canSlotTarget(slot: Pick<SlotOut, 'kind'> & { property?: 'fill' | 'stroke' }, el: Pick<ElementOut, 'type'>): boolean {
  switch (slot.kind) {
    case 'text':
      return el.type === 'text';
    case 'image':
      return el.type === 'image';
    case 'color':
      return slot.property === 'stroke' ? el.type === 'shape' : el.type === 'shape' || el.type === 'text';
  }
}

/** Cross-reference rules that a per-field schema cannot express. */
function checkDocumentReferences(doc: z.output<typeof DocumentObjectSchema>, ctx: Ctx): void {
  // Page, element, slot and group ids share ONE namespace (clone helpers and
  // editors may then use a single id -> thing lookup without ambiguity).
  const seen = new Map<string, string>();
  const elements = new Map<string, ElementOut>();
  const groups = new Map<string, (string | number)[]>();
  const claim = (id: string, what: string, path: (string | number)[]) => {
    const prev = seen.get(id);
    if (prev) issue(ctx, path, `Duplicate id "${id}" (already used by ${prev})`);
    else seen.set(id, what);
  };
  const hasAsset = (id: string) => Object.hasOwn(doc.assets, id);

  // D-4: width/height are the exact px of `physical`. Raster exports use width/height and
  // the PDF page uses `physical`, so a disagreement would stretch the PDF image.
  if (doc.size.physical) {
    const px = physicalToPx(doc.size.physical);
    if (Math.abs(px.width - doc.size.width) > PHYSICAL_SIZE_EPSILON || Math.abs(px.height - doc.size.height) > PHYSICAL_SIZE_EPSILON) {
      issue(
        ctx,
        ['size', 'physical'],
        `Physical size ${doc.size.physical.width}x${doc.size.physical.height} ${doc.size.physical.unit} is ${px.width}x${px.height} px, but size is ${doc.size.width}x${doc.size.height} px (width/height must be the exact px of physical)`,
      );
    }
  }

  let totalElements = 0;
  let totalText = 0;
  doc.pages.forEach((page, pi) => {
    claim(page.id, 'a page', ['pages', pi, 'id']);
    if (page.background.image && !hasAsset(page.background.image.assetId)) {
      issue(ctx, ['pages', pi, 'background', 'image', 'assetId'], `Unknown asset "${page.background.image.assetId}"`);
    }
    page.elements.forEach((el, ei) => {
      totalElements++;
      claim(el.id, 'an element', ['pages', pi, 'elements', ei, 'id']);
      elements.set(el.id, el);
      if (el.groupId !== null && !groups.has(el.groupId)) groups.set(el.groupId, ['pages', pi, 'elements', ei, 'groupId']);
      if (el.type === 'text') totalText += el.content.length;
      if (el.type === 'image') {
        if (!hasAsset(el.assetId)) {
          issue(ctx, ['pages', pi, 'elements', ei, 'assetId'], `Unknown asset "${el.assetId}"`);
        } else if (el.crop) {
          const asset = doc.assets[el.assetId]!;
          if (el.crop.x + el.crop.width > asset.width + CROP_EPSILON || el.crop.y + el.crop.height > asset.height + CROP_EPSILON) {
            issue(
              ctx,
              ['pages', pi, 'elements', ei, 'crop'],
              `Crop exceeds the asset's declared size ${asset.width}x${asset.height} (use fitCropToImage())`,
            );
          }
        }
      }
    });
  });
  if (totalElements > MAX_TOTAL_ELEMENTS) issue(ctx, ['pages'], `Too many elements (${totalElements} > ${MAX_TOTAL_ELEMENTS})`);
  if (totalText > MAX_TOTAL_TEXT_LENGTH) issue(ctx, ['pages'], `Too much text (${totalText} > ${MAX_TOTAL_TEXT_LENGTH} characters)`);

  if (doc.kind === 'template' && doc.template === null) {
    issue(ctx, ['template'], 'A document with kind "template" must have a template block');
  }
  if (doc.kind === 'design' && doc.template !== null) {
    issue(ctx, ['template'], 'A document with kind "design" must have template: null');
  }

  doc.template?.slots.forEach((slot, si) => {
    claim(slot.id, 'a slot', ['template', 'slots', si, 'id']);
    slot.targets.forEach((target, ti) => {
      const path = ['template', 'slots', si, 'targets', ti];
      const el = elements.get(target);
      if (!el) return issue(ctx, path, `Slot target "${target}" is not an element of this document`);
      if (!canSlotTarget(slot, el)) issue(ctx, path, `A ${slot.kind} slot cannot target a ${el.type} element ("${target}")`);
    });
  });

  for (const [groupId, path] of groups) {
    const prev = seen.get(groupId);
    if (prev) issue(ctx, path, `Group id "${groupId}" collides with ${prev} id`);
  }
}

export const DocumentSchema = DocumentObjectSchema.superRefine(checkDocumentReferences);

// ---------------------------------------------------------------------------
// Brand kit
// ---------------------------------------------------------------------------

export const BrandKitSchema = z
  .strictObject({
    format: z.literal(BRAND_KIT_FORMAT),
    schemaVersion: z.literal(1),
    id: IdSchema,
    name: z.string().max(200).default('Brand kit'),
    colors: z
      .array(z.strictObject({ id: IdSchema, name: z.string().max(100).default(''), value: ColorSchema }))
      .max(200)
      .default([]),
    fonts: z
      .array(
        z.strictObject({
          id: IdSchema,
          role: z.enum(['heading', 'subheading', 'body', 'accent']),
          family: FontFamilySchema,
          weight: FontWeightSchema.default(400),
          style: FontStyleSchema.default('normal'),
        }),
      )
      .max(50)
      .default([]),
    logos: z
      .array(z.strictObject({ id: IdSchema, name: z.string().max(200).default(''), assetId: IdSchema }))
      .max(100)
      .default([]),
    assets: z.record(IdSchema, AssetSchema).default(() => ({})),
  })
  .superRefine((kit, ctx) => {
    kit.logos.forEach((logo, i) => {
      if (!Object.hasOwn(kit.assets, logo.assetId)) {
        ctx.addIssue({ code: 'custom', path: ['logos', i, 'assetId'], message: `Unknown asset "${logo.assetId}"` });
      }
    });
    const roles = new Set<string>();
    kit.fonts.forEach((font, i) => {
      if (roles.has(font.role)) {
        ctx.addIssue({ code: 'custom', path: ['fonts', i, 'role'], message: `Duplicate brand font role "${font.role}" (at most one font per role)` });
      }
      roles.add(font.role);
    });
  });

// ---------------------------------------------------------------------------
// Type-level drift guards: zod output must equal the hand-written types.
// ---------------------------------------------------------------------------

type Equals<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;
type Assert<_T extends true> = never;

export type _TypeChecks = [
  Assert<Equals<z.output<typeof TextElementSchema>, T.TextElement>>,
  Assert<Equals<z.output<typeof ShapeElementSchema>, T.ShapeElement>>,
  Assert<Equals<z.output<typeof ImageElementSchema>, T.ImageElement>>,
  Assert<Equals<z.output<typeof PageSchema>, T.Page>>,
  Assert<Equals<z.output<typeof AssetSchema>, T.Asset>>,
  Assert<Equals<z.output<typeof FontRefSchema>, T.FontRef>>,
  Assert<Equals<z.output<typeof TemplateInfoSchema>, T.TemplateInfo>>,
  Assert<Equals<z.output<typeof DocumentSchema>, T.PlakatDocument>>,
  Assert<Equals<z.output<typeof BrandKitSchema>, T.BrandKit>>,
];

/** Shape accepted from hand-written JSON (fields with defaults may be omitted). */
export type PlakatDocumentInput = z.input<typeof DocumentSchema>;
export type ElementInput = z.input<typeof ElementSchema>;
export type BrandKitInput = z.input<typeof BrandKitSchema>;

// ---------------------------------------------------------------------------
// Issue formatting
// ---------------------------------------------------------------------------

export interface ValidationIssue {
  /** JSON path, e.g. "pages[0].elements[2].fill". */
  path: string;
  message: string;
}

export function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const p of path) {
    if (typeof p === 'number') out += `[${p}]`;
    else out += out ? `.${String(p)}` : String(p);
  }
  return out || '(root)';
}

export function toValidationIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((i) => ({ path: formatPath(i.path), message: i.message }));
}

/**
 * Finds an own `__proto__` / `constructor` / `prototype` KEY anywhere in untrusted
 * JSON. zod silently drops an own `__proto__` key from records, so without this
 * scan such a key would disappear instead of failing validation.
 * Returns the JSON path of the first offender (depth-first, in key order), or null.
 * Iterative: arbitrarily deep input cannot overflow the call stack.
 */
export function findReservedKey(value: unknown, path: (string | number)[] = []): string | null {
  // Each entry is "visit this key (object keys are checked when visited), then its value".
  // Paths are rebuilt from parent links only for the offender (no per-node path copies).
  const links: { parent: number; key: string | number }[] = [];
  const pathOf = (i: number) => {
    const out: (string | number)[] = [];
    for (; i >= 0; i = links[i]!.parent) out.unshift(links[i]!.key);
    return [...path, ...out];
  };
  const stack: { value: unknown; link: number; objectKey: boolean }[] = [{ value, link: -1, objectKey: false }];
  while (stack.length > 0) {
    const { value: v, link, objectKey } = stack.pop()!;
    if (objectKey && RESERVED_IDS.has(links[link]!.key as string)) return formatPath(pathOf(link));
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) stack.push({ value: v[i], link: links.push({ parent: link, key: i }) - 1, objectKey: false });
    } else if (v !== null && typeof v === 'object') {
      const keys = Object.keys(v);
      for (let i = keys.length - 1; i >= 0; i--) {
        const key = keys[i]!;
        stack.push({ value: (v as Record<string, unknown>)[key], link: links.push({ parent: link, key }) - 1, objectKey: true });
      }
    }
  }
  return null;
}

/**
 * Returns the JSON path of the first value nested deeper than `maxDepth` objects/arrays,
 * or null. Iterative, so it is safe on hostile input; run it BEFORE anything recursive
 * (structuredClone in migrateDocument, zod, findReservedKey) sees untrusted JSON.
 */
export function findExcessiveNesting(value: unknown, maxDepth: number = MAX_JSON_DEPTH): string | null {
  const stack: { value: unknown; depth: number; parent: number; key: string | number }[] = [{ value, depth: 0, parent: -1, key: '' }];
  // Parent links, so a path is only built for the offender.
  const nodes: { parent: number; key: string | number }[] = [];
  while (stack.length > 0) {
    const entry = stack.pop()!;
    const v = entry.value;
    if (v === null || typeof v !== 'object') continue;
    const index = nodes.push({ parent: entry.parent, key: entry.key }) - 1;
    const depth = entry.depth + 1;
    if (depth > maxDepth) {
      const path: (string | number)[] = [];
      for (let i = index; i > 0; i = nodes[i]!.parent) path.unshift(nodes[i]!.key);
      return formatPath(path);
    }
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) stack.push({ value: v[i], depth, parent: index, key: i });
    } else {
      const keys = Object.keys(v);
      for (let i = keys.length - 1; i >= 0; i--) stack.push({ value: (v as Record<string, unknown>)[keys[i]!], depth, parent: index, key: keys[i]! });
    }
  }
  return null;
}
