#!/usr/bin/env bash
set -euo pipefail

ROOT=/home/xp/src/copilot-api-js
EXP="$ROOT/exp/silence-recovery-gates"
OUT="$EXP/results/q1"
PORT=41921
SERVER_PID=''

listener_pid() {
  ss -ltnp "( sport = :$PORT )" | grep -oP 'pid=\K[0-9]+' | head -1 || true
}

cleanup() {
  local pid
  pid=$(listener_pid)
  if [[ -n "$pid" ]]; then kill "$pid" || true; fi
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then kill "$SERVER_PID" || true; fi
  [[ -n "$SERVER_PID" ]] && wait "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT

if ss -ltn "( sport = :$PORT )" | grep -q ":$PORT"; then
  echo "refusing to use occupied Q1 port $PORT" >&2
  exit 1
fi
mkdir -p "$OUT"
rm -f "$OUT"/*.json "$OUT"/*.log

run_case() {
  local client=$1
  local delay=$2
  local label="${client}-${delay}ms"
  local nonce="${label}-$(date +%s%N)"
  Q1_PORT="$PORT" Q1_NONCE="$nonce" Q1_PRE_HEADER_DELAY_MS="$delay" bun "$EXP/q1-pre-header-server.ts" >"$OUT/$label.server.log" 2>&1 &
  SERVER_PID=$!
  local healthy=''
  for _ in $(seq 1 80); do
    healthy=$(curl --max-time 1 -fsS "http://127.0.0.1:$PORT/health" || true)
    if [[ "$healthy" == *"$nonce"* ]]; then printf '%s\n' "$healthy" >"$OUT/$label.health.json"; break; fi
    sleep 0.1
  done
  if [[ "$healthy" != *"$nonce"* ]] || ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Q1 server did not become healthy with its own nonce for $label" >&2
    exit 1
  fi
  if [[ $client == sdk ]]; then
    Q1_BASE_URL="http://127.0.0.1:$PORT" Q1_DELAY_MS="$delay" Q1_RESULTS_PATH="$OUT/$label.json" bun "$EXP/q1-runner.ts" || true
  else
    Q1_BASE_URL="http://127.0.0.1:$PORT" Q1_DELAY_MS="$delay" Q1_RESULTS_PATH="$OUT/$label.json" bun "$EXP/q1-claude-cli-runner.ts" || true
  fi
  local listener
  listener=$(listener_pid)
  if [[ -n "$listener" ]]; then kill "$listener" || true; fi
  if kill -0 "$SERVER_PID" 2>/dev/null; then kill "$SERVER_PID" || true; fi
  wait "$SERVER_PID" 2>/dev/null || true
  SERVER_PID=''
}

# SDK establishes the adjustable lower boundary with maxRetries:0 and a deliberately high 1250s client timeout.
for delay in 60000 100000 125000; do run_case sdk "$delay"; done
# True Claude Code path confirms the actual client behavior at two calibrated points.
run_case cli 60000
run_case cli 125000

python3 - "$OUT" <<'PY'
import json, sys
from pathlib import Path
out=Path(sys.argv[1])
for path in sorted(out.glob('*.json')):
    if path.name.endswith('.health.json'): continue
    d=json.loads(path.read_text())
    print(path.name, {k:d.get(k) for k in ('delayMs','status','elapsedMs','exitCode','parsed')})
PY
