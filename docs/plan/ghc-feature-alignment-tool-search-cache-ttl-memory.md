# GHC 特性对齐：tool-search default-allow + extended-cache-ttl + memory tool

> **实施状态：已全部落地**
> **落地**：2026-07-05（4 commits：`067f79a` P0 → `1e06ef5` P1 → `1a08848` P2 → `5e1976c` P3）
> **现状锚点**：`features.ts`（`toolSearchDefaultAllow`/`modelSupportsExtendedCacheTtl`/`modelSupportsMemory`/`matchModelCapability` family）；`request-preparation.ts`（`applyCacheControlMode` 每层 ttl / `rewriteMemoryTool` step / `addToolCacheControl` server-tool 排除）；`state.ts` 新字段；`config.yaml` 新键；配套测试 `tests/anthropic/anthropic-features.unit.test.ts` + `anthropic-request-preparation.it.test.ts` + `anthropic-prepare-steps.unit.test.ts` + `tests/config/config-hot-reload.it.test.ts`
> **验证**：全套件 3586 pass（仅 5 个 pre-existing order-dependent 失败，baseline 同款、非本次引入）；独立对抗 subagent audit 十维零缺陷
> **相关**：GHC 侧现状与映射见 skill `ghc-api-reference`；运行时选项见 [../DESIGN.md](../DESIGN.md)

## Context（为什么做）

分析当前 GHC 扩展（`microsoft/vscode` 的 `extensions/copilot/src/`，同步于 2026-07-04）后发现本代理落后三处，均在"忠实镜像 GHC"路线上：① tool-search 用手动 allowlist（每个新 Claude 要手动加）；② `extended-cache-ttl-2025-04-11` 完全未支持；③ memory tool 未支持。用户决策：tool-search 改纯配置决定不手动加模型；extended-cache-ttl 两级可配 ttl；memory tool config 开关默认关。`request_header_whitelist` 保持现状（vscode header-name 做法不适用，本项目已有 core+floor 隔离）。

裁判轴：长远正确 + 完整 + GHC 忠实，不用 ROI/YAGNI 裁剪。

## 落地内容（按 phase → commit）

- **P0 `067f79a` family fallback**：`matchModelCapability` 加可选 `family`，所有能力函数传 `resolvedModel.capabilities.family`，镜像 GHC `matches(id) || matches(family)`。dash 边界比 GHC 裸 startsWith 更严（`claude-opus-40` 不误伤）——有意保留。
- **P1 `1e06ef5` tool-search default-allow**：`toolSearchDefaultAllow`（镜像 GHC `chatModelCapabilities.ts`，仅 Claude 分支）替换手动 `toolSearchModels` 列表；新 `model_capabilities.tool_search_overrides`（per-model force-on/off）；`state.toolSearchEnabled` 归一为唯一总闸（修 `features.ts:208` + `message-tools.ts:282` split-brain）；compat `removeKey` 迁移旧列表。优先级 `metadata ?? overrides ?? default-allow`。
- **P2 `1a08848` extended-cache-ttl**：`modelSupportsExtendedCacheTtl`（config `model_capabilities.extended_cache_ttl`）+ `anthropic.extended_cache_ttl.{enabled,tools_system_ttl,messages_ttl}`；接入既有 `cache_control` 模式管线（proxied 注入带 ttl 断点、sanitize 按层升级、passthrough/disabled 不动）；`walkCacheControl` 加 section 线索；beta 由 `wireHasOneHourTtl` 扫描裁决（`ctx.wroteExtendedTtl`）。Agent 门用 `isAgentCall`。
- **P3 `5e1976c` memory tool**：`modelSupportsMemory`（config `model_capabilities.memory`）+ `anthropic.memory_tool`（默认关）；新 prepare step `rewrite-memory-tool`（在 cache-control 前）把客户端 `memory` 工具改写为 `{name:"memory", type:"memory_20250818"}`；`forceMemoryContextBeta` 强制 context-management beta（绕过 `disableContextManagement`）；**root-cause 附带修**：`addToolCacheControl` 排除有 `type` 的 server tool 作缓存锚点（同时根治 tool_search server-tool 隐患）。

## 有意的（更正确）偏离 GHC——已文档化

1. **extended-ttl enum `{5m,1h}` 而非 GHC 的 bool**：避免 "off" 语义把 proxied 主力的 message 断点缓存误删的 footgun。
2. **extended-ttl beta 采 `wroteExtendedTtl` 门**（非 GHC 无条件 parent-enabled 门）：enum 能表达 enabled+5m，此时不发 beta（更正确）。
3. **Agent 门用 `isAgentCall`**（assistant 消息存在）近似 GHC `location===Agent && !subagent`：本项目无 ChatLocation 信号；GHC 实际把我们这种 MessagesProxy 定位排除在 extended-ttl 外，因用户明确要此特性而有意背离；首轮无 ttl 正确。
4. **family 匹配保留 dash 边界**（比 GHC 裸 startsWith 严）。

## 未决/风险

- **memory CAPI 接受性未实测**：GHC 仅在 BYOK 直连路径注入 `memory_20250818`，CAPI 路径不注入。故 `memory_tool` 默认关；开启后须用探针/history `sseEvents` 实测 CAPI 是否接受该 server-tool 类型 + `context-management` beta。若被拒，`filterUnsupportedBetas` + `unsupported-beta-retry` 自愈剥 beta（但 body 里的 tool 类型无自愈，属未来工作）。
- **memory `forceMemoryContextBeta` 绕过 `disableContextManagement`**：beta-vs-body 耦合未经 oracle 证实（见上条实测项）。
