#!/usr/bin/env bash
# Long-lived mock GHC upstream launcher for the buffered empty_text anchor oracle.
#
# Start THIS FIRST, then start the copilot-api proxy with its ghc_api_base_url pointed here.
# The proxy fetches /models from this mock at startup, so it must be up before the proxy.
#
# Usage: start-mock.sh [PORT]
#   PORT default 8890. Override silence windows via env:
#     MOCK_SILENCE_SEC        keepalive-chain upstream silence (default 320, > CC's 300s deadline)
#     MOCK_ANCHOR_SILENCE_SEC thinking-chain pre-content silence (default 25, > proxy keepalive cadence)
#     MOCK_MODEL              advertised/echoed model id (default claude-opus-4-8)
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${1:-${MOCK_PORT:-8890}}"

echo "[start-mock] launching mock GHC upstream on :$PORT (logs → $DIR/mock.log)"
echo "[start-mock] next: start the proxy with  ghc_api_base_url: http://localhost:$PORT"
MOCK_PORT="$PORT" exec bun run "$DIR/mock.ts" 2>&1 | tee "$DIR/mock.log"
