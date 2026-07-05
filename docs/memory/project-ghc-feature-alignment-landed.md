---
name: project-ghc-feature-alignment-landed
description: GHC 三特性对齐已落地(tool-search default-allow/extended-cache-ttl/memory tool)；现状看 skill ghc-api-reference；memory_tool pending 见 docs/todo
metadata:
  node_type: memory
  type: project
---

**GHC 三特性对齐已落地（2026-07-05，4 commits）：tool-search default-allow / extended-cache-ttl / memory tool。** 权威现状看 skill `ghc-api-reference`（映射表已刷新）+ `docs/plan/ghc-feature-alignment-tool-search-cache-ttl-memory.md` + DESIGN 运行时选项表。

- **tool-search**：手动列表 → **default-allow**（`features.ts:toolSearchDefaultAllow` 镜像 GHC，Claude ≥4.5 放行 / 拒 Haiku+pre-4.5）+ per-model 覆盖 + `anthropic.tool_search` 总闸。新 Claude 自动点亮。
- **`extended-cache-ttl-2025-04-11`**：`anthropic.extended_cache_ttl.{enabled,tools_system_ttl,messages_ttl}` enum `{5m,1h}`，beta 由 `wireHasOneHourTtl` 扫 body 裁决。

**pending（见 `docs/todo/deferred-backlog.md`）**：`memory_tool` 默认关，CAPI 接受性未实测须先探针。新 Claude 模型上线时核对走 skill `ghc-api-reference`。
