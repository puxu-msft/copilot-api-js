#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${REPO_OVERRIDE:-$(cd "$DIR/../.." && pwd)}"
PORT="${PORT:-}"
WORK_DIR="${WORK_DIR:-/tmp/inter-block-anchor-allocator-baseline}"
APP_DIR="$WORK_DIR/copilot-api"
# The authoritative O-6 fixture. Capturing writes somewhere else and then compares, because a gate
# whose default action is to overwrite its own baseline can only ever pass.
BASELINE="$DIR/pre-change-wire.sse"
RECAPTURE="${RECAPTURE:-0}"
CAPTURE="${CAPTURE_OVERRIDE:-$WORK_DIR/current-wire.sse}"
LOG="$WORK_DIR/server.log"
EVIDENCE_TIMING="${EVIDENCE_TIMING:-dev}"
case "$EVIDENCE_TIMING" in
  dev|closeout) ;;
  *)
    printf 'EVIDENCE_TIMING must be dev or closeout, got %s\n' "$EVIDENCE_TIMING" >&2
    exit 2
    ;;
esac
MEASURED_SHA="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || true)"
if [[ ! "$MEASURED_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'cannot resolve a full measured_sha from %s\n' "$REPO" >&2
  exit 2
fi
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

# Which tree this gate measured. Without it the answer is unobtainable after the
# fact: the capture is pure SSE bytes and the EXIT trap kills the server before
# anyone could read /proc/<pid>/cwd. A plan step that told an executor to derive
# the tree "from the O-6 capture" was therefore unexecutable, and the only
# remaining options were to assert "I cd'd correctly" -- which the same step
# forbade -- or to edit this script from inside a cutover commit.
# `cd` does not move it: REPO comes from this file's own location, so the gate
# measures whichever tree holds the copy you invoked.
# Structured evidence intent. Consumers MUST read these exact fields rather
# than infer self-reference by grepping prose for a SHA spelling. The output
# claims the current HEAD by construction, so it is self-referential and must
# stay outside the measured tree if it is archived verbatim.
printf 'evidence_timing=%s\n' "$EVIDENCE_TIMING"
printf 'measured_sha=%s\n' "$MEASURED_SHA"
printf 'claims_current_head=true\n'
printf 'repo=%s\n' "$REPO"
printf 'server_entry=%s\n' "$REPO/packages/cli/src/main.ts"
printf 'head=%s tree=%s\n' \
  "$MEASURED_SHA" \
  "$([ -n "$(git -C "$REPO" status --porcelain 2>/dev/null)" ] && echo DIRTY || echo clean)"

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

if [[ "$RECAPTURE" == "1" ]]; then
  cp "$CAPTURE" "$BASELINE"
  printf 'RECAPTURE=1: rewrote the authoritative fixture %s — commit this separately from any implementation change.\n' "$BASELINE"
  exit 0
fi

if [[ ! -f "$BASELINE" ]]; then
  printf 'no baseline at %s; run once with RECAPTURE=1 to establish one\n' "$BASELINE" >&2
  exit 8
fi

if cmp -s "$CAPTURE" "$BASELINE"; then
  printf 'O-6 PASS: captured wire is byte-identical to %s (repo=%s)\n' "$BASELINE" "$REPO"
  exit 0
fi

printf 'O-6 FAIL: captured wire differs from %s\n' "$BASELINE" >&2
cmp "$CAPTURE" "$BASELINE" >&2 || true
exit 9
