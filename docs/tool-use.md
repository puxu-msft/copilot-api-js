# Tool Use 与 Server Tools

涵盖 tool name 清洗/还原、server tool 处理、tool input 解码与 tool-call 文本恢复。

## Tool name 映射

`src/lib/tool-name-mapper.ts` 跨域共享：发上游前按目标模型约束清洗非法/超长/冲突名，响应里还原客户端原始名（Anthropic + CC + Responses 三路径）。受 `sanitize_tool_names` 控制。

## Server tools

`src/lib/anthropic/server-tool-filter.ts` 拦截 `server_tool_use` / `*_tool_result`（响应侧无条件常驻，`tool_search` 强依赖它）。请求侧 `stripServerTools` 的剥离集合现为**两源并集**：反应式学习账本 ∪ 单次重试 hint（全局 config 键 `server_tool_strip` 随 web_search 双跳退役已删，strip 现纯 reactive-learned，无全局 config）。`tool_search`（`tool_search` 配置）按模型能力注入；`tool_search_non_deferred` 控制延迟工具。

`stripToolFields`（`message-tools.ts`）剥除 GHC 上游拒绝的**未知 custom-tool 顶层字段**（400 `tools.N.<variant>.<field>: Extra inputs are not permitted`）。四源并集：内置默认 `["eager_input_streaming"]`（新版 CC 挂在每 tool 上、GHC 版本较旧拒之）∪ config `tool_strip_fields` ∪ 端点级学习账本（`tool-field-rejection-retry` 策略捕获后写入、模型无关）∪ 单次 hint（`PrepareHints.excludeToolFields`），减 config `tool_keep_fields`（可逆逃生口）与恒不剥的 `LEGIT_TOOL_KEYS`（`name`/`description`/`input_schema`/`type`/`defer_loading`/`cache_control`——上游把这些报成 extra 是变体误路由信号，放行到裸 400 而非静默剥）。

## web_search 双跳（已退役 2026-07-13）

web_search 双跳（proxy 自建服务端 web_search 冒充）已整套退役——服务 0 真实流量、永久 `[bypass]` 税，是一次 Spec 失败（把「让 web_search 能用」错等于「有人需要服务端执行 web_search」）。整个 `src/lib/anthropic/web-search/` 目录 + `web-search-handler.ts` / `web-search-direct.ts` 及 config 键 `server_tool_web_search` / `server_tool_strip` / `server_tool_rewrite` 均已删（compat 层降为 `removeKey` 弃用声明，旧配置带这些键时告警但加载成功）。退役理由与三类工具（真·server-executed vs 内置 client-executed vs 自定义 client tool）的准确定位见 ADR [decisions/2026-07-13-server-tool-positioning-and-web-search-retirement.md](decisions/2026-07-13-server-tool-positioning-and-web-search-retirement.md) + RFC [rfc/2026-07-13-retire-web-search-double-hop.md](rfc/2026-07-13-retire-web-search-double-hop.md)。

**现状**：裸 Anthropic 客户端若真发 native web_search server tool，请求走 v4 主路径 → GHC 400 拒绝 → **保留的反应式自愈网**（`server-tool-rejection-retry` / `web-search-not-found-retry`）自动 strip 掉重试、返回无 web_search 结果的降级响应（非硬失败）。`stripServerTools` / `rewriteServerToolBlocks` 函数骨架保留但**纯 learned-driven**（learned-cache + per-attempt hint 源，无 config），常驻兜底 `downgradeEmptyEncryptedSearchResults`（`sanitize/empty-encrypted-search-result.ts`，无 config、无条件生效）仍降级历史会话/不可控客户端 echo 带空 `encrypted_content` 的合成 `web_search_tool_result`。双跳可行性与实现留在 git 历史 + `exp/web-search-double-hop-live/`，将来真出现需服务端执行 server tool 的客户端可按需重建。

## tool input 解码 / tool-call 恢复

响应侧：`decode_tool_input_fields` 把指定字段从 stringified JSON 解回结构化；`recover_tool_call_text` 透明重建被降级为文本的 tool_use（CANDIDATE/COMMIT 两阶段，仅 forwarded 流）。

详见 DESIGN.md「核心模块 · anthropic」与运行时选项表 anthropic.tool_* 各项。
