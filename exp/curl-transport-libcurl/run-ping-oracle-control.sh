#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
H2_PORT=${H2_PORT:-35443}
H1_PORT=${H1_PORT:-35444}
if ss -ltn "( sport = :$H2_PORT or sport = :$H1_PORT )" | rg -q LISTEN; then
  printf 'PoC ports %s/%s are already occupied\n' "$H2_PORT" "$H1_PORT" >&2
  exit 1
fi
H2_PORT=$H2_PORT H1_PORT=$H1_PORT node "$HERE/oracle.mjs" > "$HERE/ping-oracle-control.log" 2>&1 &
launcher=$!
cleanup() {
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
  rg -q '"event":"ready"' "$HERE/ping-oracle-control.log" && break
  sleep 0.1
done
rg -q '"event":"ready"' "$HERE/ping-oracle-control.log" || { cat "$HERE/ping-oracle-control.log" >&2; exit 1; }
NODE_TLS_REJECT_UNAUTHORIZED=0 H2_ORIGIN="https://127.0.0.1:$H2_PORT" node --input-type=module <<'EOF'
import http2 from "node:http2"
const session = http2.connect(process.env.H2_ORIGIN)
await new Promise((resolve, reject) => {
  session.once("connect", resolve)
  session.once("error", reject)
})
await new Promise((resolve, reject) => session.ping(Buffer.from("oracle!!"), (error) => error ? reject(error) : resolve()))
session.close()
EOF
sleep 0.1
rg -a '"event":"h2-ping"' "$HERE/ping-oracle-control.log"
