#!/usr/bin/env bash
# Long-lived mock GHC upstream launcher for the buffered empty_text anchor oracle.
#
# TRANSPORT: this mock is an HTTPS/HTTP2 (`h2`) upstream served by node:http2's secure server,
# and it MUST run under NODE (not Bun): Bun's http2 SERVER `stream.close(code)` does not emit a
# faithful RST_STREAM frame, which the retry chain depends on (skill bun-upstream-transport).
# Node 24+ runs this `.ts` directly via type-stripping — no build step needed.
#
# Start THIS FIRST, then start the copilot-api PROXY (Bun, :4142) with its ghc_api_base_url pointed
# at https://localhost:$PORT (see start-proxy.sh). The proxy fetches /models from this mock at
# startup, so it must be up before the proxy.
#
# Usage: start-mock.sh [PORT]
#   PORT default 8890. Override silence windows via env:
#     MOCK_SILENCE_SEC        keepalive-chain upstream silence (default 320, > CC's 300s deadline)
#     MOCK_ANCHOR_SILENCE_SEC thinking-chain pre-content silence (default 25, > proxy keepalive cadence)
#     MOCK_MODEL              advertised/echoed model id (default claude-opus-4-8)
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${1:-${MOCK_PORT:-8890}}"
CERT="$DIR/mock-cert.pem"
KEY="$DIR/mock-key.pem"

# Self-signed localhost cert (idempotent — only generated when absent). SAN covers localhost +
# 127.0.0.1 so the proxy's node:tls servername check passes.
if [ ! -f "$CERT" ] || [ ! -f "$KEY" ]; then
  echo "[start-mock] generating self-signed localhost cert → $CERT / $KEY"
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$KEY" -out "$CERT" \
    -days 3650 -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1 \
    || { echo "[start-mock] ERROR: openssl cert generation failed" >&2 ; exit 3 ; }
fi

# Pick a Node that supports running .ts directly (type-stripping, Node 22.6+/24). `node --version`.
NODE_BIN="${NODE_BIN:-node}"
if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  echo "[start-mock] ERROR: node not found (need Node 22.6+/24 to run mock.ts via type-stripping)" >&2
  exit 4
fi

echo "[start-mock] launching mock GHC upstream (h2, Node $("$NODE_BIN" --version)) on https://localhost:$PORT (logs → $DIR/mock.log)"
echo "[start-mock] next: start the PROXY (Bun) with  ghc_api_base_url: https://localhost:$PORT  (see start-proxy.sh)"
MOCK_PORT="$PORT" exec "$NODE_BIN" "$DIR/mock.ts" 2>&1 | tee "$DIR/mock.log"
