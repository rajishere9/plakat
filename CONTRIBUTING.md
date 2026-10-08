# Contributing to Plakat

Thanks for helping. This guide covers the development setup, the rules that keep the editor and the export in sync, and the step-by-step paths for the most common contributions: templates, asset providers and fonts.

- [Development setup](#development-setup)
- [Repository layout](#repository-layout)
- [Coding conventions](#coding-conventions)
- [Running the tests](#running-the-tests)
- [Changing the document format](#changing-the-document-format)
- [Adding a template](#adding-a-template)
- [Adding an asset provider](#adding-an-asset-provider)
- [Adding a font to the catalog](#adding-a-font-to-the-catalog)
- [Regenerating the README media](#regenerating-the-readme-media)
- [Commits and pull requests](#commits-and-pull-requests)

## Development setup

Requirements: **Node.js 22+** and npm. Nothing else: no database and no Docker.

```sh
npm ci
npm run dev
```

- `npm run dev` (`scripts/dev.mjs`) starts the API server with `tsx watch` on port 8787 and the Vite dev server on http://localhost:5173. Vite proxies `/api` and `/uploads` to the server.
- Without `DATABASE_URL` the server uses embedded **PGlite** and keeps its data in `./data` (git-ignored). Delete that folder to start over.
- To work against PostgreSQL, put `DATABASE_URL=postgres://…` in `.env` (copy [`.env.example`](.env.example)). The server applies migrations at startup.
- Fonts come from Google Fonts and Openverse search needs the internet; everything else works offline.

The renderer's tests use [`canvas`](https://github.com/Automattic/node-canvas) (node-canvas). `npm ci` downloads a prebuilt binary for common platforms; if that fails, install the system libraries listed in its README (Cairo, Pango, libjpeg, giflib, librsvg).

## Repository layout

| Path | What lives there |
|---|---|
| `packages/schema` | `@plakat/schema`: document types (`types.ts`), zod validation (`validation.ts`), migrations (`version.ts`), units and presets, template and brand-kit helpers, the Google Fonts catalog. No DOM, no Node APIs. |
| `packages/renderer` | `@plakat/renderer`: `PageScene` (the only document → Konva mapping), resource loading and the readiness barrier, `rasterizePage`, and PNG/JPG/PDF/ZIP export. Browser and Node environments (`env-browser`, `env-node`). |
| `apps/web` | The editor: React 19, Vite, a Zustand + immer store (`src/store`), the canvas controller (`src/canvas`), panels, dialogs and export. |
| `apps/server` | Fastify 5 API: projects, templates, brand kits, uploads, thumbnails and asset providers (`src/assets`). PostgreSQL via `pg`, or PGlite. |
| `templates` | Built-in `.plakat.json` templates, their generator and preview scripts, and the template test suite. |
| `e2e` | Playwright specs that run the built editor against the real server (`e2e/server.mjs`). |
| `scripts` | `dev.mjs`, `typecheck.mjs` and `record-demos.mjs` (README media). |
| `docs` | The specifications: [document-schema.md](docs/document-schema.md), [render-export-pipeline.md](docs/render-export-pipeline.md), [templates.md](docs/templates.md), [asset-providers.md](docs/asset-providers.md), [self-hosting.md](docs/self-hosting.md). |

The workspaces consume each other's TypeScript sources directly (`.ts` imports, nothing is compiled), so a change in `@plakat/schema` is picked up by the editor and the server right away.

## Coding conventions

- **TypeScript in strict mode** everywhere (`tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`). Import local files with their `.ts`/`.tsx` extension and use `import type` for types. `npm run typecheck` must pass.
- **Tests sit beside the code** as `*.test.ts` / `*.test.tsx`. A bug fix comes with a test that fails without the fix.
- **Style:** 2-space indent, single quotes, semicolons, trailing commas, lines up to about 160 characters. Match the file you are editing. There is no formatter in the toolchain, so keep diffs free of unrelated reformatting.
- **Comments explain why**, especially for anything that affects parity, security or the file format. Doc comments on exported functions.
- **No new runtime dependency** without discussing it in an issue first. Plakat prefers small in-repo code (the ZIP writer is about 100 lines) over another package.
- **User-facing text** is sentence case and plain ("Download", "Use as is"). Errors say what happened and what to do.
- **Accessibility:** controls need an accessible name (the e2e tests select by role and name), dialogs trap focus, and everything must work from the keyboard.

### The parity rule

An exported file must match the editor's canvas pixel for pixel ([render-export-pipeline.md](docs/render-export-pipeline.md)). That holds only while these rules hold:

- **Document content is drawn only by `PageScene` from `@plakat/renderer`.** Never draw elements another way in the editor (no react-konva for content, no ad-hoc Konva nodes for text, shapes or images on the content layer). New element features go into `PageScene`, so the editor and the export get them together.
- **Never export with `stage.toCanvas()`, `stage.toDataURL()` or `layer.toCanvas()` on the editor's stage.** Exports and snapshots go through `rasterizePage` / `exportPage`, which draw the page root in page-local space at the exact pixel size.
- Editor-only visuals (selection, handles, snapping guides, hover, crop UI, page labels) live on the separate chrome layer and must never be added to a `PageScene` root.
- Anything that changes how pixels are produced (caching, filters, text layout, rounding) must behave identically in the editor and the export. Add or extend a parity test: `packages/renderer/src/parity.test.ts` in Node, `e2e/parity.spec.ts` in the browser.

## Running the tests

| Command | What it runs |
|---|---|
| `npm run typecheck` | `tsc --noEmit` for schema, renderer, server, web, templates and e2e, in parallel. |
| `npm test` | Every unit suite through vitest projects: schema, renderer and server (Node), web (jsdom) and templates. |
| `npx vitest run --project server` | One project: `schema`, `renderer`, `server`, `web` or `templates`. `npx vitest run <path>` filters by file path. |
| `npx vitest run templates/` | The template suite only (keep the trailing slash). |
| `npm run build` | Production build of the editor into `apps/web/dist`. |
| `npm run test:e2e` | Builds the editor, starts `e2e/server.mjs` (real server, in-memory PGlite, temporary uploads) and runs the Playwright specs in Chromium. |
| `npm run templates:check` | Fails if a generated template file is out of date. |

The server tests use in-memory PGlite. `apps/server/src/db/pg.test.ts` also runs the production `pg` code path against PGlite over a socket (`@electric-sql/pglite-socket`), so PostgreSQL-specific behavior is tested without a database server. Tests never touch the network: `createTestApp` injects an offline `fetch` and a fake DNS resolver.

Before the first e2e run, install the browser: `npx playwright install chromium` (on Linux add `--with-deps`). Useful variables:

| Variable | Effect |
|---|---|
| `PLAKAT_E2E_PORT` | Port for the e2e server (default 8791). Use a different one if you run several suites at once. |
| `PLAKAT_E2E_BUILD=1` | Rebuild `apps/web/dist` even if it exists (e2e/server.mjs only builds when it is missing). |
| `PLAKAT_E2E_CHROMIUM` | Path to a Chromium binary to use instead of Playwright's. |
| `PLAKAT_E2E_TRACE=1` | Keep Playwright traces for failed tests. |
| `PLAKAT_E2E_DEBUG=<dir>` | Log and save the two images when a pixel comparison fails. |

## Changing the document format

The document format is a public contract: files people downloaded must keep opening. Any change to what is persisted (a new field, a new enum value, a changed default or limit) follows [document-schema.md §11](docs/document-schema.md#11-versioning-and-migration):

1. **Bump `CURRENT_SCHEMA_VERSION`** (`packages/schema/src/version.ts`). There are no minor versions; additions bump it too.
2. **Add a migration** `N-1 → N` to `MIGRATIONS`: a pure function on untyped JSON that does not mutate its input and uses no clock or randomness. Never edit or delete a released migration.
3. **Update `types.ts` and `validation.ts` together.** Compile-time drift guards fail the build if they disagree.
4. **Add tests:** a fixture file at the previous version that loads through `loadDocument`, plus tests for the migration itself. Keep every older fixture.
5. **Update `docs/document-schema.md`** (and the pipeline doc if rendering changes) in the same PR, with a decision note (**D-n**) for anything non-obvious.
6. Run `npm run templates:build` if the change affects the canonical output of the built-in templates, and check the server still loads stored rows (it migrates on read).

Open an issue before starting a format change; they are hard to undo.

## Adding a template

Templates are the easiest way to contribute. The full guide is [docs/templates.md](docs/templates.md); this is the summary.

**Where:** `templates/<category>/<slug>.plakat.json`, one directory deep, kebab-case, with `template.category` equal to the directory name. Reuse an existing category (`instagram-post`, `instagram-story`, `youtube-thumbnail`, `poster`, `business-card`) unless the format is genuinely new. The document `id` is the template's identity on every server: once released, never change it.

**Two ways to make one:**

- **In the editor (path A).** Design it, then **Share → Save as template**: choose the slots, label them, set `maxLength` on text slots and set the category. Use **Download template file** to get a portable `.plakat.json` with images embedded, save it under `templates/`, and fill in each asset's `source` (license and author). Uploaded images arrive without a license, and the tests reject that.
- **In code (path B).** Add a `defineTemplate({ … })` block to `templates/scripts/build-templates.ts` and run `npm run templates:build`. The generator is reproducible byte for byte, so a template built this way stays easy to change.

**Slots** drive the "Use template" fill form. Make a slot of every text a user would always change, every photo or logo, and the one or two colors that define the look. Labels are short and in sentence case ("Event name"), ordered from most to least important, with colors last. Always set `maxLength`, and choose it with the stress preview so the longest allowed text still fits. Mark only the essential fields `required`.

**Assets and licensing:** images are embedded `data:` URIs, about 60 KB each at most (80 KB hard limit), and **your own work or CC0 only**. No CC BY / BY-SA, no "free for commercial use" stock, no AI output of unclear origin, and no real people, brands or logos. Record provenance in `asset.source`. The procedural placeholders in `templates/assets/` are CC0 and free to reuse.

**Fonts:** only families and weights listed in the catalog (see [below](#adding-a-font-to-the-catalog)).

**Check it:**

```sh
npx tsx templates/scripts/preview-templates.ts --stress <slug>   # renders PNGs, also with max-length text
npx vitest run templates/
npm run templates:check                                          # if you used the generator
```

**PR checklist** (also in the "New template" pull request template):

- [ ] File at `templates/<category>/<slug>.plakat.json` with a stable, unique `id`
- [ ] Title, one-sentence description and tags; `template.category` equals the directory
- [ ] Slots: labels, order, `maxLength` on every text slot, sensible `required`, color palettes
- [ ] `--stress` preview checked by eye, PNGs attached to the PR
- [ ] Only catalogued fonts and weights
- [ ] Images embedded, ≤ ~60 KB each, own work or CC0, with `source` filled in
- [ ] No real people, brands or trademarks in placeholder content
- [ ] `npx vitest run templates/` passes (and `npm run templates:check` for generated templates)

## Adding an asset provider

Asset providers are the stock-photo sources in the Photos panel. A provider is a class on the server that implements `AssetProvider` (`apps/server/src/assets/provider.ts`): `search()` returns items, and `getDownload()` resolves an item id to an image URL and its attribution. The server downloads the image itself, with SSRF guards, so the client never supplies a URL. The editor needs no change: it lists whatever `GET /api/asset-providers` returns.

[docs/asset-providers.md](docs/asset-providers.md) describes the interface and walks through adding Unsplash, including the configuration, the tests with a mocked `fetch`, and the provider's attribution and API terms. Read the provider's API terms before you open the PR: some require hotlinking, download tracking or a specific attribution format.

## Adding a font to the catalog

Plakat uses Google Fonts only, and the editor offers the families in `GOOGLE_FONTS_CATALOG` (`packages/schema/src/font-catalog.ts`). The catalog records which weights and italics each family **really** has, because Google's css2 API rejects a whole request if one variant does not exist.

1. Look the family up on [fonts.google.com](https://fonts.google.com) and note its category and every upright and italic weight.
2. Add one line in the right category block, for example:
   ```ts
   font('Space Grotesk', 'sans-serif', range(300, 700), []),   // upright 300–700, no italics
   font('Lora', 'serif', range(400, 700)),                      // italics = same weights
   ```
3. Run `npx vitest run packages/schema`. If you can, check the css2 URL that `googleFontsCssUrl()` builds for the family returns 200 for every listed weight.
4. Keep the PR to the catalog only (it touches `@plakat/schema`). Templates may use the family once it has landed.

Families that are not in the catalog can still be typed into the font picker; the catalog is about offering correct choices, not about allowing them.

## Regenerating the README media

The GIFs and the screenshot in `docs/media/` are recorded from the real app by [`scripts/record-demos.mjs`](scripts/record-demos.mjs). Re-record them when the UI changes visibly.

```sh
npm run build                                   # the recorder serves apps/web/dist
node scripts/record-demos.mjs                   # all four GIFs and editor.png
node scripts/record-demos.mjs --only image      # one: create, editing, image, export or hero
```

The script starts its own throwaway server (`e2e/server.mjs`, in-memory database) on a free port, drives each demo with Playwright at 1280 × 800 with a drawn mouse pointer and human pacing, and converts the video with ffmpeg (two-pass palette, about 12 fps, 960 px wide). If a GIF is over 4 MB it is re-encoded at a lower frame rate and width. It needs the Playwright Chromium browser, `ffmpeg` on `PATH`, and network access for Google Fonts. The test photo is drawn by the script itself, so no third-party image is involved. Look at the result before committing (for example extract a few frames with `ffmpeg -ss <seconds> -i docs/media/editing.gif -frames:v 1 frame.png`).

## Commits and pull requests

- **Branches** off `main`; one topic per PR. Large features start with an issue so the design can be agreed first.
- **Commit messages:** imperative mood, with a short scope prefix when it helps: `renderer: cache filtered images per page size`, `templates: add wedding invitation`, `docs: explain BASIC_AUTH`. Explain *why* in the body when it is not obvious.
- **Before you push:** `npm run typecheck && npm test`, and `npm run test:e2e` when you touched the editor, the renderer or the server API. CI runs all of them, plus the production build and a Docker image build.
- **PR description:** what changed, why, and how you tested it. Add screenshots or a short recording for UI changes, and the preview PNGs for templates.
- **Docs travel with code:** a change to the format, the export or the API updates the matching file in `docs/` in the same PR.
- Be kind in reviews. By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
