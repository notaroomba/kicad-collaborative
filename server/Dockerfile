FROM rust:1-slim AS build
WORKDIR /app
COPY . .
RUN cargo build --release && cp target/release/kicad-collab-server /srv-bin

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /srv-bin /usr/local/bin/kicad-collab-server
CMD ["kicad-collab-server"]
