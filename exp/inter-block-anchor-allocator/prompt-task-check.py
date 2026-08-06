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


def plan_task_definitions(text: str) -> list[tuple[str, str]]:
    """Parse live task definitions together with their owning prompt.

    Population equality alone is insufficient: moving T2.8 from Commit 2's
    live table into Commit 3's live table preserves the 84-id set while sending
    the executor to the wrong phase. The parent section therefore determines a
    canonical prompt owner and is part of the parsed definition.
    """
    out: list[tuple[str, str]] = []
    in_table = False
    table_owner = ""
    current_h2 = ""
    current_h3 = ""
    commit_h2 = re.compile(r"^## Commit (-1|[0-8])(?:\s|$)")
    for line in text.splitlines():
        if line.startswith("## ") and not line.startswith("### "):
            current_h2 = line
            current_h3 = ""
            in_table = False
            continue
        if line.startswith("### ") and not line.startswith("#### "):
            if line == "### 逐 task":
                commit = commit_h2.match(current_h2)
                in_table = bool(commit)
                table_owner = (
                    "commit-minus-1.md" if commit and commit.group(1) == "-1"
                    else f"commit-{commit.group(1)}.md" if commit
                    else ""
                )
            else:
                # "历史逐 task 表" is intentionally not a live definition
                # source. Substring matching let a same-Commit archive table
                # keep a removed task alive.
                current_h3 = line
                in_table = False
                table_owner = ""
            continue
        if line.startswith("#### "):
            # The post-merge table has one exact canonical heading. A historical
            # heading that merely contains these words is not authoritative.
            in_table = line == "#### Post-merge 逐 task" and current_h3.startswith("### 0.4f ")
            table_owner = "post-merge-preflight.md" if in_table else ""
            continue
        if not in_table:
            continue
        match = re.match(r"^\| \*\*(T\d+\.\d+[a-z]?)\*\*(?:[^|]*)\|", line)
        if match:
            out.append((match.group(1), table_owner))
    return out


def task_id_owner(task: str) -> str:
    """Derive the only legal phase owner from the frozen task-id grammar.

    Parent headings are not sufficient: a whole live-looking table can be moved
    beneath the wrong Commit heading. The id prefix is an independent axis.
    """
    if re.fullmatch(r"T0\.0[abce]", task):
        return "commit-minus-1.md"
    if re.fullmatch(r"T0\.0[df]", task):
        return "post-merge-preflight.md"
    match = re.fullmatch(r"T([0-8])\.\d+[a-z]?", task)
    if not match:
        raise ValueError(f"task id has no owner rule: {task}")
    return f"commit-{match.group(1)}.md"


def main() -> int:
    if not PLAN.is_file() or not PROMPTS.is_dir():
        print("prompt-task-check: missing cutover plan or prompts directory", file=sys.stderr)
        return 2

    definitions = plan_task_definitions(PLAN.read_text(encoding="utf-8"))
    definition_ids = [task for task, _owner in definitions]
    duplicate_definitions = sorted(task for task, count in Counter(definition_ids).items() if count > 1)
    plan_tasks = set(definition_ids)
    expected_owner = dict(definitions)
    invalid_plan_owners = sorted(
        f"{task}: table={owner}, id-rule={task_id_owner(task)}"
        for task, owner in definitions
        if owner != task_id_owner(task)
    )
    prompt_files = {p.name for p in PROMPTS.glob("*.md") if p.name != "README.md"}
    missing_files = EXPECTED_PROMPTS - prompt_files
    extra_files = prompt_files - EXPECTED_PROMPTS
    failures: list[str] = []
    if duplicate_definitions:
        failures.append(f"duplicate plan task definitions: {duplicate_definitions}")
    if invalid_plan_owners:
        failures.append(f"plan task definitions under wrong phases: {invalid_plan_owners}")
    if missing_files:
        failures.append(f"missing prompt files: {sorted(missing_files)}")
    if extra_files:
        failures.append(f"unexpected prompt files: {sorted(extra_files)}")

    ownership: Counter[str] = Counter()
    actual_owner: dict[str, str] = {}
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
            actual_owner.setdefault(task, name)

    prompt_task_set = set(ownership)
    duplicates = sorted(task for task, count in ownership.items() if count != 1)
    orphans = sorted(prompt_task_set - plan_tasks)
    unassigned = sorted(plan_tasks - prompt_task_set)
    wrong_phase = sorted(
        f"{task}: plan={expected_owner[task]}, prompt={actual_owner[task]}"
        for task in plan_tasks & prompt_task_set
        if expected_owner[task] != actual_owner[task]
    )
    if duplicates:
        failures.append(f"duplicate prompt owners: {duplicates}")
    if orphans:
        failures.append(f"orphan prompt tasks: {orphans}")
    if unassigned:
        failures.append(f"unassigned plan tasks: {unassigned}")
    if wrong_phase:
        failures.append(f"wrong prompt owners: {wrong_phase}")

    print(f"plan tasks: {len(plan_tasks)}")
    print(f"prompt tasks: {len(prompt_task_set)}")
    print(f"duplicates: {'none' if not duplicates else duplicates}")
    print(f"orphans: {'none' if not orphans else orphans}")
    print(f"unassigned: {'none' if not unassigned else unassigned}")
    print(f"wrong-phase: {'none' if not wrong_phase else wrong_phase}")
    if failures:
        for failure in failures:
            print(f"FAIL: {failure}", file=sys.stderr)
        return 1
    print("prompt-task-check: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
