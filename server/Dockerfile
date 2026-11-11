# The web chrome (server/web, TypeScript + React) is bundled first so a deploy never ships a
# stale static/dist — the committed bundle only keeps `cargo run` working without node.
FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY web ./web
COPY scripts ./scripts
# the headless editor (web/mcp) bundles the editor's schematic and board tool modules
COPY static/sch-tools.js static/pcb-tools.js ./static/
# the Python runtime for KiCad's own plugins packs its pcbnew and wx modules (plugins/python) beside the interpreter
COPY plugins/python ./plugins/python
RUN npm run check && npm run build

FROM rust:1-slim-bookworm AS build
WORKDIR /app
COPY . .
COPY --from=web /web/static/dist ./static/dist
RUN cargo build --release && cp target/release/kicad-collab-server /srv-bin

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# node runs the headless editor behind the MCP endpoint (src/mcp_host.rs); same Debian release as the web stage
COPY --from=web /usr/local/bin/node /usr/local/bin/node
COPY --from=build /srv-bin /usr/local/bin/kicad-collab-server
# served as /static/pyodide/*; too large to compile into the binary (src/pcm.rs runtime_dir)
COPY --from=web /web/static/dist/pyodide /usr/local/share/kicad-collab/pyodide
CMD ["kicad-collab-server"]
