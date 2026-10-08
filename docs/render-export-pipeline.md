# Render & export pipeline

How a `PlakatDocument` becomes pixels, both in the editor and in exported files. Read this alongside [`document-schema.md`](./document-schema.md), which defines the format.

**Hard requirement:** an export must match the canvas pixel for pixel. Precisely: for any document, page and pixel ratio `s`, the editor's own `PageScene` for that page, rasterized at `s` with `rasterizePage` (whatever the editor's zoom, pan and number of visible pages), is **byte-identical** (RGBA) to `exportPage(doc, page, { scale: s })` before encoding. The rest of this document exists to make that sentence true.

Decisions are marked **P-n**, each with a one-line rationale.

---

## 1. Architecture

```
            ┌──────────────────────── @plakat/renderer ────────────────────────┐
 document ─▶│ prepareResources()  ──▶  PageScene (scene builder)  ──▶ rasterize│──▶ PNG / JPG / PDF / ZIP
            │  (readiness barrier)      build + reconcile by id      (exact WxH)│
            └──────────────▲──────────────────────▲──────────────────────────────┘
                           │                      │
                 editor (apps/web) uses the SAME PageScene for its content layer;
                 selection/guides/hover live on a separate chrome layer.
```

- **P-1** There is **one imperative scene builder** (`PageScene` in `@plakat/renderer`), and it is the only code that maps document elements to Konva nodes. The editor and the export both use it. The editor does **not** use react-konva for content. *Rationale:* parity holds by construction when there is only one mapping, and the tests (§6) cover the rare ways two call sites can still differ: incremental updates and chrome leakage.
- **P-2** The scene builder is DOM-free apart from Konva itself, and it runs under Node with `konva/canvas-backend` and `canvas`. *Rationale:* parity and dimension tests run in vitest without a browser.

### 1.1 Renderer API (contract)

The renderer package owns final names, but the shape below is what the editor and tests code against.

```ts
interface RenderEnv {
  loadImage(src: string, asset: Asset): Promise<DecodedImage>;   // §3.2
  loadFonts(fonts: FontRef[]): Promise<void>;                     // §3.1 (browser: FontFace API; Node: registerFont)
}
interface Resources { images: Map<AssetId, DecodedImage> }        // DecodedImage: CanvasImageSource with width/height

prepareResources(doc, pageIds: Id[], env): Promise<Resources>     // readiness barrier — resolves only when everything is drawable

class PageScene {
  constructor(opts: { doc: PlakatDocument; pageId: Id; resources: Resources; pixelRatio: number });
  readonly root: Konva.Group;                    // page-local space: ALWAYS at (0,0), scale 1, opacity 1 (§2.2)
  readonly size: PageSize;
  readonly pixelRatio: number;
  update(doc: PlakatDocument, opts?: {           // reconcile by element id (§2.2)
    dirty?: Iterable<Id>;                        //   re-apply these even if reference-equal (after drag/transform)
    rebuildText?: true | Iterable<Id>;           //   destroy + rebuild these text nodes (late fonts, new subsets)
  }): void;
  setPixelRatio(pixelRatio: number): void;       // content scale + clip/background + filter caches (§2.2, §3.5)
  destroy(): void;
}

rasterizePage(scene: PageScene, scale: number | ExportScaleId): HTMLCanvasElement | Canvas   // THE raster function (§4, P-9)
exportPage(doc, pageId, opts: { format: 'png'|'jpg'; scale: number|ExportScaleId; quality?: number; env }): Promise<Blob|Buffer>
exportDocument(doc, opts: { format: 'png'|'jpg'|'pdf'; scale; pageIds?; env }): Promise<{ filename: string; mimeType: string; data: Blob|Buffer }>
```

## 2. Scene structure

### 2.1 Layers

| Stage layer | Contents | In export? |
|---|---|---|
| **content** | One editor-owned **page frame** (`Konva.Group`) per page shown, positioned at that page's on-screen offset; each frame holds exactly one `PageScene.root`, and nothing else. | Only the roots, through `rasterizePage`. |
| **chrome** | Konva `Transformer`, snap guides, hover and selection outlines, crop-mode overlay, off-page ghosting, marquee, page labels. | **Never.** |

Rules:

- **P-12** **Zoom and pan live on the stage** (`stage.scale()`, `stage.position()`) and **page offsets on the frames**, never on a `PageScene.root`. The root always stays at (0, 0) with scale 1 and opacity 1, and frames, layers and the stage never get opacity, filters or a cache. `rasterizePage` draws the root in **root-local space** (`root.drawScene(canvas, root)`, the same mechanism Konva's own `cache()` uses), so stage zoom and pan, frame offsets, other pages and the chrome layer can never reach the bitmap. **Never call `stage.toCanvas()` / `layer.toCanvas()` on the editor stage**: `Stage._toKonvaCanvas` draws every layer (chrome included) and `Node._toKonvaCanvas` draws with the full absolute transform (zoom, pan, frame offset). *Rationale:* one raster function, independent of where the scene is mounted, is the only way the editor-vs-export comparison can be exact.
- **P-3** Editor UI state never mutates content nodes. Hover and selection are drawn as separate shapes on the chrome layer, never as stroke or shadow changes on content nodes. *Rationale:* any editor-only attribute on a content node is a parity bug waiting to happen.
- The Transformer lives on the chrome layer and attaches to content nodes, which Konva supports across layers. It is configured from `transformerConstraints(selection)` (`@plakat/schema`): uniform corner scaling for multi-selections containing an element rotated by a non-multiple of 90° (otherwise Konva decomposes the result into **skew**, which the format cannot represent), corners plus middle-left/right for single text, `flipEnabled: false`. Dragging and transforming mutate the content node live. On `dragend` or `transformend`, the editor computes the new element with `bakeTransform(el, node attrs)` (`@plakat/schema`, the one tested implementation), commits it to the store, and calls `scene.update(doc, { dirty: touchedIds })`. **Every touched node is re-applied even if its element is reference-equal**: a drag that snaps back, a resize clamped to the old size or a no-op transform commits the same values, immer returns the same object, and a reference check alone would leave the node at its live x/y or `scaleX ≠ 1`. Content nodes are therefore document-exact **at rest**. Parity is only defined at rest.
- While text is being edited inline, an HTML `<textarea>` overlay is shown and the Konva text node is hidden. This is the one sanctioned editor-only mutation, and parity tests run with no active text edit.
- Chrome strokes use `strokeScaleEnabled: false`, so they are independent of zoom.

### 2.2 Page root

`PageScene.root` is a `Konva.Group` at (0, 0) with scale 1 (P-12). Its only child is the **content group**:

```
root            Group  x=0 y=0 scale=1                     ← editor puts it in a page frame; rasterizePage draws it with top = root
└─ content      Group  scaleX=contentScaleX scaleY=contentScaleY  clip={0, 0, size.width, size.height}
   ├─ background   Rect   size.width × size.height, fill = background.color   (skipped when null)
   ├─ bg image     Image  computeImageLayout({ width: size.width, height: size.height, crop: null, objectFit: 'cover' }, asset, decoded)
   └─ element nodes, in page.elements order
```

- `contentScaleX/Y` come from `exportPixelSize(size, pixelRatio)` (§4, P-8): they map the page box exactly onto the `W × H` bitmap. They are 1 for integer pages at integer ratios.
- The clip (D-7), the background Rect and the background-image layout are in **page px** and do not depend on the pixel ratio; only the content scale does. `setPixelRatio(r)` recomputes `exportPixelSize(size, r)`, re-applies the content scale, and re-caches filtered nodes (§3.5). *Everything ratio-dependent is a function of the current pixel ratio*, so a scene built at one ratio and rasterized at another equals a fresh build at the second.

Element nodes: there is exactly **one top-level node per element**, with `id()` set to the element id and `name('element')`. Its attributes are `x`, `y`, `rotation`, `opacity`, `isolated` (text with `opacity < 1` only, §3.3) and `visible = !hidden`, with `offset = 0` and `scale = 1`. Hidden elements get `visible(false)` and are never drawn.

**Reconciliation** (`PageScene.update(doc)`), which is what lets the editor patch the scene instead of rebuilding it:

1. Build a `Map<id, node>` of existing nodes.
2. For each element of the new page, in order: if a node with that id and the same type exists, call `applyElement(node, el)` **unless** the element object is reference-equal to the previous one **and** its id is not in `opts.dirty`. Otherwise create the node. (The store uses immer, so structural sharing makes the reference check cheap; `dirty` covers the cases where the node, not the document, changed: drag and transform.)
3. Text nodes listed in `opts.rebuildText` (or all text nodes for `true`) are **destroyed and rebuilt** through the fresh-build path, never patched (§3.1).
4. Set z-order with `node.zIndex(i)` to match the array index.
5. Destroy nodes whose id is no longer present.
6. Re-apply the background if `background` changed; re-apply content scale and clip if `size` changed (and on `setPixelRatio`).
7. `batchDraw()` once.

An update must produce **the same node attributes as a fresh build**. Code both paths through one `applyElement(node, element)` function, which always sets every attribute it owns, including `scaleX = scaleY = 1`. This is what the incremental parity test (§6.1) verifies.

## 3. Element → Konva mapping and the readiness barrier

### 3.1 Fonts

Do not create or update a text node until its font is ready. Konva measures text when attributes are set, so a node created before the font loads keeps fallback metrics.

The browser barrier works as follows:

1. Run `collectFonts(doc)` over the pages being rendered (the elements, not `doc.fonts`) for the stylesheets, and `fontLoadRequests(doc, { pageIds })` for the load work list.
2. For each family, inject `<link rel="stylesheet" href="${canonicalFontCssUrl(font)}">` once per family, using `display=block`. For a catalogued family the URL always asks for **every** variant Google serves for it, whatever the document uses, so the page holds exactly one set of `@font-face` rules per family. For an uncatalogued family it is `googleFontsCssUrl(font)`, which asks only for the variants in use (`requestedFontVariants`, schema §9). If the stylesheet fails (css2 answers 400 when any variant is missing, possible only for uncatalogued families), retry once per variant with `googleFontVariantCssUrl` and record which variants failed.
3. For every request, await `document.fonts.load(req.query, req.text)`, then assert `document.fonts.check(req.query, req.text)`. **Pass `req.text`**: Google Fonts splits families into `unicode-range` subsets and the browser loads only the subsets that intersect the text; the default text (a space) would load latin only, and Polish, Turkish, Cyrillic, Greek or Vietnamese glyphs would render and measure in a fallback font.
   **P-13** Every font stylesheet on the page goes through this one canonical URL and the shared `loadFontStylesheet` (the font picker's previews too). *Rationale:* found by the §6.2 e2e test. When different variant sets were requested per document, page or export, a second stylesheet added duplicate `@font-face` rules for faces already in use. Text laid out before them was measured with one face and drawn with the other, so centered italic text moved by a sub-pixel amount and the editor snapshot no longer matched the export.
4. Use a 15 s overall timeout. On timeout or failure, throw `FontLoadError` with the list of missing variants. The editor shows a warning and renders with fallback fonts. **Export refuses** unless `allowFallbackFonts: true`. *Rationale:* a silent fallback produces a "valid" file that looks wrong.

**Late fonts and new subsets (editor).** When the user picks a font, or commits text that contains characters not in the `text` of the request already satisfied for that face, run the barrier for the affected requests, then call `scene.update(doc, { rebuildText: affectedIds })`. The text nodes are **destroyed and rebuilt** through the fresh-build path. Re-setting the same attributes does nothing: Konva's `Node._setAttr` returns early on an unchanged value, so no `*Change` event fires and `Text._setTextData` never re-measures, which would keep fallback-font line breaks that the export (a fresh build after the barrier) does not have.

In Node tests, fonts are registered with `registerFont(file, { family, weight, style })` from files under the renderer's test fixtures before any node is built. Tests must not depend on OS fonts.

### 3.2 Images

`loadImage` creates `new Image()`, sets `img.crossOrigin = 'anonymous'` **before** setting `src`, then sets `src` and awaits `img.decode()`. It asserts `naturalWidth > 0`.

- **Declared vs decoded size** (schema D-19). Crops and layout are defined in `asset.width × asset.height`. The renderer always calls `computeImageLayout(el, asset, { width: img.width, height: img.height })`, which scales the crop to the decoded bitmap, so a different-resolution rendition samples the same region. If `compareDecodedSize(asset, decoded).aspectMismatch` (> 1 %, typically an un-baked EXIF rotation), log a warning naming the asset; the web client bakes orientation before upload (`normalizeUploadFile`: decode with `imageOrientation: 'from-image'`, re-encode), so this should never happen for uploads. Browsers apply EXIF orientation and node-canvas does not, which is one more reason to bake it.
- **SVG** is rasterized to an offscreen canvas of exactly `svgRasterSize(asset, k)` = `round(asset.width × k) × round(asset.height × k)` and that canvas is the `DecodedImage` (`computeImageLayout` scales crops to it, D-19). Browsers invent 300 × 150 for SVGs without an intrinsic size, hence the declared size. The factor is **`k = svgRasterScale(asset, displayScale)`**: `displayScale` is the largest number of document px one declared SVG px covers anywhere in the document (`svgDisplayScales(doc)`: every page, hidden elements and page backgrounds, crops and `objectFit` included), `k = max(1, displayScale) × SVG_RASTER_PIXEL_RATIO (4)`, rounded **up** to a half-octave step, then capped at 8192 px per side and 16 777 216 px in total. So a 24 × 24 icon drawn at 600 × 600 is rasterized at 3072 × 3072, not 96 × 96, and its edges stay crisp at print. `k` depends on the **document only**, never on the zoom or export scale, so the editor and every export of the same document draw the same bitmap (byte parity), and the caps are the same on every platform (Safari's canvas area) for the same reason. 4 covers print (3.125); above it (a 2× screen beyond 200 % zoom) on-screen SVGs are upsampled.
  `prepareResources` passes `k` to `env.loadImage(src, asset, id, { svgRasterScale: k })` and re-decodes an SVG already in `resources` whose `k` changed (`decodedSvgScale(img)`). The editor calls **`resourcesOutdated(doc, resources, pageIds)`** after document changes (an SVG element was resized) and, when it returns true, runs `prepareResources(doc, pageIds, env, { into })` and `scene.update(doc, { resources })`, which re-applies the image nodes whose bitmap changed. Shrinking an element lowers `k` again (the export would), so the bitmaps stay identical. Node: node-canvas scales an SVG `Image` as a bitmap in `drawImage`; the Node env sets the image's `width`/`height` to the raster size first so librsvg renders the vector at that size.
- Cache decoded images by `src` (SVGs by `src` and raster size).
- On failure, throw `AssetLoadError(assetId)`. The editor draws a placeholder (a checkerboard rect) for missing assets. Export refuses.

**P-4** All non-`data:` image sources must be same-origin or CORS-enabled. Uploads are served by the Plakat server, which is same-origin. Third-party provider images (Openverse) are never drawn from their remote URL: `POST /api/asset-providers/:id/import` downloads the full image into the server's uploads, so the editor only ever draws same-origin `/uploads/…` images. (An earlier draft planned a `GET /api/assets/proxy?url=…` route; it was not built, because a proxy that fetches client-supplied URLs is an SSRF risk and the import route covers the need. Remote thumbnails in the search panel are plain `<img>` tags and never reach a canvas.) *Rationale:* one tainted image makes `toBlob` throw a `SecurityError`, and that would surface only at export time.

### 3.3 Text

The text node is a `Konva.Text` with:

- `text`: `applyTextTransform(content, textTransform)`
- `fontFamily`
- `fontStyle`: `"<italic|normal> <weight>"`, for example `"italic 700"`. Konva puts this string straight into the canvas font shorthand.
- `fontSize`, `lineHeight`, `align`, `fill`
- `letterSpacing`: `el.letterSpacing × el.fontSize` px (the document stores em, schema D-18), subject to the bidi rule below
- `direction`: `'ltr'` or `'rtl'`, **always explicit** (never Konva's default `'inherit'`, which would take the direction of the DOM canvas in the editor but `ltr` on the detached export canvas)
- `textDecoration`: `''` for `none`
- `width`: `max(el.width, widestGrapheme)`, `wrap: 'word'`. `widestGrapheme` is the largest `measureSize(g).width + letterSpacingPx` over the distinct graphemes (`Intl.Segmenter`) of the transformed text, cached per (font, grapheme). *Rationale:* when not even one grapheme fits the width, Konva's `_setTextData` stops wrapping and silently drops the rest of the paragraph (D-9). A too-narrow box overflows to the side instead.
- **no `height`**

**Bidi** (`textLayoutAttrs(text, align, letterSpacingPx)`). The base direction is that of the first strong character of the transformed text (`textBaseDirection`, like HTML `dir="auto"`; the inline editor's textarea must use `dir="auto"` too). Konva draws each grapheme with its own `fillText`, advancing left to right, whenever `letterSpacing ≠ 0` or `align = 'justify'` and its direction is not `'rtl'`: that mirrors Hebrew (letters and words reversed) and leaves Arabic unshaped (isolated forms). So:
- RTL base direction: `direction: 'rtl'`. Konva then draws one native run per line, with `letterSpacing` through `ctx.letterSpacing`. Konva cannot justify that run, so `justify` becomes `right` (the start edge of RTL text). `left`, `center` and `right` stay absolute.
- LTR base direction with RTL characters inside (`containsRtl`), and `letterSpacing ≠ 0` or `justify`: `letterSpacing` 0 and `justify` → `left`, so the line stays one native run and the RTL words stay intact.
- Anything else is unchanged (LTR text keeps Konva's per-grapheme path for spacing and justify).
`widestGrapheme` uses the effective `letterSpacing`. node-canvas has no `ctx.letterSpacing`, so under Node RTL text is drawn without its spacing (measurement includes it); only tests render under Node.

**Opacity.** An element group with `opacity < 1` that holds **text** is a Konva **isolated** group (`isolated: true`): its children are drawn into a device-pixel buffer and the opacity is applied once to the finished image, like CSS `opacity`. Without it Konva applies `globalAlpha` to every `fillText` (per line, or per grapheme with letter spacing) and overlapping lines or glyphs (line height below ~1, negative letter spacing) composite twice and come out darker (alpha 192 instead of 128 at opacity 0.5). Shapes need no isolation (Konva's own buffer handles fill + stroke) and images draw one primitive. The buffer is in destination device pixels, so the editor's `rasterizePage` and the export (same canvas, same geometry) stay byte-identical.

**P-5** Vertical alignment is computed, not delegated. Measure `h = node.height()` with the height left unset, then offset the text within the element box: `top` uses 0, `middle` uses `(height − h)/2`, and `bottom` uses `height − h`. If `h > height`, the offset is 0 and the text overflows downward. *Rationale:* Konva drops whole lines that do not fit a fixed `height` (verified in `Text.js`). D-9 forbids losing text.

The element node is then a `Konva.Group` (x, y, rotation, opacity) containing the `Konva.Text` at `(0, offsetY)`. Use the same structure for every text element, regardless of alignment.

### 3.4 Shapes

| `shape` | Konva node (inside the element group, local coords) |
|---|---|
| `rect` | `Konva.Rect { width, height, cornerRadius }` |
| `ellipse` | `Konva.Ellipse { x: w/2, y: h/2, radiusX: w/2, radiusY: h/2 }` |
| `line` | `Konva.Line { points: getShapePoints('line', w, h), stroke, strokeWidth, dash, lineCap: 'butt' }` with no fill |
| `triangle`, `polygon`, `star` | `Konva.Line { points: getShapePoints(shape, w, h, sides, innerRadius), closed: true }` |

All shapes set `fill` (`undefined` when null), `stroke` (`undefined` when null), `strokeWidth`, `dash`, `lineJoin: 'miter'`, and `strokeScaleEnabled: true`. Strokes are centered on the geometry, which is Konva's default. Use `getShapePoints()` from `@plakat/schema` and never reimplement it.

### 3.5 Images and filters

The image node is a `Konva.Image` with:

- `image`
- `crop` and position/size from `computeImageLayout(el, asset, { width: img.width, height: img.height })` (§3.2): set `crop`, `x = dest.x`, `y = dest.y`, `width = dest.width`, `height = dest.height`. The returned crop is never degenerate (a crop that clamps to zero falls back to `cover`), because Konva treats a falsy `cropWidth` as "no crop" and would draw the whole image.
- `cornerRadius`

It sits inside the element group. For a flip, wrap it in an inner group with `scaleX = -1, x = width` for `flipX`, and `scaleY = -1, y = height` for `flipY`. (These are the only non-unit scales in the content layer.)

**Filters.** Use Konva *function* filters only, in this fixed order. Include a filter only when its value is non-neutral.

| Order | Field | Konva filter | Konva attribute |
|---|---|---|---|
| 1 | `brightness` b | `Filters.Brighten` | `brightness = b / 100` |
| 2 | `contrast` c | `Filters.Contrast` | `contrast = c` |
| 3 | `saturation` s | `Filters.HSL` | `saturation = log2(max(1 + s/100, 2^-10))` (Konva applies `2^saturation`, so −100 gives ≈0 chroma and +100 gives 2×) |
| 4 | `grayscale` | `Filters.Grayscale` | — |
| 5 | `sepia` | `Filters.Sepia` | — |
| 6 | `invert` | `Filters.Invert` | — |
| 7 | `blur` r | `Filters.Blur` | `blurRadius = r` (document px). Konva 10 multiplies by the **cache** `pixelRatio` internally (`Blur.js`: `round(min(r, 180) × pixelRatio)`). |

- **P-6** Use only function filters, never CSS filter strings. *Rationale:* Konva 10 sends CSS filter strings to `ctx.filter` in browsers but to its JS fallback under node-canvas, so the browser and the Node tests would run different code.
- **P-7** Filters need `node.cache()`, and **the cache `pixelRatio` must equal the effective output pixel ratio**: `s` for export, and `zoom × devicePixelRatio` for on-screen display. The exact call is

  ```ts
  node.cache({ pixelRatio: r, offset: Math.max(1, Math.ceil(1 / r)) })
  ```

  Always pass `pixelRatio` explicitly and never rely on the `Konva.pixelRatio` default. The **`offset` padding is required**: `Node.cache` sizes its bitmap `floor(logicalWidth × r)` (`SceneCanvas`), which at a fractional ratio truncates up to one device pixel; a 100 px image at print (r = 3.125) would get 312 instead of 312.5 device px and lose half a column at its right and bottom edges, a seam that unfiltered (uncached) images do not have. With at least one logical px (and at least one device px) of transparent padding on each side, the truncation always falls on padding. After any change to a cached element, or a change of pixel ratio (`setPixelRatio`), call `clearCache()` then `cache(...)` again. In the editor, re-caching after zoom is debounced (about 150 ms), with the stale cache shown meanwhile. *Rationale:* a cache made at ratio 1 and drawn at 2× is upsampled and blurry, and blur radius in device pixels depends on the cache ratio.
- Images without active filters are **not** cached in either path. (Caching changes how pixels are rasterized, so both paths must follow the same rule.)
- **Cache size limits** (`planFilterCache`). A filter cache is `(w + 2·offset) × r` device px per side, plus a filter canvas and an `ImageData` of the same size. When that exceeds the browser's canvas limits or memory, Konva only logs "Unable to apply filter" and the image **disappears** (seen on screen at zoom 8 × dpr 2, and in a print export of an image much larger than the page; WebKit's 16.7 MP cap is reached far sooner). So every filter cache is planned against `limits = env.canvasLimits()` (export) or `platformCanvasLimits()` (editor), with a budget of `min(limits.maxArea, FILTER_CACHE_MAX_AREA = 8192²)`:
  1. the whole node at ratio `r`, exactly the P-7 call above (the normal case);
  2. else only the part the page clip can show: the page box mapped into node-local coordinates (`group × flip × node` transform, inverted; bounding box), padded by the blur radius + 2 px, with its origin on a multiple of the smallest `n` for which `n × r` is an integer (print: 8) so the crop does not resample the visible pixels (integer ratios: byte-identical; fractional ratios: within 1 level), cached with `cache({ x, y, width, height, pixelRatio: r, offset })`;
  3. else, **editor** (`filterCacheOverflow: 'clamp'`, the PageScene default): the largest ratio below `r` that fits the budget (the image stays visible, a little soft at extreme zoom); **export** (`renderPageWithResources` creates its scene with `canvasLimits` and `filterCacheOverflow: 'error'`): the cropped cache if it fits the hard limits, otherwise **`CanvasLimitError`**, never a file with the image missing.
  The plan is a function of node geometry, page size, ratio and limits, so the editor's `rasterizePage` and the export choose the same cache. A cropped cache in the editor is computed for the element's position at apply time; it is refreshed by the `update(doc, { dirty })` after a drag or transform (and on `setPixelRatio` / page-size changes). Only caches over the budget are ever cropped.

## 4. Export dimensions: the rounding rule

`exportPixelSize(size, scale)` in `@plakat/schema` is the single source of truth:

```
s = scale                         // 1, 2, or print = 300/96 = 3.125, or any positive number
W = max(1, round_half_up(snap6(size.width  × s)))     // snap6 = round to 1e-6 to kill float noise
H = max(1, round_half_up(snap6(size.height × s)))
contentScaleX = W / (size.width  × s)                  // 1 for integer pages at integer s
contentScaleY = H / (size.height × s)
```

- **P-8** The **page box maps exactly onto the bitmap**. Canvases and caches use the nominal ratio `s`, and the content group (§2.2) is scaled by `contentScaleX/Y`, so page px `(0..size.width) × (0..size.height)` cover exactly `W × H` device pixels; clip and background are the page size. *Rationale:* drawing at the plain uniform `s` would leave the bitmap edge cutting through the last column/row whenever `W ≠ size.width × s` (A4 @ 1x: 794 vs 793.70, so the right column would be 30 % background; EU card @ 2x: 48 %), a visible light seam on full-bleed dark photos in PNG, JPG and PDF. The anisotropy is at most `0.5 / W` (0.04 % for A4), invisible, and circles stay round to well under a pixel.
- **P-9** **One raster function for editor and export**, drawing the root in root-local space (P-12), with Konva's truncating bitmap size (`floor(logical × pixelRatio)`: `100 × 3.125 → 312`, not 313) neutralized by a half-pixel margin:

  ```ts
  import { SceneCanvas } from 'konva/lib/Canvas';

  function rasterizePage(scene: PageScene, scale: number | ExportScaleId) {
    const { width: W, height: H, pixelRatio: s } = exportPixelSize(scene.size, scale);
    const previous = scene.pixelRatio;
    scene.setPixelRatio(s);                                   // content scale + filter caches for s (§2.2, P-7)
    try {
      if ((scene.root.getParent()?.getAbsoluteOpacity() ?? 1) !== 1) throw new Error('page frame must not carry opacity');
      const canvas = new SceneCanvas({ width: (W + 0.5) / s, height: (H + 0.5) / s, pixelRatio: s });
      if (canvas._canvas.width !== W || canvas._canvas.height !== H) throw new Error('raster size mismatch');  // floor(W + 0.5 ± ε) === W
      scene.root.drawScene(canvas, scene.root);               // top = root: no stage zoom/pan, frame offset, other layers
      return canvas._canvas;
    } finally {
      scene.setPixelRatio(previous);                          // editor: restore on-screen caches
    }
  }
  ```

  The extra half pixel lies outside the page clip and outside the bitmap. `drawScene(canvas, root)` checks visibility relative to the root only, so an off-screen or hidden page frame still rasterizes. The only ancestor state that leaks into a root-local draw is opacity (Konva multiplies ancestor opacity), hence the assertion.
- The export path builds a fresh `PageScene` at `pixelRatio = s`, adds its root to one layer of a detached offscreen `new Konva.Stage({ container: detachedDiv, width: 1, height: 1, listening: false })` (the stage size is irrelevant to `rasterizePage`), and calls the **same** `rasterizePage`. Destroy the stage, and release its canvases with `Konva.Util.releaseCanvas`, after encoding.
- Before allocating, run `checkCanvasLimits({W, H})` with `DEFAULT_CANVAS_LIMITS`, or `SAFARI_CANVAS_LIMITS` when on WebKit. If the result is over the limit, throw a clear error that suggests a lower scale. Tiled rendering is future work.

### 4.1 Expected pixel dimensions

These values are asserted in `packages/schema/src/units.test.ts`; keep the two in sync.

| Preset | Document px | 1x | 2x | print (300 dpi, s = 3.125) |
|---|---|---|---|---|
| Instagram post | 1080 × 1080 | 1080 × 1080 | 2160 × 2160 | 3375 × 3375 |
| Instagram story | 1080 × 1920 | 1080 × 1920 | 2160 × 3840 | 3375 × 6000 ⚠ Safari |
| YouTube thumbnail | 1280 × 720 | 1280 × 720 | 2560 × 1440 | 4000 × 2250 |
| A4 poster (210 × 297 mm) | 793.70 × 1122.52 | 794 × 1123 | 1587 × 2245 | **2480 × 3508** |
| Business card US (3.5 × 2 in) | 336 × 192 | 336 × 192 | 672 × 384 | 1050 × 600 |
| Business card EU (85 × 55 mm) | 321.26 × 207.87 | 321 × 208 | 643 × 416 | 1004 × 650 |

⚠ Safari caps canvas area at 16,777,216 px. A story at print size is 20.25 MP, so on WebKit it fails the limit check with a clear error.

## 5. Output formats

| Format | Encoding | Background | Notes |
|---|---|---|---|
| **PNG** | `canvas.toBlob('image/png')` (Node: `canvas.toBuffer('image/png')`) | Alpha is preserved, and a null page color stays transparent. | This is the reference output; parity tests compare against it. For `print`, the PNG SHOULD carry a `pHYs` chunk (`round(300 / 0.0254)` px/m). |
| **JPG** | `toBlob('image/jpeg', quality)`, with quality defaulting to **0.92** (range 0.5..1) | Flattened: a new `W × H` canvas filled with `#ffffff`, then `drawImage(pageCanvas, 0, 0)`. | A page background color sits on top of the white base. With an opaque background the output is identical to the PNG apart from JPEG loss. For `print`, set JFIF density to 300 dpi where the encoder allows. |
| **PDF** | jsPDF, one PDF page per document page, laid out by `pdfPageLayout(doc.size)` → `{ width, height, orientation, userUnit }`: `new jsPDF({ unit: 'pt', format: [width, height], orientation, userUnit })`, `doc.addPage([width, height], orientation)` for later pages, `addImage(flattenedCanvas, 'PNG', 0, 0, width, height, undefined, 'FAST')`. | Flattened onto white, like JPG. | The scale defaults to **print**. The A4 page is 595.28 × 841.89 pt. Screen presets use px × 0.75 pt, so an Instagram post is 810 × 810 pt. **`orientation` must always be passed**: jsPDF defaults to portrait and swaps width/height when width > height, which would turn the landscape presets (YouTube 960 × 540 pt, US card 252 × 144 pt, EU card 240.9 × 155.9 pt) portrait and crop the image. Pages over 14 400 pt on a side (jsPDF clamps there) use an integer `userUnit` > 1, with all coordinates in user units. |

- **P-10** **The PDF is a raster.** Each page is a single lossless image at the chosen scale (300 dpi by default). Text is not selectable, and vector output is **future work** (it would need a second renderer, which would break the single-mapping guarantee of P-1). The UI must say "PDF (image, 300 dpi)".
- **P-11** **Multi-page PNG and JPG:** exporting one page downloads a single file. Exporting more than one page downloads a ZIP of `<slug>-01.png`, `<slug>-02.png` and so on, numbered from 1 and zero-padded to the page-count width. The ZIP uses the STORE method (PNG and JPG are already compressed) and is written by a ~100-line in-repo zip writer (CRC-32, local headers, central directory), so no new dependency is needed. PDF is always one file. *Rationale:* browsers block multiple automatic downloads.
- Filenames are `slugify(meta.title) || 'plakat'`, plus `-<page>` when needed, plus the extension.
- Pages are exported sequentially, yielding to the event loop between pages (`await new Promise(r => setTimeout(r))`), and each page's canvases are released before the next page starts. This bounds memory.

## 6. Proving parity

### 6.1 Node (vitest, `packages/renderer`)

The setup is `import 'konva/canvas-backend'` with fixture fonts registered (§3.1) and fixture images given as data URIs. Fixture documents cover:

- every element type and shape kind
- rotation (including 15° and 90°), opacity < 1 on a shape with both fill and stroke, and dashes
- all filters, including blur
- `crop`, `cover`, `contain`, flips and `cornerRadius`
- every `textTransform`, `verticalAlign` and `justify`
- `hidden` elements, a transparent background and a background image
- **a fractional A4 page**

Additional fixtures: a **narrow text box** (width 0 and narrower than one glyph), text with **latin-ext and Cyrillic** characters, a **full-bleed dark rect and image on a fractional page**, a **filtered image whose width × s is not an integer** at print, and an image whose decoded rendition is half the declared size with an explicit crop.

Tests:

1. **Dimensions.** For every preset × {1x, 2x, print}, `exportPage` decodes to exactly the table in §4.1. (Run at least 1x and 2x for all presets, plus print for A4 and the business cards, to keep CI fast; the Instagram story at print is rasterized without encoding.) Fractional custom sizes (100.5 × 50.5 px, 32.16 × 4.64 px whose print size lands on float noise just below .5, 85.5 × 54 mm, 3.5 × 2.25 in) are rasterized at 1x/2x/print against values computed from the dpi math, not copied from the table.
2. **Editor path vs export path, byte-exact.**
   - *Editor path:* build a stage shaped like the real editor: **stage zoom ≠ 1 (e.g. 0.37) and a non-zero pan**, a content layer with **two page frames at different offsets**, each holding a `PageScene` root, and a chrome layer with a Transformer attached to two nodes, plus guide lines. Apply a scripted series of edits through `scene.update(doc_i, opts)`: move, resize (through `bakeTransform`), restyle, reorder, delete, insert, hide/unhide, change a filter, **a no-op drag commit** (node moved live, then the store commits the original values: `update(doc, { dirty })` must restore it), **a font that loads after the scene was built** (`rebuildText`), and **change pixel ratio** (`setPixelRatio`) on the A4 fixture. End at `finalDoc`. Rasterize the second page with `rasterizePage(scene, s)`.
   - *Export path:* `exportPage(finalDoc, { scale: s })` on a fresh offscreen stage.
   - Assert `pixelmatch(a, b, null, W, H, { threshold: 0 }) === 0`, and that the raw RGBA `Buffer.equals`, for s ∈ {1, 2, 3.125}.
3. **Chrome isolation.** `rasterizePage` on the editor-shaped stage with a populated chrome layer must equal the export. Also assert that the output does not change when the stage zoom, pan or the frame offset change.
4. **Filter cache ratio.** Render a blurred image at s = 2 with a correctly ratioed cache, then deliberately with `cache({ pixelRatio: 1 })`. The images must differ (this guards against a regression to default caching), and the correctly cached one must equal the export.
5. **Filter cache truncation.** At print, an image with neutral filters forced through the P-7 cache must equal the same image uncached, edge columns and rows included.
6. **No edge seam.** A full-bleed `#000000` rect on A4 (1x and print) and on the EU card (2x) gives `#000000` in every pixel of the last column and row (P-8).
7. **Filter cache limits.** A filtered image much larger than the page is cached only where the page shows it, and that crop changes no pixel (≤ 1 level at print); at ratio 16 the editor clamps the cache to the budget and the image stays visible; the export throws `CanvasLimitError` when even the crop does not fit.
8. **Text.** RTL text with letter spacing or justify reaches the canvas as one `fillText` per line with `direction = 'rtl'` (`text.test.ts`), and translucent text with overlapping lines or glyphs never exceeds the element's alpha.
9. **SVG raster.** A 24 × 24 two-tone SVG drawn at 600 × 600 has a crisp edge at 1x and print; resizing re-rasterizes (`resourcesOutdated`).

### 6.2 Browser e2e (Playwright, `/e2e`)

Open each fixture in the editor. Set zoom to 100% and wait for `window.__plakat.ready()`, a test hook that resolves after the readiness barrier and a draw.

1. `window.__plakat.snapshotContentLayer(pageId, s)` returns the editor's own `PageScene` for that page as PNG bytes through `rasterizePage`. Take it **at a zoom other than 100 % and with the page scrolled** in a multi-page document, then trigger the real **Download PNG** at 1x and 2x through the UI. Decode both and require a pixelmatch diff of 0 at threshold 0, plus equal dimensions.
2. Download JPG, PDF and multi-page ZIP, and assert the dimensions, page count and PDF page size and orientation in pt, including the YouTube thumbnail and both business cards (landscape).
3. Run in Chromium (required) and WebKit and Firefox (best effort).

**Implementation.** The specs are in `e2e/` and run with `npm run test:e2e`. That command builds the web app, and `playwright.config.ts` starts `e2e/server.mjs`: the real server serving `apps/web/dist` through `WEB_DIST`, with an in-memory PGlite database and a temporary upload directory. `parity.spec.ts` covers item 1 at devicePixelRatio 1 and 2. It opens the two-page café menu template at 37 % zoom, wheel-scrolls to page 2, and compares at 1x and 2x, checking both pixelmatch and raw RGBA bytes. `export-dimensions.spec.ts` covers item 2: PNG and JPG at every scale for the Instagram post, YouTube thumbnail and A4; PDF for YouTube and A4; and multi-page ZIP and PDF exports. `image-upload.spec.ts` repeats the parity check on an uploaded image after crop and filters. The suite currently runs in Chromium only.

The fixtures use real Google Fonts in this test, which is acceptable because the editor and the export run in the **same** browser.

## 7. Pitfalls

| Pitfall | Handling |
|---|---|
| **devicePixelRatio.** The on-screen stage renders at `zoom × dpr`, while export renders at `s`. | These are different rasterizations by design. Parity is defined at equal effective ratio (§6). The editor rounds pan offsets so the page origin lands on integer device pixels, which avoids half-pixel resampling on screen. |
| **`stage.toCanvas` on the editor stage** draws chrome and applies zoom, pan and frame offsets. | P-12: `rasterizePage` draws the root with `top = root`; zoom/pan never on the root. |
| **Konva truncation** (`floor`) of fractional bitmap sizes. | Use the P-9 recipe and assert the dimensions. Filter caches: P-7 padding. |
| **Fractional page sizes** (A4). | Content scale maps the page box exactly onto `W × H` (P-8); no edge seam. |
| **Font not ready** when a node is created, which leaves stale metrics or FOUT in an export. | Readiness barrier (§3.1), `display=block`, and **rebuild** text nodes after late loads (re-setting equal attributes does not re-measure). Export never runs before the barrier resolves. |
| **Unicode-range subsets** not loaded (latin-ext, Cyrillic, …). | `fontLoadRequests` passes the rendered characters to `load`/`check` (§3.1). |
| **Missing font variants** make css2 answer 400 for the whole family. | Catalogued families request only existing variants; per-variant retry otherwise (§3.1, schema §9). |
| **Equal-value updates** (no-op drag, clamped resize) keep live node attrs. | `update(doc, { dirty })` after every drag/transform (§2.2). |
| **Narrow text boxes** silently drop text in Konva. | Konva width ≥ widest grapheme (§3.3). |
| **Decoded size ≠ declared size** (renditions, EXIF, SVG). | Crops scaled by `computeImageLayout(el, asset, decoded)`; SVG rasterized at declared size × `svgRasterScale`; server bakes EXIF (§3.2). |
| **SVG rasterized at its (small) declared size** and blurry once enlarged. | §3.2: raster factor from how large the document draws it; `resourcesOutdated` after resizes. |
| **Filter cache over the canvas limits**: the image silently vanishes. | §3.5 cache size limits: crop to the page, clamp (editor) or `CanvasLimitError` (export). |
| **RTL text with letter spacing or justify** drawn per grapheme left to right (mirrored Hebrew, unshaped Arabic). | §3.3 bidi: explicit `direction`, native runs for RTL. |
| **Element opacity on text** applied per draw call (overlaps darker). | §3.3: isolated group for translucent text. |
| **jsPDF orientation and page limit.** | `pdfPageLayout`: explicit orientation, `userUnit` above 14 400 pt (§5). |
| **Text rendering differs across OSes and browsers.** | Irrelevant to parity: the editor and the export run in the same browser. Templates may reflow slightly between browsers, which is accepted; Plakat promises "what you see is what you export", not cross-machine identity. |
| **Filter cache at the wrong ratio**, which blurs images and changes blur strength. | P-7: pass `pixelRatio` explicitly and re-cache on ratio change. |
| **CSS vs function filters** take different code paths. | P-6: function filters only. |
| **Image smoothing.** | Leave Konva's defaults (`imageSmoothingEnabled: true`, browser-default quality) in **both** paths. Never set `imageSmoothingQuality` in only one path. Large downscales may alias, identically in both; mip-mapped pre-scaling, if added later, must be keyed by effective ratio and shared by both paths. |
| **CORS taint**: `toBlob` throws `SecurityError`. | P-4: `crossOrigin='anonymous'` is set before `src`, and third-party images are imported into the server's uploads first. Catch `SecurityError` and report the offending asset. |
| **Opacity on fill+stroke shapes.** Konva uses a buffer canvas (`_useBufferCanvas`). | Same code in both paths. Never set `perfectDrawEnabled: false` in only one path; leave it at its default everywhere. |
| **Canvas size limits** (Safari 16.7 MP). | `checkCanvasLimits` before allocating (§4). |
| **Memory** on multi-page print exports. | Process pages sequentially, destroy each stage, and call `Konva.Util.releaseCanvas`. |
| **Editor-only state leaking into content** (hover strokes, crop ghost, selection tint). | P-3: chrome layer only, enforced by the chrome-isolation test. |
| **Global `Konva.pixelRatio`.** | Never mutate it for exports. Pass `pixelRatio` explicitly to `SceneCanvas` (in `rasterizePage`) and `cache`. |

## 8. Decision index

| # | Decision |
|---|---|
| P-1 | One imperative scene builder shared by the editor and the export; no react-konva for content. |
| P-2 | The scene builder runs under Node for tests. |
| P-3 | Editor UI never mutates content nodes; chrome lives on its own layer. |
| P-4 | Images must be CORS-clean; third-party images are imported into the server's uploads (no proxy). |
| P-5 | Text vertical alignment is computed; text nodes never get a fixed height. |
| P-6 | Konva function filters only. |
| P-7 | Filter cache `pixelRatio` equals the effective output ratio, is always explicit, and is padded (`offset`) against truncation; caches over the canvas limits are cropped to the page, then clamped (editor) or refused (export). |
| P-8 | Page box mapped exactly onto `W × H` by `contentScaleX/Y`; canvases use the nominal `s`. |
| P-9 | One `rasterizePage` for editor and export: `SceneCanvas` of `(W + 0.5)/s`, `root.drawScene(canvas, root)`, exact dimensions asserted. |
| P-10 | PDF is a raster at print DPI; vector PDF is future work. |
| P-11 | Multi-page PNG/JPG export as a STORE ZIP written in-repo. |
| P-12 | Page roots stay at the origin; zoom/pan on the stage, offsets on page frames; raster in root-local space. |
| P-13 | One canonical Google Fonts stylesheet per family (all catalogued variants), loaded once per page through `loadFontStylesheet`, font-picker previews included. |
