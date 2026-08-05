#!/usr/bin/env python3
"""Validate task ownership across third-layer cutover prompts.

The task population SSOT is cutover-plan.md. Prompts declare their assigned
set twice in identical HTML markers: one near the heading and one near the
phase task section, so a human sees the ownership in both reading contexts.
The checker verifies both copies agree but counts each task once per prompt.

Exit: 0 exact task-set equality and one prompt owner per task
      1 population/marker failure
      2 usage/parse failure
"""

from __future__ import annotations

import os
import pathlib
import re
import sys
from collections import Counter

ROOT = pathlib.Path(__file__).resolve().parents[2]
RFC_DIR = ROOT / "docs/rfc/2026-08-03-generation-emission-command-algebra"
PLAN = pathlib.Path(os.environ.get("PLAN") or RFC_DIR / "cutover-plan.md")
PROMPTS = pathlib.Path(os.environ.get("PROMPTS") or RFC_DIR / "prompts")
TASK_RE = re.compile(r"\bT\d+\.\d+[a-z]?\b")
MARKER_RE = re.compile(r"<!-- prompt-task-ids: ([^>]+) -->")
EXPECTED_PROMPTS = {
    "commit-minus-1.md",
    "post-merge-preflight.md",
    *{f"commit-{n}.md" for n in range(9)},
}


def prompt_tasks(text: str) -> set[str]:
    """Task references inside prompt ownership markers."""
    return set(TASK_RE.findall(text))


def plan_task_definitions(text: str) -> list[str]:
    """Parse only rows in explicitly headed ``逐 task`` tables.

    Row shape alone is not a definition boundary. A rejected/historical section
    can preserve a whole former task row verbatim; treating that as live made a
    definition movable into section 12 without changing the population. The
    plan now names every live definition table with a heading containing
    ``逐 task`` (including the post-merge table in section 0.4f).
    """
    out: list[str] = []
    in_table = False
    current_h2 = ""
    current_h3 = ""
    commit_h2 = re.compile(r"^## Commit (?:-1|[0-8])(?:\s|$)")
    for line in text.splitlines():
        if line.startswith("## ") and not line.startswith("### "):
            current_h2 = line
            current_h3 = ""
            in_table = False
            continue
        if line.startswith("### ") and not line.startswith("#### "):
            if "逐 task" in line:
                # Live commit task tables only. A verbatim task table moved to
                # section 12 (even under a heading named "历史逐 task 表") is
                # historical prose, not a definition source.
                in_table = bool(commit_h2.match(current_h2))
            else:
                current_h3 = line
                in_table = False
            continue
        if line.startswith("#### "):
            # Post-merge tasks live under the one non-Commit definition owner,
            # section 0.4f. No other h4 "逐 task" heading is authoritative.
            in_table = "逐 task" in line and current_h3.startswith("### 0.4f ")
            continue
        if not in_table:
            continue
        match = re.match(r"^\| \*\*(T\d+\.\d+[a-z]?)\*\*(?:[^|]*)\|", line)
        if match:
            out.append(match.group(1))
    return out


def main() -> int:
    if not PLAN.is_file() or not PROMPTS.is_dir():
        print("prompt-task-check: missing cutover plan or prompts directory", file=sys.stderr)
        return 2

    definitions = plan_task_definitions(PLAN.read_text(encoding="utf-8"))
    duplicate_definitions = sorted(task for task, count in Counter(definitions).items() if count > 1)
    plan_tasks = set(definitions)
    prompt_files = {p.name for p in PROMPTS.glob("*.md") if p.name != "README.md"}
    missing_files = EXPECTED_PROMPTS - prompt_files
    extra_files = prompt_files - EXPECTED_PROMPTS
    failures: list[str] = []
    if duplicate_definitions:
        failures.append(f"duplicate plan task definitions: {duplicate_definitions}")
    if missing_files:
        failures.append(f"missing prompt files: {sorted(missing_files)}")
    if extra_files:
        failures.append(f"unexpected prompt files: {sorted(extra_files)}")

    ownership: Counter[str] = Counter()
    for name in sorted(EXPECTED_PROMPTS & prompt_files):
        markers = MARKER_RE.findall((PROMPTS / name).read_text(encoding="utf-8"))
        if len(markers) != 2:
            failures.append(f"{name}: expected exactly 2 task markers, got {len(markers)}")
            continue
        first, second = prompt_tasks(markers[0]), prompt_tasks(markers[1])
        if first != second:
            failures.append(
                f"{name}: heading/task-section markers disagree "
                f"(only-first={sorted(first - second)}, only-second={sorted(second - first)})"
            )
        for task in first:
            ownership[task] += 1

    prompt_task_set = set(ownership)
    duplicates = sorted(task for task, count in ownership.items() if count != 1)
    orphans = sorted(prompt_task_set - plan_tasks)
    unassigned = sorted(plan_tasks - prompt_task_set)
    if duplicates:
        failures.append(f"duplicate prompt owners: {duplicates}")
    if orphans:
        failures.append(f"orphan prompt tasks: {orphans}")
    if unassigned:
        failures.append(f"unassigned plan tasks: {unassigned}")

    print(f"plan tasks: {len(plan_tasks)}")
    print(f"prompt tasks: {len(prompt_task_set)}")
    print(f"duplicates: {'none' if not duplicates else duplicates}")
    print(f"orphans: {'none' if not orphans else orphans}")
    print(f"unassigned: {'none' if not unassigned else unassigned}")
    if failures:
        for failure in failures:
            print(f"FAIL: {failure}", file=sys.stderr)
        return 1
    print("prompt-task-check: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
