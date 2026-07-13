# GHC usage 数据 wire 事实（参考）

> **快照 as-of 2026-07-12（实测）**——GHC 的 usage wire 行为随其升级变化；主张与观测冲突时用下方「实测手法」重验，别拿本快照当永恒真相。

GHC 升级了 usage 数据，实测 wire 事实（`/chat/completions` + `/responses` 端点）：

- **`response.usage.input_tokens_details` 加 `cache_write_tokens`**（+ 模态 `text/audio/image/video_tokens`），`completion_tokens_details` 加 `accepted/rejected_prediction_tokens`。字段**存在但常为 null/0**（仅特定模型/缓存写场景非零）。本项目在 `src/types/api/ghc-usage.ts` 建槽位捕获（→ `cache_creation_input_tokens`），见 spec `docs/spec/2026-07-12-ghc-usage-details.md`。
- **`include: ["usage"]` 现在被 Responses API 拒绝**（`400 Invalid value: 'usage'. Supported values are: 'file_search_call.results', ...`）。usage 现在**默认返回**在 `response.completed.usage`——不需（也不能）再请求它。曾导致 CC→Responses 流式（`stream_options.include_usage`）400 挂掉，修复见 spec `docs/spec/2026-07-12-cc-responses-streaming-usage.md`。
- **`/responses` 流式还发一个 `copilot_usage` sidecar 帧**（`{token_details:[{token_type:"input"|"cache_read"|"cache_write"|"output", token_count, cost_per_batch, batch_size}]}`）——GHC 特有的带成本明细的冗余 usage 表示。本项目**不解析它**（`response.completed.usage` 已够）；translator switch 的 `default` 分支安全忽略未知帧型。
- **chat/completions（CC 直连）端点不填 `cache_write_tokens`**——缓存写时报 `cached_tokens:0`、缓存读时报 `cached_tokens:N`，从不在 CC 形状暴露 cache_write（该字段目前只在 Responses 形状 `input_tokens_details` 出现）。

**实测手法**：发一个大唯一 system prompt（>1k tokens）触发缓存写、同 prompt 二发触发缓存读；经 4141 History API 看 entry 的 `attempts[-1].upstreamResponse.{usage, sseEvents}` 对照客户端响应与上游原始帧。
