#!/usr/bin/env bash
# Q1 first-failure-point run: hold real Claude Code in pre-header silence for
# longer than any plausible tolerance and read the give-up moment off the server.
#
# Deliberately NOT a ladder: a ladder can only bracket the answer and costs one
# full run per rung. Watching `request.signal` abort server-side yields the exact
# moment plus the retry behaviour that follows, in a single run.
#
# Never uses port 4141 (the user's main server) and refuses an occupied port.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXP="$ROOT/exp/silence-recovery-gates"
OUT="$EXP/results/q1-firstfail"
PORT="${Q1_PORT:-41932}"
WINDOW_MS="${Q1_SILENCE_WINDOW_MS:-900000}"
CAP_MS="${Q1_CAP_MS:-2400000}"
LABEL="${Q1_LABEL:-firstfail}"
SERVER_PID=''

if [[ "$PORT" == "4141" ]]; then echo "port 4141 is the user's main server and is never allowed" >&2; exit 1; fi

cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then kill "$SERVER_PID" || true; fi
  local listener
  listener=$(ss -ltnp "( sport = :$PORT )" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true)
  if [[ -n "$listener" ]]; then kill "$listener" || true; fi
}
trap cleanup EXIT

if ss -ltn "( sport = :$PORT )" 2>/dev/null | grep -q ":$PORT"; then
  echo "refusing to use occupied port $PORT" >&2
  exit 1
fi
mkdir -p "$OUT"

NONCE="$LABEL-$(date +%s%N)"
Q1_PORT="$PORT" Q1_NONCE="$NONCE" Q1_SILENCE_WINDOW_MS="$WINDOW_MS" Q1_OBSERVATIONS_PATH="$OUT/$LABEL.observations.json" \
  bun "$EXP/q1-abort-observer-server.ts" >"$OUT/$LABEL.server.log" 2>&1 &
SERVER_PID=$!

# Poll for the server's OWN nonce: a bare 200 could come from a peer session's
# listener on the same port, which would silently invalidate the whole run.
healthy=''
for _ in $(seq 1 200); do
  healthy=$(curl --max-time 1 -fsS "http://127.0.0.1:$PORT/health" 2>/dev/null || true)
  if [[ "$healthy" == *"$NONCE"* ]]; then break; fi
  sleep 0.1
done
if [[ "$healthy" != *"$NONCE"* ]]; then
  echo "server never became healthy with its own nonce ($NONCE)" >&2
  exit 1
fi
echo "server healthy on $PORT (pid $SERVER_PID), silence window ${WINDOW_MS}ms, cap ${CAP_MS}ms"

# The CLI arm answers "when does real CC give up". The other two are its controls,
# and they are layered rather than redundant: the SDK arm rules out CC-only policy
# (its own request timer, its stream-idle watchdog); the bare-fetch arm strips
# every Anthropic layer so its error CAUSE names the layer that actually decided.
# Note the two arms failing at the SAME point does NOT implicate the harness —
# they share a Node/undici transport, so a common default explains it just as well.
# Ruling out our own server needs the raw-socket control instead (see FINDINGS).
case "${Q1_CLIENT:-cli}" in
  sdk)
    Q1_BASE_URL="http://127.0.0.1:$PORT" Q1_DELAY_MS="$WINDOW_MS" Q1_RESULTS_PATH="$OUT/$LABEL.client.json" \
      bun "$EXP/q1-runner.ts" || true
    ;;
  bare-fetch)
    # Deliberately `node`, not `bun`: the claim under test is undici's default
    # headersTimeout in Node's fetch, which is the stack real CC runs on.
    Q1_BASE_URL="http://127.0.0.1:$PORT" Q1_RESULTS_PATH="$OUT/$LABEL.client.json" \
      node --experimental-strip-types "$EXP/q1-bare-fetch-runner.ts" || true
    ;;
  *)
    Q1_BASE_URL="http://127.0.0.1:$PORT" Q1_CAP_MS="$CAP_MS" Q1_RESULTS_PATH="$OUT/$LABEL.client.json" \
      bun "$EXP/q1-firstfail-cli-runner.ts" || true
    ;;
esac

curl --max-time 5 -fsS "http://127.0.0.1:$PORT/observations" >"$OUT/$LABEL.observations.final.json" 2>/dev/null || true
echo "--- observations ---"
python3 -m json.tool "$OUT/$LABEL.observations.final.json" 2>/dev/null || cat "$OUT/$LABEL.observations.json"
