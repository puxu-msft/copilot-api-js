# Q2 oracle 实测报告 — pre-response 保活（③）的 go/no-go 硬门

**日期：** 2026-06-22
**对应 RFC：** [../../docs/rfc/pre-response-abort-handling.md](../../docs/rfc/pre-response-abort-handling.md) §6 Q2 / §4.2.3 / §4.2.5 / §5 C3b
**性质：** 实测（非代码）。真实 `@anthropic-ai/sdk` 0.105.0 + 真实 `claude` CLI 2.1.185 作独立 oracle，受控 mock 上游。
**裁决：** **GO（有条件）** — ③ 可实现；grace 默认值有了实测依据。

---

## 0. TL;DR

| 问题 | 实测结论 |
|---|---|
| **(a) CC 请求超时类型** | **idle 型**（每收一帧/字节重置），**非** total 型。源码（`db()` 在 body-idle watchdog 激活时 `timeout:!1` 关掉 SDK 600s 总超时）+ 行为（ping@30s 存活 330s 并成功完成）双证。 |
| **(a) CC 超时阈值** | **≈ 60s idle**（无字节 60s → abort + **自动重试**）。8 个样本全落 60.0–60.2s，first-party 与 prod-faithful（custom URL + `copilot-api` token）两路径一致。incident 的 ~292s **不是**单次自动超时——是用户中断 *或* ~5×60s 重试风暴（RFC 已自行 hedge "或用户中断"）。 |
| **(a) grace 默认值** | **必须 < 60s**（硬约束，实测）。推荐 **grace ≈ 40s + heartbeat ≈ 30–40s**（留 ≥20s margin）。**③ 当前稿的 120s heartbeat 太慢、会失效。** |
| **(b) 错误帧等价性** | **部分等价**。`error.type` 字面量在富帧里**保住**（CC 各类错误都正确显示）；但 200+SSE-error 一律 `status=undefined`、丢类型化子类。**401/400/任何不可重试类 → 完全等价**（CC 不重试是正确行为）。**429（及 5xx 可重试类）→ 真发散**：CC 对 HTTP-429 持续重试（≥7 次退避），对 200+SSE-error-429 视为终态、**一次即弃不重试**。 |
| **go/no-go** | **GO**：keepalive 机制实证可行；错误帧残余被延迟-commit 收窄到"长 stall（>grace）后才到的*可重试*错误"这一病态少数；不可重试错误完全等价；`error.type` 保真保证正确显示。 |

---

## 1. 方法（probe-harness-must-match-prod）

- **独立 oracle（self-consistent-needs-independent-oracle）**：不用代理自身 encode↔decode 自洽判等价，而是用**真实 `@anthropic-ai/sdk` 0.105.0**（代理与 Claude Code 共享的同一版本）+ **真实 `claude` CLI 2.1.185** 作对端裁决。
- **受控 mock 上游** [`mock-server.ts`](./mock-server.ts)：可 (i) pre-response 静默 N 秒（含**真withhold headers** 与 200-then-idle 两式）、(ii) 200+SSE 仅 ping、(iii) 返回 HTTP 4xx（real-Anthropic 形态）、(iv) 200+首事件即富 error 帧（③ POST-COMMIT 形态）、(v) commit-then-error（mid-stream）。
- **prod 忠实接线**：真实 prod 把 CC 经 `~/.claude/settings.json` 的 `env` 块指向 `localhost:4141`（custom URL + `ANTHROPIC_AUTH_TOKEN=copilot-api`，**不**设 `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL`）。故 CC 驱动用 `--settings`（命令行优先级，盖过 user settings 的 base URL）+ **两套对照**：`CC_FIRST_PARTY=1`（first-party 路径）与 `CC_FIRST_PARTY=0`（prod-faithful，正是 incident 发生的接线）。
- **harness 不自证（pass-null）**：mock 逐请求记 monotonic 时间戳 + 客户端 abort 事件；CC 的 POST 次数从 mock 日志数（不靠 CC 自报）；SDK 重试次数用 custom `fetch` 计数器实测。

---

## 2. Part (b) — 错误帧等价性

### 2.1 原始 SDK 层（[`sdk-probe.ts`](./sdk-probe.ts)，@anthropic-ai/sdk 0.105.0）

| shape | 异常类 | `.status` | `error.type` | retry_after | SDK 尝试次数 |
|---|---|---|---|---|---|
| HTTP-429（real-anthropic） | **RateLimitError** | **429** | rate_limit_error | (header) | **3**（自动重试 2×） |
| 200+SSE-error-429（③ post-commit） | APIError（裸） | **undefined** | rate_limit_error | 30（body 内） | **1**（零重试） |
| HTTP-401 | AuthenticationError | 401 | authentication_error | — | 1 |
| 200+SSE-error-401 | APIError（裸） | **undefined** | authentication_error | — | 1 |
| HTTP-400 | BadRequestError | 400 | invalid_request_error | — | 1 |
| 200+SSE-error-400 | APIError（裸） | **undefined** | invalid_request_error | — | 1 |

**证实 RFC §4.2.5 静态 oracle**（在 *installed* 0.105.0 版逐行核）：`core/streaming.js:113` 对流内 `event: error` 抛 `new APIError(undefined, body, undefined, headers, type)` → `status===undefined`；`RateLimitError` 只由 `error.js:60 generate(status===429)` 在 HTTP-response 路径产；`shouldRetry`（`client.js:570`）作用于 HTTP response、**先于**流迭代，故 200 流的 error 帧**零自动重试**。`error.type` 字面量两形态都在 `body.error.type` 保住。

### 2.2 Claude Code 包装层（真实 `claude` CLI，更高层 oracle）

| 场景 | mock 收到 POST 次数 | CC 用户可见 |
|---|---|---|
| E1 200+SSE-error-429 | **1** | `is_error:true`，`"API Error: Number of requests has exceeded your rate limit"`，**不重试** |
| E2 HTTP-429（retry-after=1） | **7+**（1s,2.5s,4.7s,6.8s,11.5s,20s,37s… 退避） | **持续重试** |
| E3 commit-then-error-429（mid-stream） | 1 | API Error，不重试 |
| E4 200+SSE-error-401 | 1 | `"Not logged in · Please run /login"`（从 `error.type=authentication_error` 映射），不重试（**正确**） |
| E5 200+SSE-error-400 | 1 | `"API Error: messages: at least one message is required"`，不重试（**正确**） |

**裁决（错误帧）：**
- **`error.type` 保真 → 全类错误正确显示**（401 甚至触发 CC 专属 "请 /login" UX）。非 `500 Unexpected`，无误导。
- **401 / 400 / 任何不可重试类 → 完全等价**：CC 显示正确 + 不重试本就是正确行为，HTTP-4xx 与 200+SSE-error **可观测无差**。
- **429（及 5xx 可重试类）→ 真发散**：CC 对 HTTP-429 持续重试（≥7×），对 200+SSE-error-429 一次即弃。这是 §4.2.5 担心的核心，**行为实证**。
- **E3 关键**：流一旦 commit（已发 message_start），即便是 mid-stream 的"真"上游错误，CC 也**不重试**——这是流式协议**固有**（real Anthropic 亦然）。故 ③ 的 POST-COMMIT 对*任何* generation 开始后的错误与 real-Anthropic 一致；**唯一**真发散 = real-Anthropic 本会以 pre-stream HTTP 返回、但在 ③ 下落到 grace 之后才到的错误。

---

## 3. Part (a) — CC 请求超时类型 + 阈值

### 3.1 行为实测

| 场景 | 接线 | 结果 |
|---|---|---|
| noheaders（真 withhold headers） | first-party | abort **+60.00s**（×2，重试） |
| noheaders | **prod-faithful** | abort **+60.00s**（×3+，重试） |
| silent（200 headers + idle body） | first-party | abort **+60.17/60.14s**（×2） |
| silent | **prod-faithful**（B2） | abort **+60.0–60.2s**（×**6**，持续重试 ~380s） |
| **ping@30s** + tail | first-party（C） | **存活 330s，成功完成**（`is_error:false`，`result:"done"`，11 pings） |
| **ping@45s** + tail | prod-faithful | **存活并完成**（pings 0/45/90/135/180s + tail 227s，`is_error:false`，`result:"done"`，225s）→ 45s 间隔（margin 15s）足够保活 |

**8 个 abort 样本全落 60.0–60.2s**，first-party 与 prod-faithful 一致 → 阈值稳定、非路径相关、非 flaky。

### 3.2 源码佐证（idle 型，非 total）

`claude` 2.1.185 二进制：
- `db()`：`n = forAnthropicAPI && !API_FORCE_IDLE_TIMEOUT && (hasBodyIdleWatchdog||…)`；`n` 真 → fetchOptions `timeout:!1` —— **body-idle watchdog 激活时关掉 SDK 的 600s 总超时**，改由 watchdog 管。
- watchdog `y8u`：`_=(S)=>{…A=performance.now();…o=setTimeout(…,t)}` 每收一 chunk 重置 deadline `A`/重排 timer `o` → **idle 型，逐 chunk 重置**。
- `API_TIMEOUT_MS` 默认 `600000`（600s，SDK client timeout）；另有 `ubf()`=300s；idle deadline clamp `[1ms, 1800000ms]`。
- **行为压过静态**：实测 abort 在 60s（非静态 candidate 的 180/300/600s）；ping 重置存活证明确属 idle watchdog。

### 3.3 incident 292s 的调和（诚实标注）

incident（req_1782109595295_538）单次 292s + 孪生同时断。我的实测**自动**机制是 60s+重试。两解释，均不与"自动超时=60s"矛盾：
1. **用户中断**：RFC §1.2 已自写 "或用户中断"；孪生双请求**同时**断强烈指向单一用户动作（Esc 取消全部在飞）。
2. **重试风暴**：headless CC 在 idle-timeout 后自动重试，~5×60s ≈ 300s（但每次重试 = 新代理请求，与 incident 单条 292s 略不符 → 倾向解释 1，或 incident 为 interactive 模式）。

**残余不确定**：headless `-p` 模式实测 60s；**interactive 模式未能 headless 复现**。但 60s 由 SDK/fetch 层 body-idle watchdog 驱动（非 `-p` 特性），interactive 应同机制。为稳妥，grace 推荐取**保守偏小**值，对两模式都安全。

---

## 4. 裁决 — go/no-go + grace 默认值

### 4.1 GO（有条件）

③ **可实现**。理由：
1. **keepalive 机制实证可行**：idle 型 + ping（含 message_start 前的 ping）重置 deadline，确认 ping@30s 存活 330s 并成功完成。③ 的"commit 200 + 周期 ping"对 opus 长 stall 有效。
2. **错误帧残余窄且可接受**：延迟-commit（§4.2.2）只让 grace 之后才到的错误 downgrade。429 等可重试错误是**亚秒级 pre-response 决策** → 落在 grace 内 → 出 real HTTP-429 → CC 正常重试。只有"长 stall（>grace）**后**才到的**可重试**错误"才 downgrade = 病态少数。不可重试错误（401/400/绝大多数）**完全等价**。
3. **`error.type` 保真**（`mapHttpErrorToEnvelope` 已落地 `3e4b3cd`）保证 CC 各类错误正确显示，无 `500 Unexpected` 误导。

### 4.2 grace 默认值（实测依据，替换 RFC §4.2.3 "待 Q2 实测"）

**硬约束（实测）：`grace < 60s`** —— CC 在无字节 60s 后 abort 第一尝试，若 grace ≥ 60s，CC 在代理 commit 前就放弃了 → ③ 在首尝试上根本不触发。

**推荐：`pre_stream_grace` 默认 ≈ 40s，heartbeat 间隔 ≈ 30–40s**（均留 ≥20s margin under 60s）。
- grace 40s：绝大多数上游（含错误）在 40s 内回头 → PRE-COMMIT 零发散；仅真·长 stall 在 40s 后 commit。
- heartbeat 30–40s：commit 后周期 ping < 60s idle 阈值，持续保活（ping@30s 已证存活；ping@45s margin 见 §3.3）。
- **⚠️ ③ 当前稿/既有 `anthropicFakeSseHeartbeat` 的 120s 太慢**：> 60s 阈值，无效。**heartbeat 必须 < 60s**。此结论亦波及既有 mid-stream `anthropicFakeSseHeartbeat`（若设 120s）与 `protect_streaming_heartbeat`（prod 默认 15s，OK）。

### 4.3 §4.2.5 残余的诚实标注

200+SSE-error 相对 HTTP-error 的**不可消除残余**：对**可重试**错误（429/5xx/overloaded），CC 丢失 `.status` 与自动重试。协议层无法弥补（SSE-error 无 HTTP 状态语义）。这正是**grace 取大、最小化落入 POST-COMMIT 的错误数**的根本原因，且应文档诚实标注。**不建议**对特定 error.type 在 POST-COMMIT 拒绝 downgrade（已 commit 200，物理上回不了 HTTP status）——唯一杠杆是 grace 取得足够大让可重试错误几乎都落在 PRE-COMMIT。

---

## 5. 复现

```bash
# Part (b) 原始 SDK oracle（mock 在 8788）
MOCK_MODE=ok MOCK_PORT=8788 bun run exp/q2-oracle/mock-server.ts &
bun run exp/q2-oracle/sdk-probe.ts

# Part (a) + CC-layer（自动起 mock + 真实 claude）
bash exp/q2-oracle/run-all.sh            # E1-E5 错误帧 + A/B/C 超时（first-party）
CC_FIRST_PARTY=0 ... bash exp/q2-oracle/cc-run.sh <label> <mode>   # prod-faithful
```

产物：`exp/q2-oracle/*.log`（mock 时间戳日志 + CC cli json）、`sdk-probe.out`、`part-a-summary.log`。
