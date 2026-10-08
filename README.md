# Plakat

Plakat is an open-source, self-hostable design editor in the style of Canva, built around templates. It uses React, Konva, Zustand, Fastify and Postgres. The editor and the PNG/JPG/PDF export share one renderer, so an export matches the editor pixel for pixel. This is checked in CI ([docs/render-export-pipeline.md](docs/render-export-pipeline.md) §6).

## Quick start

Requirements: Node ≥ 22.

```sh
npm install
npm run dev        # API server on :8787 (embedded PGlite, data in ./data) + Vite on :5173
```

Open http://localhost:5173. Without `DATABASE_URL` the server uses embedded PGlite, so no database setup is needed. Copy `.env.example` to `.env` for the other options, such as Postgres, the storage directories and Openverse credentials.

Production (single process, serves the built SPA):

```sh
npm run build
WEB_DIST=apps/web/dist DATABASE_URL=postgres://… npm start
```

A `Dockerfile` and a `docker-compose.yml` (Plakat with Postgres) are included.

## Repository layout

| Path | What |
|---|---|
| `packages/schema` | `@plakat/schema`: the document format, validation, migrations, templates and units ([docs/document-schema.md](docs/document-schema.md)) |
| `packages/renderer` | `@plakat/renderer`: the Konva scene builder shared by the editor and the export, plus PNG/JPG/PDF/ZIP output |
| `apps/server` | Fastify REST API: projects, templates, brand kits, uploads and asset providers. Uses Postgres or PGlite |
| `apps/web` | The React editor: store, canvas workspace, panels and export dialog |
| `templates` | Built-in `.plakat.json` templates, loaded by the server at startup ([docs/templates.md](docs/templates.md)) |
| `e2e` | Playwright end-to-end tests |

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Server and web dev server together (`scripts/dev.mjs`) |
| `npm run build` | Production build of the web app (`apps/web/dist`) |
| `npm run typecheck` | Typechecks every project: schema, renderer, server, web, templates and e2e |
| `npm test` | Every unit test suite (vitest projects; jsdom for the web app) |
| `npm run test:e2e` | Builds, then runs the Playwright specs against the real server on port 8791 |
| `npm run templates:build` / `templates:check` | Regenerate the built-in templates, or check that they are up to date |
