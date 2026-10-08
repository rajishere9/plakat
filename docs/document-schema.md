# Plakat document schema — v1

This is the authoritative spec of the Plakat document format: the JSON that the editor edits, the server stores, the renderer draws, and `.plakat.json` files carry.

- **Implementation:** `@plakat/schema` (`packages/schema/src`). The zod schemas in `validation.ts` are the executable form of this spec. Compile-time guards there fail the build if the TypeScript types in `types.ts` drift from them.
- **Current `schemaVersion`:** `1`.
- **Golden example:** `packages/schema/src/__fixtures__/example.plakat.json`. It is reproduced in [§13](#13-worked-example), and tests load it.

Decisions are marked **D-n**, each with a one-line rationale. Other packages must not reinterpret a field in a way this document does not state. Change the format only by bumping the version ([§11](#11-versioning--migration)).

---

## 1. Envelope

```jsonc
{
  "format": "plakat.document",   // required, constant
  "schemaVersion": 1,            // required, integer
  "kind": "design",              // "design" | "template"            (default "design")
  "id": "doc_V1StGXR8Z5jd",      // required
  "meta": { … },                 // §2                               (default: see §2)
  "size": { … },                 // §3, shared by every page          required
  "pages": [ … ],                // §5, >= 1                          required
  "assets": { "<assetId>": … },  // §8 registry                       (default {})
  "fonts": [ … ],                // §9 derived cache                  (default [])
  "template": null               // §10, non-null iff kind = "template" (default null)
}
```

| Rule | |
|---|---|
| Ids | Every id (document, page, element, group, asset key, slot) matches `^[A-Za-z0-9_-]{1,64}$`, and `__proto__`, `constructor` and `prototype` are refused (as ids **and** as object keys anywhere in the file). Factories emit `<prefix>_<12 alphanumerics>`, with prefixes `doc pg el as grp slot bk bc bf bl`. Prefixes are cosmetic and never parsed. |
| Uniqueness | Page, element and slot ids share **one namespace** and are unique together within a document. A `groupId` is shared by its members but must not equal any page, element or slot id (**D-17**). Asset ids are registry keys (a separate namespace). |
| Lookups | Registry lookups use own properties only (`Object.hasOwn`), never `in`, so `toString` and friends are never "found". |
| Colors | `#rrggbb` or `#rrggbbaa`, case-insensitive. Factories emit lowercase. Nothing else is accepted (no names, `rgb()` or `transparent`; `null` means "none" where a field allows it). |
| Numbers | Finite JSON numbers. Ranges are listed per field. |
| Unknown keys | **Rejected** everywhere (strict objects). |
| Defaults | Hand-written JSON may omit any field that has a default. `loadDocument()` always returns the canonical form with every field present, and `serializeDocument()` always writes the canonical form. Defaults are fresh per parse (no shared arrays or objects between documents). |
| Size limits | One asset `src` ≤ 25 MiB of characters (`MAX_ASSET_SRC_LENGTH`), ≤ 20 000 elements across all pages (`MAX_TOTAL_ELEMENTS`), ≤ 2 000 000 characters of text content in total (`MAX_TOTAL_TEXT_LENGTH`), plus the per-field caps below. The server's own request-body limit (configured in `apps/server`) bounds the file as a whole. |

- **D-17** One id namespace for pages, elements, slots and groups. *Rationale:* clone helpers and editors can map any id unambiguously, and a hand-written template where a slot is called `el_headline` cannot corrupt a clone.
- **D-1** Unknown keys are rejected, not stripped. *Rationale:* any format change bumps `schemaVersion` (D-20), so an unknown key at a known version is always a typo or a corrupt file. Template authors get an error instead of silent data loss.
- **D-2** Defaults are accepted on input, but output is canonical. *Rationale:* hand-authored templates stay short, while stored and exported files stay explicit and stable to diff.

## 2. `meta`

| Field | Type | Default | Notes |
|---|---|---|---|
| `title` | string ≤ 500 | `"Untitled design"` | |
| `description` | string ≤ 10 000 | `""` | |
| `tags` | string[] ≤ 64, each ≤ 64 chars | `[]` | Template gallery search. |
| `createdAt` / `updatedAt` | ISO-8601 datetime | `1970-01-01T00:00:00.000Z` | The server owns `updatedAt` on save. |
| `sourceTemplateId` | id \| null | `null` | Set by `instantiateTemplate()`. |

## 3. Units, page size and DPI

**Document space is CSS px at 96 px/in.** Every length in the document is in document px: positions, sizes, font sizes, stroke widths, blur and corner radii.

`size` is shared by **all pages** of a document.

| Field | Type | Default | Notes |
|---|---|---|---|
| `width`, `height` | number 1..20 000 | required | Document px. **May be fractional.** |
| `presetId` | string \| null | `null` | Informational (UI label, analytics). Never used for math. |
| `physical` | `{ width, height, unit: "mm" \| "in" }` \| null | `null` | Authoritative physical size for print and PDF. |

Conversions (`units.ts`), all exact with no rounding: `px = mm / 25.4 × 96`, `px = in × 96`, `pt = px × 72 / 96`.

- **D-3** One page size per document. *Rationale:* this matches Canva, and it keeps template instantiation, "resize design" and PDF assembly trivial. Per-page sizes can come in a later version.
- **D-4** For physical sizes, `width`/`height` store the **exact, unrounded** px value (A4 = `793.7007874015748 × 1122.5196850393702`), and `physical` keeps the original mm/in. *Rationale:* rounding at storage time would compound with export rounding. A4 at 300 DPI must come out at exactly 2480 × 3508, and 794 × 3.125 = 2481.25 would not.
- **D-5** Pixel rounding happens **once**, at raster time, through `exportPixelSize()` (see `render-export-pipeline.md` §4). Stored geometry is never rounded.
- PDF pages larger than 14 400 pt on a side (jsPDF's and the PDF viewer limit; possible above ~19 200 px or ~5 080 mm) are written with an integer PDF `/UserUnit` > 1 (`pdfPageLayout()`), so the page is never clamped smaller than its image.

### Presets (`presets.ts`)

| id | Label | Document px | Physical |
|---|---|---|---|
| `instagram-post` | Instagram post | 1080 × 1080 | — |
| `instagram-story` | Instagram story | 1080 × 1920 | — |
| `youtube-thumbnail` | YouTube thumbnail | 1280 × 720 | — |
| `a4-poster` | A4 poster | 793.70… × 1122.51… | 210 × 297 mm |
| `business-card` | Business card (US) | 336 × 192 | 3.5 × 2 in |
| `business-card-eu` | Business card (EU) | 321.25… × 207.87… | 85 × 55 mm |

Custom sizes come from `customPageSize(w, h, 'px' | 'mm' | 'in')`. Bleed and crop marks are out of scope for V1.

## 4. Coordinate system and transforms

- The origin is the page's top-left corner. +x points right, +y points down, and units are document px.
- `x`, `y` is the page-space position of the element's **local origin**, the top-left corner of its **unrotated** box.
- `width`, `height` is the unrotated box size.
- `rotation` is in degrees, **clockwise, about the local origin (`x`, `y`)**. Any finite value in ±36 000 is valid, and the editor normalizes to [0, 360) with `normalizeRotation()`.
- There are no scale or skew fields. The editor bakes Transformer scaling into the element on transform end with **`bakeTransform(el, nodeAttrs)`**, the single tested implementation: `width *= scaleX`, `height *= scaleY`; for text, a uniform scale also multiplies `fontSize` (tracking follows because `letterSpacing` is in em), while a side-anchor scale only changes the box and the text re-wraps. Negative scale on both axes is normalized to +180° rotation; a single negative scale (mirror) or any skew throws. At rest, every content node has `scaleX = scaleY = 1`.
- Skew can arise when Konva's Transformer scales a multi-selection non-uniformly while a member is rotated by a non-multiple of 90°. The editor therefore configures the Transformer from **`transformerConstraints(selected)`**: such selections (and `groupId` groups) get `keepRatio: true` with corner anchors only; single text gets corners plus middle-left/right; single images uniform corners; `flipEnabled: false` always.

- **D-6** Use Konva's native transform model: `x`, `y`, `rotation`, `width` and `height` map 1:1 to Konva attrs with `offset = 0`. *Rationale:* the editor and the export run zero conversion code, so there is nothing to diverge, and Konva's Transformer emits exactly these values. Rotating "about the center", as the properties panel does, is a pure helper: `rotateAroundCenter(el, deg)` returns the new `{x, y, rotation}`.
- `geometry.ts` provides `getElementCorners`, `getElementBounds` (rotated AABB), `getSelectionBounds`, `getElementCenter`, `moveBoundsTo` and `getSnapEdges`. Snapping and alignment run on AABBs.

**Z-order is array order.** In `page.elements`, index 0 is drawn first (bottom) and the last element is drawn on top. There is no z-index field.

**Page clipping:** content is clipped to the page box in both the editor content layer and the export (**D-7**). *Rationale:* this is Canva's behavior, and it is required for export parity. The editor may show off-page parts ghosted, but only on its chrome layer.

## 5. Page

| Field | Type | Default | Notes |
|---|---|---|---|
| `id` | id | required | |
| `name` | string ≤ 200 | `""` | |
| `background.color` | color \| null | `"#ffffff"` | `null` means transparent: PNG keeps alpha, while JPG and PDF flatten onto white. |
| `background.image` | `{ assetId }` \| null | `null` | Drawn over `color` with object-fit **cover** over the whole page. |
| `elements` | Element[] ≤ 10 000 | `[]` | Z-order is array order. |

## 6. Elements

V1 has three element types: `text`, `shape` and `image`. The JSON uses a discriminated union on `type`. The TypeScript union is `PlakatElement` (deliberately not `Element`, which would shadow the DOM type in editor code).

### 6.1 Common fields

| Field | Type | Default | Notes |
|---|---|---|---|
| `id` | id | required | |
| `type` | `"text" \| "shape" \| "image"` | required | |
| `name` | string ≤ 200 | `""` | Layers-panel label. `""` means the UI derives a label. |
| `x`, `y` | number ±1e6 | required | §4. |
| `width`, `height` | number 0..100 000 | required | §4. |
| `rotation` | number ±36 000 | `0` | Degrees, clockwise, about (`x`, `y`). |
| `opacity` | 0..1 | `1` | |
| `locked` | boolean | `false` | Not selectable or movable on canvas. Still selectable from the layers panel. |
| `hidden` | boolean | `false` | Not rendered at all, in the editor content layer or in export. |
| `groupId` | id \| null | `null` | Flat selection group (D-8). |

- **D-8** **No group container in V1.** Grouping is a flat `groupId` tag: clicking any member selects every element with the same `groupId`, and they move, scale and delete together. Group members need not be contiguous in z-order. *Rationale:* the scene stays flat (no nested transforms, and z-order stays plain array order), the renderer ignores `groupId` entirely so export parity is unaffected, and template slots always target leaf elements. Nested containers are reserved for a future `schemaVersion`.

### 6.2 `text`

| Field | Type | Default | Notes |
|---|---|---|---|
| `content` | string ≤ 100 000 | required | Plain text. `\n` is a hard break. Words wrap at `width`. |
| `fontFamily` | string | `"Inter"` | A Google Fonts family name (§9): `^[A-Za-z0-9][A-Za-z0-9 ]{0,99}$`. |
| `fontWeight` | 100 \| 200 \| … \| 900 | `400` | |
| `fontStyle` | `"normal" \| "italic"` | `"normal"` | |
| `fontSize` | number (0, 5000] | `32` | px |
| `lineHeight` | 0.5..5 | `1.2` | Multiplier of `fontSize`. |
| `letterSpacing` | number −1..5 | `0` | **em**: a fraction of `fontSize` added after each glyph (`0.05` = 5 %). The renderer passes `letterSpacing × fontSize` px to Konva (**D-18**). |
| `align` | `left \| center \| right \| justify` | `left` | |
| `verticalAlign` | `top \| middle \| bottom` | `top` | Position of the text block inside `height`. |
| `fill` | color | `"#000000"` | |
| `textDecoration` | `none \| underline \| line-through` | `none` | |
| `textTransform` | `none \| uppercase \| lowercase \| capitalize` | `none` | Applied at render time by `applyTextTransform()`. `content` keeps the user's casing. |

- **D-9** Text never clips. If the laid-out text is taller than `height`, it overflows downward from the top (see the pipeline doc §3.3). The editor auto-grows `height` to fit after edits. A box narrower than a single grapheme (width 0, a resize, large tracking, a big font in a small slot) is laid out at the width of its widest grapheme instead, overflowing to the side (pipeline doc §3.3). *Rationale:* Konva silently drops lines that do not fit a fixed height, and stops wrapping (dropping the rest of the paragraph) when one grapheme does not fit the width; losing user text in an export is unacceptable.
- **D-18** `letterSpacing` is em-relative. *Rationale:* scaling a text box or changing its font size must not change its tracking or re-wrap it; absolute px would need a later migration.
- No rich text (mixed styles within one element), text shadow or text stroke in V1.

### 6.3 `shape`

| Field | Type | Default | Notes |
|---|---|---|---|
| `shape` | `rect \| ellipse \| line \| triangle \| polygon \| star` | required | |
| `fill` | color \| null | `"#cccccc"` | Ignored for `line`. |
| `stroke` | color \| null | `null` | A `line` with a null stroke is invisible. |
| `strokeWidth` | 0..1000 | `0` | px, **centered** on the geometry (it extends `strokeWidth/2` outside the box). |
| `dash` | number[] ≤ 16 | `[]` | Konva dash pattern in px. `[]` means solid. |
| `cornerRadius` | number ≥ 0 | `0` | `rect` only. |
| `sides` | int 3..64 | `5` | `polygon` side count, or `star` point count. Factories use the same default (`DEFAULT_SHAPE_SIDES`). |
| `innerRadius` | 0.05..0.95 | `0.5` | `star` inner/outer radius ratio. |

Geometry in local box space (`getShapePoints()` is the single implementation):

- `rect` is a box `(0, 0, w, h)` with `cornerRadius`.
- `ellipse` has center `(w/2, h/2)` and radii `w/2`, `h/2`.
- `line` is a polyline `[0, h/2, w, h/2]`. Direction comes from `rotation`. `h` is just the hit and bounds height.
- `triangle` is `[w/2, 0, w, h, 0, h]`.
- `polygon` and `star` are regular figures with the first vertex at the top. Their **own AABB is stretched to exactly fill** `(0, 0, w, h)`, so the shape always fills its box, as in Canva.

All fields are always present. Fields that do not apply to a `shape` are ignored. *Rationale:* a flat, uniform object is easier to validate and to switch between kinds.

### 6.4 `image`

| Field | Type | Default | Notes |
|---|---|---|---|
| `assetId` | id | required | Must be a key of `assets`. |
| `crop` | `{x, y, width, height}` \| null | `null` | **In the asset's declared pixel space** (`asset.width × asset.height`, §8), and validated to lie inside it (±0.01 px). The crop is stretched to fill the box, and the editor keeps aspect locked while cropping. |
| `objectFit` | `cover \| contain \| fill` | `cover` | Used only when `crop` is null. |
| `flipX`, `flipY` | boolean | `false` | Mirrors the pixels inside the box about its center. Does not change `x`, `y`, `width` or `height`. |
| `cornerRadius` | number ≥ 0 | `0` | Applies to the drawn rect. |
| `filters` | object | all neutral | See below. |

`computeImageLayout(el, asset, decoded?)` resolves `{ crop, dest }`. All math happens in the declared space; the returned `crop` is then scaled by `decoded / declared` per axis, so a different-resolution rendition of the same image (a re-encoded upload, a provider thumbnail) samples the same region. With `contain`, `dest` is letterboxed inside the box, and every other case fills the box. A crop that goes past the image bounds is clamped; one that clamps to zero width or height falls back to `cover` (Konva would otherwise draw the whole image). `coverCrop()` gives the explicit crop that is equivalent to `cover`, which is what crop mode starts from. `fitCropToImage(crop, w, h, boxAspect?)` makes any crop valid without distortion (keeps the aspect, shrinks uniformly, keeps the center); the crop UI, "Replace image" (when it keeps framing) and box resizes use it, since an out-of-range crop fails validation.

`filters` (all fields default to neutral):

| Field | Range | Meaning |
|---|---|---|
| `brightness` | −100..100 | Additive; ±100 adds ±255 per channel. |
| `contrast` | −100..100 | |
| `saturation` | −100..100 | −100 is fully desaturated, 0 is unchanged, 100 doubles chroma. |
| `blur` | 0..100 | Blur radius in **document px**. It scales with the export resolution. |
| `grayscale`, `sepia`, `invert` | boolean | |

The render pipeline doc §3.5 defines the exact Konva mapping and order.

- **D-10** Images store a crop in declared asset pixels rather than a scale and offset. *Rationale:* the crop is independent of the box size, it survives box resizes and asset swaps through `objectFit` when null, and it maps onto Konva's `crop` attribute after one proportional scale.
- **D-19** `asset.width/height` is the **only** coordinate space for crops; the decoded bitmap is only a rendition of it. *Rationale:* layout must not depend on which rendition a given server or browser decodes, so templates stay portable.

## 7. Paint

Fills are solid colors only in V1. Use `#rrggbbaa` for per-fill alpha. Gradients and pattern fills are future versions.

## 8. Assets

`assets` is a registry `{ [assetId]: Asset }`. Elements and backgrounds reference assets **by id only**.

| Field | Type | Default | Notes |
|---|---|---|---|
| `type` | `"image"` | required | The only kind in V1. |
| `mimeType` | `image/png \| image/jpeg \| image/webp \| image/gif \| image/svg+xml` | required | Authoritative. Bundling uses it. |
| `width`, `height` | int > 0 | required | Declared natural size in px **after EXIF orientation** (as displayed). It is the coordinate space of `crop` (D-19), it allows layout math without decoding, and SVGs need it. Producers record the size of the pixels they serve: the server bakes EXIF orientation into uploads and stores post-orientation dimensions; a re-encode or downsize must keep the aspect ratio. Renderers scale crops to the decoded size and warn on an aspect mismatch above 1 % (`compareDecodedSize`). SVGs are rasterized at exactly `width × height` before use. |
| `src` | string ≤ 25 MiB | required | One of the three forms below. |
| `name` | string | `""` | |
| `source` | object \| null | `null` | Provenance: `{ provider, externalId, pageUrl, author, license, licenseUrl, attribution }`. `pageUrl` and `licenseUrl` must be absolute `http(s)://` URLs (they become links). Required in practice for third-party providers (Openverse) so attribution survives into templates. |

`src` forms (anything else is rejected):

1. **`data:image/<png|jpeg|webp|gif|svg+xml>[;…],…`** is fully portable. Use it in `.plakat.json` exports and starter templates. Its mime type must equal `mimeType`, and the payload must be valid base64 (with `;base64`) or valid percent-encoding.
2. **`https://…` or `http://…`** is a remote URL. It must be CORS-enabled for export. Third-party URLs (provider results) are fetched through the server proxy (pipeline doc §3.2).
3. **`/…` (root-relative; never `//` or `/\`, which URL parsers resolve to another host)** is a file on the hosting Plakat server, for example `/api/uploads/<id>.png`. It is only meaningful on that server.

Non-`data:` forms may not contain whitespace, backslashes or control characters. Fetching is policy-checked too (`resolveAssetUrl`/`createFetchAssetFetcher`): root-relative srcs must resolve to the base origin, only http(s) is fetched, and **server-side code must pass `allowRemote: false` or an allow-list predicate**, because srcs in imported files are untrusted (SSRF). On import the server rewrites remote srcs to upload or proxy URLs.

- **D-11** Asset ids are registry keys, not identities. Within one document, `cloneWithNewIds()`, `clonePageWithNewIds()`, `cloneElementsWithNewIds()` and `instantiateTemplate()` **keep** asset ids, so duplicates share one registry entry. Ids are **not** globally unique: hand-written portable templates use readable ids (`as_placeholder`, `as_logo`), so two files can use the same id for different images. Content therefore moves **between** documents only through `mergeAssets()` / `importPages()` / `importElements()`: an incoming id is kept when the target lacks it or holds a deep-equal record, reuses the id of an equal record, and otherwise gets a fresh `as_` id with references rewritten. "Add page from template", cross-design paste and inserting a brand-kit logo all use them; never spread one registry into another.
- Unreferenced entries are allowed, but `instantiateTemplate()` removes them through `pruneUnusedAssets()`.

## 9. Fonts

Text elements reference fonts by `fontFamily`, `fontWeight` and `fontStyle`. `fonts` is a **derived cache** of the exact variants in use:

```json
"fonts": [{ "family": "Inter", "source": "google", "variants": [{ "weight": 400, "style": "normal" }] }]
```

- `source` can only be `"google"` in V1: Google Fonts family names, loaded from `fonts.googleapis.com/css2`, with one stylesheet per family (`googleFontsCssUrl()`).
- **Variant availability.** css2 answers HTTP 400 for a whole request if any requested weight/style does not exist (`Lobster:wght@700`). `GOOGLE_FONTS_CATALOG` (`font-catalog.ts`) records the weights and italics each catalogued family really has. The editor limits the weight and italic controls, the Bold/Italic shortcuts and brand-kit fonts to them (`getFontInfo`, `hasFontVariant`). The document may still name any 100..900 weight and either style (old files, hand-written templates); `googleFontsCssUrl()` requests `requestedFontVariants()`, which maps each used variant to what the browser would match (`resolveFontVariant`: nearest weight per CSS, italic → upright when absent), and the browser synthesizes bold or oblique **identically in editor and export**. Families outside the catalog are requested as written; on a 400 the loader retries per variant (`googleFontVariantCssUrl`) and reports only the missing ones.
- **Subsets.** Google Fonts splits a family into `unicode-range` faces (latin, latin-ext, cyrillic, greek, vietnamese, …) and the browser loads only faces that intersect the text passed to `document.fonts.load(font, text)`. `fontLoadRequests(doc, { pageIds })` therefore returns one `{ family, weight, style, query, text }` per used face, where `text` is every character rendered with it (after `textTransform`, hidden elements included).
- `collectFonts(doc)` computes the list from the text elements, hidden ones included. Variants are sorted with normal before italic, then by ascending weight. `serializeDocument()` and `normalizeDocument()` re-sync the cache, so a stale or empty `fonts` array in input is harmless.
- **The renderer always derives what to load from the elements, via `collectFonts`, never from `fonts` alone.** The readiness barrier is described in pipeline doc §3.1.
- Family names match `^[A-Za-z0-9][A-Za-z0-9 ]{0,99}$` (all Google Fonts names do), so CSS font shorthands and css2 URLs built from a validated document are always well-formed.
- **D-12** V1 supports Google Fonts only, with no OS fonts and no uploaded fonts. *Rationale:* a template must look the same on every machine, and system fonts make that impossible. Custom font uploads would add `source: "asset"` in a later version.
- **D-13** Fonts are not embedded in portable files. A `.plakat.json` needs network access to Google Fonts and nothing else. *Rationale:* Google Fonts licenses allow embedding, but it would bloat every file. Offline bundles are a future option.

## 10. Templates and slots

A template is an ordinary document with `kind: "template"` and a non-null `template` block. **Any design can become a template:** `saveAsTemplate(design, slots)`.

```jsonc
"template": {
  "category": "social/sale",            // string | null       (default null)
  "slots": [ /* TemplateSlot[] */ ]     //                     (default [])
}
```

A slot is a named, typed input that writes into one or more **target elements**:

| Field | Applies to | Type | Default | Notes |
|---|---|---|---|---|
| `id` | all | id | required | |
| `kind` | all | `text \| image \| color` | required | |
| `label` | all | string | `""` | Form label. |
| `description` | all | string | `""` | Help text. |
| `required` | all | boolean | `false` | Enforced only when `instantiateTemplate(…, { enforceRequired: true })` is called. Otherwise it is a UI hint. |
| `targets` | all | id[] (1..100) | required | Element ids in this document. |
| `maxLength` | text | int \| null | `null` | Unicode code points of the fill. |
| `multiline` | text | boolean | `true` | `false` rejects `\n`. |
| `fit` | image | `cover \| contain` | `cover` | Filling a target sets `objectFit = fit` and `crop = null`. |
| `property` | color | `fill \| stroke` | `fill` | |
| `palette` | color | color[] | `[]` | Suggested swatches. `[]` means any color. |

Target compatibility, validated:

| Slot | May target |
|---|---|
| `text` | `text` elements, writing `content` |
| `image` | `image` elements, writing `assetId`, `crop` and `objectFit` |
| `color` + `fill` | `shape` or `text` elements, writing `fill` |
| `color` + `stroke` | `shape` elements, writing `stroke` |

The template's own content is the placeholder and default value of each slot. Elements that no slot targets are the "fixed design". In **fill mode** (the "Use template" form) only slots are editable. After instantiation, the result is a normal design and everything is editable, as in Canva.

**Fills** passed to `instantiateTemplate` and `applySlotFill` are keyed by slot id:

```ts
{ text: string }                     // text slot
{ assetId: string, asset?: Asset }   // image slot (asset is added to the registry under assetId)
{ color: "#rrggbb" }                 // color slot
```

**Fill validation** (`applySlotFill`, `instantiateTemplate`): the fill must match the slot kind, `maxLength` and `multiline`; colors must match the color pattern; an image fill's `assetId` must be a valid id, and `asset`, when given, must pass `AssetSchema` (otherwise `assetId` must already be an own key of the registry). **A slot only writes to its own targets:** if `asset` is given under an `assetId` that already holds a *different* record, the record is stored under a fresh `as_` id and only the slot's targets point at it; other elements and backgrounds using the old id are untouched.

**`instantiateTemplate(template, fills, opts)`** does the following, in order:

1. Validates each fill against its slot (above). It throws `TemplateError` on an unknown slot or an invalid fill.
2. Applies the fills.
3. Regenerates **every** document, page, element, group and slot id (`cloneWithNewIds`, one map per namespace). Asset ids are kept.
4. Sets `kind = "design"`, `template = null`, `meta.sourceTemplateId = template.id`, and `createdAt`/`updatedAt = now`.
5. Prunes unused assets, syncs `fonts`, and **validates the result** (`DocumentValidationError`).

The input template is never mutated.

**Editing an open template (id-preserving).** `convertToTemplate(doc, { category })` turns a document into a template in place (same ids, so selection, undo history and the scene survive). `addSlot(doc, idOrSpec)`, `updateSlot(doc, slotId, patch)`, `setSlotTargets(doc, slotId, ids)`, `moveSlot(doc, slotId, index)` and `removeSlot(doc, slotId)` edit the slot table without touching any other id; each re-checks target compatibility and throws `TemplateError`.

**`saveAsTemplate(design, slots, opts)`** is "Save a **copy** as template": it takes `slots` as element ids or explicit `SlotSpec`s. With a bare id, the kind is inferred: text becomes a text slot, an image becomes an image slot, and a shape becomes a color slot (`stroke` if it has no fill, otherwise `fill`). It returns a new template with **all ids regenerated**, a **replaced** slot table and remapped targets, and validates it.

**Deleting.** A dangling slot target is a validation error, so every delete path goes through `removeElements(doc, ids)` / `removePage(doc, pageId)`, which drop the ids from `slot.targets` and remove slots left with no target. `normalizeDocument()` (and therefore `serializeDocument()`) applies the same pruning, so a raw splice in an immer recipe still saves.

- **D-14** Slots live in a side table that points at element ids, rather than as flags on elements. *Rationale:* one slot can drive several elements (the same name in two places, one accent color on many shapes), and the element schema stays identical between designs and templates.
- **D-15** Page-background color slots and font slots are not in V1. Restyling fonts is a brand-kit editor action (§12).

## 11. Versioning and migration

- `schemaVersion` is a **monotonic integer**. **Every** change to the persisted format bumps it, additions included, and there are no minor versions (**D-20**). *Rationale:* together with strict parsing (D-1), any reader can tell exactly what it can handle.
- A file **without** `schemaVersion` is **v0**: loose, unversioned JSON such as hand-written files or prototypes. The real migration `0 → 1` stamps `format`/`schemaVersion` and folds a top-level `width`/`height` into `size`.
- Migrations are registered in `MIGRATIONS` (`version.ts`). Entry `i` upgrades `i → i+1`. A migration is a **pure function on untyped JSON**: it does not mutate its input and uses no clock or randomness. Migrations are **never deleted or edited** once released.
- `migrateDocument(json)` applies the steps from the file's version up to `CURRENT_SCHEMA_VERSION`. `loadDocument(json)` migrates and then validates strictly. **`loadDocument` is the only sanctioned way to turn untrusted JSON (files, request bodies, DB rows) into a `PlakatDocument`.**
- **Files from the future** (`schemaVersion > CURRENT`) are refused with `UnsupportedSchemaVersionError` ("upgrade Plakat"). Plakat never guesses, never opens them read-only, and never downgrades.
- A gap in the chain raises `MigrationError`, and so does a non-integer or negative version, or a `format` other than `plakat.document`.
- **Never break old files:** each release keeps fixture files for every past version. A test loads each fixture through `loadDocument` and asserts the result. Adding version N means adding the migration `N-1 → N`, a fixture at N−1, updating `types.ts` and `validation.ts` (the drift guards force this), and updating this spec.
- **Storage:** the server stores validated canonical JSON plus a `schema_version` column. It migrates on read and writes the current version back lazily, on the next save.
- Brand kits are versioned the same way, with their own `schemaVersion` and chain (currently v1, with no migrations).

## 12. Brand kit

A brand kit is a **separate document**. Designs and templates never reference one. A kit holds **at most one font per role** (validated); `setBrandFont` upserts by role and `addBrandFont` refuses a taken role. Other helpers: `addBrandColor` (validates the color), `removeBrandColor`, `removeBrandFont`, `addBrandLogo` (validates the asset), `removeBrandLogo` (drops its asset), `getBrandLogoAsset`.

```jsonc
{
  "format": "plakat.brandkit", "schemaVersion": 1, "id": "bk_…", "name": "Acme",
  "colors": [{ "id": "bc_…", "name": "Primary", "value": "#ff5e3a" }],
  "fonts":  [{ "id": "bf_…", "role": "heading" | "subheading" | "body" | "accent",
               "family": "Playfair Display", "weight": 700, "style": "normal" }],
  "logos":  [{ "id": "bl_…", "name": "Logo", "assetId": "as_…" }],
  "assets": { "as_…": { /* Asset, §8 */ } }
}
```

- **D-16** Brand values are **copied** into designs: inserting a logo copies its asset record into `doc.assets` through `importElements()` (so a design asset that happens to share the kit's id is never replaced), and picking a brand color writes the literal hex. There are **no brand tokens in V1**. *Rationale:* documents stay self-contained and portable, and renders never depend on mutable external state. **"Apply brand kit" needs no slots** and works on any design: `applyBrandKit(doc, kit, { colors, fonts, pageIds })` maps the document's distinct colors ordered by usage (`documentColorsByUsage`: text fills, shape fills and strokes, page backgrounds; ties in first-seen order) onto the kit colors in order, keeping each replaced color's own alpha; and restyles text by size rank (largest `fontSize` → `heading`, second → `subheading`, falling back to `heading`, the rest → `body`; a role the kit lacks leaves those elements alone). It is pure and id-preserving. Token references such as `{"$brand": "colors.primary"}` are a candidate for a later `schemaVersion`.

## 13. Worked example

This is a one-page Instagram-post template with an image slot, two text slots (one with `textTransform`), a color slot, and a two-element group (rotated star plus label). It is byte-identical to `packages/schema/src/__fixtures__/example.plakat.json`, and it is canonical: `loadDocument(x)` deep-equals `x`.

```json
{
  "format": "plakat.document",
  "schemaVersion": 1,
  "kind": "template",
  "id": "doc_summerSale01",
  "meta": {
    "title": "Summer sale — Instagram post",
    "description": "Bold sale announcement with a hero photo.",
    "tags": ["sale", "summer"],
    "createdAt": "2026-10-08T12:00:00.000Z",
    "updatedAt": "2026-10-08T12:00:00.000Z",
    "sourceTemplateId": null
  },
  "size": { "width": 1080, "height": 1080, "presetId": "instagram-post", "physical": null },
  "pages": [
    {
      "id": "pg_cover",
      "name": "Cover",
      "background": { "color": "#fff4e6", "image": null },
      "elements": [
        {
          "id": "el_photo",
          "type": "image",
          "name": "Hero photo",
          "x": 0, "y": 0, "width": 1080, "height": 640,
          "rotation": 0, "opacity": 1, "locked": false, "hidden": false, "groupId": null,
          "assetId": "as_placeholder",
          "crop": null,
          "objectFit": "cover",
          "flipX": false, "flipY": false,
          "cornerRadius": 0,
          "filters": { "brightness": 0, "contrast": 10, "saturation": 20, "blur": 0, "grayscale": false, "sepia": false, "invert": false }
        },
        {
          "id": "el_band",
          "type": "shape",
          "name": "Accent band",
          "x": 0, "y": 600, "width": 1080, "height": 80,
          "rotation": 0, "opacity": 1, "locked": true, "hidden": false, "groupId": null,
          "shape": "rect",
          "fill": "#ff5e3a", "stroke": null, "strokeWidth": 0, "dash": [],
          "cornerRadius": 0, "sides": 5, "innerRadius": 0.5
        },
        {
          "id": "el_badge",
          "type": "shape",
          "name": "Badge",
          "x": 880, "y": 520, "width": 160, "height": 160,
          "rotation": 15, "opacity": 1, "locked": false, "hidden": false, "groupId": "grp_badge",
          "shape": "star",
          "fill": "#ffd60a", "stroke": "#1d1d1f", "strokeWidth": 4, "dash": [],
          "cornerRadius": 0, "sides": 12, "innerRadius": 0.8
        },
        {
          "id": "el_badgeText",
          "type": "text",
          "name": "Badge label",
          "x": 900, "y": 580, "width": 120, "height": 40,
          "rotation": 15, "opacity": 1, "locked": false, "hidden": false, "groupId": "grp_badge",
          "content": "-50%",
          "fontFamily": "Inter", "fontWeight": 800, "fontStyle": "normal",
          "fontSize": 34, "lineHeight": 1.15, "letterSpacing": 0,
          "align": "center", "verticalAlign": "middle",
          "fill": "#1d1d1f", "textDecoration": "none", "textTransform": "none"
        },
        {
          "id": "el_headline",
          "type": "text",
          "name": "Headline",
          "x": 80, "y": 730, "width": 920, "height": 132,
          "rotation": 0, "opacity": 1, "locked": false, "hidden": false, "groupId": null,
          "content": "Summer sale",
          "fontFamily": "Playfair Display", "fontWeight": 700, "fontStyle": "italic",
          "fontSize": 110, "lineHeight": 1.2, "letterSpacing": -0.02,
          "align": "left", "verticalAlign": "top",
          "fill": "#1d1d1f", "textDecoration": "none", "textTransform": "none"
        },
        {
          "id": "el_subline",
          "type": "text",
          "name": "Details",
          "x": 80, "y": 900, "width": 920, "height": 48,
          "rotation": 0, "opacity": 1, "locked": false, "hidden": false, "groupId": null,
          "content": "This weekend only · shop.example.com",
          "fontFamily": "Inter", "fontWeight": 400, "fontStyle": "normal",
          "fontSize": 36, "lineHeight": 1.3, "letterSpacing": 0.03,
          "align": "left", "verticalAlign": "top",
          "fill": "#3a3a3c", "textDecoration": "none", "textTransform": "uppercase"
        }
      ]
    }
  ],
  "assets": {
    "as_placeholder": {
      "type": "image",
      "mimeType": "image/png",
      "width": 4,
      "height": 3,
      "src": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAGUlEQVR4nGP4P5MBjhj+x1nBEQND1X84AgB0xhKhNwf2AgAAAABJRU5ErkJggg==",
      "name": "Placeholder gradient",
      "source": null
    }
  },
  "fonts": [
    { "family": "Inter", "source": "google", "variants": [ { "weight": 400, "style": "normal" }, { "weight": 800, "style": "normal" } ] },
    { "family": "Playfair Display", "source": "google", "variants": [ { "weight": 700, "style": "italic" } ] }
  ],
  "template": {
    "category": "social/sale",
    "slots": [
      { "id": "slot_photo", "kind": "image", "label": "Hero photo", "description": "Landscape photos work best.", "required": true, "targets": ["el_photo"], "fit": "cover" },
      { "id": "slot_headline", "kind": "text", "label": "Headline", "description": "", "required": true, "targets": ["el_headline"], "maxLength": 24, "multiline": false },
      { "id": "slot_details", "kind": "text", "label": "Details", "description": "Dates, URL or code.", "required": false, "targets": ["el_subline"], "maxLength": 60, "multiline": false },
      { "id": "slot_accent", "kind": "color", "label": "Accent color", "description": "", "required": false, "targets": ["el_band"], "property": "fill", "palette": ["#ff5e3a", "#007aff", "#34c759"] }
    ]
  }
}
```

The smallest valid hand-written document (everything else defaults):

```json
{
  "format": "plakat.document", "schemaVersion": 1, "id": "doc_min",
  "size": { "width": 1080, "height": 1080 },
  "pages": [{ "id": "pg_1", "elements": [
    { "id": "el_t", "type": "text", "x": 80, "y": 80, "width": 920, "height": 48, "content": "Hello" }
  ] }]
}
```

## 14. Portable files (`.plakat.json`)

- Extension `.plakat.json`, MIME type `application/vnd.plakat+json`, UTF-8. The content is the canonical document JSON: 2-space indent and a trailing newline (`serializeDocument`). Templates and designs use the same format, distinguished by `kind`.
- **Export as file:** `bundleAssets(doc, fetcher)` rewrites every non-`data:` `src` to a base64 `data:` URI. The data URI uses the asset's declared `mimeType`, regardless of the HTTP `Content-Type`. The result is `isPortable(doc) === true`: it renders anywhere with only Google Fonts access. The fetcher is injected, so the browser, the server and tests can each supply their own (`createFetchAssetFetcher(baseUrl)`).
- **Import:** `parseDocument(text)` runs `JSON.parse`, migration, and strict validation. On import, the server may move `data:` assets into uploads (`dataUriToBytes`, then store, then `mapAssetSources` to rewrite `src` to `/api/uploads/…`) to keep database rows small.
- Starter templates in `/templates` **must** be portable. CONTRIBUTING.md describes the authoring workflow.
- `serializeDocument` validates before writing, so Plakat never emits an invalid file.

## 15. Decision index

| # | Decision |
|---|---|
| D-1 | Strict objects: unknown keys rejected. |
| D-2 | Defaults on input, canonical output. |
| D-3 | One page size per document. |
| D-4 | Exact fractional px for physical sizes; `physical` is authoritative for print. |
| D-5 | Rounding only at raster time (`exportPixelSize`). |
| D-6 | Konva-native transforms: rotation about the top-left local origin. |
| D-7 | Content clipped to the page. |
| D-8 | No group container; flat `groupId` tag. |
| D-9 | Text never clips; auto-height in the editor. |
| D-10 | Image crop in source pixels. |
| D-11 | Asset ids kept within a document; content moves between documents only through `mergeAssets`/`importPages`/`importElements`. |
| D-12 | Google Fonts only. |
| D-13 | Fonts not embedded in portable files. |
| D-14 | Slots are a side table targeting element ids. |
| D-15 | No background or font slots in V1. |
| D-16 | Brand kit is a separate document; values are copied, with no tokens; "apply brand kit" works by color usage and font size rank, without slots. |
| D-17 | Pages, elements, slots and groups share one id namespace. |
| D-18 | `letterSpacing` is in em. |
| D-19 | Crops live in the declared asset size; decoded renditions are scaled to it. |
| D-20 | Every format change bumps the integer `schemaVersion`; future versions refused. |
