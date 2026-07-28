#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${REPO_OVERRIDE:-$(cd "$DIR/../.." && pwd)}"
PORT="${PORT:-}"
WORK_DIR="${WORK_DIR:-/tmp/inter-block-anchor-allocator-baseline}"
APP_DIR="$WORK_DIR/copilot-api"
CAPTURE="${CAPTURE_OVERRIDE:-$DIR/pre-change-wire.sse}"
LOG="$WORK_DIR/server.log"
PID_FILE="$WORK_DIR/server.pid"
HOOK_MARKER='msg_allocator_baseline'
HOOK_TEXT='allocator baseline'

if [[ -z "$PORT" ]]; then
  # Let the kernel choose an unused high port. The post-spawn ownership check below closes the
  # release/rebind race and prevents a peer server from making the readiness probe falsely green.
  PORT="$(python3 - <<'PY'
import socket
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
)"
fi
if [[ "$PORT" == "4141" ]]; then
  printf '%s\n' "refusing to bind the user's live :4141 server" >&2
  exit 2
fi
if ss -ltn "sport = :$PORT" | grep -q LISTEN; then
  printf 'refusing occupied test port %s; current owner:\n' "$PORT" >&2
  ss -ltnp "sport = :$PORT" >&2 || true
  exit 3
fi

is_owned_process() {
  local current="$1"
  while [[ "$current" =~ ^[0-9]+$ ]] && (( current > 1 )); do
    [[ "$current" == "$pid" ]] && return 0
    [[ -r "/proc/$current/stat" ]] || return 1
    current="$(python3 - "$current" <<'PY'
import pathlib, sys
fields = pathlib.Path(f"/proc/{sys.argv[1]}/stat").read_text().split()
print(fields[3])
PY
)"
  done
  return 1
}

assert_listener_owned() {
  local quiet="${1:-false}"
  local listeners=()
  mapfile -t listeners < <(ss -ltnp "sport = :$PORT" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u)
  if (( ${#listeners[@]} != 1 )) || ! is_owned_process "${listeners[0]:-}"; then
    if [[ "$quiet" != "true" ]]; then
      printf 'test port %s is not owned by spawned pid %s; listeners:\n' "$PORT" "$pid" >&2
      ss -ltnp "sport = :$PORT" >&2 || true
      for listener in "${listeners[@]}"; do
        printf 'pid=%s cmd=' "$listener" >&2
        tr '\0' ' ' < "/proc/$listener/cmdline" >&2 || true
        printf '\n' >&2
      done
    fi
    return 1
  fi
}

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
    # Kill the OWNED LISTENERS FIRST, then the wrapper. `bun run <script>` execs a child that
    # holds the socket, so killing only the wrapper orphans a live test server that keeps the
    # port (and a real token) forever — that is exactly how the peer process this script now
    # refuses to trust came to exist. `is_owned_process` already walks the ppid chain; reuse it
    # so we only ever kill our own descendants, never a peer's server and never 4141.
    local listeners=()
    mapfile -t listeners < <(ss -ltnp "sport = :$PORT" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u)
    for listener in "${listeners[@]}"; do
      [[ "$listener" == "$pid" ]] && continue
      if is_owned_process "$listener" && kill -0 "$listener" 2>/dev/null; then
        kill "$listener" 2>/dev/null || true
      fi
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid"
      wait "$pid" 2>/dev/null || true
    fi
    # Post-condition: the port must actually be free again. A surviving listener here means the
    # descendant walk missed something — say so loudly rather than leaking silently.
    sleep 0.3
    if ss -ltn "sport = :$PORT" 2>/dev/null | grep -q LISTEN; then
      printf 'WARNING: test port %s still has a listener after cleanup:\n' "$PORT" >&2
      ss -ltnp "sport = :$PORT" >&2 || true
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
  if grep -qE 'Failed to start server|port already in use|Is port .* in use' "$LOG"; then
    printf 'test server reported a bind failure; log follows\n' >&2
    tail -n 80 "$LOG" >&2
    exit 5
  fi
  if assert_listener_owned true && curl -fsS --max-time 1 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

if ! assert_listener_owned || ! curl -fsS --max-time 1 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  printf 'owned test server did not become ready; log follows\n' >&2
  tail -n 80 "$LOG" >&2
  exit 6
fi

curl -fsSN "http://127.0.0.1:$PORT/v1/messages" \
  -H 'content-type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"claude-opus-5","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"Return the deterministic baseline."}]}' \
  > "$CAPTURE"

# A matching listener is necessary but not sufficient: assert the hook's unique payload marker too,
# so a wrong project server/config cannot silently become the authoritative byte baseline.
if ! grep -Fq "$HOOK_MARKER" "$CAPTURE" || ! grep -Fq "$HOOK_TEXT" "$CAPTURE"; then
  printf 'captured wire did not come from deterministic-hook.ts; expected %s and %s\n' "$HOOK_MARKER" "$HOOK_TEXT" >&2
  exit 7
fi

sha256sum "$CAPTURE"
wc -c "$CAPTURE"
printf 'port=%s listener_pid=%s spawn_pid=%s\n' "$PORT" "$(ss -ltnp "sport = :$PORT" | grep -oP 'pid=\K[0-9]+' | sort -u)" "$pid"
printf 'capture=%s\n' "$CAPTURE"
