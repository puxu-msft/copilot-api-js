---
name: project-ghc-feature-alignment-landed
description: GHC 三特性对齐已落地(tool-search default-allow / extended-cache-ttl / memory tool);memory_tool 默认关、CAPI 接受性未实测须先探针
metadata: 
  node_type: memory
  type: project
  originSessionId: 5bd76cb3-e145-4823-b562-d28f848c87c2
---

2026-07-05 对齐当前 GHC ext(microsoft/vscode extensions/copilot)三特性,4 commits(067f79a family fallback → 1e06ef5 tool-search → 1a08848 extended-cache-ttl → 5e1976c memory)。**权威现状看** archived plan `docs/plan/ghc-feature-alignment-tool-search-cache-ttl-memory.md` + skill `ghc-api-reference`(映射表已刷新)+ DESIGN.md 运行时选项表;不在此重复细节。

要点(仅存指针 + 一个 pending):
- tool-search 从手动 `model_capabilities.tool_search` 列表 → **default-allow**(`features.ts:toolSearchDefaultAllow` 镜像 GHC,Claude ≥4.5 放行/拒 Haiku+pre-4.5)+ `tool_search_overrides` per-model 覆盖 + `anthropic.tool_search` 唯一总闸(旧列表 compat `removeKey` 迁走)。新 Claude 自动点亮、不再手动加。
- `extended-cache-ttl-2025-04-11`:`anthropic.extended_cache_ttl.{enabled,tools_system_ttl,messages_ttl}`,enum `{5m,1h}`(非 GHC 的 bool,避 off footgun),接入既有 cache_control 管线,beta 由 `wireHasOneHourTtl` 扫描 body 裁决(header-mirrors-body,亦覆盖 passthrough 客户端 1h)。

**Pending(actionable,易漏):** `anthropic.memory_tool` **默认关**——GHC 只在 BYOK 直连注入 `memory_20250818`、CAPI 路径不注入,故本项目经 CAPI 发该 server-tool 类型 + `context-management` beta 的**接受性未实测**。谁要开启 memory_tool,**先**用探针/history `sseEvents` 实测 CAPI 是否接受(见 skill `empirical-verification`);被拒时 `unsupported-beta-retry` 只自愈 beta、body 里的 tool 类型无自愈(属未来工作)。

**How to apply:** 新 Claude 模型上线时 tool-search/memory/extended-ttl 已自动或按名单认,核对走 skill `ghc-api-reference`;`memory_tool` 保持关直到实测 CAPI 接受。
