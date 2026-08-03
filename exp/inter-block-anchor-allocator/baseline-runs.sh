#!/usr/bin/env bash
# Capture N independent full-suite runs as verifiable artifacts.
#
# Why this exists as a script rather than a recipe in a handover: the handover
# originally described the provenance ("record date, HEAD, dirty state, full
# stdout") in prose, and review pointed out three ways a prose recipe fails --
# provenance written in a different shell than the run it claims to describe,
# no check that the tree matches the commit being claimed, and `cmd | tee log`
# reporting tee's exit status so a red run looks green. Each run here writes its
# own provenance and its own exit code into the same file, in the same shell,
# around the same invocation.
#
# It still does not prove the runs were real to a third party -- nothing local
# can. It only removes the failure modes above and makes the artifacts costly
# to fabricate by hand (per-run wall clock, shard timings, full stdout).
#
# Usage:
#   OUT=docs/tmp/2026-08-04-entry-runs RUNS=15 exp/inter-block-anchor-allocator/baseline-runs.sh
#
# The command defaults to the full backend suite. To override, pass it as
# positional arguments -- NOT through a string env var, which word-splits and
# silently mangles anything quoted (that bug was in this script's first draft
# and made its own red-path control pass for the wrong reason):
#   OUT=/tmp/x RUNS=2 baseline-runs.sh bun scripts/parallel-test.ts unit
#
# Env:
#   OUT          required, output directory (created; must not already hold run-*.log)
#   RUNS         number of runs, default 15; must be >= MIN_RUNS
#   MIN_RUNS     floor, default 15 -- a batch smaller than this cannot report green.
#                Lower it deliberately when smoke-testing this script itself; never
#                for a gate. RUNS=0 previously reported "0/0 green" with rc 0, which
#                is a criterion that passes on an empty population.
#   ALLOW_DIRTY  set to 1 to run against a dirty tree; the dirt is still recorded
#                and every log is marked DIRTY. Do not use this for a gate.
#   STOP_ON_FAIL set to 0 to keep going after a red run, default 1

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNS="${RUNS:-15}"
MIN_RUNS="${MIN_RUNS:-15}"
if [ "$#" -gt 0 ]; then CMD=("$@"); else CMD=(bun scripts/parallel-test.ts unit it http); fi
CMD_DISPLAY="$(printf '%q ' "${CMD[@]}")"
ALLOW_DIRTY="${ALLOW_DIRTY:-0}"
STOP_ON_FAIL="${STOP_ON_FAIL:-1}"

case "$RUNS" in ''|*[!0-9]*) printf 'baseline-runs: RUNS must be a non-negative integer, got %s\n' "$RUNS" >&2; exit 2 ;; esac
case "$MIN_RUNS" in ''|*[!0-9]*) printf 'baseline-runs: MIN_RUNS must be a non-negative integer, got %s\n' "$MIN_RUNS" >&2; exit 2 ;; esac
if [ "$RUNS" -lt "$MIN_RUNS" ]; then
  printf 'baseline-runs: RUNS=%s is below MIN_RUNS=%s; a batch this small cannot report green.\n' "$RUNS" "$MIN_RUNS" >&2
  printf 'A zero-length batch would otherwise print "0/0 green" and exit 0 -- green on an empty population.\n' >&2
  exit 2
fi

if [ -z "${OUT:-}" ]; then
  printf 'baseline-runs: set OUT to an output directory\n' >&2
  exit 2
fi
case "$OUT" in
  /*) OUT_DIR="$OUT" ;;
  *)  OUT_DIR="$REPO/$OUT" ;;
esac
mkdir -p "$OUT_DIR"
if compgen -G "$OUT_DIR/run-*.log" > /dev/null; then
  printf 'baseline-runs: %s already contains run-*.log; refusing to mix batches\n' "$OUT_DIR" >&2
  exit 2
fi

dirty="$(git -C "$REPO" status --porcelain)"
if [ -n "$dirty" ] && [ "$ALLOW_DIRTY" != "1" ]; then
  printf 'baseline-runs: working tree is dirty, so a run here does not measure the commit it would claim.\n' >&2
  printf 'Either clean the tree, or set ALLOW_DIRTY=1 (the logs are then marked DIRTY and do not satisfy a gate).\n' >&2
  printf '%s\n' "$dirty" >&2
  exit 3
fi

head_sha="$(git -C "$REPO" rev-parse HEAD)"
printf 'baseline-runs: %s runs of [%s] at %s (%s)\n' \
  "$RUNS" "$CMD_DISPLAY" "${head_sha:0:8}" "$([ -n "$dirty" ] && echo DIRTY || echo clean)"

failed=0
for i in $(seq 1 "$RUNS"); do
  log="$(printf '%s/run-%02d.log' "$OUT_DIR" "$i")"
  {
    printf '=== run          : %d of %d\n' "$i" "$RUNS"
    printf '=== started      : %s\n' "$(date -Is)"
    printf '=== repo         : %s\n' "$REPO"
    printf '=== head         : %s\n' "$(git -C "$REPO" rev-parse HEAD)"
    printf '=== tree         : %s\n' "$([ -n "$(git -C "$REPO" status --porcelain)" ] && echo DIRTY || echo clean)"
    git -C "$REPO" status --porcelain | sed 's/^/=== dirt         : /'
    printf '=== command      : %s\n' "$CMD_DISPLAY"
    printf '=== stdout+stderr follows\n\n'
  } > "$log"

  before_tree="$(git -C "$REPO" status --porcelain)"
  start=$(date +%s)
  # No pipe into tee: tee's status would mask the suite's. Append, then read back.
  ( cd "$REPO" && FORCE_COLOR=0 "${CMD[@]}" ) >> "$log" 2>&1
  rc=$?
  end=$(date +%s)
  after_tree="$(git -C "$REPO" status --porcelain)"

  # A per-run header snapshot taken before the run says nothing about what the
  # tree looked like during it. Someone editing a tracked file mid-run used to
  # leave the batch reporting green against a commit it never actually measured.
  drift=0
  if [ "$before_tree" != "$after_tree" ]; then
    drift=1
    failed=$((failed + 1))
  fi

  {
    printf '\n=== exit code    : %d\n' "$rc"
    printf '=== finished     : %s\n' "$(date -Is)"
    printf '=== elapsed      : %ds\n' "$((end - start))"
    printf '=== tree drift   : %s\n' "$([ "$drift" = 1 ] && echo YES || echo no)"
    if [ "$drift" = 1 ]; then
      printf '%s\n' "$after_tree" | sed 's/^/=== after        : /'
    fi
  } >> "$log"

  tail_line="$(grep -a 'parallel-test' "$log" | tail -1)"
  printf 'run %02d  rc=%d  %ds  drift=%s  %s\n' \
    "$i" "$rc" "$((end - start))" "$([ "$drift" = 1 ] && echo YES || echo no)" "${tail_line:-<no summary line>}"

  if [ "$drift" = 1 ]; then
    printf 'baseline-runs: the working tree changed during run %02d; this run measured no single commit.\n' "$i" >&2
    if [ "$STOP_ON_FAIL" = "1" ]; then
      printf 'baseline-runs: stopping. Log: %s\n' "$log" >&2
      exit 1
    fi
  fi

  if [ "$rc" -ne 0 ]; then
    if [ "$drift" != 1 ]; then failed=$((failed + 1)); fi
    if [ "$STOP_ON_FAIL" = "1" ]; then
      printf 'baseline-runs: run %02d exited %d; stopping. Log: %s\n' "$i" "$rc" "$log" >&2
      exit 1
    fi
  fi
done

if [ "$failed" -ne 0 ]; then
  printf 'baseline-runs: %d of %d runs failed or drifted\n' "$failed" "$RUNS" >&2
  exit 1
fi
if [ "$RUNS" -lt 1 ]; then
  printf 'baseline-runs: refusing to report green on an empty batch\n' >&2
  exit 2
fi
printf 'baseline-runs: %d/%d green at %s; artifacts in %s\n' "$RUNS" "$RUNS" "${head_sha:0:8}" "$OUT_DIR"
