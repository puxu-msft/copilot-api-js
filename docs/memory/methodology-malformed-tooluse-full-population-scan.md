---
name: methodology-malformed-tooluse-full-population-scan
description: 分析「畸形 tool_use / decode error」全人群的正确方法——扫 upstream_response blob 的 sseEvents，别只查 error_message；用 content_block_stop 区分真缺陷 vs abort 伪畸形
metadata: 
  node_type: memory
  type: project
  originSessionId: 96c45286-59fc-4ec5-8f54-d66b5302d97c
---

分析 copilot-api-js「畸形 tool_use input / AskUserQuestion decode error」历史时，两个易错点：

**① 只查 `error_message` 会漏大半人群。** fail-gate 只对 `unrepairable` 记 error_message；被 tags/unicode/jsonrepair **修好**的、或 repair 关时**原样转发**的畸形都记 completed。真全人群 = 扫**全部 `upstream_response` stage blob 的 `sseEvents`**（`decompress(blob_gz)` → 重建每个 tool_use 块的 `input_json_delta` 累积 → `JSON.parse` 测畸形 → 用真实源 `repairToolInput(raw, REPAIR_ITEMS)` 分类）。sseEvents 藏在 `upstream_response` blob 里（**无独立 sse_events stage**），全库仅 ~43MB 压缩、7659 行、6s 扫完。

**② `content_block_stop` 区分真缺陷 vs abort 伪畸形。** 块已 `content_block_stop`+`message_stop` 但字节坏 = 真上游缺陷；无 `content_block_stop`（流被 client abort / RST 中途切断）= input 天然不完整的 **abort 伪畸形**，jsonrepair 能「补全括号」但语义无意义、**绝不该修**（代码正确地不对中断 `flush()` 路径 fail-gate）。实测：8638 tool_use 块里 33 畸形，20 真缺陷（**全是 AskUserQuestion**，字符串化 `questions`+中文 `\uXXXX` 密集转义击中 opus-4.8）+ 13 abort 伪畸形（Write/Agent/Task）。

**③ 外层 parse 通过不代表干净——须探内层 stringified 字段（2026-07-12 补，最大盲点）。** `JSON.parse(外层)` 成功只证外层合法；AskUserQuestion 的 `questions` 是 **stringified JSON 字段**，其内层可自身畸形（截断），外层却合法。初次分析只查外层 → 整类漏掉（正是 `empirical-verification` 的「通过不自证」）。全库补扫：**43 例**外层合法/内层 `questions` 畸形，**全 `status=completed`（静默转发坏字节给客户端）**，比外层畸形（干净 fail-gate）更隐蔽。修复 = 对显式 decode 字段跑同级联 + gate 放宽认 array（`questions` 内层是数组）；顶层仍 object-only 防造假。AskUserQuestion 真畸形全人群 = 20 外层 + 43 内层 = 63。触发案例 req_1783844271353_1895。

脚本存 `exp/askuserquestion-decode/`（gitignored 本地 scratch）。修复项覆盖率结论沉淀在 spec `docs/spec/anthropic-malformed-tool-input-repair.md`：18 无损可修（unicode/jsonrepair）+ 2 丢-hex-位需有损 `unicode-lossy`（landed 2026-07-11，替 un-completable `\u…`→U+FFFD、排级联最后）。通用实测手法见 skill [[empirical-verification]]、schema 见 skill [[history-sqlite-schema]]。
