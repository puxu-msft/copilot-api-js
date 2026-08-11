#!/usr/bin/env python3

import argparse
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
RESUME_PROMPT = "继续上一条因网络或 API 中断而未完成的任务；严格保持原任务、判据和输出格式，不要开启新任务。"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run one layered-delivery skill evaluation in a resumable Claude context.")
    parser.add_argument("--suite", choices=("core", "r2"), required=True)
    parser.add_argument("--id", type=int, required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--without-skill", action="store_true")
    return parser.parse_args()


def parse_response(stdout: str) -> dict | None:
    try:
        response = json.loads(stdout)
    except json.JSONDecodeError:
        return None
    return response if isinstance(response, dict) else None


def failure_text(completed: subprocess.CompletedProcess[str], response: dict | None) -> str:
    parts = [completed.stdout, completed.stderr]
    if response is not None:
        parts.append(str(response.get("result", "")))
    return "\n".join(parts).lower()


def run_resumable(initial_command: list[str], prompt: str, session_id: str, common_resume_args: list[str]) -> tuple[dict, int]:
    command = initial_command
    input_text = prompt
    resume_count = 0
    delay_seconds = 3
    while True:
        completed = subprocess.run(command, input=input_text, capture_output=True, text=True)
        response = parse_response(completed.stdout)
        if completed.returncode == 0 and response is not None and response.get("is_error") is False:
            return response, resume_count

        detail = failure_text(completed, response)
        if any(marker in detail for marker in CONTEXT_TERMINAL_MARKERS):
            raise SystemExit(
                f"session {session_id} reached a context-window terminal state; use the capacity handoff protocol"
            )
        if not any(marker in detail for marker in NETWORK_MARKERS):
            diagnostic = completed.stderr.strip() or completed.stdout.strip() or f"exit {completed.returncode}"
            raise SystemExit(f"non-network evaluation failure in session {session_id}: {diagnostic}")

        resume_count += 1
        time.sleep(delay_seconds)
        delay_seconds = min(delay_seconds * 2, 30)
        command = ["claude", "-p", "--resume", session_id, *common_resume_args]
        input_text = RESUME_PROMPT


def main() -> None:
    args = parse_args()
    evals_dir = Path(__file__).resolve().parent
    skill_path = evals_dir.parent / "SKILL.md"
    suite_path = evals_dir / ("evals.json" if args.suite == "core" else "r2-evals.json")
    cases = json.loads(suite_path.read_text(encoding="utf-8"))["evals"]
    try:
        case = next(item for item in cases if item["id"] == args.id)
    except StopIteration as exc:
        raise SystemExit(f"evaluation id {args.id} is absent from {suite_path.name}") from exc

    prompt = case["prompt"]
    skill_text = skill_path.read_text(encoding="utf-8")
    system_prompt = "你是软件工程项目协调者。直接完成用户任务。"
    if not args.without_skill:
        system_prompt += "必须遵循下面 skill 全文。\n\n" + skill_text

    session_id = str(uuid.uuid4())
    common_args = [
        "--safe-mode",
        "--disable-slash-commands",
        "--tools",
        "",
        "--permission-mode",
        "dontAsk",
        "--model",
        args.model,
        "--effort",
        "high",
        "--output-format",
        "json",
    ]
    initial_command = [
        "claude",
        "-p",
        "--session-id",
        session_id,
        *common_args,
        "--system-prompt",
        system_prompt,
    ]
    raw_response, resume_count = run_resumable(initial_command, prompt, session_id, common_args)
    envelope = {
        "schema_version": 2,
        "suite": args.suite,
        "case_id": case["id"],
        "case_name": case["name"],
        "model_requested": args.model,
        "without_skill": args.without_skill,
        "prompt_sha256": hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
        "skill_sha256": None if args.without_skill else hashlib.sha256(skill_text.encode("utf-8")).hexdigest(),
        "session_id": session_id,
        "resume_count": resume_count,
        "requested_runtime_options": {
            "safe_mode": True,
            "slash_commands_disabled": True,
            "tools": [],
            "session_persistence": True,
        },
        "response": raw_response,
    }
    print(json.dumps(envelope, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
