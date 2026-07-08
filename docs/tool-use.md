# Tool Use 与 Server Tools

涵盖 tool name 清洗/还原、server tool 处理、web_search 双跳、tool input 解码与 tool-call 文本恢复。

## Tool name 映射

`src/lib/tool-name-mapper.ts` 跨域共享：发上游前按目标模型约束清洗非法/超长/冲突名，响应里还原客户端原始名（Anthropic + CC + Responses 三路径）。受 `sanitize_tool_names` 控制。

## Server tools

`src/lib/anthropic/server-tool-filter.ts` 拦截 `server_tool_use` / `*_tool_result`。剥离集合是三源并集：全局开关（`server_tool_strip`）∪ 反应式学习账本 ∪ 单次重试 hint。`tool_search`（`tool_search` 配置）按模型能力注入；`tool_search_non_deferred` 控制延迟工具。

`stripToolFields`（`message-tools.ts`）剥除 GHC 上游拒绝的**未知 custom-tool 顶层字段**（400 `tools.N.<variant>.<field>: Extra inputs are not permitted`）。四源并集：内置默认 `["eager_input_streaming"]`（新版 CC 挂在每 tool 上、GHC 版本较旧拒之）∪ config `tool_strip_fields` ∪ 端点级学习账本（`tool-field-rejection-retry` 策略捕获后写入、模型无关）∪ 单次 hint（`PrepareHints.excludeToolFields`），减 config `tool_keep_fields`（可逆逃生口）与恒不剥的 `LEGIT_TOOL_KEYS`（`name`/`description`/`input_schema`/`type`/`defer_loading`/`cache_control`——上游把这些报成 extra 是变体误路由信号，放行到裸 400 而非静默剥）。

## web_search 双跳（旁路）

`src/lib/anthropic/web-search/`（orchestrator + backends + detect + synthesize）：拦含 native web_search 的请求、执行真实搜索、主模型二次生成。**不进 driver**，走 legacy direct-completion。配套 `server_tool_rewrite: downgrade` 处理回流的 server_tool_use。

## tool input 解码 / tool-call 恢复

响应侧：`decode_tool_input_fields` 把指定字段从 stringified JSON 解回结构化；`recover_tool_call_text` 透明重建被降级为文本的 tool_use（CANDIDATE/COMMIT 两阶段，仅 forwarded 流）。

详见 DESIGN.md「核心模块 · anthropic」与运行时选项表 anthropic.tool_* 各项。
