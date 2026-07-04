---
name: reference-claude-code-timeout-and-sse-error-oracle
description: REFERENCE 实测：Claude Code CLI 请求超时**两层**——①byte-idle≈60s+自动重试（ping 重置）②no-real-content≈300s（2.1.201，只有真实 content_block_delta 重置，ping/SSE-comment 不算 chunk、空 content_delta 算）；Anthropic SDK 对 200+SSE-error 帧走裸 APIError status=undefined+零重试、CC 包装层 429 不重试但 401/400 等价
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

**Claude Code 第二层：no-real-content 上限 ≈ 300s（2.1.201 实测，2026-07-04，harness `exp/cc-idle-280s/`）**：
- 上面的 60s 是**第一层**（byte-idle，任意字节重置，ping 压住）。CC 2.1.201 另有**第二层**：一定时间内必须收到**真实 content chunk**（`content_block_delta`），否则断（报 `API Error: Stream idle timeout - no chunks received`——字面精确：no real content chunks）。阈值 ≈ **300s**（`duration_ms=300169/300187` 实测），first-party 与 prod-faithful（custom URL + token）**一致**（不能从 60s 层跨层外推，独立复测确认）。
- **`event: ping` 与 SSE comment 都不算 chunk**：纯 ping@20s 压住 60s 层却撞 300s 层断（复现用户 incident）。**空 `content_block_delta` 算 chunk**——`thinking_delta{thinking:""}` / `text_delta{text:""}` / `input_json_delta{partial_json:""}` 三种空 delta 全部实测保活到 340s 完整收尾。
- 与本 memory 上文"ping@30s 存活 330s>300s"**不矛盾**：那些 2.1.185 测试的真实内容 tail 都在 <300s 出现、重置了 300s 层（当时未覆盖 >300s 纯 ping）；本项目纯 ping 无 tail 才暴露第二层。故"ping 重置 idle"指的是**第一层 60s**。
- **修复（本项目落地）**：config `anthropic.stream_keepalive_mode: content_delta`（默认）——keepalive 发匹配当前 open block 的空 content delta 而非裸 ping，重置 300s 层。covering matrix + 四臂对照见 `exp/cc-idle-280s/REPORT.md`；实现 `src/lib/anthropic/keepalive-frame.ts`（sink + web_search legacy heartbeat 共用）。占位 block 覆盖 web_search search-合成阻塞静默暂缓。方法学同 [[feedback-self-consistent-needs-independent-oracle]]（真实 CC 作独立 oracle）+ [[feedback-pass-null-clean-not-self-validating]]（纯 ping 断=正样本证明检查触达）。

**Anthropic SDK 0.105.0 对 200+SSE-error 帧（vs HTTP-4xx）**：
- 流内 `event: error`（`core/streaming.js:113`）→ `new APIError(undefined, body, ...)`：**`.status===undefined`、非 RateLimitError/AuthenticationError/BadRequestError 子类**（子类只由 `error.js generate(status)` 在 HTTP-response 路径产）、**零自动重试**（`shouldRetry` 作用于 HTTP response、先于流迭代）。HTTP-4xx 则得类型化子类 + `.status` + 自动重试。
- `error.type` 字面量两形态都在 `body.error.type` 保住。
- **Claude Code 包装层**：对 200+SSE-error **401/400 完全等价**（显示正确 + 不重试本就正确，401 还触发 "请 /login" UX）；**仅 429/5xx 可重试类真发散**——HTTP-429 持续重试 ≥7×退避，200+SSE-error-429 一次即弃。流一旦 commit（message_start 后），即便真上游错误 CC 也不重试（流式协议固有）。

用途：本结论支撑 [[project-pre-response-abort-rfc]] 的 ③ 延迟-commit GO 裁决（grace<60s 默认 40s、heartbeat<60s、错误帧残余可接受）。
