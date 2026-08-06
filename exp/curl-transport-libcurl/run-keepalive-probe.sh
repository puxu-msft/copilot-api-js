#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
H2_PORT=${H2_PORT:-34443}
H1_PORT=${H1_PORT:-34444}
if ss -ltn "( sport = :$H2_PORT or sport = :$H1_PORT )" | rg -q LISTEN; then
  printf 'PoC ports %s/%s are already occupied\n' "$H2_PORT" "$H1_PORT" >&2
  exit 1
fi
H2_PORT=$H2_PORT H1_PORT=$H1_PORT node "$HERE/oracle.mjs" > "$HERE/keepalive-oracle.log" 2>&1 &
launcher=$!
client_pid=""
cleanup() {
  if [ -n "$client_pid" ]; then
    kill "$client_pid" 2>/dev/null || true
    wait "$client_pid" 2>/dev/null || true
  fi
  pid=$(ss -ltnp "( sport = :$H2_PORT )" 2>/dev/null | rg -o 'pid=[0-9]+' | cut -d= -f2 | head -1 || true)
  if [ -n "$pid" ]; then
    cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline")
    case "$cmd" in *'/exp/curl-transport-libcurl/oracle.mjs'*) kill "$pid";; esac
  fi
  kill "$launcher" 2>/dev/null || true
  wait "$launcher" 2>/dev/null || true
}
trap cleanup EXIT
for _ in $(seq 1 50); do
  rg -q '"event":"ready"' "$HERE/keepalive-oracle.log" && break
  sleep 0.1
done
rg -q '"event":"ready"' "$HERE/keepalive-oracle.log" || { cat "$HERE/keepalive-oracle.log" >&2; exit 1; }
H2_ORIGIN="https://127.0.0.1:$H2_PORT" bun "$HERE/run-multi-probes.ts" keepalive > "$HERE/keepalive-result.jsonl" &
client_pid=$!
for _ in $(seq 1 100); do
  rg -q '"path":"/hold-long"' "$HERE/keepalive-oracle.log" && break
  sleep 0.05
done
sleep 2.3
ss -tnope | rg ":$H2_PORT\\b" | tee "$HERE/ss-keepalive.txt"
wait "$client_pid"
client_pid=""
cat "$HERE/keepalive-result.jsonl"
printf 'observed_h2_ping_count='
rg -a -c '"event":"h2-ping"' "$HERE/keepalive-oracle.log" || true
