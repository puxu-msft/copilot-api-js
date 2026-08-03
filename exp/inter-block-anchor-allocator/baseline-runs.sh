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
# WHAT THIS SCRIPT CLAIMS, precisely:
#   "the named command was invoked N times at one commit, with per-run
#    provenance recorded, and its self-reported test count was stable and above
#    a floor the caller named."
# WHAT IT DOES NOT CLAIM:
#   "the full backend suite executed."
# The gap is not a wording nicety. MIN_TESTS and the number it checks come from
# the same place -- the command's own summary line -- so a selector that
# silently narrowed will "measure" 6800, the caller will freeze MIN_TESTS=6800
# from that measurement, and every run then agrees with itself. Review built
# exactly that and it stayed green here. Closing it needs an execution-evidence
# channel independent of the runner's own tally: have the run emit junit
# (scripts/parallel-test.ts already drives `--reporter=junit` for timings) and
# compare the testsuite names against a disk-side glob of *.{unit,it,http}.test.ts.
# That is separate work, recorded as T3-b in the handover.
#
# It also does not prove the runs were real to a third party -- nothing local
# can. It removes the failure modes above and makes the artifacts costly to
# fabricate by hand (per-run wall clock, shard timings, full stdout).
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
#   MIN_TESTS    REQUIRED, no default: a run whose summary line reports fewer
#                than this many tests is not counted green. Set it to the test
#                count you expect at this commit.
#                There is deliberately no default. A default of 1 is a paper
#                floor -- a degenerate selector reporting "1 tests · 1 pass"
#                walks straight past it, which is exactly how the fake-`bun`
#                construction came back after the first fix. Making the caller
#                name the number forces the floor to be frozen per entry commit
#                instead of inherited from whatever this script happened to ship
#                with. Use MIN_TESTS=0 only when smoke-testing this script.
#                DERIVE THE FLOOR FROM SOMETHING OTHER THAN THE COMMAND YOU ARE
#                ABOUT TO RUN. Measuring it with the same possibly-degraded
#                selector makes the floor validate itself; see the claim
#                section above.
#                None of this defends against a hostile PATH -- nothing local
#                can -- but the resolved binary, its version and PATH go into
#                every log, and every run in a batch must report the SAME count,
#                so a batch that quietly degrades partway through turns red.

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNS="${RUNS:-15}"
MIN_RUNS="${MIN_RUNS:-15}"
if [ "$#" -gt 0 ]; then CMD=("$@"); else CMD=(bun scripts/parallel-test.ts unit it http); fi
CMD_DISPLAY="$(printf '%q ' "${CMD[@]}")"
ALLOW_DIRTY="${ALLOW_DIRTY:-0}"
STOP_ON_FAIL="${STOP_ON_FAIL:-1}"
if [ -z "${MIN_TESTS:-}" ]; then
  printf 'baseline-runs: MIN_TESTS is required -- name the test count you expect at this commit.\n' >&2
  printf 'There is no default on purpose: MIN_TESTS=1 passes a degenerate run reporting "1 tests".\n' >&2
  printf 'Smoke-testing this script rather than gating? MIN_TESTS=0.\n' >&2
  exit 2
fi
case "$MIN_TESTS" in ''|*[!0-9]*) printf 'baseline-runs: MIN_TESTS must be a non-negative integer, got %s\n' "$MIN_TESTS" >&2; exit 2 ;; esac
first_ntests=""

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
    printf '=== resolves to  : %s\n' "$(command -v "${CMD[0]}" 2>/dev/null || echo '<not on PATH>')"
    printf '=== version      : %s\n' "$("${CMD[0]}" --version 2>&1 | head -1)"
    printf '=== PATH         : %s\n' "$PATH"
    printf '=== stdout+stderr follows\n\n'
  } > "$log"

  before_tree="$(git -C "$REPO" status --porcelain)"
  before_head="$(git -C "$REPO" rev-parse HEAD)"
  start=$(date +%s)
  # No pipe into tee: tee's status would mask the suite's. Append, then read back.
  ( cd "$REPO" && FORCE_COLOR=0 "${CMD[@]}" ) >> "$log" 2>&1
  rc=$?
  end=$(date +%s)
  after_tree="$(git -C "$REPO" status --porcelain)"
  after_head="$(git -C "$REPO" rev-parse HEAD)"

  # A per-run header snapshot taken before the run says nothing about what the
  # tree looked like during it. Someone editing a tracked file mid-run used to
  # leave the batch reporting green against a commit it never actually measured.
  #
  # Comparing only `status` is not enough, and this was a real hole: a commit
  # landing mid-run leaves the porcelain output empty on both sides while HEAD
  # moves underneath, so the batch reported green for a commit it never ran.
  # Both axes are checked; either moving invalidates the run.
  drift=0
  drift_why=""
  if [ "$before_tree" != "$after_tree" ]; then drift=1; drift_why="worktree"; fi
  if [ "$before_head" != "$after_head" ]; then drift=1; drift_why="${drift_why:+$drift_why+}HEAD"; fi
  if [ "$drift" = 1 ]; then failed=$((failed + 1)); fi

  {
    printf '\n=== exit code    : %d\n' "$rc"
    printf '=== finished     : %s\n' "$(date -Is)"
    printf '=== elapsed      : %ds\n' "$((end - start))"
    printf '=== drift        : %s\n' "$([ "$drift" = 1 ] && echo "YES ($drift_why)" || echo no)"
    printf '=== head after   : %s\n' "$after_head"
    if [ "$drift" = 1 ]; then
      printf '%s\n' "$after_tree" | sed 's/^/=== tree after   : /'
    fi
  } >> "$log"

  tail_line="$(grep -a 'parallel-test' "$log" | tail -1)"

  # A run that executed no tests is not a green run. Reported test count is the
  # cheapest thing that distinguishes "the suite ran" from "something printed
  # nothing and exited 0".
  ntests="$(printf '%s' "$tail_line" | grep -aoE '[0-9]+ tests' | head -1 | grep -aoE '[0-9]+')"
  printf '=== tests seen   : %s\n' "${ntests:-none}" >> "$log"
  if [ "${ntests:-0}" -lt "$MIN_TESTS" ] 2>/dev/null; then
    printf '=== too few tests: reported %s, MIN_TESTS=%s\n' "${ntests:-none}" "$MIN_TESTS" >> "$log"
    if [ "$drift" != 1 ]; then failed=$((failed + 1)); fi
    printf 'baseline-runs: run %02d reported %s tests (MIN_TESTS=%s); not counting it green.\n' \
      "$i" "${ntests:-no}" "$MIN_TESTS" >&2
    if [ "$STOP_ON_FAIL" = "1" ]; then exit 1; fi
  fi

  # Every run in a batch must report the same count. A batch that starts honest
  # and degrades partway -- a selector narrowing, a shard silently dropping --
  # clears a fixed floor while measuring less and less.
  if [ -z "$first_ntests" ]; then
    first_ntests="${ntests:-none}"
  elif [ "${ntests:-none}" != "$first_ntests" ]; then
    printf '=== count drift  : run 01 reported %s, this run %s\n' "$first_ntests" "${ntests:-none}" >> "$log"
    if [ "$drift" != 1 ]; then failed=$((failed + 1)); fi
    printf 'baseline-runs: run %02d reported %s tests but run 01 reported %s; the batch is not measuring one thing.\n' \
      "$i" "${ntests:-none}" "$first_ntests" >&2
    if [ "$STOP_ON_FAIL" = "1" ]; then exit 1; fi
  fi
  printf 'run %02d  rc=%d  %ds  drift=%s  %s\n' \
    "$i" "$rc" "$((end - start))" "$([ "$drift" = 1 ] && echo "YES:$drift_why" || echo no)" "${tail_line:-<no summary line>}"

  if [ "$drift" = 1 ]; then
    printf 'baseline-runs: %s changed during run %02d; this run measured no single commit.\n' "$drift_why" "$i" >&2
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
