#!/usr/bin/env python3

import hashlib
import json
import re
from pathlib import Path


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def read_frontmatter_name(path: Path) -> str:
    lines = path.read_text(encoding="utf-8").splitlines()
    require(bool(lines) and lines[0] == "---", f"dependency lacks frontmatter: {path}")
    end = lines.index("---", 1)
    names = [line.partition(":")[2].strip() for line in lines[1:end] if line.partition(":")[0] == "name"]
    require(len(names) == 1 and bool(names[0]), f"dependency has invalid name field: {path}")
    return names[0]


def resolve_dependency(project_root: Path, dependency: dict[str, str]) -> Path:
    relative_path = dependency["relative_path"]
    scope = dependency["scope"]
    if scope == "project":
        candidates = [project_root / relative_path]
    elif scope == "user":
        candidates = [Path.home() / ".claude/skills" / relative_path]
    elif scope == "superpowers-plugin":
        plugin_root = Path.home() / ".claude/plugins/cache/superpowers-marketplace/superpowers"
        candidates = sorted(plugin_root.glob(f"*/{relative_path}"), reverse=True)
    else:
        raise SystemExit(f"unknown dependency scope: {scope}")
    existing = [candidate.resolve() for candidate in candidates if candidate.is_file()]
    require(bool(existing), f"unresolved skill dependency: {dependency['name']}")
    return existing[0]


def main() -> None:
    evals_dir = Path(__file__).resolve().parent
    skill_dir = evals_dir.parent
    project_root = skill_dir.parents[2]
    skill_path = skill_dir / "SKILL.md"
    skill_text = skill_path.read_text(encoding="utf-8")
    skill_lines = skill_text.splitlines()
    skill_hash = sha256_text(skill_text)

    require(skill_lines[0] == "---", "SKILL.md must start with YAML frontmatter")
    frontmatter_end = skill_lines.index("---", 1)
    fields = {}
    for line in skill_lines[1:frontmatter_end]:
        key, separator, value = line.partition(":")
        require(bool(separator), f"invalid frontmatter line: {line!r}")
        fields[key] = value.strip()
    require(set(fields) == {"name", "description"}, f"unexpected frontmatter fields: {sorted(fields)}")
    require(fields["name"] == "delivering-in-validated-batches", "skill name mismatch")
    require(bool(re.fullmatch(r"[a-z0-9-]+", fields["name"])), "skill name is not kebab-ASCII")
    require(fields["description"].startswith("Use when "), "description must start with 'Use when '")
    frontmatter_bytes = len("\n".join(skill_lines[: frontmatter_end + 1]).encode("utf-8"))
    require(frontmatter_bytes <= 1024, f"frontmatter exceeds 1024 bytes: {frontmatter_bytes}")
    require(len(skill_lines) < 500, f"SKILL.md exceeds 500 lines: {len(skill_lines)}")

    markdown_files = sorted(skill_dir.rglob("*.md"))
    link_pattern = re.compile(r"(?<!!)\[[^\]]+\]\(([^)]+)\)")
    checked_links = 0
    for markdown_path in markdown_files:
        text = markdown_path.read_text(encoding="utf-8")
        for raw_target in link_pattern.findall(text):
            target = raw_target.split("#", 1)[0]
            if not target or re.match(r"^[a-z][a-z0-9+.-]*:", target, re.IGNORECASE):
                continue
            resolved = (markdown_path.parent / target).resolve()
            require(resolved.exists(), f"broken link in {markdown_path.relative_to(skill_dir)}: {raw_target}")
            checked_links += 1

    dependencies = json.loads((skill_dir / "dependencies.json").read_text(encoding="utf-8"))["skills"]
    require(len(dependencies) == 6, "expected six external skill dependencies")
    dependency_names = [dependency["name"] for dependency in dependencies]
    require(len(dependency_names) == len(set(dependency_names)), "duplicate skill dependency")
    resolved_dependencies = {}
    for dependency in dependencies:
        require(f"`{dependency['name']}`" in skill_text, f"dependency absent from SKILL.md: {dependency['name']}")
        resolved_path = resolve_dependency(project_root, dependency)
        require(read_frontmatter_name(resolved_path) == dependency["frontmatter_name"], f"dependency identity mismatch: {dependency['name']}")
        resolved_dependencies[dependency["name"]] = resolved_path

    suites = {}
    for suite_key, suite_name in (("core", "evals.json"), ("r2", "r2-evals.json")):
        suite = json.loads((evals_dir / suite_name).read_text(encoding="utf-8"))
        require(suite["skill_name"] == fields["name"], f"skill_name mismatch in {suite_name}")
        cases = {case["id"]: case for case in suite["evals"]}
        require(len(cases) == len(suite["evals"]), f"duplicate evaluation ID in {suite_name}")
        require(all(len(case["assertions"]) == 5 for case in cases.values()), f"each {suite_name} case must have five assertions")
        suites[suite_key] = cases
    all_ids = sorted(case_id for cases in suites.values() for case_id in cases)
    require(all_ids == list(range(1, 12)), "evaluation IDs must be 1 through 11")

    matrix = json.loads((evals_dir / "run-matrix.json").read_text(encoding="utf-8"))["runs"]
    require(len(matrix) == 32, f"expected 32 run matrix entries, got {len(matrix)}")
    require(all(entry.get("evidence_role") in {"baseline", "historical", "current"} for entry in matrix), "invalid evidence role")
    matrix_files = [entry["file"] for entry in matrix]
    require(len(matrix_files) == len(set(matrix_files)), "duplicate run file in matrix")
    runs_dir = evals_dir / "runs"
    run_files = sorted(runs_dir.glob("*.json"))
    require(set(matrix_files) == {path.name for path in run_files}, "run matrix and run file sets differ")

    manifest_path = runs_dir / "sha256sum.txt"
    manifest_lines = manifest_path.read_text(encoding="utf-8").splitlines()
    manifest_pattern = re.compile(r"^([0-9a-f]{64})  ([^/]+\.json)$")
    manifest = {}
    for line in manifest_lines:
        match = manifest_pattern.fullmatch(line)
        require(match is not None, f"invalid manifest line: {line!r}")
        digest, name = match.groups()
        require(name not in manifest, f"duplicate manifest path: {name}")
        manifest[name] = digest
    require(set(manifest) == set(matrix_files), "manifest and run matrix sets differ")

    run_results = {}
    run_result_lines = {}
    schema_counts = {1: 0, 2: 0}
    for entry in matrix:
        path = runs_dir / entry["file"]
        require(hashlib.sha256(path.read_bytes()).hexdigest() == manifest[path.name], f"digest mismatch: {path.name}")
        envelope = json.loads(path.read_text(encoding="utf-8"))
        case = suites[entry["suite"]][entry["id"]]
        schema_version = envelope["schema_version"]
        require(schema_version in schema_counts, f"schema mismatch: {path.name}")
        schema_counts[schema_version] += 1
        require(envelope["suite"] == entry["suite"], f" suite mismatch: {path.name}")
        require(envelope["case_id"] == entry["id"], f"case mismatch: {path.name}")
        require(envelope["case_name"] == case["name"], f"case name mismatch: {path.name}")
        require(envelope["model_requested"] == entry["model"], f"model mismatch: {path.name}")
        require(envelope["without_skill"] is entry["without_skill"], f"mode mismatch: {path.name}")
        require(envelope["prompt_sha256"] == sha256_text(case["prompt"]), f"prompt hash mismatch: {path.name}")
        role = entry["evidence_role"]
        if role == "baseline":
            require(entry["without_skill"] is True and envelope["skill_sha256"] is None, f"invalid baseline evidence: {path.name}")
        elif role == "historical":
            require(entry["without_skill"] is False and bool(re.fullmatch(r"[0-9a-f]{64}", envelope["skill_sha256"] or "")), f"invalid historical skill hash: {path.name}")
        else:
            require(entry["without_skill"] is False and envelope["skill_sha256"] == skill_hash, f"current skill hash mismatch: {path.name}")
            require(schema_version == 2, f"current evidence is not resumable schema 2: {path.name}")
        if schema_version == 1:
            require(envelope["isolation"] == {
                "safe_mode": True,
                "slash_commands_disabled": True,
                "tools": [],
                "session_persistence": False,
            }, f"schema-1 runtime options mismatch: {path.name}")
        else:
            require(envelope["requested_runtime_options"] == {
                "safe_mode": True,
                "slash_commands_disabled": True,
                "tools": [],
                "session_persistence": True,
            }, f"schema-2 runtime options mismatch: {path.name}")
            require(bool(re.fullmatch(r"[0-9a-f-]{36}", envelope["session_id"])), f"invalid session ID: {path.name}")
            require(isinstance(envelope["resume_count"], int) and envelope["resume_count"] >= 0, f"invalid resume count: {path.name}")
        response = envelope["response"]
        require(response.get("is_error") is False, f"run reported error: {path.name}")
        result = response.get("result", "")
        require(bool(result.strip()), f"run has empty result: {path.name}")
        run_results[path.name] = result
        run_result_lines[path.name] = result.splitlines()

    grading_artifact = json.loads((evals_dir / "final-grading.json").read_text(encoding="utf-8"))
    require(grading_artifact.get("schema_version") == 2, "grading schema mismatch")
    grader = grading_artifact.get("grader", {})
    require(grader.get("model") == "sonnet", "grader model mismatch")
    require(bool(re.fullmatch(r"[0-9a-f-]{36}", grader.get("session_id", ""))), "invalid grader session ID")
    require(isinstance(grader.get("resume_count"), int) and grader["resume_count"] >= 0, "invalid grader resume count")
    require(bool(re.fullmatch(r"[0-9a-f]{64}", grader.get("input_sha256", ""))), "invalid grader input hash")
    grading = grading_artifact["runs"]
    require(len(grading) == len(matrix), "grading and matrix entry counts differ")
    grading_by_file = {entry["run_file"]: entry for entry in grading}
    require(len(grading_by_file) == len(grading), "duplicate run in grading")
    require(set(grading_by_file) == set(matrix_files), "grading and matrix file sets differ")
    passed_by_role = {"baseline": 0, "historical": 0, "current": 0}
    total_by_role = {"baseline": 0, "historical": 0, "current": 0}
    bound_evidence_lines = 0
    for entry in matrix:
        case = suites[entry["suite"]][entry["id"]]
        graded_assertions = grading_by_file[entry["file"]]["assertions"]
        require([item["text"] for item in graded_assertions] == case["assertions"], f"assertion set mismatch: {entry['file']}")
        source_lines = run_result_lines[entry["file"]]
        for item in graded_assertions:
            evidence = item["evidence"]
            require(bool(evidence), f"empty evidence: {entry['file']}")
            for excerpt in evidence:
                line_number = excerpt["line"]
                require(isinstance(line_number, int) and 1 <= line_number <= len(source_lines), f"invalid evidence line: {entry['file']} / {item['text']}")
                require(excerpt["text"] == source_lines[line_number - 1], f"unbound evidence line: {entry['file']} / {item['text']} / {line_number}")
                bound_evidence_lines += 1
            role = entry["evidence_role"]
            total_by_role[role] += 1
            passed_by_role[role] += int(item["passed"] is True)
    require(total_by_role["baseline"] == 25, f"baseline assertion count mismatch: {total_by_role['baseline']}")
    require(passed_by_role["baseline"] < total_by_role["baseline"], "baseline has no discriminating failures")
    require(passed_by_role["historical"] == total_by_role["historical"] == 105, f"historical assertions are not 105/105: {passed_by_role['historical']}/{total_by_role['historical']}")
    require(passed_by_role["current"] == total_by_role["current"] == 30, f"current assertions are not 30/30: {passed_by_role['current']}/{total_by_role['current']}")

    print(f"frontmatter_bytes={frontmatter_bytes}")
    print(f"skill_lines={len(skill_lines)}")
    print(f"markdown_files={len(markdown_files)}")
    print(f"checked_internal_links={checked_links}")
    print(f"resolved_skill_dependencies={len(resolved_dependencies)}/6")
    print(f"evaluations={sum(len(cases) for cases in suites.values())}")
    print(f"run_envelopes_verified={len(matrix)}/{len(matrix)}")
    print(f"schema_1_successful_runs={schema_counts[1]}")
    print(f"schema_2_resumable_runs={schema_counts[2]}")
    print(f"prompt_hashes_verified={len(matrix)}/{len(matrix)}")
    print(f"skill_hashes_verified={len(matrix)}/{len(matrix)}")
    print(f"manifest_hashes_verified={len(matrix)}/{len(matrix)}")
    print(f"grader_session_id={grader['session_id']}")
    print(f"grader_resume_count={grader['resume_count']}")
    print(f"bound_grading_evidence_lines={bound_evidence_lines}/{bound_evidence_lines}")
    print(f"baseline_assertions={passed_by_role['baseline']}/{total_by_role['baseline']}")
    print(f"historical_assertions={passed_by_role['historical']}/{total_by_role['historical']}")
    print(f"current_assertions={passed_by_role['current']}/{total_by_role['current']}")
    print("validation=PASS")


if __name__ == "__main__":
    main()
