/**
 * Canonical TypeScript types of the Plakat document format (schemaVersion 1).
 *
 * These describe the *canonical* (fully populated) form that `loadDocument()`
 * returns. Hand-written JSON may omit fields that have defaults; see
 * docs/document-schema.md and `PlakatDocumentInput`.
 */

export const DOCUMENT_FORMAT = 'plakat.document' as const;
export const BRAND_KIT_FORMAT = 'plakat.brandkit' as const;

/** URL-safe identifier, `^[A-Za-z0-9_-]{1,64}$`. */
export type Id = string;

/** `#rrggbb` or `#rrggbbaa` (case-insensitive; factories emit lowercase). */
export type Color = string;

/** ISO-8601 UTC timestamp, e.g. `2026-10-08T12:00:00.000Z`. */
export type IsoDateTime = string;

export type DocumentKind = 'design' | 'template';

export type PhysicalUnit = 'mm' | 'in';

export interface PhysicalSize {
  width: number;
  height: number;
  unit: PhysicalUnit;
}

/**
 * Size shared by every page of a document. `width`/`height` are CSS px at
 * 96 px/in and may be fractional for physical presets (A4 = 793.7007...).
 */
export interface PageSize {
  width: number;
  height: number;
  /** Preset this size came from (informational), or null for custom. */
  presetId: string | null;
  /** Authoritative physical size for print/PDF, or null for screen formats. */
  physical: PhysicalSize | null;
}

export interface DocumentMeta {
  title: string;
  description: string;
  tags: string[];
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  /** Id of the template this design was instantiated from, if any. */
  sourceTemplateId: Id | null;
}

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

export type ElementType = 'text' | 'shape' | 'image';

export interface ElementBase {
  id: Id;
  type: ElementType;
  /** Display name in the layers panel ('' = derive from type/content). */
  name: string;
  /** Page-space position of the element's local origin (unrotated top-left corner). */
  x: number;
  y: number;
  /** Unrotated box size in page px. */
  width: number;
  height: number;
  /** Degrees, clockwise, about the local origin (x, y) — identical to Konva. */
  rotation: number;
  /** 0..1 */
  opacity: number;
  locked: boolean;
  hidden: boolean;
  /** Flat selection group tag; elements sharing a groupId select/move together. */
  groupId: Id | null;
}

export type FontWeight = 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;
export type FontStyle = 'normal' | 'italic';
export type TextAlign = 'left' | 'center' | 'right' | 'justify';
export type VerticalAlign = 'top' | 'middle' | 'bottom';
export type TextDecoration = 'none' | 'underline' | 'line-through';
export type TextTransform = 'none' | 'uppercase' | 'lowercase' | 'capitalize';

export interface TextElement extends ElementBase {
  type: 'text';
  /** Plain text; '\n' is a hard line break. */
  content: string;
  fontFamily: string;
  fontWeight: FontWeight;
  fontStyle: FontStyle;
  /** px */
  fontSize: number;
  /** Multiplier of fontSize. */
  lineHeight: number;
  /**
   * Tracking in em: a fraction of `fontSize` added after each glyph (0.05 = 5 %).
   * The renderer passes `letterSpacing * fontSize` px to Konva, so scaling a text
   * box scales its tracking with it.
   */
  letterSpacing: number;
  align: TextAlign;
  verticalAlign: VerticalAlign;
  fill: Color;
  textDecoration: TextDecoration;
  textTransform: TextTransform;
}

export type ShapeKind = 'rect' | 'ellipse' | 'line' | 'triangle' | 'polygon' | 'star';

export interface ShapeElement extends ElementBase {
  type: 'shape';
  shape: ShapeKind;
  /** null = no fill. Ignored for `line`. */
  fill: Color | null;
  /** null = no stroke. A `line` without stroke is invisible. */
  stroke: Color | null;
  /** px, centered on the geometry. */
  strokeWidth: number;
  /** Dash pattern in px ([] = solid). */
  dash: number[];
  /** px; `rect` only. */
  cornerRadius: number;
  /** Polygon side count or star point count (3..64). */
  sides: number;
  /** Star inner radius as a fraction of the outer radius (0.05..0.95). */
  innerRadius: number;
}

export interface CropRect {
  /**
   * In the asset's DECLARED pixel space (`asset.width` x `asset.height`), whatever
   * resolution the decoded bitmap has; see computeImageLayout().
   */
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ObjectFit = 'cover' | 'contain' | 'fill';

export interface ImageFilters {
  /** -100..100, additive. */
  brightness: number;
  /** -100..100 */
  contrast: number;
  /** -100 (grayscale) .. 100 (2x chroma). */
  saturation: number;
  /** Blur radius in page px, 0..100. */
  blur: number;
  grayscale: boolean;
  sepia: boolean;
  invert: boolean;
}

export interface ImageElement extends ElementBase {
  type: 'image';
  assetId: Id;
  /** Explicit crop in declared asset pixels (stretched into the box), or null = derive from objectFit. */
  crop: CropRect | null;
  objectFit: ObjectFit;
  flipX: boolean;
  flipY: boolean;
  /** px */
  cornerRadius: number;
  filters: ImageFilters;
}

/**
 * Any element. Deliberately NOT named `Element`, which would shadow the DOM's
 * global `Element` type in editor code.
 */
export type PlakatElement = TextElement | ShapeElement | ImageElement;

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export interface BackgroundImage {
  assetId: Id;
}

export interface PageBackground {
  /** null = transparent (PNG keeps alpha; JPG/PDF flatten onto white). */
  color: Color | null;
  /** Drawn above `color` with objectFit "cover". */
  image: BackgroundImage | null;
}

export interface Page {
  id: Id;
  name: string;
  background: PageBackground;
  /** z-order = array order (index 0 is bottom-most). */
  elements: PlakatElement[];
}

// ---------------------------------------------------------------------------
// Assets & fonts
// ---------------------------------------------------------------------------

export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | 'image/svg+xml';

export interface AssetSource {
  /** e.g. 'upload', 'openverse', 'brand-kit'. */
  provider: string;
  externalId: string | null;
  /** Landing page of the original (for attribution). */
  pageUrl: string | null;
  author: string | null;
  license: string | null;
  licenseUrl: string | null;
  /** Ready-to-display attribution line. */
  attribution: string | null;
}

export interface ImageAsset {
  type: 'image';
  mimeType: ImageMimeType;
  /**
   * Declared natural size in px, AFTER EXIF orientation (i.e. as displayed). This is
   * the coordinate space of `ImageElement.crop`. Producers must record the size of the
   * pixels they serve; a different-resolution rendition is tolerated (crops are scaled
   * proportionally at render time), a different aspect ratio is a producer bug.
   */
  width: number;
  height: number;
  /** `data:image/...` URI (mime must equal `mimeType`), `https://`/`http://` URL, or root-relative server path `/...`. */
  src: string;
  name: string;
  source: AssetSource | null;
}

export type Asset = ImageAsset;

export type FontSource = 'google';

export interface FontVariant {
  weight: FontWeight;
  style: FontStyle;
}

export interface FontRef {
  family: string;
  source: FontSource;
  /** Exact weight/style combinations used; unique, sorted by (style normal<italic, weight asc). */
  variants: FontVariant[];
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export type SlotKind = 'text' | 'image' | 'color';

export interface SlotBase {
  id: Id;
  kind: SlotKind;
  label: string;
  description: string;
  required: boolean;
  /** Element ids this slot writes to (>= 1). */
  targets: Id[];
}

export interface TextSlot extends SlotBase {
  kind: 'text';
  /** Max characters (after fill, before textTransform), or null = unlimited. */
  maxLength: number | null;
  multiline: boolean;
}

export interface ImageSlot extends SlotBase {
  kind: 'image';
  /** objectFit applied to targets when filled (crop is reset to null). */
  fit: 'cover' | 'contain';
}

export interface ColorSlot extends SlotBase {
  kind: 'color';
  property: 'fill' | 'stroke';
  /** Suggested colors ([] = any). */
  palette: Color[];
}

export type TemplateSlot = TextSlot | ImageSlot | ColorSlot;

export interface TemplateInfo {
  category: string | null;
  slots: TemplateSlot[];
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export interface PlakatDocument {
  format: typeof DOCUMENT_FORMAT;
  schemaVersion: 1;
  kind: DocumentKind;
  id: Id;
  meta: DocumentMeta;
  size: PageSize;
  /** >= 1 page. */
  pages: Page[];
  /** Asset registry keyed by asset id. */
  assets: Record<Id, Asset>;
  /** Derived cache of fonts used by text elements; maintained by syncFonts(). */
  fonts: FontRef[];
  /** Present iff kind === 'template'. */
  template: TemplateInfo | null;
}

// ---------------------------------------------------------------------------
// Brand kit (separate document)
// ---------------------------------------------------------------------------

export interface BrandColor {
  id: Id;
  name: string;
  value: Color;
}

export type BrandFontRole = 'heading' | 'subheading' | 'body' | 'accent';

export interface BrandFont {
  id: Id;
  role: BrandFontRole;
  family: string;
  weight: FontWeight;
  style: FontStyle;
}

export interface BrandLogo {
  id: Id;
  name: string;
  assetId: Id;
}

export interface BrandKit {
  format: typeof BRAND_KIT_FORMAT;
  schemaVersion: 1;
  id: Id;
  name: string;
  colors: BrandColor[];
  fonts: BrandFont[];
  logos: BrandLogo[];
  assets: Record<Id, Asset>;
}
