---
name: project-web-search-double-hop-retired
description: web_search 双跳 + server_tool_strip/rewrite config 键已退役删除（2026-07-13，11 commit landed master）。教训=称职实现≠有需求(Spec 失败)；实测 History 语料 0 原生 server tool 声明。保留 tool_search/server-tool-filter/memory/反应式自愈网。权威看 ADR
metadata:
  type: project
---

**web_search 双跳（proxy 自建服务端 web_search 冒充）+ 相关 config 键已整套退役删除**（2026-07-13，11 commit landed master：`814b4abc`→`6b3cc178`）。权威看 ADR [decisions/2026-07-13-server-tool-positioning-and-web-search-retirement.md](../decisions/2026-07-13-server-tool-positioning-and-web-search-retirement.md) + RFC [rfc/2026-07-13-retire-web-search-double-hop.md](../rfc/2026-07-13-retire-web-search-double-hop.md) + [tool-use.md](../tool-use.md) 退役注记节。

**删了什么**：`src/lib/anthropic/web-search/` 全目录、`web-search-handler.ts`/`web-search-direct.ts`、legacy `runAnthropicPipeline`、streaming-pump 5 死导出、legacy poisoned-thinking twin；config 键 `server_tool_web_search`/`server_tool_strip`/`server_tool_rewrite`（compat `removeKey` 弃用、旧配置 warn-and-continue 不崩）。

**保留什么（与双跳无关的载重）**：tool_search 整套、`server-tool-filter`（响应侧无条件常驻、tool_search 依赖）、memory（`server_tool_memory`，client-executed）、反应式自愈网（`server-tool-rejection-retry`/`web-search-not-found-retry`/learned-driven `stripServerTools`/`rewriteServerToolBlocks`/`resolveServerToolMode`）、常驻 empty-encrypted 兜底、pipeline.ts 4 共享导出。退役后原生 web_search → v4 driver → GHC 400 → 自愈网 strip 降级（不硬失败）。

**承重教训（可复用）**：
- **称职实现 ≠ 有需求（Spec 失败）**。双跳建得很好、mock 测试 48 pass，但**实测 History 语料 0 条原生 server tool 声明**——建了没人要的东西。真实客户端（Claude Code）自执行 WebSearch/WebFetch（client tool）、Responses 路径原生透传 gpt-5.5。判「是否有意义」先**实测需求**（4141 History API 扫语料），别只看「能不能做」。
- **三类工具模型（别把 client-executed 误称 server tool）**：真·server-executed（web_search/web_fetch/code_execution，产 `server_tool_use`）vs 内置 client-executed（memory/computer/text_editor/bash，产普通 `tool_use`+`caller:{type:"direct"}`）vs 自定义 client tool。「有 `type:` ≠ server-executed」。据此重命名 `isServerToolType`→`isApiDefinedToolType`。
- **删除类大重构方法论**：前置门控探针（确认 GHC 400 措辞命中自愈表，才断开行为）→ TS-guided 级联清理（删定义→typecheck 报 unused→逐个清）→ keep/delete 边界靠**逐导出 grep**（pipeline.ts 非纯 legacy，`createBetaProbe` 等被 v4 共享，误删打爆主路径——reviewer 抓的最严重点）→ 死导出 TS 不报（unused export），须按映射主动删（推翻 DESIGN.md「别删」措辞，实证 client-sink 自带 heartbeat）。见 [[feedback-broken-reference-supply-vs-delete]] 的反面（这次是确凿删）。

**验证纪律**：5 测试失败全用 committed-blob 隔离核实为 peer 已提交工作（refusal-recovery category / streamIdleTimeoutMs golden / response 类型 lint），非本退役——见 [[feedback-pass-null-clean-not-self-validating]] 簇。concurrent-sessions：git 护栏拦裸 stash、全程显式 pathspec、peer WIP 未裹入。
