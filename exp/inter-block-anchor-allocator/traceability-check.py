#!/usr/bin/env python3
"""Validate the cutover traceability matrix.

The matrix asserts three things a reviewer cannot check by reading:
  1. every acceptance id appears exactly once and carries an owning commit;
  2. NOT-YET-IN-SCOPE is a frozen five, not a label anyone may claim -- otherwise
     it is an escape hatch, and R-14 (the one whose absence ships a green
     regression) walks out through it;
  3. no gate sits in a commit earlier than the capability it depends on.

Deliberately NOT checked here: how each id is tested, its mutation control, its
false-red control. Those live in RFC 10.2 and are not copied, because one table
maintained in two places drifts -- this directory has already been bitten by
that once.

Exit: 0 all checks pass (reverse trace may be pending, said so on stdout)
      1 a check failed
      2 usage / parse problem
"""

import os
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
RFC_DIR = ROOT / "docs/rfc/2026-08-03-generation-emission-command-algebra"

# Overridable so the mutation controls can run against copies. Without this the
# only way to exercise a control is to mutate the real document, which is how a
# control ends up leaving debris in a shared tree.
MATRIX = pathlib.Path(os.environ.get("MATRIX") or RFC_DIR / "traceability.md")
DESIGN = pathlib.Path(os.environ.get("DESIGN") or RFC_DIR / "design.md")
PLAN = pathlib.Path(os.environ.get("PLAN") or RFC_DIR / "cutover-plan.md")

# Frozen per RFC 10.3/10.4. O-4 is partial: its targeted reuse is in scope,
# only the full real-SDK acceptance is not.
FROZEN_DEFERRED = {"O-3", "O-4", "O-5", "O-7", "O-9"}

FAILS: list[str] = []
NOTES: list[str] = []


def fail(msg: str) -> None:
    FAILS.append(msg)


def rows(text: str, id_re: str) -> dict[str, list[str]]:
    """Markdown table rows keyed by id, value = list of cells."""
    out: dict[str, list[str]] = {}
    for line in text.splitlines():
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if cells and re.fullmatch(id_re, cells[0]):
            if cells[0] in out:
                fail(f"{cells[0]} appears more than once in the matrix")
            out[cells[0]] = cells
    return out


def commits(cell: str) -> list[int]:
    return [int(n) for n in re.findall(r"\bC(\d)\b", cell)]


def production_gates(cell: str) -> list[int]:
    """Commits whose tier on the same segment is the production hard gate."""
    found = []
    for seg in re.split(r"[·・]", cell):
        if "production 硬门" in seg:
            found.extend(commits(seg))
    return found


def main() -> int:
    for p in (MATRIX, DESIGN):
        if not p.is_file():
            print(f"traceability-check: missing {p}", file=sys.stderr)
            return 2

    matrix = MATRIX.read_text(encoding="utf-8")
    design = DESIGN.read_text(encoding="utf-8")

    r_rows = rows(matrix, r"R-\d+")
    o_rows = rows(matrix, r"O-\d+")

    # --- 1. population: every id declared in the RFC must appear here ---
    rfc_r = {f"R-{n}" for n in re.findall(r"(?<![0-9A-Za-z-])R-(\d+)(?![0-9A-Za-z-])", design)}
    rfc_o = {f"O-{n}" for n in re.findall(r"(?<![0-9A-Za-z-])O-(\d+)(?![0-9A-Za-z-])", design)}
    for missing in sorted(rfc_r - set(r_rows), key=lambda s: int(s[2:])):
        fail(f"{missing} is in the RFC but has no row in the matrix (orphan: acceptance with no owner)")
    for missing in sorted(rfc_o - set(o_rows), key=lambda s: int(s[2:])):
        fail(f"{missing} is in the RFC but has no row in the matrix (orphan)")

    # --- 2. in-scope rows must own at least one commit ---
    for rid, cells in r_rows.items():
        state = cells[-1]
        if state == "IN-SCOPE" and not commits(cells[1]):
            fail(f"{rid} is IN-SCOPE but names no owning commit")
        if state.startswith("NOT-YET") and rid not in FROZEN_DEFERRED:
            fail(
                f"{rid} claims NOT-YET-IN-SCOPE, which is a frozen list of "
                f"{sorted(FROZEN_DEFERRED)} -- an id outside it using that label "
                f"is the escape hatch this check exists to close"
            )

    # --- 3. deferred set is exactly the frozen five, and each names a phase ---
    deferred = {i for i, c in o_rows.items() if "NOT-YET-IN-SCOPE" in c[-1]}
    if deferred != FROZEN_DEFERRED:
        fail(
            f"deferred set is {sorted(deferred)}, frozen list is "
            f"{sorted(FROZEN_DEFERRED)} (added: {sorted(deferred - FROZEN_DEFERRED)}, "
            f"dropped: {sorted(FROZEN_DEFERRED - deferred)})"
        )

    # Section 8 covers the M series with one range row; M7 appears once in the
    # whole RFC. Literal-hit matching would fail O-9 on the correct document.
    scope_out = design.split("## 8.")[1].split("## 9.")[0] if "## 8." in design else ""
    ranges = [(int(a), int(b)) for a, b in re.findall(r"M(\d)\s*[～~-]\s*M(\d)", scope_out)]

    def phase_resolves(name: str) -> bool:
        if re.fullmatch(r"P\d", name):
            return name in scope_out
        m = re.fullmatch(r"M(\d)", name)
        if not m:
            return False
        n = int(m.group(1))
        return name in scope_out or any(lo <= n <= hi for lo, hi in ranges)

    for oid in sorted(deferred):
        named = re.findall(r"\b([MP]\d)\b", o_rows[oid][2])
        if not named:
            fail(f"{oid} is NOT-YET-IN-SCOPE but names no successor phase")
            continue
        for ph in named:
            if not phase_resolves(ph):
                fail(f"{oid} defers to {ph}, which resolves to no row or range in RFC section 8 (roadmap break)")

    # --- 4. no gate earlier than the capability it depends on ---
    for rid, cells in r_rows.items():
        gates, deps = production_gates(cells[1]), commits(cells[2])
        if gates and deps and min(gates) < max(deps):
            fail(
                f"{rid}: production gate at C{min(gates)} precedes the capability "
                f"it depends on (C{max(deps)}) -- a gate written before its "
                f"capability gets ticked off against the wrong thing"
            )

    # --- 5. reverse trace, once the plan layer exists ---
    tbd = sum(1 for c in list(r_rows.values()) + list(o_rows.values()) if "_TBD_" in "|".join(c))
    if PLAN.is_file():
        if tbd:
            fail(f"cutover-plan.md exists but {tbd} matrix row(s) still say _TBD_ for their plan task")
        plan = PLAN.read_text(encoding="utf-8")
        task_ids = set(re.findall(r"\bT\d+\.\d+\b", plan))
        cited = set(re.findall(r"\bT\d+\.\d+\b", matrix))
        for orphan in sorted(task_ids - cited):
            fail(f"plan task {orphan} is cited by no matrix row (task with no RFC source)")
    else:
        NOTES.append(f"reverse trace pending: {PLAN.name} does not exist yet ({tbd} rows marked _TBD_)")

    print(f"traceability-check: {len(r_rows)} R rows, {len(o_rows)} O rows, "
          f"{len(deferred)} deferred")
    for n in NOTES:
        print(f"  note: {n}")
    if FAILS:
        print()
        for f in FAILS:
            print(f"FAIL: {f}", file=sys.stderr)
        return 1
    print("traceability-check: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
