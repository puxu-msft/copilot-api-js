#!/usr/bin/env bash
# Q2 part (a) + part (b)-CC-layer orchestrator. Runs serially (one claude at a time => clean timing,
# no shared ~/.claude contention). Each scenario spawns a fresh mock on its own port.
#
# FAST (error-frame reaction at the Claude-Code wrapper layer — the real-world oracle above raw SDK):
#   E1 sse-error:429        does CC retry / display a 200+SSE-error-429? (attempt count in mock log)
#   E2 http-error:429:1     baseline: CC reaction to a real HTTP 429 (retry-after=1 to keep it fast)
#   E3 commit-then-error:429:1   mid-stream error after message_start
#   E4 sse-error:401 / E5 sse-error:400   non-retryable shapes
#
# SLOW (timeout measurement):
#   A  noheaders:360        TRUE pre-response silence (no headers) => CC time-to-first-byte threshold (grace upper bound)
#   B  silent:360           200 headers then idle body => CC body-idle threshold
#   C  ping:30:330          200 + ping every 30s => idle-reset test (does ping keep CC alive past A/B threshold?)
set -u
DIR="/home/xp/src/copilot-api-js/exp/q2-oracle"
RUN="$DIR/cc-run.sh"
SUMMARY="$DIR/part-a-summary.log"
: > "$SUMMARY"

note() { echo "$@" | tee -a "$SUMMARY"; }

note "===== Q2 part(a)+CC-layer run  $(date -Is) ====="

# ---- FAST error-frame reaction ----
for spec in "E1 sse-error:429 8791 30" "E2 http-error:429:1 8792 40" "E3 commit-then-error:429:1 8793 30" "E4 sse-error:401 8794 30" "E5 sse-error:400 8795 30"; do
  set -- $spec
  LBL=$1; MODE=$2; PORT=$3; CEIL=$4
  note "----- $LBL mode=$MODE -----"
  MOCK_PORT=$PORT CC_CEIL=$CEIL bash "$RUN" "$LBL" "$MODE" >> "$SUMMARY" 2>&1
  # extract attempt count (POST /v1/messages lines) + CC result line
  ATT=$(grep -c "POST /v1/messages" "$DIR/cc.$LBL.mock.log" 2>/dev/null)
  note "[$LBL] mock POST attempts=$ATT"
  note "[$LBL] CC result: $(grep -oE '"subtype":"[^"]*"|"is_error":[a-z]*|"api_error_status":[^,]*|"result":"[^"]*"' "$DIR/cc.$LBL.cli.log" 2>/dev/null | tr '\n' ' ' | head -c 300)"
  sleep 1
done

# ---- SLOW timeout measurement ----
for spec in "A noheaders:360 8796 380" "B silent:360 8797 380" "C ping:30:330 8798 400"; do
  set -- $spec
  LBL=$1; MODE=$2; PORT=$3; CEIL=$4
  note "----- $LBL mode=$MODE (long) -----"
  MOCK_PORT=$PORT CC_CEIL=$CEIL bash "$RUN" "$LBL" "$MODE" >> "$SUMMARY" 2>&1
  ABORT=$(grep -oE "ABORTED[^]]*\+[0-9.]+s|abort[^]]*\+[0-9.]+s" "$DIR/cc.$LBL.mock.log" 2>/dev/null | head -1)
  ELAPSED=$(grep -oE "elapsed \([0-9]+s\)" "$DIR/cc.$LBL.mock.log" 2>/dev/null | head -1)
  note "[$LBL] disconnect: ${ABORT:-<none>}  survived-window: ${ELAPSED:-<no>}"
  note "[$LBL] CC result: $(grep -oE '"subtype":"[^"]*"|"is_error":[a-z]*|"result":"[^"]*"' "$DIR/cc.$LBL.cli.log" 2>/dev/null | tr '\n' ' ' | head -c 200)"
  sleep 1
done

note "===== DONE  $(date -Is) ====="
