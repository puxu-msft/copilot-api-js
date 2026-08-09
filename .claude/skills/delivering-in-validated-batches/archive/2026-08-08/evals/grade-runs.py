#!/usr/bin/env python3

import hashlib
import json
import subprocess
import time
import uuid
from pathlib import Path

NETWORK_MARKERS = (
    "api error",
    "server error",
    "network error",
    "nghttp2_cancel",
    "stream closed",
    "mid-response",
    "terminated",
    "connection reset",
    "connection closed",
    "timeout",
    "timed out",
)
CONTEXT_TERMINAL_MARKERS = (
    "context window exceeded",
    "input exceeds the context window",
)
NETWORK_RESUME_PROMPT = "继续上一条因网络或 API 中断而未完成的同一评分；保持原输入、判据和严格 JSON 输出格式。"


def parse_response(stdout: str) -> dict | None:
    try:
        response = json.loads(stdout)
    except json.JSONDecodeError:
        return None
    return response if isinstance(response, dict) else None


def invoke_resumable(
    command: list[str], input_text: str, session_id: str, common_args: list[str]
) -> tuple[dict, int]:
    network_resume_count = 0
    delay_seconds = 3
    while True:
        completed = subprocess.run(command, input=input_text, capture_output=True, text=True)
        response = parse_response(completed.stdout)
        if completed.returncode == 0 and response is not None and response.get("is_error") is False:
            return response, network_resume_count
        detail = "\n".join((completed.stdout, completed.stderr, str((response or {}).get("result", "")))).lower()
        if any(marker in detail for marker in CONTEXT_TERMINAL_MARKERS):
            raise SystemExit(
                f"grader session {session_id} reached a context-window terminal state; use the capacity handoff protocol"
            )
        if not any(marker in detail for marker in NETWORK_MARKERS):
            diagnostic = completed.stderr.strip() or completed.stdout.strip() or f"exit {completed.returncode}"
            raise SystemExit(f"non-network grader failure in session {session_id}: {diagnostic}")
        network_resume_count += 1
        time.sleep(delay_seconds)
        delay_seconds = min(delay_seconds * 2, 30)
        command = ["claude", "-p", "--resume", session_id, *common_args]
        input_text = NETWORK_RESUME_PROMPT


def grading_errors(
    grading: object,
    matrix: list[dict],
    suites: dict[str, dict[int, dict]],
    result_lines: dict[str, list[str]],
) -> list[str]:
    errors = []
    if not isinstance(grading, dict) or not isinstance(grading.get("runs"), list):
        return ["top-level JSON must contain a runs array"]
    expected_files = [entry["file"] for entry in matrix]
    actual_files = [run.get("run_file") for run in grading["runs"] if isinstance(run, dict)]
    if actual_files != expected_files:
        errors.append("run_file sequence must exactly match the supplied matrix order")
        return errors
    for entry, run in zip(matrix, grading["runs"], strict=True):
        expected_assertions = suites[entry["suite"]][entry["id"]]["assertions"]
        assertions = run.get("assertions")
        if not isinstance(assertions, list) or len(assertions) != len(expected_assertions):
            errors.append(f"{entry['file']}: assertion count differs from the supplied case")
            continue
        lines = result_lines[entry["file"]]
        for index, (expected_text, assertion) in enumerate(zip(expected_assertions, assertions, strict=True), 1):
            if not isinstance(assertion, dict):
                errors.append(f"{entry['file']} assertion {index}: must be an object")
                continue
            if assertion.get("text") != expected_text:
                errors.append(f"{entry['file']} assertion {index}: text differs from the supplied assertion")
            if assertion.get("passed") not in (True, False):
                errors.append(f"{entry['file']} assertion {index}: passed must be boolean")
            numbers = assertion.get("evidence_line_numbers")
            if not isinstance(numbers, list) or not numbers:
                errors.append(f"{entry['file']} assertion {index}: evidence_line_numbers must be a non-empty array")
                continue
            for number in numbers:
                if not isinstance(number, int) or not 1 <= number <= len(lines):
                    errors.append(
                        f"{entry['file']} assertion {index}: evidence line {number!r} is outside 1..{len(lines)}"
                    )
    return errors


def main() -> None:
    evals_dir = Path(__file__).resolve().parent
    runs_dir = evals_dir / "runs"
    suites = {
        "core": {case["id"]: case for case in json.loads((evals_dir / "evals.json").read_text(encoding="utf-8"))["evals"]},
        "r2": {case["id"]: case for case in json.loads((evals_dir / "r2-evals.json").read_text(encoding="utf-8"))["evals"]},
    }
    matrix = json.loads((evals_dir / "run-matrix.json").read_text(encoding="utf-8"))["runs"]
    cases = []
    result_lines = {}
    for entry in matrix:
        run = json.loads((runs_dir / entry["file"]).read_text(encoding="utf-8"))
        case = suites[entry["suite"]][entry["id"]]
        lines = run["response"]["result"].splitlines()
        result_lines[entry["file"]] = lines
        cases.append(
            {
                "run_file": entry["file"],
                "assertions": case["assertions"],
                "numbered_output": "\n".join(f"{index}: {line}" for index, line in enumerate(lines, 1)),
            }
        )

    prompt = (
        "逐个 run 评判每条 assertion 是否被 numbered_output 明确满足。不得按意图、常识或相近措辞放行。"
        "每项返回支持 verdict 的原始行号数组 evidence_line_numbers；即使 assertion 失败，也选择暴露失败的原行。"
        "可选择多行，但每个行号必须必要且足以共同支持 verdict。保持 run_file、assertion text 逐字不变，"
        "并保持 run 顺序与输入完全一致。"
        "输出严格 JSON：{\"runs\":[{\"run_file\":\"原文件名\",\"assertions\":[{"
        "\"text\":\"原断言\",\"passed\":true或false,\"evidence_line_numbers\":[整数]}]}]}。\n\n"
        + json.dumps(cases, ensure_ascii=False)
    )
    input_hash = hashlib.sha256(prompt.encode("utf-8")).hexdigest()
    session_id = str(uuid.uuid4())
    common = [
        "--safe-mode",
        "--disable-slash-commands",
        "--tools",
        "",
        "--permission-mode",
        "dontAsk",
        "--model",
        "sonnet",
        "--effort",
        "xhigh",
        "--output-format",
        "json",
    ]
    command = [
        "claude",
        "-p",
        "--session-id",
        session_id,
        *common,
        "--system-prompt",
        "你是独立评测员。只依被评分 numbered_output 裁决，不补写缺失内容。",
    ]
    outer, network_resume_count = invoke_resumable(command, prompt, session_id, common)
    correction_count = 0
    while True:
        try:
            grading = json.loads(outer["result"])
        except (json.JSONDecodeError, KeyError, TypeError) as exc:
            errors = [f"grader result is not valid JSON: {exc}"]
        else:
            errors = grading_errors(grading, matrix, suites, result_lines)
        if not errors:
            break
        correction_count += 1
        correction_prompt = (
            "你上一条评分 JSON 未通过机械结构校验。保持所有 verdict 的语义判断不变，只修正结构、顺序、"
            "断言原文和证据行号，并重新返回完整 JSON；不得省略任何 run。错误如下：\n- "
            + "\n- ".join(errors[:50])
        )
        command = ["claude", "-p", "--resume", session_id, *common]
        outer, additional_network_resumes = invoke_resumable(command, correction_prompt, session_id, common)
        network_resume_count += additional_network_resumes

    for run in grading["runs"]:
        lines = result_lines[run["run_file"]]
        for assertion in run["assertions"]:
            line_numbers = assertion.pop("evidence_line_numbers")
            assertion["evidence"] = [
                {"line": line_number, "text": lines[line_number - 1]}
                for line_number in line_numbers
            ]
    artifact = {
        "schema_version": 2,
        "grader": {
            "model": "sonnet",
            "session_id": session_id,
            "network_resume_count": network_resume_count,
            "correction_count": correction_count,
            "input_sha256": input_hash,
        },
        "runs": grading["runs"],
    }
    target = evals_dir / "final-grading.json"
    temporary = target.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(artifact, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(target)

    matrix_by_file = {entry["file"]: entry for entry in matrix}
    assertions_by_role = {
        role: [
            assertion
            for run in grading["runs"]
            if matrix_by_file[run["run_file"]]["evidence_role"] == role
            for assertion in run["assertions"]
        ]
        for role in ("baseline", "historical", "current")
    }
    for role, assertions in assertions_by_role.items():
        print(f"{role}_assertions={sum(item['passed'] for item in assertions)}/{len(assertions)}")
    print(f"grader_session_id={session_id}")
    print(f"grader_network_resume_count={network_resume_count}")
    print(f"grader_correction_count={correction_count}")


if __name__ == "__main__":
    main()
