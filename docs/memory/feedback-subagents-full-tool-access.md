---
name: feedback-subagents-full-tool-access
description: 派 subagent 一律给全量工具权限，不限制工具使用
metadata:
  type: feedback
---

派 subagent 时**永远给全量工具权限**，不要用工具受限的 agent 类型（如 `ecc:architect` 只有 Read/Grep/Glob）。需要完整工具（含 Bash/Edit/Write 等）就用 `claude` 或 `general-purpose`（tools=`*`），即使任务名义上"只读分析"也别预设受限——受限会让 subagent 无法跑探针/实测/验证命令，削弱其裁决可信度（empirical-verification 要亲手实测）。

**Why:** 用户 2026-06-20 明确指示"未来总是要给 subagent 全量工具权限，不要限制 subagent 工具使用"。受限工具的 architect 只能静态读代码，跑不了 `bun test`/`grep -r` 之外的实测探针，与 [[feedback_reviewer_verify_critically]] / [[methodology-probe-harness-must-match-prod]] 的"实测裁决"纪律冲突。

**How to apply:** Agent 工具的 `subagent_type` 选 `claude`/`general-purpose`（全量工具）而非 `ecc:architect`/`ecc:code-reviewer` 等受限类型；在 prompt 里仍可写"只读分析、不写代码"作为行为约束，但工具权限本身不设限，让它能自行实测验证。
