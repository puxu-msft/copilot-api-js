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
#   2. no section OUTSIDE the frozen list matches the frozen predicate. This is
#      a drift tripwire, NOT a completeness proof: it turns red when a new
#      section starts using the vocabulary we froze, and stays green when one
#      participates in Q1 through vocabulary we did not anticipate.
#
# Check 2 has earned its keep twice, and each time by finding a member no
# hand-written list had: 4.12, whose escalation clause ("if review shows the
# existing registry cannot express the required joint query, go back to the
# main session") went unnoticed by five successive lists. And it has also been
# beaten once: 4.8 constrains which options exist at all (":392 forbids dynamic
# compound names for the `command` dimension") while sharing no vocabulary with
# the rest -- review found it by asking a structural question instead. That is
# the standing evidence that this scan does not close the set.
#
# After Q1 is ruled, update EXPECTED below in the same commit that updates the
# RFC. A ruling that lands in some sections but not others shows up here as a
# state mismatch, which is the whole point.
#
# Usage: exp/inter-block-anchor-allocator/q1-locations.sh [--table]
# Exit:  0 all listed sections match expectation and no unlisted one matches
#          the frozen predicate (a tripwire result, not a completeness proof)
#        1 drift (state mismatch, or an unlisted section matches)
#        2 usage / file problems

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DOC="${DOC:-$REPO/docs/rfc/2026-08-03-generation-emission-command-algebra/design.md}"
[ -f "$DOC" ] || { printf 'q1-locations: no such file: %s\n' "$DOC" >&2; exit 2; }

# Content predicate for "this line participates in Q1". Deliberately NOT just
# "Q1": section 4.9 is a member and never spells it.
#
# HONEST BOUNDARY -- read this before quoting the exit code as proof.
# This predicate is natural language, so it is evadable: a future section could
# discuss the same question using "跨轴过滤", "cube", "tuple" or wording nobody
# has thought of, and this script would stay green. Terms named by
# review are folded in below, but folding in the ones we thought of does not
# make the set closed.
# So what exit 0 means is "no NEW section matches a frozen predicate", i.e. a
# drift tripwire -- not "Q1 appears in exactly these seven places". Per the
# project's freeze-hit-set-not-zero-hits rule, the artifact of record is the
# frozen hit set below, not a zero-miss claim. Anyone extending the RFC's
# telemetry discussion still owes a human read.
PREDICATE='Q1|联合查询|joint query|compound dimension|multidimensional|多轴|跨轴|cube|tuple'

# Members of the Q1 set, one per line:
#   section | state-before-ruling | state-after-ruling | kind | match-pattern | note
#
# "match-pattern" is how THIS member is recognised; "-" means use PREDICATE.
# Section 4.8 needs its own: its participation is a naming constraint on the
# compound dimension, and it shares no vocabulary with the rest. Widening
# PREDICATE to catch it (bare "compound") matches 18 sections and turns the
# drift scan into noise, so precision lives per member instead.
#
# Three kinds, do not conflate:
#   statement  -- says something about Q1 today
#   destination -- empty by design today; the ruling must FILL it. Reading that
#                  emptiness as "already in sync" is the easy mistake.
#   constraint -- constrains which options are even available; the ruling has to
#                 say how it resolves the tension, not quietly pick a reading.
#
# PHASE=pre (default) checks the before column; PHASE=post checks the after
# column. Both columns live on the same line so "updated the RFC, forgot the
# script" cannot happen by omission -- flipping PHASE is the whole update.
EXPECTED='
4.7|absent|ruled|destination|-|per-command telemetry 接入形状；裁决后必须写死所选方案的 key 形状
4.8|mentions|ruled|constraint|动态compound名称|:392 禁止 `command` 维使用动态 compound 名称，与选项 A 的 generation_command_outcome 正面相关；裁决必须写明如何化解
4.9|declares-open|ruled|statement|-|compound phase／partial measures；逐字写着选项 A 与 B，却从不写 "Q1"
4.12|declares-open|ruled|statement|-|遥测不是闭合oracle；含升级条款「既有registry无法表达必需联合查询→回主会话裁决」
7.8|declares-open|ruled|statement|-|Commit 5 前置停门；裁决后改为已裁 + 具体迁移任务
9.1|declares-open|ruled|statement|-|问题陈述 + 选项 A/B/C + 推荐
9.2|absent|ruled|destination|-|已裁决表，裁决落盘的正主；裁决后必须含 Q1
9.4|declares-open|ruled|statement|-|停点表；裁决后撤销该停点
'

PHASE="${PHASE:-pre}"
case "$PHASE" in pre|post) ;; *) printf 'q1-locations: PHASE must be pre or post\n' >&2; exit 2 ;; esac

# Emit "<section-number>\t<line-no>\t<line>" for every PREDICATE hit.
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

section_body() {
  awk -v want="$1" '
    /^#{2,4} /{ if (match($0, /[0-9]+\.[0-9]+/)) { cur = substr($0, RSTART, RLENGTH); insec = (cur == want) } }
    insec { print }
  ' "$DOC"
}

# Classify from the MATCHING LINES only, never the whole section. Judging the
# whole body let 9.2's boilerplate ("以下不是open questions：") decide its state:
# once a ruling lands there, that unrelated sentence would report the ruling
# section as "still open" -- the exact opposite of the truth.
state_of() {
  local sec="$1" pat="$2" lines
  [ "$pat" = "-" ] && pat="$PREDICATE"
  lines="$(section_body "$sec" | grep -aE "$pat")"
  if [ -z "$lines" ]; then printf 'absent'; return; fi
  # Order matters: 7.8 says "Q1必须已裁", which is a precondition, not a ruling.
  if printf '%s' "$lines" | grep -aqE 'open question|保持open|仍open|必须已裁|需人裁|不裁决会怎样|回主会话裁决|待主会话'; then
    printf 'declares-open'; return
  fi
  if printf '%s' "$lines" | grep -aqE '已裁决|已裁|裁决为|裁定'; then printf 'ruled'; return; fi
  printf 'mentions'
}

known=""
rc=0
printf '%-6s %-16s %-16s %s\n' SECTION EXPECTED ACTUAL VERDICT
printf 'PHASE=%s\n' "$PHASE"
while IFS='|' read -r sec pre post kind pat note; do
  [ -z "$sec" ] && continue
  known="$known $sec"
  [ "$PHASE" = "post" ] && want="$post" || want="$pre"
  got="$(state_of "$sec" "$pat")"
  if [ "$got" = "$want" ]; then verdict="ok ($kind)"; else verdict="DRIFT ($kind) — $note"; rc=1; fi
  printf '%-6s %-16s %-16s %s\n' "$sec" "$want" "$got" "$verdict"
done <<< "$EXPECTED"

# The load-bearing check: has a section outside the frozen list started using
# the frozen vocabulary? (Green here means no such drift, not a closed set.)
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
