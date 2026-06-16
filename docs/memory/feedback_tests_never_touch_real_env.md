---
name: feedback_tests_never_touch_real_env
description: "Tests must never write real user config/env; use dependency injection, not process.env mutation; verify before running"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 2cc513ee-b169-4c19-a99a-9041eaf57d8d
---

A test for `setup-claude-code` (in `tests/`) wrote to the user's **real `~/.claude.json` / `~/.claude/settings.json`** during a test run. Cause: I replaced a `mock.module("node:os")` (which had safely redirected `homedir()` to a temp dir) with runtime `process.env.HOME = tempDir` — but **Bun's `os.homedir()` does NOT re-read `process.env.HOME` at call time** (it returned the real `/home/xp`), so `writeClaudeCodeConfig()` clobbered the real config. The user was rightly alarmed ("严重的问题... 实验不要直接修改了真实环境配置").

**Why:** I treated a `mock.module` purely as cross-file-leakage to be removed, missing that it served a **safety isolation** purpose (keeping fs writes off the real home). And I ran the broken test against the real environment without first proving it was isolated.

**How to apply:**
- A test that does real file I/O against `$HOME`/config paths MUST isolate via **dependency injection** — give the function an `options.home` (or paths) param and pass a `mkdtemp` temp dir. Never rely on `process.env.HOME` mutation (Bun `os.homedir()` ignores it at runtime) and never `mock.module("node:os")` as the seam.
- Before "fixing"/removing any `mock.module`, ask whether it provides **safety isolation** (fs/network containment), not just inter-file isolation — if so, the replacement must preserve that containment.
- **Prove isolation before executing** anything that could touch real user state: confirm the code path can only hit a temp/sandbox location. When in doubt, get the user's confirmation first (they said: 未确认不动手).
- For the CLI itself, respect existing config: detect existing custom config, show an intuitive `+/~/-` diff, confirm before destructive overwrites, and split "essential" (written by default) vs "extension" (opt-in only) settings. Relates to [[feedback_complete_root_cause_fix]] and [[feedback_optimize_long_term_maintainability]].
