---
name: methodology-background-agent-result-surfacing-failure
description: 后台 subagent 完成但 task-notification 的 <result> 正文为空(只回 usage)——SendMessage-resume 早期能救、后期失效;规避=直接自证具体断言,别死等 agent 正文
metadata:
  type: reference
---

**现象**：`Agent(run_in_background)` / `SendMessage`-resume 的后台 subagent 完成时，task-notification 带 `status: completed` + `<usage>`（`subagent_tokens`/`tool_uses`/`duration` 齐全，证明它确实干了活），但 **`<result>` 字段为空/缺失**——只有 "Agent … finished" 摘要，**没有裁决/报告正文**。跨模型都中招（实测 `gpt-souls:reviewer` 和 Claude `reviewer` 均复现），是**后台 agent 报告→notification 的通用 harness 传递故障**，非模型/评审缺失。

**恢复尝试的规律**：`SendMessage` 让它重发正文，**早期偶发时能救回一次**，但**后期连续故障时 resume 也救不回**（重发的 resume 只跑很少 tool_use、正文仍不 surface）。别无限循环拽同一 agent。

**不要做**：读它的 `.output` 文件——那是 JSONL transcript 符号链接、整读会撑爆上下文（除非**有界** `tail -c 30000` / python 切片抢救末段）。

**Why**：评审/规划的**价值在其结论**，结论不 surface = 这次 agent 白跑；但它做的**核实工作是可复现的**——它查的 file:line、grep 结论，主会话能自己再查一遍。

**How to apply**：
1. surfacing 失败时**不死等**——把 agent 要回答的**具体、可自查断言**直接自证（读文件/`rg`/git log）。例：reviewer 要确认「G5 是否漏排 Task」→ 直接 `rg "G5|Task 11" plan.md`；「wiring 是否对」→ 直接读计划 Architecture 节。这比反复 resume 可靠。
2. 派 agent 时就让它**把结论也写进一个产物文件**（plan/report md），而非只靠 return 正文——文件是可靠交接，return 正文会丢。本项目 subagent-driven 的 File Handoffs 正是此理。
3. 相关坑：**agent 把字面控制字符写进 doc 会损坏文件**——planner 用字面 `\x00`(NUL) 做 metrics 复合键分隔符、写进 md 成 5 个 NUL 字节，使文件对 grep/rg 变「binary file matches」全静默跳过（`tr -cd '\0' | wc -c` 查、`data.replace(b'\x00', b'\\x00')` 修成转义文本）。派生成含代码的 doc 时，代码里的控制字符要用转义序列。

相关：[[feedback-backend-flakiness-must-sendmessage-resume-no-alternatives]]（抖动挂了 resume 不换模型——本条是它的补充：resume 也救不回正文时怎么办）、[[feedback-proactive-liveness-dead-check-on-background-agents]]、验证纪律 skill `verifying-authoritative-claims`（自证 > 信 agent 声音）。
