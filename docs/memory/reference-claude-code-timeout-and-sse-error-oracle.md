---
name: reference-claude-code-timeout-and-sse-error-oracle
description: REFERENCE 实测：Claude Code CLI 请求超时=idle 型≈60s+自动重试（非 total，ping 重置）；Anthropic SDK 对 200+SSE-error 帧走裸 APIError status=undefined+零重试、CC 包装层 429 不重试但 401/400 等价
metadata:
  node_type: memory
  type: reference
---

实测裁决（2026-06-22，`claude` CLI 2.1.185 + `@anthropic-ai/sdk` 0.105.0，harness 见 `exp/q2-oracle/`），供未来 keepalive/heartbeat/错误透传决策复用。方法=真实客户端作独立 oracle（[[feedback-self-consistent-needs-independent-oracle]]）+ 受控 mock 上游 + prod-faithful 接线（[[methodology-probe-harness-must-match-prod]]）。

**Claude Code 请求超时（idle 型，非 total）**：
- CC 对 `/v1/messages` 流式请求用 **body-idle watchdog**——每收一字节/帧重置 deadline。源码 `db()`：body-idle watchdog 激活时给 fetch 设 `timeout:!1`，**关掉** `@anthropic-ai/sdk` 的 600s（`API_TIMEOUT_MS` 默认）总超时，改由 idle watchdog 管。idle deadline clamp `[1ms, 1800000ms]`、静态 base ≈180s 但**行为实测 ≈ 60s**。
- **阈值 ≈ 60s**：无字节 60s → abort + **自动重试**（实测重试 ≥6× 60s-spaced）。8 个样本全 60.0–60.2s，first-party（`_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1`）与 prod-faithful（custom base URL + auth token，不设 first-party）两路径一致。
- **ping 重置确认 idle 型**：mock 每 30s 发 `event: ping`（**message_start 之前也算字节**）→ CC 存活 330s 并成功完成；ping@45s 存活 225s 完成；故 keepalive 只需 ping 间隔 < 60s。**heartbeat ≥ 60s（如 120s）无效**。
- 注：incident 报的 ~292s 单次断开**非**自动超时——是用户中断（孪生双请求同时断）或 headless 重试风暴（~5×60s）。CC 自动机制就是 60s idle。interactive 模式未 headless 复现，但 watchdog 是 SDK/fetch 层、应 mode 无关。
- 驱动 headless CC 打到自定义 mock：`claude -p ... --settings <json>`（命令行优先级盖过 `~/.claude/settings.json` 的 `env.ANTHROPIC_BASE_URL=localhost:4141`）+ `--strict-mcp-config`；`--output-format json` 出 `is_error`/`result`/`duration_ms`。

**Anthropic SDK 0.105.0 对 200+SSE-error 帧（vs HTTP-4xx）**：
- 流内 `event: error`（`core/streaming.js:113`）→ `new APIError(undefined, body, ...)`：**`.status===undefined`、非 RateLimitError/AuthenticationError/BadRequestError 子类**（子类只由 `error.js generate(status)` 在 HTTP-response 路径产）、**零自动重试**（`shouldRetry` 作用于 HTTP response、先于流迭代）。HTTP-4xx 则得类型化子类 + `.status` + 自动重试。
- `error.type` 字面量两形态都在 `body.error.type` 保住。
- **Claude Code 包装层**：对 200+SSE-error **401/400 完全等价**（显示正确 + 不重试本就正确，401 还触发 "请 /login" UX）；**仅 429/5xx 可重试类真发散**——HTTP-429 持续重试 ≥7×退避，200+SSE-error-429 一次即弃。流一旦 commit（message_start 后），即便真上游错误 CC 也不重试（流式协议固有）。

用途：本结论支撑 [[project-pre-response-abort-rfc]] 的 ③ 延迟-commit GO 裁决（grace<60s 默认 40s、heartbeat<60s、错误帧残余可接受）。
