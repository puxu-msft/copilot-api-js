#!/usr/bin/env bash
set -euo pipefail
ROOT=/home/xp/src/copilot-api-js/exp/napi-http-spike
bash "$ROOT/build.sh"
node "$ROOT/probe-tsfn.cjs"
bun "$ROOT/probe-tsfn.cjs"
node "$ROOT/run-http1-probes.cjs" node
node "$ROOT/run-http1-probes.cjs" bun
node "$ROOT/run-h2-probe.cjs" node
node "$ROOT/run-h2-probe.cjs" bun
node "$ROOT/probe-backpressure.cjs"
bun "$ROOT/probe-backpressure.cjs"
node "$ROOT/run-tcp-probe.cjs" node
node "$ROOT/run-tcp-probe.cjs" bun
