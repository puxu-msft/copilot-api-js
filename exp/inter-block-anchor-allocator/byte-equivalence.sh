#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$DIR/../.." && pwd)"
PORT="${PORT:-42061}"
WORK_DIR="${WORK_DIR:-/tmp/inter-block-anchor-allocator-baseline}"
APP_DIR="$WORK_DIR/copilot-api"
CAPTURE="$DIR/pre-change-wire.sse"
LOG="$WORK_DIR/server.log"
PID_FILE="$WORK_DIR/server.pid"

if [[ "$PORT" == "4141" ]]; then
  printf '%s\n' "refusing to bind the user's live :4141 server" >&2
  exit 2
fi

mkdir -p "$APP_DIR"
cat > "$APP_DIR/config.yaml" <<YAML
anthropic:
  stream_keepalive_ping_sec: 20
hooks:
  enabled: true
  upstream_module: "$DIR/deterministic-hook.ts"
YAML

LIVE_TOKEN="$HOME/.local/share/copilot-api/github_token"
if [[ ! -f "$APP_DIR/github_token" ]]; then
  if [[ ! -f "$LIVE_TOKEN" ]]; then
    printf 'missing GitHub token at %s\n' "$LIVE_TOKEN" >&2
    exit 3
  fi
  cp "$LIVE_TOKEN" "$APP_DIR/github_token"
  chmod 600 "$APP_DIR/github_token"
fi

cleanup() {
  if [[ -f "$PID_FILE" ]]; then
    pid="$(<"$PID_FILE")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid"
      wait "$pid" 2>/dev/null || true
    fi
  fi
}
trap cleanup EXIT INT TERM

XDG_DATA_HOME="$WORK_DIR" NODE_ENV=production bun run "$REPO/packages/cli/src/main.ts" start --port "$PORT" > "$LOG" 2>&1 &
pid=$!
printf '%s\n' "$pid" > "$PID_FILE"

for _ in $(seq 1 100); do
  if ! kill -0 "$pid" 2>/dev/null; then
    printf 'test server exited before readiness; log follows\n' >&2
    tail -n 80 "$LOG" >&2
    exit 4
  fi
  if curl -fsS --max-time 1 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

if ! curl -fsS --max-time 1 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  printf 'test server did not become ready; log follows\n' >&2
  tail -n 80 "$LOG" >&2
  exit 5
fi

curl -fsSN "http://127.0.0.1:$PORT/v1/messages" \
  -H 'content-type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"claude-opus-5","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"Return the deterministic baseline."}]}' \
  > "$CAPTURE"

sha256sum "$CAPTURE"
wc -c "$CAPTURE"
printf 'capture=%s\n' "$CAPTURE"
