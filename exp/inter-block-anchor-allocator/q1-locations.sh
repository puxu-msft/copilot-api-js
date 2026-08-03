#!/usr/bin/env bash
# Report every section of the command-algebra RFC that participates in Q1
# (per-command telemetry joint-query capability), and fail if the set drifts.
#
# Why a script: the handover's Q1 consistency criterion went through three
# broken oracles. The first listed three locations, the second four, the third
# five -- and each was assembled by grepping for the literal string "Q1". That
# query cannot see section 4.9, which states the open question and names
# options A and B verbatim without ever writing "Q1". A criterion whose
# completeness rests on a query that structurally cannot find one of its
# members is not a criterion.
#
# So this checks two different things, and the second is the load-bearing one:
#   1. each known location still holds the state it is supposed to hold;
#   2. NO OTHER section matches the Q1 content predicate -- i.e. the list is
#      still complete. Adding a location anywhere must turn this red.
#
# Check 2 earned its keep on first run: it found 4.12, whose escalation clause
# ("if review shows the existing registry cannot express the required joint
# query, go back to the main session") is a Q1 member that five hand-written
# lists in a row had missed.
#
# After Q1 is ruled, update EXPECTED below in the same commit that updates the
# RFC. A ruling that lands in some sections but not others shows up here as a
# state mismatch, which is the whole point.
#
# Usage: exp/inter-block-anchor-allocator/q1-locations.sh [--table]
# Exit:  0 all listed sections match expectation and no unlisted one matches
#        1 drift (state mismatch, or an unlisted section matches)
#        2 usage / file problems

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DOC="${DOC:-$REPO/docs/rfc/2026-08-03-generation-emission-command-algebra/design.md}"
[ -f "$DOC" ] || { printf 'q1-locations: no such file: %s\n' "$DOC" >&2; exit 2; }

# Content predicate for "this line participates in Q1". Deliberately NOT just
# "Q1": section 4.9 is a member and never spells it.
PREDICATE='Q1|联合查询|compound dimension|multidimensional'

# Two kinds of member, do not conflate them:
#   statement  -- says something about Q1 today; expected "declares-open"
#   destination -- silent today by design, must be FILLED by the ruling;
#                  expected "absent" now, and the ruling must flip it
#
# section | expected-now | kind | responsibility / what the ruling must do to it
EXPECTED='
4.7|absent|destination|per-command telemetry 接入形状；裁决后必须写死所选方案的 key 形状
4.9|declares-open|statement|compound phase／partial measures；逐字写着选项 A 与 B，却从不写 "Q1"
4.12|declares-open|statement|遥测不是闭合oracle；含升级条款「既有registry无法表达必需联合查询→回主会话裁决」
7.8|declares-open|statement|Commit 5 前置停门；裁决后改为已裁 + 具体迁移任务
9.1|declares-open|statement|问题陈述 + 选项 A/B/C + 推荐
9.2|absent|destination|已裁决表，裁决落盘的正主；裁决后必须含 Q1
9.4|declares-open|statement|停点表；裁决后撤销该停点
'

# Emit "<section-number>\t<line-no>\t<line>" for every predicate hit.
hits() {
  awk -v pred="$PREDICATE" '
    BEGIN { cur = "(preamble)" }
    # A sub-heading without its own number (e.g. "#### Q1. ...") belongs to the
    # numbered section above it. Resetting to "?" here hid three option lines
    # inside 9.1 from this very check.
    /^#{2,4} /            { if (match($0, /[0-9]+\.[0-9]+/)) cur = substr($0, RSTART, RLENGTH)
                            next }
    $0 ~ pred             { printf "%s\t%d\t%s\n", cur, NR, substr($0, 1, 90) }
  ' "$DOC"
}

state_of() {
  local sec="$1" body
  body="$(awk -v want="$sec" '
    /^#{2,4} /{ if (match($0, /[0-9]+\.[0-9]+/)) { cur = substr($0, RSTART, RLENGTH); insec = (cur == want) } }
    insec { print }
  ' "$DOC")"
  if [ -z "$(printf '%s' "$body" | grep -aE "$PREDICATE")" ]; then printf 'absent'; return; fi
  # Keep this set wide. A narrow one misfiled 9.1 -- the open-questions section
  # itself -- as merely mentioning the cube, because it says "需人裁" rather
  # than "open question".
  if printf '%s' "$body" | grep -aqE 'open question|保持open|仍open|必须已裁|需人裁|不裁决会怎样|回主会话裁决|待主会话'; then printf 'declares-open'; return; fi
  printf 'silent-on-cube'
}

known=""
rc=0
printf '%-6s %-16s %-16s %s\n' SECTION EXPECTED ACTUAL VERDICT
while IFS='|' read -r sec want kind note; do
  [ -z "$sec" ] && continue
  known="$known $sec"
  got="$(state_of "$sec")"
  if [ "$got" = "$want" ]; then verdict="ok ($kind)"; else verdict="DRIFT ($kind) — $note"; rc=1; fi
  printf '%-6s %-16s %-16s %s\n' "$sec" "$want" "$got" "$verdict"
done <<< "$EXPECTED"

# The load-bearing check: has a seventh location appeared?
extra="$(hits | awk '{print $1}' | sort -u | while read -r s; do
  case " $known " in *" $s "*) ;; *) echo "$s" ;; esac
done)"
if [ -n "$extra" ]; then
  rc=1
  printf '\nq1-locations: UNLISTED section(s) match the Q1 predicate: %s\n' "$(printf '%s' "$extra" | tr '\n' ' ')" >&2
  printf 'Either add them to EXPECTED, or the RFC grew a Q1 statement somewhere it should not have.\n' >&2
  hits | while IFS=$'\t' read -r s n l; do
    case " $known " in *" $s "*) ;; *) printf '  %s:%s  %s\n' "$s" "$n" "$l" >&2 ;; esac
  done
fi

[ "${1:-}" = "--table" ] && { printf '\nAll predicate hits:\n'; hits | sed 's/^/  /'; }

if [ "$rc" -eq 0 ]; then
  printf '\nq1-locations: %d/%d as expected, no unlisted section\n' \
    "$(printf '%s' "$EXPECTED" | grep -c '|')" "$(printf '%s' "$EXPECTED" | grep -c '|')"
fi
exit "$rc"
