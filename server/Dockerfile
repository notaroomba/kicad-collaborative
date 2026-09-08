# The web chrome (server/web, TypeScript + React) is bundled first so a deploy never ships a
# stale static/dist — the committed bundle only keeps `cargo run` working without node.
FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY web ./web
COPY scripts ./scripts
RUN npm run check && npm run build

FROM rust:1-slim-bookworm AS build
WORKDIR /app
COPY . .
COPY --from=web /web/static/dist ./static/dist
RUN cargo build --release && cp target/release/kicad-collab-server /srv-bin

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /srv-bin /usr/local/bin/kicad-collab-server
CMD ["kicad-collab-server"]
