---
name: upstream-tool-use-id-format-tolerant
description: GHC Copilot 上游不深校验 tool_use id 格式——echo-back 只要 tool_use/tool_result id 引用一致即可，任意 toolu_* 字符串都接受
metadata: 
  node_type: memory
  type: reference
  originSessionId: b8f41cff-bec9-433d-9caf-a12ba43ef6e4
---

实证（2026-06-16 POC，`localhost:4141` 真实 echo-back 探针）：GitHub Copilot 上游**不深校验** `tool_use.id` 格式。构造多轮请求（assistant 轮带合成 id 的 `tool_use` + user 轮带配对 `tool_result`），三种 id 全部 200 接受：

- `toolu_`+24base62（真实同构形态）→ 200
- `toolu_recovered_0`（非标准、短、含下划线）→ 200
- 真实 id 对照 → 200

**结论：** 上游只要求 `tool_use.id` 与后续 `tool_result.tool_use_id` **引用一致**（referential integrity），不校验前缀/长度/字符集。任何代理层**合成 tool_use block** 的功能（如 [[ghc-tool-call-text-downgrade]] 的恢复机制）生成的 id，echo-back 不会因格式 400。

**仍建议合成 `toolu_`+24base62**（同构真实 + 防任何会校验格式的**客户端** SDK——本 POC 只验了上游，没验 Claude Code 客户端侧；零成本双保险）。

探针方法见 [[empirical-probe-via-history-api]]。
