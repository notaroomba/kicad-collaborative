#!/usr/bin/env bash
# github-real.sh — run github-real.mjs end to end on a developer machine: a throwaway
# Postgres, the stand-in OAuth, the bridge to api.github.com and a server built from
# this checkout. Everything lives in a temporary folder and is stopped at the end.
#
#   REAL_REPO=owner/throwaway server/scripts/github-real.sh
#
# Needs: cargo, node, Postgres binaries (initdb, pg_ctl) on PATH, and a GitHub token for
# an account that can push to REAL_REPO, in GH_TOKEN or from `gh auth token`.
# It writes to REAL_REPO and nowhere else (the bridge refuses any other write).
set -euo pipefail
cd "$(dirname "$0")/.."
: "${REAL_REPO:?REAL_REPO=owner/name of a throwaway repository is required}"
GH_TOKEN="${GH_TOKEN:-$(gh auth token)}"
export GH_TOKEN
GH_ID="${REAL_GH_ID:-$(curl -fsS -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/user | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))')}"

# Homebrew's Postgres refuses to start without a valid locale ("postmaster became
# multithreaded during startup").
export LC_ALL="${LC_ALL:-en_US.UTF-8}" LANG="${LANG:-en_US.UTF-8}"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/kc-github-real.XXXXXX")"
PGPORT="${PGPORT:-55439}"
pids=()
cleanup() {
  for p in "${pids[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  pg_ctl -D "$WORK/pg" -m fast stop >/dev/null 2>&1 || true
  echo "logs kept in $WORK"
}
trap cleanup EXIT

[ -d scripts/node_modules ] || (cd scripts && npm ci --silent)
cargo build --quiet

initdb -D "$WORK/pg" -U postgres -A trust >/dev/null
pg_ctl -D "$WORK/pg" -o "-p $PGPORT -k /tmp -c listen_addresses=127.0.0.1" -l "$WORK/pg.log" -w start >/dev/null
createdb -h 127.0.0.1 -p "$PGPORT" -U postgres kcreal
DB="postgres://postgres@127.0.0.1:$PGPORT/kcreal"

node scripts/fake-github.mjs >"$WORK/fake.log" 2>&1 & pids+=($!)
WRITE_REPO="$REAL_REPO" node scripts/github-bridge.mjs >"$WORK/bridge.log" 2>&1 & pids+=($!)
DATABASE_URL="$DB" JWT_SECRET=realtest PUBLIC_URL=http://127.0.0.1:8096 PORT=8096 KC_DEV_LOGIN=1 \
  GITHUB_CLIENT_ID=test GITHUB_CLIENT_SECRET=test \
  GITHUB_API_URL=http://127.0.0.1:8097 GITHUB_WEB_URL=http://127.0.0.1:8098 \
  ./target/debug/kicad-collab-server >"$WORK/server.log" 2>&1 & pids+=($!)
for _ in $(seq 1 60); do curl -fsS http://127.0.0.1:8096/healthz >/dev/null 2>&1 && break; sleep 0.5; done

E2E_BASE=http://127.0.0.1:8096 E2E_PG_URL="$DB" E2E_JWT_SECRET=realtest REAL_REPO="$REAL_REPO" REAL_GH_ID="$GH_ID" \
  node scripts/github-real.mjs
