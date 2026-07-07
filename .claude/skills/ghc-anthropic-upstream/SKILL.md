---
name: ghc-anthropic-upstream
description: 当排查 copilot-api-js Anthropic 路径上游异常时使用——thinking signature "cannot be modified" 400、空明文 thinking 毒化、thinking-only refusal(stop_reason:refusal)、tool_use 降级成 antml 文本、server_tool_use 400、tool_use.id 格式。含经 history sseEvents 诊断与本地探针手法（通用实测见 empirical-verification）。
---

# Anthropic 上游调试

## 探针手法（实证 > 推断）

从常驻 `localhost:4141` 拉真实数据复现（`curl -s :4141/health` 确认在跑，**别自启/kill**）：`GET /history/api/entries?limit=N` 看列表 → `GET /history/api/entries/:id` 取全量（`clientRequest`/`clientResponse`/`attempts[].{upstreamRequest,upstreamResponse}`/per-attempt `sseEvents`；2026-07-07 重构后旧 `inboundRequest`/`outbound*` 腿名已迁 client/upstream），内含真实有效 thinking signature。jq 拼最小请求 `--slurpfile` 防转义、`max_tokens` 调小省 token → `curl -X POST :4141/v1/messages`。**无损取字节**（勿 `tr -d '\n'` 折叠，会误判间隔）。

## 症状 → 根因 → 配置

| 症状 | 根因 | 处理 |
|---|---|---|
| `thinking ... cannot be modified` 400 | 上游 opus-4.8 thinking 全空明文+签名属常态(只发 signature_delta)；个别块签名对不上=毒化，baked 进历史每轮重败；inline `role:system` 驱动 GHC 坍缩使其落进 latest-assistant 严格校验 | proxy 逐字节透传非元凶；`system_messages_sanitize:as_user` 减坍缩救不回旧；剥全部 thinking→200；CC 自动剥重试兜底(暂缓 proxy 修) |
| 空轮/坏轮、`stop_reason:refusal` 仅 thinking | thinking-only refusal | `refusal_recover_text`。docs/refusal-recovery.md |
| `call<invoke>…` 文本无 tool_use | GHC 偶发降级成 antml-strip 文本（`stop_reason` 仍 tool_use/或 end_turn 弱信号），标签间是 `\n` 非零间隔 | `tool_recover_call_text`（非本项目 bug，grep antml 零命中） |
| `references web_search but not server tool` 400 | 历史残留 server_tool_use | `tool_rewrite_history_server:downgrade` + 开 web_search |
| `Invalid encrypted_content in search_result block` 400 | web_search 双跳合成的 `web_search_tool_result` 结果项 `encrypted_content=""`（`synthesize.ts`，后端产不出真加密内容）回流历史，上游校验真实非空 string（空/null/占位全 400，error-shaped 反而 200） | **always-on 兜底自动降级**（`sanitize/empty-encrypted-search-result.ts`，无需配置）；开 `tool_rewrite_history_server:downgrade` 更宽清理。exp/encrypted-content-400 |
| 双空块被拒 | shim 把 sig 嵌 start 无 signature_delta（web_search 双跳绕 shim 曾酿此） | `thinking_signature_compat` |

## 实测关键事实

- thinking signature **自包含**（加密 thinking 内容本身、非上下文/位置）：跨对话/非首块/重写后均 200；唯一约束=原样不改、连续序列不重排。
- tool_use.id 上游不校验格式（`toolu_recovered_0` 也 200），只引用一致性要紧；仍合成 `toolu_`+24base62 防客户端 SDK。
- 上游兼容矩阵/特性协商属 docs（anthropic-compat.md / refusal-recovery.md），本 skill 只管调试。

> Claude Code **客户端**的连接/流式行为（CC 请求超时两层、keepalive 空 content-delta、合成帧 event: 行 + synthetic 标记、SDK 对 200+SSE-error 零重试）是**下游客户端**域，不在本 skill——见 skill `claude-code-connection`。上游**传输**（fetch/http2/proxy/keepalive）见 skill `bun-upstream-transport`。
