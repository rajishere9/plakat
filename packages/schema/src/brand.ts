import { syncFonts } from './fonts.ts';
import { createId, deepCopy } from './ids.ts';
import { checkJsonNesting, DocumentValidationError } from './load.ts';
import {
  BRAND_KIT_FORMAT,
  type Asset,
  type BrandColor,
  type BrandFont,
  type BrandFontRole,
  type BrandKit,
  type BrandLogo,
  type Color,
  type Id,
  type PlakatDocument,
  type PlakatElement,
} from './types.ts';
import {
  AssetSchema,
  BrandKitSchema,
  COLOR_PATTERN,
  FONT_FAMILY_PATTERN,
  findReservedKey,
  toValidationIssues,
  type BrandKitInput,
} from './validation.ts';
import { MigrationError, UnsupportedSchemaVersionError } from './version.ts';

export { BrandKitSchema, type BrandKitInput };
export type { BrandColor, BrandFont, BrandFontRole, BrandKit, BrandLogo } from './types.ts';

export const CURRENT_BRAND_KIT_SCHEMA_VERSION = 1;

export class BrandKitError extends Error {
  override name = 'BrandKitError';
}

/** Empty brand kit. */
export function createBrandKit(name = 'Brand kit'): BrandKit {
  return {
    format: BRAND_KIT_FORMAT,
    schemaVersion: 1,
    id: createId('bk'),
    name,
    colors: [],
    fonts: [],
    logos: [],
    assets: {},
  };
}

/**
 * Validates untrusted brand-kit JSON. Same versioning policy as documents
 * (newer schemaVersion -> UnsupportedSchemaVersionError); no migrations exist yet.
 */
export function loadBrandKit(input: unknown): BrandKit {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new MigrationError('A brand kit must be a JSON object');
  }
  const obj = input as Record<string, unknown>;
  if (obj['format'] !== BRAND_KIT_FORMAT) throw new MigrationError(`Not a Plakat brand kit (format: ${JSON.stringify(obj['format'])})`);
  const v = obj['schemaVersion'];
  if (typeof v === 'number' && v > CURRENT_BRAND_KIT_SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError(v, CURRENT_BRAND_KIT_SCHEMA_VERSION);
  }
  const tooDeep = checkJsonNesting(input);
  if (tooDeep) throw tooDeep;
  const reserved = findReservedKey(input);
  if (reserved) throw new DocumentValidationError([{ path: reserved, message: 'Reserved key (__proto__, constructor and prototype are not allowed)' }]);
  const parsed = BrandKitSchema.safeParse(input);
  if (!parsed.success) throw new DocumentValidationError(toValidationIssues(parsed.error));
  return parsed.data;
}

/** Appends a color. Throws BrandKitError unless `value` is #rrggbb / #rrggbbaa. */
export function addBrandColor(kit: BrandKit, value: string, name = ''): BrandKit {
  if (!COLOR_PATTERN.test(value)) throw new BrandKitError(`Invalid color "${value}" (expected #rrggbb or #rrggbbaa)`);
  return { ...kit, colors: [...kit.colors, { id: createId('bc'), name, value: value.toLowerCase() }] };
}

export function removeBrandColor(kit: BrandKit, colorId: Id): BrandKit {
  return { ...kit, colors: kit.colors.filter((c) => c.id !== colorId) };
}

export type BrandFontSpec = Pick<BrandFont, 'role' | 'family'> & Partial<Pick<BrandFont, 'weight' | 'style'>>;

function checkFontSpec(spec: BrandFontSpec): void {
  if (!FONT_FAMILY_PATTERN.test(spec.family)) throw new BrandKitError(`Invalid font family "${spec.family}"`);
}

/** Adds the font for a role. A kit has at most one font per role: throws BrandKitError if the role is taken (use setBrandFont to replace). */
export function addBrandFont(kit: BrandKit, spec: BrandFontSpec): { kit: BrandKit; font: BrandFont } {
  if (kit.fonts.some((f) => f.role === spec.role)) throw new BrandKitError(`The kit already has a ${spec.role} font`);
  return setBrandFont(kit, spec);
}

/** Sets (inserts or replaces) the font for `spec.role`. */
export function setBrandFont(kit: BrandKit, spec: BrandFontSpec): { kit: BrandKit; font: BrandFont } {
  checkFontSpec(spec);
  const existing = kit.fonts.find((f) => f.role === spec.role);
  const font: BrandFont = {
    id: existing?.id ?? createId('bf'),
    role: spec.role,
    family: spec.family,
    weight: spec.weight ?? 400,
    style: spec.style ?? 'normal',
  };
  const fonts = existing ? kit.fonts.map((f) => (f.role === spec.role ? font : f)) : [...kit.fonts, font];
  return { kit: { ...kit, fonts }, font };
}

export function removeBrandFont(kit: BrandKit, fontId: Id): BrandKit {
  return { ...kit, fonts: kit.fonts.filter((f) => f.id !== fontId) };
}

/** Adds a logo (asset validated, stored under a fresh asset id). */
export function addBrandLogo(kit: BrandKit, asset: Asset, name = ''): { kit: BrandKit; logo: BrandLogo } {
  const parsed = AssetSchema.safeParse(deepCopy(asset));
  if (!parsed.success) throw new BrandKitError(`Invalid logo asset: ${toValidationIssues(parsed.error)[0]?.message ?? 'unknown error'}`);
  const assetId = createId('as');
  const logo: BrandLogo = { id: createId('bl'), name, assetId };
  return { kit: { ...kit, logos: [...kit.logos, logo], assets: { ...kit.assets, [assetId]: parsed.data } }, logo };
}

/** Removes a logo and its asset record (unless another logo still uses it). */
export function removeBrandLogo(kit: BrandKit, logoId: Id): BrandKit {
  const logo = kit.logos.find((l) => l.id === logoId);
  if (!logo) return kit;
  const logos = kit.logos.filter((l) => l.id !== logoId);
  const assets = { ...kit.assets };
  if (!logos.some((l) => l.assetId === logo.assetId)) delete assets[logo.assetId];
  return { ...kit, logos, assets };
}

/**
 * Resolves a logo to the asset record + its KIT asset id. To insert it into a design,
 * build an image element referencing `assetId` and pass it with
 * `{ [assetId]: asset }` to importElements(), which merges the registry without
 * clobbering a different design asset that happens to share the id.
 */
export function getBrandLogoAsset(kit: BrandKit, logoId: Id): { assetId: Id; asset: Asset } | null {
  const logo = kit.logos.find((l) => l.id === logoId);
  const asset = logo && Object.hasOwn(kit.assets, logo.assetId) ? kit.assets[logo.assetId] : undefined;
  return logo && asset ? { assetId: logo.assetId, asset: deepCopy(asset) } : null;
}

// ---------------------------------------------------------------------------
// Apply brand kit (works on any design; needs no slots)
// ---------------------------------------------------------------------------

export interface ApplyBrandKitOptions {
  /** Remap colors (default true). */
  colors?: boolean;
  /** Restyle text fonts by role (default true). */
  fonts?: boolean;
  /** Limit to these pages (default all). */
  pageIds?: readonly Id[];
}

const rgbKey = (c: Color) => c.slice(0, 7).toLowerCase();

/**
 * The document's distinct colors (#rrggbb, alpha ignored) ordered by usage: count of
 * text fills, shape fills, shape strokes and page background colors, descending; ties
 * in first-seen order (pages in order, background before elements).
 */
export function documentColorsByUsage(doc: Pick<PlakatDocument, 'pages'>, pageIds?: readonly Id[]): Color[] {
  const filter = pageIds ? new Set(pageIds) : null;
  const counts = new Map<string, number>();
  const bump = (c: Color | null) => {
    if (c) counts.set(rgbKey(c), (counts.get(rgbKey(c)) ?? 0) + 1);
  };
  for (const page of doc.pages) {
    if (filter && !filter.has(page.id)) continue;
    bump(page.background.color);
    for (const el of page.elements) {
      if (el.type === 'text') bump(el.fill);
      else if (el.type === 'shape') {
        bump(el.fill);
        bump(el.stroke);
      }
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
}

/**
 * "Apply brand kit" — a pure, deterministic restyle of a design (or template):
 *  - colors: the i-th most-used document color (documentColorsByUsage) becomes the
 *    i-th kit color, for i < min(#doc colors, #kit colors). A replaced `#rrggbbaa`
 *    keeps its own alpha. Applies to text fills, shape fills/strokes, page backgrounds.
 *  - fonts: distinct text fontSizes ranked descending: the largest -> `heading`, the
 *    second -> `subheading` (falls back to `heading`), the rest -> `body`. A role the
 *    kit lacks leaves those elements unchanged. family/weight/style are written.
 * Ids are preserved; the fonts cache is re-synced.
 */
export function applyBrandKit(doc: PlakatDocument, kit: BrandKit, options: ApplyBrandKitOptions = {}): PlakatDocument {
  const filter = options.pageIds ? new Set(options.pageIds) : null;
  const inScope = (pageId: Id) => !filter || filter.has(pageId);

  const colorMap = new Map<string, Color>();
  if (options.colors !== false) {
    documentColorsByUsage(doc, options.pageIds).forEach((c, i) => {
      const kc = kit.colors[i];
      if (kc) colorMap.set(c, kc.value);
    });
  }
  const recolor = <C extends Color | null>(c: C): C => {
    if (!c) return c;
    const to = colorMap.get(rgbKey(c));
    if (!to) return c;
    return (to.slice(0, 7) + (c.length === 9 ? c.slice(7) : to.slice(7))).toLowerCase() as C;
  };

  const roleFont = new Map<BrandFontRole, BrandFont>(kit.fonts.map((f) => [f.role, f]));
  const sizes =
    options.fonts === false
      ? []
      : [...new Set(doc.pages.filter((p) => inScope(p.id)).flatMap((p) => p.elements.flatMap((e) => (e.type === 'text' ? [e.fontSize] : []))))].sort(
          (a, b) => b - a,
        );
  const fontFor = (size: number): BrandFont | undefined => {
    const rank = sizes.indexOf(size);
    if (rank === -1) return undefined;
    if (rank === 0) return roleFont.get('heading');
    if (rank === 1) return roleFont.get('subheading') ?? roleFont.get('heading');
    return roleFont.get('body');
  };

  const restyle = (el: PlakatElement): PlakatElement => {
    if (el.type === 'text') {
      const f = fontFor(el.fontSize);
      return {
        ...el,
        fill: recolor(el.fill),
        ...(f ? { fontFamily: f.family, fontWeight: f.weight, fontStyle: f.style } : {}),
      };
    }
    if (el.type === 'shape') return { ...el, fill: recolor(el.fill), stroke: recolor(el.stroke) };
    return el;
  };

  const pages = doc.pages.map((page) =>
    inScope(page.id)
      ? {
          ...page,
          background: { ...page.background, color: recolor(page.background.color) },
          elements: page.elements.map(restyle),
        }
      : page,
  );
  return syncFonts({ ...doc, pages });
}
