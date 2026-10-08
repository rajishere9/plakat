# Plakat

**Plakat is an open-source, self-hostable design editor in the style of Canva, built around templates.** Start from a template or a blank page, edit it in the browser and download a PNG, JPG or PDF. Your designs, uploads and templates stay on your own server.

The editor and the exporter draw pages with the same renderer, so a downloaded file matches what you see in the editor pixel for pixel. Tests check this in Node and in a real browser.

![The Plakat editor: a product-launch template with the headline selected, the layers panel on the left and text properties on the right](docs/media/editor.png)

> **Status:** early (0.1). The editor, the export and the document format are complete enough to use, and they are covered by unit and browser tests. There are no user accounts yet, so read [Security](#security) before you put Plakat on a network.

## Contents

- [Features](#features)
- [See it in action](#see-it-in-action)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Security](#security)
- [Architecture](#architecture)
- [Document format](#document-format)
- [Export](#export)
- [Stock photos (asset providers)](#stock-photos-asset-providers)
- [Templates](#templates)
- [Development and tests](#development-and-tests)
- [Non-goals](#non-goals)
- [Roadmap](#roadmap)
- [License](#license)

## Features

**Designs and pages**
- Presets for Instagram post and story, YouTube thumbnail, A4 poster, and US (3.5 × 2 in) and EU (85 × 55 mm) business cards, plus custom sizes in px, mm or in.
- Designs with several pages: add, duplicate, rename and reorder pages, and set a background color or image on each.
- Autosave to the server. If the same design is saved from two tabs, Plakat asks which version to keep instead of overwriting one.

**Editing**
- Text, shapes (rectangle, rounded rectangle, circle, triangle, polygons, stars, lines) and images.
- Inline text editing on the canvas, more than 50 catalogued Google Fonts with only the weights each family really has, and per-element line height, letter spacing, alignment, letter case and color.
- Move, resize and rotate, with snapping guides to the page and to other elements. Align and distribute, groups, lock and hide, and a layers panel with drag-to-reorder.
- Undo and redo, copy and paste (also between tabs, and plain text from other apps), and keyboard shortcuts for most actions (press `?` in the editor to see them).

**Images**
- Upload PNG, JPEG, WebP, GIF or SVG (up to 25 MB), or search openly licensed photos from Openverse.
- Crop on the canvas, fill/fit/stretch, flip, corner radius, brightness, contrast, saturation, blur, grayscale, sepia and invert.
- Attribution and license data from providers stays with the image.

**Templates and brand kits**
- Built-in starter templates. "Use template" opens a form built from the template's slots (text with length limits, images, colors) with a live preview, or you can use the template as is.
- Turn any design into a template: mark its texts, images and colors as slots, then save it to the gallery or download it as a file.
- Brand kits with colors, fonts per role (heading, subheading, body, accent) and logos, shown in the editor's pickers.

**Files**
- Download PNG, JPG or PDF at 1x, 2x or print size (300 dpi). Several pages download as a ZIP (PNG/JPG) or as one multi-page PDF.
- Download any design or template as a portable `.plakat.json` file with its images embedded, and import it on any other Plakat server.

## See it in action

**Start from a template:** pick a template, edit the headline on the canvas, then change its font and color.

![Starting from the Product launch template: the headline is edited inline, then switched to Abril Fatface and coral](docs/media/create-from-template.gif)

**Edit:** add shapes and text, drag them with snapping guides, reorder layers, then undo and redo.

![Adding a circle, a rectangle and a heading, dragging them to the page's center line, moving the circle to the top in the layers panel, then undoing and redoing](docs/media/editing.gif)

**Images:** upload a photo, crop it on the canvas and apply filters.

![Uploading a landscape photo, enlarging it, cropping it to the sun and raising contrast and saturation, then trying sepia](docs/media/image-crop-filters.gif)

**Export:** the download dialog shows the exact pixel size before you export.

![The download dialog for an A4 poster: PNG at 1x is 794 × 1123 px, 2x is 1587 × 2245 px, print is 2480 × 3508 px at 300 dpi, then a PDF at print size](docs/media/export.gif)

These recordings come from the real app. `scripts/record-demos.mjs` regenerates them (see [CONTRIBUTING.md](CONTRIBUTING.md#regenerating-the-readme-media)).

## Quick start

### Docker Compose (Plakat with PostgreSQL)

```sh
git clone <this repository> plakat && cd plakat
cp .env.example .env          # optional: set POSTGRES_PASSWORD, PUBLIC_URL, BASIC_AUTH, …
docker compose up -d --build
```

Then open http://localhost:8787. Compose starts PostgreSQL 17 and a single Plakat container that serves both the API and the editor. Designs live in the `pgdata` volume, and uploads in `plakat-data`.

By default compose publishes the port on **all** host interfaces. Set `PLAKAT_BIND=127.0.0.1` in `.env` to keep it on your own machine, and read [Security](#security) before exposing it.

You can also run the image alone with the embedded database: `docker build -t plakat . && docker run -p 127.0.0.1:8787:8787 -v plakat-data:/data plakat`.

> The `Dockerfile` and `docker-compose.yml` are new. They have been reviewed, and the CI workflow builds the image on every push, but they have not been run in production yet. Please open an issue if something does not work.

### Local development (no database to install)

Requirements: Node.js 22 or newer.

```sh
npm ci
npm run dev
```

Open http://localhost:5173. `npm run dev` starts the API server on port 8787 and the Vite dev server on 5173, which proxies `/api` and `/uploads` to the API. Without `DATABASE_URL` the server uses an embedded PGlite database (Postgres compiled to WebAssembly) and keeps everything in `./data`, so there is nothing else to set up. To use a real PostgreSQL instead, set `DATABASE_URL` in `.env`.

### Production without Docker

```sh
npm ci
npm run build                                   # builds the editor into apps/web/dist
WEB_DIST=apps/web/dist DATABASE_URL=postgres://user:pass@host:5432/plakat \
  node --import tsx apps/server/src/index.ts    # run from the repository root
```

The server runs its database migrations at startup and serves the built editor with a fallback to `index.html`. Run it from the repository root so that relative paths (`WEB_DIST`, `DATA_DIR`) resolve there. (`npm start` also works, but it runs inside `apps/server`, so relative paths resolve against that directory.)

More detail on proxies, backups and upgrades: [docs/self-hosting.md](docs/self-hosting.md).

## Configuration

The server reads environment variables, plus an optional `.env` file in the working directory or the repository root. Variables already set in the environment win over `.env`. [`.env.example`](.env.example) documents every option, and [`apps/server/src/config.ts`](apps/server/src/config.ts) is the source of truth.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8787` | HTTP port. |
| `HOST` | `127.0.0.1` | Interface to listen on. The default accepts local connections only. The Docker image sets `0.0.0.0`. |
| `PUBLIC_URL` | – | Public base URL, e.g. `https://plakat.example.com`. Its host name is accepted in the `Host` header and its origin may send write requests. Logged at startup. |
| `ALLOWED_HOSTS` | – | Extra host names accepted in the `Host` header, comma separated. A leading dot matches subdomains (`.example.com`), and `*` turns the check off. See [Security](#security). |
| `BASIC_AUTH` | – | `user:password` turns on HTTP Basic authentication for everything except `/api/health`. |
| `CORS_ORIGIN` | – | Comma-separated origins allowed through CORS (and allowed to send write requests). Leave empty when the server serves the editor itself or Vite proxies it. |
| `MAX_BODY_MB` | `40` | Maximum JSON request body in MiB (documents, template imports, brand kits). |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. |
| `DATABASE_URL` | – | PostgreSQL connection string. When unset, the server uses embedded PGlite. |
| `PGLITE` | `$DATA_DIR/pglite` | Only without `DATABASE_URL`: a directory for the PGlite files, or `memory` for a throwaway database. |
| `DATA_DIR` | `./data` | Root for local state. Relative paths resolve against the working directory. |
| `UPLOAD_DIR` | `$DATA_DIR/uploads` | Uploaded and imported images, stored as `<sha256>.<ext>`. |
| `TEMPLATES_DIR` | `<repo>/templates` | Scanned for built-in `*.plakat.json` templates at startup. |
| `WEB_DIST` | – | Built editor (`apps/web/dist`) to serve. Leave unset in development, where Vite serves the editor. |
| `OPENVERSE_CLIENT_ID`, `OPENVERSE_CLIENT_SECRET` | – | Optional Openverse API credentials for higher rate limits. Openverse works without them. |
| `OPENVERSE_API_URL` | `https://api.openverse.org` | Openverse API base (for mirrors and testing). |

Used only by `docker compose`: `POSTGRES_PASSWORD` (default `plakat`, must be URL-safe), `PLAKAT_BIND` (published interface, default `0.0.0.0`) and `PLAKAT_PORT` (published port, default `8787`). Compose sets `PORT`, `HOST`, `DATABASE_URL`, `DATA_DIR` and `UPLOAD_DIR` inside the container itself.

Used only in development: `PLAKAT_API_URL` (where the Vite dev server proxies the API, default `http://localhost:8787`). The e2e variables are listed in [CONTRIBUTING.md](CONTRIBUTING.md#running-the-tests).

Fixed limits: uploads and provider downloads are capped at 25 MiB, thumbnails at 2 MiB, and a document can hold at most 1000 assets.

## Security

Plakat 0.1 **has no user accounts**. Anyone who can reach the server can read, change and delete every design, template, brand kit and upload. The defaults are chosen for that:

- **The server binds to `127.0.0.1` by default**, so only your own machine can reach it. Set `HOST=0.0.0.0` (the Docker image does) only on a network you trust, or behind a proxy.
- **To share an instance, put it behind an authenticating reverse proxy** (for example oauth2-proxy, Authelia, or your SSO). For a small team, `BASIC_AUTH=user:password` adds a single shared login; use HTTPS whenever that password crosses a network.
- **Host names are checked** to block DNS-rebinding attacks. The server accepts IP addresses, `localhost`, single-label names (`nas`) and names ending in `.local`, `.localhost`, `.internal` or `.home.arpa`. Any other name, such as `plakat.example.com`, needs `PUBLIC_URL` or `ALLOWED_HOSTS`, otherwise requests get `403 host_not_allowed`.
- **Cross-site writes are refused.** Write requests from a foreign `Origin` get `403 cross_origin_request`. Requests without browser headers (curl, scripts) are allowed.
- The server sends `X-Frame-Options: SAMEORIGIN`, `nosniff` and a `Content-Security-Policy` on the editor's HTML, and serves uploaded SVGs in a sandbox.
- Images referenced by URL are downloaded into the server's uploads when a design is saved or imported. The downloader refuses private and loopback addresses (SSRF guard), checks the file type, and handles at most 50 new URLs per request.

The editor loads fonts from Google Fonts (`fonts.googleapis.com` and `fonts.gstatic.com`), and the Photos panel shows thumbnails straight from the provider. Both send requests from your users' browsers to those services.

## Architecture

```
packages/schema     @plakat/schema    document types, validation, migrations, units, templates, fonts catalog
packages/renderer   @plakat/renderer  PageScene (the Konva scene builder) + PNG / JPG / PDF / ZIP export
apps/web            @plakat/web       React 19 editor (Vite, Zustand + immer, Konva)
apps/server         @plakat/server    Fastify 5 REST API, PostgreSQL via pg or embedded PGlite
templates/                            built-in .plakat.json templates and their generator
e2e/                                  Playwright tests against the real server and the built editor
```

**One scene builder for the editor and the export.** `PageScene` in `@plakat/renderer` is the only code that turns document elements into Konva nodes. The editor draws its content layer with it, and every export builds a fresh `PageScene` at the export scale and rasterizes it with the same function. Selection, guides and hover outlines live on a separate layer that the export never sees. Because there is only one mapping, an export is byte-identical (RGBA, before encoding) to the editor's own page at the same scale. Unit tests check this under Node with `node-canvas`, and the Playwright suite checks it in Chromium against the downloaded files. The design and the rules that keep this true are in [docs/render-export-pipeline.md](docs/render-export-pipeline.md).

Other choices:
- The editor state is a single Zustand store with immer. Every user action is one undo step, and autosave sends the canonical document JSON to the server.
- The server validates every document with `@plakat/schema` before storing it (`loadDocument` is the only way in), stores uploads by content hash, and seeds the built-in templates from `templates/` at startup.
- PostgreSQL is the production database. PGlite runs the same SQL for zero-config local use and for the server's tests.

## Document format

A Plakat design is plain JSON (`format: "plakat.document"`, `schemaVersion: 1`):

```jsonc
{
  "format": "plakat.document",
  "schemaVersion": 1,
  "kind": "design",                         // or "template"
  "id": "doc_V1StGXR8Z5jd",
  "meta": { "title": "Summer sale", "tags": [] },
  "size": { "width": 1080, "height": 1080, "presetId": "instagram-post", "physical": null },
  "pages": [{ "id": "pg_…", "name": "", "background": { "color": "#ffffff", "image": null }, "elements": [ /* text, shape, image */ ] }],
  "assets": { "as_…": { "type": "image", "mimeType": "image/jpeg", "src": "data:…", "width": 1600, "height": 1067 } },
  "fonts": [{ "family": "Inter", "source": "google", "variants": [{ "weight": 700, "style": "normal" }] }],
  "template": null                          // slots, category and fill rules for kind = "template"
}
```

- All lengths are CSS px at 96 px/in. Print sizes also keep their physical size in mm or in.
- Parsing is strict: unknown keys are rejected, and every change to the format bumps `schemaVersion` with a migration, so old files keep opening. Files from a newer version are refused with an "upgrade Plakat" message instead of being guessed at.
- A `.plakat.json` file is the same JSON with every image embedded as a `data:` URI. It opens on any Plakat server and needs only Google Fonts.

The full specification: [docs/document-schema.md](docs/document-schema.md).

## Export

| Size | Scale | Example: A4 poster (210 × 297 mm) |
|---|---|---|
| 1x | document px | 794 × 1123 px |
| 2x | 2 × | 1587 × 2245 px |
| Print | 300 dpi (3.125 ×) | 2480 × 3508 px |

- **PNG** keeps transparency. **JPG** is flattened onto white (quality 0.92). Several pages download as a ZIP.
- **PDF is a raster:** each page is one lossless image at the chosen scale (300 dpi by default) on a page of the right physical size (A4 is 595.28 × 841.89 pt). Text in the PDF is not selectable. Vector PDF is on the [roadmap](#roadmap).
- Pixel sizes follow one rounding rule (`exportPixelSize` in `@plakat/schema`), and the dialog shows them before you download. Very large exports that exceed the browser's canvas limits (for example an Instagram story at print size in Safari) fail with a clear message instead of producing a broken file.

Details: [docs/render-export-pipeline.md](docs/render-export-pipeline.md) §4–5.

## Stock photos (asset providers)

The Photos panel searches pluggable **asset providers**. [Openverse](https://openverse.org) is built in and works without a key: it indexes openly licensed images (Creative Commons and public domain). Set `OPENVERSE_CLIENT_ID` and `OPENVERSE_CLIENT_SECRET` for higher rate limits.

When a user picks a photo, the server resolves the item and downloads the image into its own uploads, so the editor only draws same-origin images. The browser never asks the server to fetch an arbitrary URL. The title, author, license and source page are stored with the image. Check each image's license before you publish: some forbid commercial use or modification, and most require attribution.

To add a provider (for example Unsplash with your own key), implement the small `AssetProvider` interface on the server: see [docs/asset-providers.md](docs/asset-providers.md).

## Templates

The built-in library covers every preset: Instagram posts (quote card, product launch), an Instagram story (event announcement), YouTube thumbnails, A4 posters (concert poster, two-page café menu) and US and EU business cards with front and back. They are ordinary `.plakat.json` files in [`templates/`](templates), loaded by the server at startup.

New templates are welcome. Design one in the editor and download it as a template file, or build it in code with the generator. [docs/templates.md](docs/templates.md) explains both paths, the slot, asset and licensing rules, and the PR checklist; [CONTRIBUTING.md](CONTRIBUTING.md#adding-a-template) has a summary.

## Development and tests

```sh
npm run dev            # API server (tsx watch, PGlite) + Vite dev server
npm run typecheck      # tsc for schema, renderer, server, web, templates and e2e
npm test               # all unit tests (vitest: node for schema/renderer/server/templates, jsdom for the web app)
npm run build          # production build of the editor
npm run test:e2e       # builds, then runs the Playwright specs in Chromium against the real server
npm run templates:check  # fails if a generated template is out of date
```

Run `npx playwright install chromium` once before the e2e suite. The server's tests use in-memory PGlite, and the PostgreSQL code path is also tested through the real `pg` driver against PGlite over a socket, so no database or Docker is needed for any test.

Setup details, conventions and the rules for schema changes: [CONTRIBUTING.md](CONTRIBUTING.md).

## Non-goals

For V1, Plakat deliberately does **not** do these:

- Real-time collaboration or comments.
- User accounts, teams or permissions (use a reverse proxy for access control).
- Video, animation, or GIF export.
- Vector or editable PDF, and print features such as bleed, crop marks or CMYK.
- System fonts or font uploads (Google Fonts only, so a design looks the same everywhere).
- A general-purpose vector illustration tool (pen tool, boolean operations).

## Roadmap

Ideas for after 0.1, roughly in order. None of them is promised.

- Vector PDF export with selectable text (it needs a second renderer, so it must come with its own parity tests).
- More asset providers (Unsplash, Pexels, Wikimedia Commons) and a way to enable them from configuration.
- Accounts and per-user ownership, then sharing.
- More templates and categories, contributed by the community.
- Custom font uploads and offline font bundles.
- Bleed and crop marks for print.
- Real-time collaboration, later.

## License

[MIT](LICENSE) © 2026 Plakat contributors.

Built-in template artwork is CC0 (see [docs/templates.md](docs/templates.md#asset-rules)). Photos found through Openverse or other providers keep their own licenses.
