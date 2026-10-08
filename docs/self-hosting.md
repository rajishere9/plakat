# Self-hosting Plakat

This guide covers running Plakat for yourself or a team: the deployment options, putting it behind a reverse proxy, access control, backups and upgrades. The [README](../README.md#configuration) lists every configuration variable.

> Plakat 0.1 has **no user accounts**. Anyone who can reach the server can read, change and delete everything on it. Keep it on a trusted network or put authentication in front of it (see [Access control](#access-control)).

## What runs

One Node.js process (Fastify) serves the API and the built editor. State lives in two places:

| State | With PostgreSQL | With embedded PGlite |
|---|---|---|
| Designs, templates, brand kits, upload metadata | the PostgreSQL database | `$DATA_DIR/pglite` (or `PGLITE`) |
| Uploaded and imported images | `UPLOAD_DIR` (default `$DATA_DIR/uploads`) | same |

Built-in templates are read from `TEMPLATES_DIR` at every start and upserted into the database, so they update with the code.

The editor in your users' browsers also talks to **Google Fonts** (all text is set in Google Fonts) and shows Photos-panel thumbnails directly from the provider (Openverse by default).

## Deployment options

### Docker Compose (recommended)

```sh
cp .env.example .env     # set POSTGRES_PASSWORD, and PUBLIC_URL / BASIC_AUTH as needed
docker compose up -d --build
docker compose logs -f app
```

Compose runs `postgres:17-alpine` and the Plakat image. Volumes: `pgdata` (database) and `plakat-data` (uploads). The app's health check calls `GET /api/health`.

- `PLAKAT_BIND` and `PLAKAT_PORT` choose where the port is published on the host. The default `0.0.0.0:8787` is reachable from your network; use `PLAKAT_BIND=127.0.0.1` when a reverse proxy on the same host is the only client.
- `.env` is used only to fill `${…}` placeholders in `docker-compose.yml`. A variable reaches the container only if it is listed under `app.environment`; the forwarded ones are `PUBLIC_URL`, `ALLOWED_HOSTS`, `BASIC_AUTH`, `CORS_ORIGIN`, `MAX_BODY_MB`, `LOG_LEVEL` and the `OPENVERSE_*` variables.
- `POSTGRES_PASSWORD` is embedded in `DATABASE_URL`, so keep it URL-safe (letters, digits, `-`, `_`, `.`, `~`) or percent-encode it.

The Docker files have been reviewed and CI builds the image, but they have not seen production use yet. Please report problems.

### Single container with PGlite

For one person or a small group, the embedded database is enough:

```sh
docker build -t plakat .
docker run -d --name plakat -p 127.0.0.1:8787:8787 -v plakat-data:/data plakat
```

Everything (database and uploads) is in the `/data` volume.

### Plain Node.js

```sh
npm ci
npm run build
export WEB_DIST=apps/web/dist DATABASE_URL=postgres://plakat:secret@localhost:5432/plakat
node --import tsx apps/server/src/index.ts
```

Run it from the repository root, under a process manager (systemd, pm2, …) that restarts it. It handles `SIGTERM` and `SIGINT` by closing the server and the database cleanly. The server binds to `127.0.0.1` unless you set `HOST`.

## Reverse proxy and HTTPS

Put a reverse proxy in front for TLS. Set `PUBLIC_URL` to the public address, so the host name is accepted (DNS-rebinding guard) and the editor's origin may send write requests:

```sh
PUBLIC_URL=https://plakat.example.com
```

If the same instance is reachable under more names, list them in `ALLOWED_HOSTS` (`plakat.example.com,design.example.org`, or `.example.com` for all subdomains). IP addresses, `localhost`, single-label names and names under `.local`, `.localhost`, `.internal` and `.home.arpa` are always accepted. Any other host gets `403 host_not_allowed`, and the server logs a warning that names the variable to set.

The server trusts `X-Forwarded-*` headers (Fastify `trustProxy`), so only let your proxy reach it directly.

**Request size:** design saves and template imports can be large (images are embedded until the server moves them into uploads). Allow at least `MAX_BODY_MB` (40 MiB by default) at the proxy.

Caddy:

```caddyfile
plakat.example.com {
	reverse_proxy 127.0.0.1:8787
}
```

nginx:

```nginx
server {
  listen 443 ssl;
  server_name plakat.example.com;
  # ssl_certificate …; ssl_certificate_key …;

  client_max_body_size 50m;

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
  }
}
```

The editor is a single-page app served from `/`, with the API under `/api` and images under `/uploads`. Serving it under a sub-path (`https://example.com/plakat/`) is not supported yet.

## Access control

Choose one:

1. **An authenticating reverse proxy** (oauth2-proxy, Authelia, Authentik, Cloudflare Access, Tailscale, your company SSO). This is the best option: real per-person logins, and Plakat never sees passwords. Exclude `/api/health` if your monitoring calls it.
2. **`BASIC_AUTH=user:password`**: one shared login for the whole instance, checked in constant time. Everything except `/api/health` requires it. Only use it over HTTPS.
3. **Network only:** keep the default `HOST=127.0.0.1`, or a private network or VPN.

The server logs a warning at startup when it listens on a non-loopback address without `BASIC_AUTH`.

Independently of these, the server refuses cross-site write requests (a foreign `Origin` gets `403 cross_origin_request`), so a malicious web page cannot change data through a logged-in browser. If you host a different front end on another origin, add that origin to `CORS_ORIGIN`.

## Backups

Back up the database and the uploads together; designs reference uploads by `/uploads/<sha256>.<ext>`.

PostgreSQL with compose:

```sh
docker compose exec -T db pg_dump -U plakat -Fc plakat > plakat-$(date +%F).dump
docker run --rm -v plakat_plakat-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/plakat-uploads-$(date +%F).tgz -C /data uploads
```

(The volume name gets the compose project prefix, `plakat_` when the directory is called `plakat`; check with `docker volume ls`.)

PGlite: stop the server, then copy `DATA_DIR` (it holds both `pglite/` and `uploads/`).

Users can also keep their own copies: **Share → Download design file** writes a portable `.plakat.json` with every image embedded, which imports into any Plakat server.

## Upgrades

1. Back up (see above).
2. Pull the new version and rebuild: `docker compose up -d --build`, or `npm ci && npm run build` and restart.
3. The server applies database migrations at startup, under an advisory lock, so a second instance starting at the same time waits instead of applying them twice.

Stored documents written by an older Plakat are migrated when they are read and saved in the current format on their next save. Every format change bumps the document's `schemaVersion`, and an older Plakat refuses documents from a newer version with an "upgrade Plakat" message instead of damaging them. There is no downgrade path, so keep the backup until you are happy with the upgrade.

## Limits

| Limit | Value | |
|---|---|---|
| JSON request body | `MAX_BODY_MB`, default 40 MiB | designs, template imports, brand kits |
| Upload / provider or remote-src download | 25 MiB per image (`MAX_ASSET_BYTES`) | PNG, JPEG, WebP, GIF, SVG |
| Thumbnail | 2 MiB, 4096 px per side | PNG only; built-in templates' thumbnails are read-only |
| Assets per document | 1000 | |
| New remote image URLs per save/import | 50 | downloaded into uploads, with SSRF guards |

Export happens in the user's browser, so large print exports use the client's memory, not the server's.

## Troubleshooting

- **`403 host_not_allowed`:** the `Host` header is not an accepted name. Set `PUBLIC_URL` or add the name to `ALLOWED_HOSTS`.
- **`403 cross_origin_request`:** a write request came from another origin. If that origin is yours, add it to `CORS_ORIGIN`.
- **`413` when saving or importing:** raise `MAX_BODY_MB` and your proxy's body limit.
- **Text looks different or falls back to a default font:** the browser cannot reach Google Fonts. The editor warns about missing fonts; exports wait for fonts for up to 15 seconds.
- **Photos panel errors:** Openverse may be rate limiting anonymous requests. Set `OPENVERSE_CLIENT_ID` and `OPENVERSE_CLIENT_SECRET`.
- **Health:** `GET /api/health` returns `{"ok":true,"db":"postgres"}` or `"pglite"`.
