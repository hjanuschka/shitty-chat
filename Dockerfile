# syntax=docker/dockerfile:1
#
# Multi-stage build for shitty.chat.
#
#   build   -- installs deps, compiles the React dashboard with Vite.
#   runtime -- slim node:22-alpine, non-root, ships server + shared + dashboard.
#
# The runtime image serves everything on one port (8787): the dashboard,
# the REST API, and the WebSocket relay. A reverse proxy (Caddy in the
# docker-compose file) terminates TLS in production.

FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare yarn@1.22.19 --activate \
    && apk add --no-cache python3 make g++

COPY package.json yarn.lock ./
COPY server/package.json server/
COPY web/package.json web/
RUN yarn install --frozen-lockfile

COPY shared shared
COPY server server
COPY web web
RUN yarn workspace @shitty-chat/web build

# -----------------------------------------------------------------------------

FROM node:22-alpine AS runtime
WORKDIR /app

RUN corepack enable && corepack prepare yarn@1.22.19 --activate \
    && apk add --no-cache python3 make g++ tini \
    && addgroup -S sc && adduser -S sc -G sc

COPY package.json yarn.lock ./
COPY server/package.json server/
COPY web/package.json web/

# Server needs devDependencies (tsx). Install, then strip build tools.
RUN yarn install --frozen-lockfile \
    && apk del python3 make g++ \
    && yarn cache clean

COPY shared shared
COPY server server
COPY --from=build /app/web/dist web/dist

RUN mkdir -p /data && chown -R sc:sc /data /app
USER sc

ENV NODE_ENV=production \
    PORT=8787 \
    SHITTY_CHAT_DB=/data/shitty-chat.db \
    SHITTY_CHAT_WEB_DIST=/app/web/dist

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --spider -q http://127.0.0.1:8787/healthz || exit 1

# tini reaps zombies and forwards signals for a clean container exit.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--import", "tsx", "server/src/index.ts"]

LABEL org.opencontainers.image.title="shitty.chat" \
      org.opencontainers.image.description="E2E-encrypted cross-machine chat + delegation for pi agents" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/YOUR-USER/shitty-chat"
