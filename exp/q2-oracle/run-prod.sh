#!/usr/bin/env bash
set -u
DIR="/home/xp/src/copilot-api-js/exp/q2-oracle"
export CC_FIRST_PARTY=0
# A2: true pre-response silence (no headers) — prod TTFB threshold => grace upper bound
MOCK_PORT=8801 CC_CEIL=680 bash "$DIR/cc-run.sh" A2 noheaders:660 > "$DIR/run-prod.A2.log" 2>&1
echo "A2 done $(date -Is)" >> "$DIR/run-prod.progress"
# B2: 200 headers then idle body — prod body-idle threshold
MOCK_PORT=8802 CC_CEIL=680 bash "$DIR/cc-run.sh" B2 silent:660 > "$DIR/run-prod.B2.log" 2>&1
echo "B2 done $(date -Is)" >> "$DIR/run-prod.progress"
