#!/usr/bin/env python3
"""Reconcile the frozen job-tmp inventory against the class table in the Task 37 closeout manifest.

Why this exists at all: the manifest's class table originally reconciled to a *remembered* total, and that total was wrong in a way worth naming — it mixed a **top-level** extension count with a **whole-tree** class count, so its rows summed to a number matching neither selector. Recomputing the table from the named set is what makes "合计 427" a checkable statement rather than a recollection.

Two corrections this script already survived, kept because both are easy to reintroduce:

- **The input must be the committed `.md` inventory.** An earlier version pointed at a `.txt`, which `.gitignore` swallows; the file was renamed, and the script then raised `FileNotFoundError`, making the manifest's "reconciled OK" claim unreproducible for anyone who tried to follow it.
- **The load-bearing check is header-vs-lines, not `sum(counter) == len(members)`.** The latter is a same-source identity: it holds by construction and proves nothing at all.

A third was found when this file was archived: its inventory path was hard-coded into a *worktree* (`.claude/worktrees/task37-closeout/…`) that closeout then deleted, so it broke again in exactly the way the first correction had fixed. The path now resolves from this file's own location, and can be overridden by argv[1].

Usage:
    python3 exp/task37-closeout-inventory/reconcile-inventory.py [path/to/inventory.md]
"""

import re
import sys
from collections import Counter
from pathlib import Path

DEFAULT_INV = (
    Path(__file__).resolve().parents[2]
    / "docs"
    / "tmp"
    / "2026-08-09-task37-closeout-tmp-inventory.md"
)

EDIT_SCRIPT = re.compile(
    r"^(fix|resolve|rewrite|wire|retarget|adapt|trim|use|settle|revert|arm|pair|dedup|close|annotate"
    r"|baseline-temp|anchor|diff-files|list-unclassified|add-baseline|regen-baseline|rebuild-baseline"
    r"|register-|sort-skips|classify-skips|freeze-inventory|recompute-)"
)


def classify(kind: str, path: str) -> str:
    name = path.rsplit("/", 1)[-1]
    if kind == "l":
        return "符号链接（指向 node_modules）"
    if name.endswith(".py"):
        return "一次性编辑/整改脚本 (.py)" if EDIT_SCRIPT.match(name) else "探针/分析脚本 (.py)"
    if name.endswith((".patch", ".diff")):
        return "变异/临时 patch"
    if name.endswith((".txt", ".log")):
        return "命令输出/门禁日志"
    if name.endswith(".ts"):
        return "临时 TS 探针"
    if name.endswith((".xml", ".json")):
        return "JUnit/结构化产物"
    if name.endswith(".md"):
        return "报告草稿"
    return "其他"


def main() -> int:
    inv = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else DEFAULT_INV
    if not inv.is_file():
        print(f"inventory not found: {inv}", file=sys.stderr)
        return 2

    declared: int | None = None
    members: list[tuple[str, str]] = []
    for line in inv.read_text(encoding="utf-8").splitlines():
        if line.startswith("#"):
            m = re.match(r"#\s*members:\s*(\d+)", line)
            if m:
                declared = int(m.group(1))
            continue
        if not line.strip():
            continue
        kind, path = line.split("\t", 1)
        members.append((kind, path))

    if declared is None:
        print("inventory header has no `# members:` line — cannot cross-validate", file=sys.stderr)
        return 2
    if declared != len(members):
        print(
            f"header declares {declared} members but the file lists {len(members)} — inventory is inconsistent",
            file=sys.stderr,
        )
        return 1

    counts = Counter(classify(k, p) for k, p in members)
    print(f"inventory: {inv}")
    print(f"header `# members`: {declared}  ==  listed member lines: {len(members)}  -> OK")
    for label, n in counts.most_common():
        print(f"{n:5d}  {label}")
    print(
        f"{sum(counts.values()):5d}  == class total (equal to the member count by construction; "
        "the load-bearing check is the header/lines match above)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
