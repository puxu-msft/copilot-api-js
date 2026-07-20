#!/usr/bin/env bash
# Independent copilot-api PROXY launcher for the buffered empty_text anchor oracle.
#
# RUNTIME: Bun — this is the PRODUCTION runtime, so the whole oracle chain is prod-faithful.
# The proxy reaches the mock over HTTPS/h2 (ghc_api_base_url=https://localhost:$MOCK_PORT), which
# routes through the proxy's production node:http2 client (upstream-fetch.ts) — the path that works
# under Bun. (A plaintext http:// mock would force the undici HTTP/1.1 path, which hangs under Bun;
# that is why the mock was moved to h2 — see REPORT.md.)
#
# ISOLATION: XDG_DATA_HOME points APP_DIR at a scratch dir so this instance has its own
# config.yaml / history.db and never touches the live :4141 data dir. It reuses the live
# github_token (real GitHub auth → copilot token; the mock ignores the upstream token but the
# proxy still needs a copilot token to boot).
#
# TLS TRUST: the mock's cert is self-signed. NODE_EXTRA_CA_CERTS makes the proxy's node:tls trust
# it WITHOUT globally disabling verification (prod-faithful — real cert validation still runs).
# Bun honors NODE_EXTRA_CA_CERTS for node:tls (verified in this harness). Set
# ORACLE_TLS_INSECURE=1 to fall back to NODE_TLS_REJECT_UNAUTHORIZED=0 (test-only, :4142 only).
#
# Start the mock (start-mock.sh) FIRST — the proxy fetches /models at boot.
#
# Usage: start-proxy.sh
#   Env: PROXY_PORT (default 4142), MOCK_PORT (default 8890), ORACLE_XDG (scratch data dir).
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$DIR/../.." && pwd)"
PROXY_PORT="${PROXY_PORT:-4142}"
MOCK_PORT="${MOCK_PORT:-8890}"
ORACLE_XDG="${ORACLE_XDG:-/tmp/oracle-xdg}"
CERT="$DIR/mock-cert.pem"
LIVE_TOKEN="$HOME/.local/share/copilot-api/github_token"

if [ "$PROXY_PORT" = "4141" ]; then
  echo "[start-proxy] REFUSING to bind :4141 (that is the LIVE instance). Use PROXY_PORT=4142." >&2
  exit 2
fi

APP_DIR="$ORACLE_XDG/copilot-api"
mkdir -p "$APP_DIR"

# Isolated config.yaml (only overrides vs bundled; deep-merges the rest).
cp -f "$DIR/oracle-config.yaml" "$APP_DIR/config.yaml"

# Reuse the live GitHub token so the proxy can obtain a copilot token at boot.
if [ ! -f "$APP_DIR/github_token" ]; then
  if [ -f "$LIVE_TOKEN" ]; then
    cp -f "$LIVE_TOKEN" "$APP_DIR/github_token"
    chmod 600 "$APP_DIR/github_token"
    echo "[start-proxy] copied live github_token → $APP_DIR/github_token"
  else
    echo "[start-proxy] WARN: no live github_token at $LIVE_TOKEN — proxy boot may fail to auth" >&2
  fi
fi

if [ ! -f "$CERT" ]; then
  echo "[start-proxy] ERROR: mock cert missing ($CERT) — start start-mock.sh first (it generates the cert)" >&2
  exit 3
fi

# TLS trust for the self-signed mock cert.
TLS_ENV=("NODE_EXTRA_CA_CERTS=$CERT")
TLS_NOTE="NODE_EXTRA_CA_CERTS (prod-faithful: real validation, mock cert added to trust store)"
if [ "${ORACLE_TLS_INSECURE:-0}" = "1" ]; then
  TLS_ENV=("NODE_TLS_REJECT_UNAUTHORIZED=0")
  TLS_NOTE="NODE_TLS_REJECT_UNAUTHORIZED=0 (test-only, :$PROXY_PORT only)"
fi

echo "[start-proxy] runtime=Bun $(bun --version)  port=:$PROXY_PORT  upstream=https://localhost:$MOCK_PORT"
echo "[start-proxy] APP_DIR=$APP_DIR (XDG_DATA_HOME=$ORACLE_XDG)"
echo "[start-proxy] TLS trust: $TLS_NOTE"
echo "[start-proxy] logs → $DIR/proxy.log"

cd "$REPO"
exec env \
  XDG_DATA_HOME="$ORACLE_XDG" \
  "${TLS_ENV[@]}" \
  bun run "$REPO/src/main.ts" start \
    --port "$PROXY_PORT" \
    --ghc-api-base-url "https://localhost:$MOCK_PORT" \
    --no-rate-limit \
    2>&1 | tee "$DIR/proxy.log"
