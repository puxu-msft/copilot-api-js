---
name: project_thinking_shim_runtime_mystery
description: "已修复——损坏的 thinking block 源于 web_search 双跳绕过了 shim；pass-through 现已重派走 direct 路径"
metadata: 
  node_type: memory
  type: project
  originSessionId: 1fafa524-2287-45c2-9bca-430ac139d890
---

已解决(2026-06-10)。根因经三层文件诊断(MODULE-LOADED/HANDLE-MESSAGES/per-block + ospid)+ pid 列归因彻底裁决。

**症状**：`[Sanitizer:Anthropic] Removed N corrupt thinking` 反复刷屏，history 请求 thinking block 双空(`{thinking:"", signature:""}`)累积。

**真正根因（完整链，全部实测）**：
1. 用户开 `web_search.enabled: true`（用户 config `~/.local/share/copilot-api/config.yaml`）+ Claude Code **每个请求都带 `WebSearch` tool**。
2. `payloadHasWebSearch` 把 Claude Code 的 `WebSearch` 也算 web_search（detect.ts:23）→ handler.ts:237 `state.webSearchEnabled && payloadHasWebSearch` 永真 → **所有请求**走 `handleWebSearchCompletion`，**绕过 `handleDirectAnthropicCompletion`→`processOneStreamEvent`→thinking-signature shim**。
3. web_search 双跳用非流式 hop 拿响应，`webSearchResponseToEvents`/`buildStartContentBlock`（synthesize.ts:170-174）对 thinking 块走默认 `return block`，把 `{thinking, signature}` 整个嵌进 `content_block_start`，且不发 signature_delta。
4. = 与上游非标准帧同形 → 标准客户端丢签名 → 回传双空块 → 累积 → sanitizer 删除 → 日志。

**为何 shim 看似不生效**：shim（thinking-signature-compat.ts，接在 processOneStreamEvent）本身正确，但 web_search 路径根本不经过它。之前所有"shim 运行时返回 null"的诊断证据全是 `thinking-signature-compat.http.test.ts` 测试流量（EMBEDDED_SIG 长 28，循环三模式），不是生产。

**关键裁决手段**：Phase 1 pid/git_sha 列 + 三层诊断（模块加载/入口/per-block + ospid）。per-block 诊断 = 0 但 HANDLE-MESSAGES = 8 → 证明请求进了 handleMessages 但没到 processOneStreamEvent → 锁定 web_search 分流。

**修复方向（待与用户确认）**：web_search 合成路径也要应用 thinking-signature shim——在 `webSearchResponseToEvents`/`buildContentBlockStart` 对 thinking 块拆成 空start+signature_delta，或在 web-search-handler 转发 events 前过一遍 `applyThinkingSignatureCompat`。根因在 synthesize.ts 合成逻辑未处理 thinking signature，与主路径 shim 应统一。还有个独立问题：Claude Code 默认带 WebSearch tool 不代表要搜索，却让所有请求走双跳——值得讨论是否该收紧 detect 条件。

**已实现的修复（A+B 双路径设计）**：
- pass-through（模型不搜索，最常见）→ 重派原 `anthropicPayload` 走 `handleDirectAnthropicCompletion`，获得真流式 + thinking-signature shim + 正确 tool_use（根治 corrupt thinking + 消除假流代价）。
- searched → 保留合成 SSE；synthesize.ts `buildStartContentBlock`/`buildContentBlockDeltas` 加 thinking/redacted_thinking 防御分支（start 不嵌 signature，拆 thinking_delta+signature_delta）。
- orchestrator 拆 `runFirstHopProbe`/`completeWebSearch`；probe 用 requestContext:undefined 不污染 reqCtx；probe usage 记入 `web_search_probe` warning（原则3）。
- 代价：pass-through 多一次 probe 调用（与搜索路径对称，用户确认选最高质量方案）。
- 经两轮 subagent review（plan + impl）+ 主线亲手复核，2213 后端测试 0 fail。计划见 .claude/plans/imperative-hopping-twilight.md。待用户重启服务器实测验证。

遵守 [[feedback_reviewer_verify_critically]]、[[feedback_complete_root_cause_fix]]。pid 列实现见 .workflow/.scratchpad/record-replay-enhancement-plan.md Phase 1。
