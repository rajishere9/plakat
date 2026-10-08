# syntax=docker/dockerfile:1
#
# Plakat: single image serving the API (Fastify, run via tsx) and the built SPA.
#   docker build -t plakat .
#   docker run -p 8787:8787 -v plakat-data:/data plakat            # embedded PGlite
#   docker compose up -d                                             # with Postgres
#
# ---------------------------------------------------------------------------
# 1) build: install the whole npm workspace from the lockfile, build the SPA.
#    (The full source tree is copied before `npm ci` so that every workspace the
#    lockfile lists is present, whatever packages/* and apps/* exist.)
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false
COPY . .
# --ignore-scripts: the only native build in the tree is `canvas`, a test-only
# devDependency of @plakat/renderer that the server and the web build never load.
# esbuild/rolldown/lightningcss ship prebuilt optional per-platform packages,
# which npm ci installs from the lockfile without running scripts.
RUN npm ci --ignore-scripts \
 && npm run build -w @plakat/web \
 && test -f apps/web/dist/index.html \
 && npm cache clean --force

# ---------------------------------------------------------------------------
# 2) runtime
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
# HOST=0.0.0.0: inside a container the server must listen on all interfaces (the
# server's own default is 127.0.0.1). Plakat has no user accounts: publish the port
# only to trusted networks or behind an authenticating proxy (or set BASIC_AUTH).
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    UPLOAD_DIR=/data/uploads \
    TEMPLATES_DIR=/app/templates \
    WEB_DIST=/app/apps/web/dist
WORKDIR /app
# Whole workspace from the build stage: root + nested node_modules (workspace
# symlinks under node_modules/@plakat/* point at packages/*), TypeScript sources
# (run by tsx), templates/ and apps/web/dist. Owned by root and read-only to the
# app user; only /data is writable.
COPY --from=build /app /app
RUN mkdir -p /data/uploads && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# Single node process (PID 1 handles SIGTERM itself); tsx registered as a loader.
CMD ["node", "--import", "tsx", "apps/server/src/index.ts"]
