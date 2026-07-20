# Phase 3 — Responses 传输失败重试对齐（buffered 采用 + 截断 gate）

> REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`。步骤用 `- [ ]` 追踪。
> 隐含遵守 [README.md](./README.md) Global Constraints。**Spec**: [../../spec/2026-07-09-codex-responses-tier1-hardening.md](../../spec/2026-07-09-codex-responses-tier1-hardening.md) R4 + R5.2 + §2.2。**依赖 Phase 2 保活**。

**Goal:** 让 Responses（SSE/HTTP）路径的 mid-stream 上游传输中断可被**重试**（对齐 Anthropic），通过**采用 driver 既有的 `runResponseBufferedSink`**（opt-in、默认 live）；截断检测（clean drain 无终止符）作为 buffered 的 commit/retry gate。用户已确认：**Codex 默认不做 mid-stream auto-retry，可配置启用**。

**Architecture（经核验）：**
- Responses 流式当前走**非缓冲 `runResponseSink`**（`handler-v4.ts:306`），**无重试循环**（任何非 abort 抛出 → `stream-error`，`driver.ts:497`）。策略只在流开始前（`runExchange`）生效。
- mid-stream 无重复投递的重试唯一机制 = driver 的 **`runResponseBufferedSink`**（`driver.ts:521`，`driver.ts:114` 注释"no consumer"已陈旧——Anthropic `messages/handler-v4.ts:1050` 已是消费者）。它 buffer 每次尝试的 rendered 帧、只在**见到终止符的 clean drain** 才 commit（flush 给 sink）；transport-close/truncation → 重跑 exchange 重 buffer，至 `retryCap`；all-or-nothing。
- **采用它作 Responses 第二消费者**（driver 签名不变，全走 opts）：`sawMessageStop: () => acc.status !== ""`（`response.completed/.failed/.incomplete` 均 set `acc.status`，`responses-stream-accumulator.ts:68/81`；这复用了 live 路径 `handler-v4.ts:359` 的 `acc.status === ""` 截断判据 = R5.2）；`anchor: undefined`（empty_text anchor 是 Anthropic 专属，driver anchor 分支在 undefined 时 inert）；`onRenderedFrame` 复用既有 restore/accumulate（buffered 路径亦调，`driver.ts:610`）。
- **R4.3(a) buffering ⇒ 强制保活**：buffered 模式 commit 前零真实帧 → 长静默自触发 Codex 300s idle。镜像 Anthropic `resolveBufferedAndHeartbeat`（`messages/handler-v4.ts:905-911`）：buffered 时 forcedHeartbeatSec = `streamKeepalivePingSec>0 ? streamKeepalivePingSec : protectStreamingHeartbeat`。
- **R4.3(b) 默认 live**：默认 `runResponseSink`（mid-stream 掉线 → fail + 保留 partial + 截断 error frame，即今 `handler-v4.ts:359-369` 不变）。buffered 是 opt-in 保护开关。**mid-stream 重试仅在 buffered 可达**。

**范围界定：** Phase 3 核心 = **SSE/HTTP 路径**（`handler-v4.ts`，Codex tier-1 路径）。**下游-WS（`ws.ts`）的 buffered 采用**是对称后续工作（Codex 用 SSE；上游-WS→下游-WS buffered 交互需单独细做）→ 记 `docs/todo/deferred-backlog.md`（Phase 5）。Responses-专属 caps（vs 复用 `protectStreaming*`）亦记 backlog。

---

## Task 3.1：Responses buffered opt-in 配置门 + 强制保活解析

**Files:**
- Modify: `src/lib/state.ts`（加 `responsesBufferedRetry: boolean`，default `false`，注册进 CONFIG_MANAGED_DEFAULTS + 类型联合）
- Modify: `src/lib/config/config.ts`（config.yaml → state 的映射，就近 `protectStreaming` / responses 配置块）
- Create: `src/routes/responses/buffered-config.ts`（`resolveResponsesBufferedAndHeartbeat(env)` helper）
- Test: `tests/responses/responses-buffered-config.unit.test.ts`

**Interfaces:**
- Produces: `export function resolveResponsesBufferedAndHeartbeat(): { buffered: boolean; heartbeatSec: number }` —— `buffered = state.responsesBufferedRetry`；`heartbeatSec = buffered ? (state.streamKeepalivePingSec > 0 ? state.streamKeepalivePingSec : state.protectStreamingHeartbeat) : state.streamKeepalivePingSec`。

- [ ] **Step 1：写失败测试**

```ts
import { describe, expect, test, afterEach } from "bun:test"
import { resolveResponsesBufferedAndHeartbeat } from "~/routes/responses/buffered-config"
import { setStateForTests, snapshotStateForTests, restoreStateForTests } from "~/lib/state"

describe("resolveResponsesBufferedAndHeartbeat", () => {
  const snap = snapshotStateForTests()
  afterEach(() => restoreStateForTests(snap))

  test("default: buffered off, heartbeat = streamKeepalivePingSec", () => {
    setStateForTests({ responsesBufferedRetry: false, streamKeepalivePingSec: 20 })
    expect(resolveResponsesBufferedAndHeartbeat()).toEqual({ buffered: false, heartbeatSec: 20 })
  })
  test("buffered on with ping>0: forces heartbeat = ping", () => {
    setStateForTests({ responsesBufferedRetry: true, streamKeepalivePingSec: 20 })
    expect(resolveResponsesBufferedAndHeartbeat()).toEqual({ buffered: true, heartbeatSec: 20 })
  })
  test("buffered on with ping=0: forces heartbeat = protectStreamingHeartbeat", () => {
    setStateForTests({ responsesBufferedRetry: true, streamKeepalivePingSec: 0, protectStreamingHeartbeat: 15 })
    expect(resolveResponsesBufferedAndHeartbeat()).toEqual({ buffered: true, heartbeatSec: 15 })
  })
})
```
（`setStateForTests` 的可设键需含新 `responsesBufferedRetry`——见 Step 3。）

- [ ] **Step 2：运行，确认失败**（helper + config 键未定义）。

- [ ] **Step 3：实现**
- `state.ts`：`readonly responsesBufferedRetry: boolean`，加进 `CONFIG_MANAGED_DEFAULTS`（`responsesBufferedRetry: false`）、`setStateForTests` 白名单、config-managed 键联合（照 `protectStreaming*` 的既有位置）。
- `config.ts`：把 responses 配置块（或新增 `responses.buffered_retry`）映射到 `setResponsesConfig`/`setState`。查既有 `responsesConfig` 处理（`config.ts` 已有 `upstream_ws` 映射，`config.ts:735` 附近）就近加 `buffered_retry`。
- `buffered-config.ts`：实现 helper。

- [ ] **Step 4：运行通过 + typecheck + 提交**

```bash
bun test tests/responses/responses-buffered-config.unit.test.ts && bun run typecheck 2>&1 | tail -2
git add -- src/lib/state.ts src/lib/config/config.ts src/routes/responses/buffered-config.ts tests/responses/responses-buffered-config.unit.test.ts
git commit -F- -- src/lib/state.ts src/lib/config/config.ts src/routes/responses/buffered-config.ts tests/responses/responses-buffered-config.unit.test.ts <<'EOF'
feat(responses): add opt-in buffered-retry config gate + forced-heartbeat resolver

responsesBufferedRetry (default OFF — Codex mid-stream auto-retry is opt-in).
resolveResponsesBufferedAndHeartbeat forces a keepalive interval in buffered
mode (commit-time flush → zero real frames until commit → must keep Codex's
300s idle clock alive), mirroring Anthropic's resolveBufferedAndHeartbeat.
EOF
```

---

## Task 3.2：Responses 采用 `runResponseBufferedSink`（opt-in 分支）

**Files:**
- Modify: `src/routes/responses/handler-v4.ts`（`pumpStreamingV4`：buffered/live 分支；sink heartbeat 用 resolved heartbeatSec；`sawUpstreamError` 判定）
- Test: `tests/responses/responses-buffered.it.test.ts`（Create）

**Interfaces:**
- Consumes: `resolveResponsesBufferedAndHeartbeat`（3.1）、`driver.runResponseBufferedSink`、`acc.status`。

- [x] **Step 1：核定 Responses upstream-error 终止的处理（sawUpstreamError）**

Run: `grep -n "\"error\"\|case \"error\"\|streamError\|type === \"error\"" src/lib/openai/responses-stream-accumulator.ts src/routes/responses/handler-v4.ts`
判据：Responses 流的终止 `error` 事件是否 set `acc.status`（或另有信号）。
- 若 `response.failed` 已 set `acc.status`（是，`:81`）→ 一个 CAPI/SSE `error` 帧是否也走 failed？确认 driver/codec 是否把 upstream `error` 映射成终止。
- 若 upstream `error` 事件**不** set `acc.status` → 它会被当 truncation 重试。决定：加 `sawUpstreamError: () => <error 事件已见>`（让 buffered commit + 由 handler fail，不浪费重试），或确认重试该 error 是无害的。将结论写进 handler 注释。

- [x] **Step 2：写失败测试（buffered mid-stream drop → 重试成功；live → fail+partial）**

`tests/responses/responses-buffered.it.test.ts`：用一个可编程的 fake `UpstreamStream`（首次 attempt 中途 transport-close 抛、重试 attempt 干净 drain 到 `response.completed`），驱动 `pumpStreamingV4`：
```ts
// buffered ON: first upstream attempt truncates mid-stream, retry completes.
test("buffered mode retries a mid-stream upstream drop and delivers ONE complete generation", async () => {
  setStateForTests({ responsesBufferedRetry: true, protectStreamingMaxRetries: 2, streamKeepalivePingSec: 20 })
  // ... drive pump with a transport that fails attempt 1 mid-stream, succeeds attempt 2
  // assert: client received the COMPLETE second generation exactly once (no partial from attempt 1),
  //         ctx settled success, attempts > 1.
})
// live (default) OFF: a mid-stream drop fails + preserves partial (unchanged behavior).
test("live mode (default) fails a mid-stream drop and preserves the partial", async () => {
  setStateForTests({ responsesBufferedRetry: false })
  // ... assert: fail + partial preserved + truncation error frame written (handler-v4.ts:359-369 behavior)
})
```
（参考 Anthropic 的 buffered 测试 `tests/anthropic/streaming-l2-baseline.http.test.ts` 的 transport-fault harness 形态。）

- [x] **Step 3：运行，确认失败**（buffered 分支未实现，测试 1 失败）。

- [x] **Step 4：实现 buffered/live 分支**

在 `pumpStreamingV4`：
- 顶部 `const { buffered, heartbeatSec } = resolveResponsesBufferedAndHeartbeat()`。
- sink heartbeat 的 `intervalSec` 用 `heartbeatSec`（替 Task 2.1 直接读 `streamKeepalivePingSec`——现由 resolver 统一，buffered 时被强制）。
- 分支：
```ts
const outcome = buffered
  ? await driver.runResponseBufferedSink(upstream, env, sink, {
      onRenderedFrame,                       // restore + accumulate (buffered path invokes it)
      anchor: undefined,                     // empty_text anchor is Anthropic-only; driver inert
      sawMessageStop: () => acc.status !== "", // terminal seen (completed/failed/incomplete) = R5.2 gate
      ...(/* sawUpstreamError per Step 1 conclusion */),
      retryCap: state.protectStreamingMaxRetries,
      bufferCapBytes: state.protectStreamingBufferCapBytes,
      onBufferedResolve: (o, retries) => {
        if (o === "success" && retries === 0) return
        // telemetry parity with Anthropic (recordProtectStreamingOutcome + feature tag + log)
      },
    })
  : await driver.runResponseSink(upstream, env, sink, { onRenderedFrame })
```
- live 分支保持 `handler-v4.ts:306` 现行为（不变）；buffered 仅当 opt-in。
- 保持 `recordForwarded()` 在 settle 前（现有顺序）。

> **实施补充（超出上方伪代码，必需的正确性修复）：** Responses `acc` 原为单个 `const`、跨 buffered 重试复用，`buildResponsesResponseData(acc)` 读追加式 `contentParts`/`toolCalls`——会把被丢弃尝试的 partial 泄漏进已提交生成的历史记录。已改 `const acc` → `let acc` 并向 buffered opts 加 `onAttemptReset: () => { acc = createResponsesStreamAccumulator(); bytesIn = 0; eventsIn = 0 }`（对齐 Anthropic 的 `let acc` + reset）。集成测试断言 `upstreamResponse.body` 只含 attempt-2 内容（去掉 reset 实测为 `"PARTIAL_ATTEMPT_1COMPLETE_ATTEMPT_2"`，故为承重断言）。`forwardedSseEvents` 不重置（buffered 仅在 commit 写客户端，wire 连续）。

- [x] **Step 5：运行通过 + 全 responses 测试 + typecheck**

Run: `bun test tests/responses/ && bun run typecheck 2>&1 | tail -2`
Expected: PASS（buffered 重试测试 + live 不变测试 + 既有 266）。

- [x] **Step 6：Anthropic 爆炸半径 tripwire**

Run: `bun test tests/anthropic/streaming-l2-baseline.http.test.ts tests/anthropic/keepalive-e2e.http.test.ts 2>&1 | grep -E "pass|fail" | tail -2`
Expected: 绿（证 driver 共享原语未因 Responses 采用而回归 Anthropic）。

- [x] **Step 7：提交**

```bash
git add -- src/routes/responses/handler-v4.ts tests/responses/responses-buffered.it.test.ts
git commit -F- -- src/routes/responses/handler-v4.ts tests/responses/responses-buffered.it.test.ts <<'EOF'
feat(responses): adopt runResponseBufferedSink for opt-in mid-stream retry

Responses becomes the driver's second buffered-sink consumer (signatures
unchanged, all via opts): sawMessageStop = acc.status !== "" (terminal-seen,
the R5.2 truncation gate reused from the live path), anchor undefined
(Anthropic-only). Default stays live runResponseSink (fail + partial on drop);
buffered is opt-in (responsesBufferedRetry) and forces keepalive. A mid-stream
upstream drop now retries the exchange and delivers ONE complete generation.
EOF
```

---

## Task 3.3：R4-pre 覆盖核验 + R5.2 截断 gate 回归 + 集成收口

**Files:**
- Test: `tests/responses/responses-buffered.it.test.ts`（补充）、`tests/responses/…`（R5.2 live 截断）
- 可能 Modify: `src/lib/codec/openai-responses/strategies.ts`（仅当 R4-pre 发现 pre-stream 传输失败有未覆盖缺口）

- [ ] **Step 1：R4-pre 覆盖核验**

核验 before-first-event 传输失败的覆盖：R1 已恢复 WS→HTTP 降级（`upstream-ws-attempt.ts`）；S4 策略覆盖 exchange 建立失败。grep 既有 Responses 策略：
Run: `grep -n "buildOpenAiResponsesStrategiesForEnv\|network\|transport\|ECONNRESET\|server-error" src/lib/codec/openai-responses/strategies.ts`
判据：pre-first-event 的网络/传输错误是否被 S4 策略或 WS→HTTP 降级覆盖。
- 若已覆盖 → 加一个 regression 测试固化（pre-stream transport error → 降级/重试），记录结论。
- 若有缺口 → 补格式无关的 network/transport-close 策略（**先 grep 同错误子串既有 matcher 避免遮蔽**，记忆 `new-strategy-shadowed-by-broader-first-match`），排前，附认领归属回归测试。

- [ ] **Step 2：R5.2 live 截断 gate 回归**

在实际 live `runResponseSink` 路径断言：clean drain 而无 `response.completed`（`acc.status === ""`）→ **fail**（保留 partial + 截断 error frame），非 silent complete（`handler-v4.ts:359-369` 现行为）。写回归测试锁定（这是 buffered gate 的 live 孪生）。

- [ ] **Step 3：buffered 穷尽路径测试**
- 重试耗尽（retryCap 用完仍 truncate）→ settle fail、保留最后 partial 语义。
- 干净首尝试 commit（retries===0）→ 成功、`onBufferedResolve` 不误报。
- `response.failed` 终止 → commit + fail（不浪费重试）。

- [ ] **Step 4：全套 + 连跑确定性 + typecheck**

Run: `bun test tests/responses/ && bun run typecheck 2>&1 | tail -2`
时序/重试测试连跑 10×确认无 flaky。

- [ ] **Step 5：提交**

```bash
git add -- tests/responses/ <可能的 strategies.ts>
git commit -m "test(responses): R4-pre coverage + R5.2 truncation-gate regressions for buffered/live" -- tests/responses/ <files>
```

---

## Phase 3 DoD

- [ ] `responsesBufferedRetry` 门（默认 false）+ 强制保活解析（3.1）。
- [ ] Responses 采用 `runResponseBufferedSink`（opt-in）；driver 签名不变（3.2）。
- [ ] buffered 模式 mid-stream 上游 drop → 重试、交付一份完整生成；live 默认 → fail+partial（3.2）。
- [ ] R4-pre 覆盖有结论 + 回归；R5.2 截断 gate（live + buffered）回归（3.3）。
- [ ] Anthropic golden tripwire 绿（driver 未回归）。
- [ ] `bun run typecheck` + `bun test tests/responses/ tests/anthropic/` 绿；时序测试 10× 无 flaky。
- [ ] 各 task 细粒度 pathspec 提交。
- [ ] deferred-backlog 记：下游-WS（`ws.ts`）buffered 采用、Responses-专属 caps。

## 交给 Phase 4

传输重试对齐后，Phase 4 转向**上游保活**（WS ping 可行性 PoC）+ idle 余量核验——若上游保活不可行，本阶段的 buffered 重试即成为上游-WS 的承重恢复防线（spec R5.1）。
