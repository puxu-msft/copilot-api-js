# Phase 2：pre-commit A 类 retry-signal 接线（route.ts glue，不改共享 forward.ts）

**依赖**：Phase 0（`state.errorShapingEnabled` 等字段）、Phase 1（`decide()`/`ErrorShapingConfig`）
**产出**：`src/routes/messages/error-shaping-glue.ts`（新文件）+ `route.ts` 两处调用点改线

## 探索确认的关键事实（决定本 Phase 的落点，非从 spec 转述）

- `mapHttpErrorToEnvelope` / `forwardError`（`src/lib/error/forward.ts`）是 **OpenAI/Gemini/Anthropic 三格式共享**的纯 status→envelope 分派，被 `azure-openai`/`chat-completions`/`embeddings`/`responses`/`gemini`/`models/*` 等六条非 Anthropic 路由复用。Global Constraint #3（只接入 Anthropic Messages，OpenAI/Gemini 不动）意味着**本 Phase 绝不修改 `forward.ts` 内部**，否则任何 header/body 改动都会连带影响其余六条路由。
- Anthropic pre-commit 的唯一入口是 `src/routes/messages/route.ts:10-24` 的两个 `catch (error) { return forwardError(c, error) }`（`/` 和 `/count_tokens`）——`handleMessagesV4`/`handleCountTokens` 在 commit 之前抛出的任何错误都走这里。
- 结论：新增一层**路由层 glue**（`src/routes/messages/error-shaping-glue.ts`），组合 `classifyError`（`~/lib/error`）+ `decide()`（`~/lib/anthropic/error-shaping`，Phase 1）+ Hono 的 `c.header()` 头注入 + 既有 `forwardError`（原样调用、零改动）。glue 文件属 `routes/`，可以同时 import `lib/error` 与 `lib/anthropic/error-shaping`，不违反"`error-shaping.ts` 不得依赖 `routes`"（依赖方向是 `routes → lib`，允许）。
- 本 Phase 只处理 spec 里 A 类（可重试）的 pre-commit 分支；`decide()` 对 `ask-user-question` 的分支在本 Phase 里先原样直通 `forwardError`（不合成 AUQ，占位注释指向 Phase 4），`canonical-error` 分支本来就是现状行为，也直通 `forwardError`。

## 涉及文件

- `src/routes/messages/error-shaping-glue.ts`（新增）
- `src/routes/messages/route.ts`（两处 `forwardError(c, error)` 改为 `shapePrecommitError(c, error)`）
- `tests/routes/messages/error-shaping-glue.unit.test.ts`（新增，纯函数级：直接构造 `Context` mock 或复用既有 `tests/routes/messages/` 里现成的 Hono test helper）
- `tests/routes/messages/error-shaping-precommit.it.test.ts`（新增，`.it` 后缀——启动真实 Hono app + fake upstream，遵循 `test-isolation` skill 的 `useIsolatedRuntime`，核实端到端头部实际出现在 HTTP 响应上，而非只测中间函数返回值）

## 接口消费/产出

- **消费**：`decide()`（Phase 1）、`classifyError`（既有 `~/lib/error`）、`state.errorShapingEnabled`（Phase 0）
- **产出**：`shapePrecommitError(c: Context, error: unknown): Response`

## 任务 2.1：golden 字节锁——`error_shaping_enabled=false` 逐字节复现现状

- [ ] 写失败测试 `tests/routes/messages/error-shaping-precommit.it.test.ts`：
  ```ts
  import { afterEach, beforeEach, describe, expect, test } from "bun:test"
  import { useIsolatedRuntime } from "~~tests/support/isolated-runtime" // 确认实际路径/导出名——按 test-isolation skill 核实
  import { state } from "~/lib/state"

  describe("pre-commit error shaping — golden lock (disabled)", () => {
    const runtime = useIsolatedRuntime()

    test("error_shaping_enabled=false → byte-identical to forwardError(c, error) baseline (429 upstream rate limit)", async () => {
      state.errorShapingEnabled = false
      // 用现有 fake-upstream harness（复用 exp/cc-error-retry-surface 的 fake server 模式，或项目既有 tests/support/fake-upstream）驱动一次真实 429 上游响应
      const res = await runtime.app.request("/v1/messages", { method: "POST", body: JSON.stringify({ model: "claude-3-5-sonnet-latest", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }), headers: { "content-type": "application/json" } })
      expect(res.status).toBe(429)
      expect(res.headers.get("retry-after")).toBeNull() // 现状：无真实头，只在 body
      const body = await res.json()
      expect(body.error.type).toBe("rate_limit_error")
    })
  })
  ```
  （fake-upstream 429 注入的具体 harness API 需要先 `grep -rn "fake.*upstream\|mockUpstream" tests/support` 核实既有约定，不得凭空发明新的 mock 机制——若无现成 429 注入 helper，参照 `exp/cc-error-retry-surface` 的 fake server 模式新增一个最小版本，遵循 `upstream-hook-mocking` skill。）
- [ ] 跑测试确认红（`shapePrecommitError` 尚不存在，`route.ts` 未接线）
- [ ] 最小实现：新建 `error-shaping-glue.ts`：
  ```ts
  import type { Context } from "hono"

  import { forwardError } from "~/lib/error"
  import { classifyError, isAbortError } from "~/lib/error/classify"
  import { decide, type ErrorShapingConfig } from "~/lib/anthropic/error-shaping"
  import { state } from "~/lib/state"

  function errorShapingConfigFromState(): ErrorShapingConfig {
    return {
      enabled: state.errorShapingEnabled,
      askUserQuestion: state.errorAskUserQuestion,
      auqTemplate: state.errorAuqTemplate,
      selfhealDelegate: state.errorSelfhealDelegate,
    }
  }

  /**
   * Pre-commit Anthropic error entry point (route.ts). Golden-locked: when
   * `error_shaping_enabled` is false, delegates to `forwardError` unchanged —
   * byte-identical to pre-error-shaping behavior. `ask-user-question` synthesis
   * is wired in Phase 4 (this Phase only implements the A-class retry-signal
   * header injection; ask-user-question falls through to plain forwardError
   * until Phase 4 lands).
   */
  export function shapePrecommitError(c: Context, error: unknown): Response {
    if (!state.errorShapingEnabled) return forwardError(c, error)
    if (error instanceof Error && isAbortError(error)) return forwardError(c, error)

    const apiError = classifyError(error)
    if (apiError.type === "aborted") return forwardError(c, error)

    const decision = decide({ error: apiError, commitPhase: "pre-commit", clientVisibleStopEmitted: false, config: errorShapingConfigFromState() })

    if (decision.kind === "retry-signal") {
      if (decision.retryAfterSec !== undefined) c.header("Retry-After", String(decision.retryAfterSec))
      c.header("x-should-retry", "true")
    }
    // ask-user-question: Phase 4 TODO — falls through to forwardError for now.
    // canonical-error: current behavior is already correct, no header changes.
    return forwardError(c, error)
  }
  ```
- [ ] `route.ts` 两处调用改为 `shapePrecommitError(c, error)`（import 从 `~/lib/error` 改为新增 `import { shapePrecommitError } from "./error-shaping-glue"`，保留 `forwardError` 若 count_tokens 或其他分支仍需直接引用则按需保留 import）
- [ ] 确认绿（golden 锁测试通过——disabled 时无 header、body 不变）
- [ ] 提交（`feat: wire pre-commit error shaping (golden-locked disabled path)`）

## 任务 2.2：A 类 retry-signal 真实头部（429/503/network_error/server_error）

- [ ] 写失败测试（同 `.it` 文件追加，`error_shaping_enabled=true`）：
  ```ts
  describe("pre-commit error shaping — enabled, A-class retry-signal", () => {
    const runtime = useIsolatedRuntime()

    test("503 upstream-rate-limited with parseable Retry-After body → real Retry-After + x-should-retry:true headers", async () => {
      state.errorShapingEnabled = true
      // 注入一个 503 upstream-rate-limited 响应，Copilot 侧 body/头带 60s 退避信息（沿用 forward.ts 既有 parseRetryAfterHeader 提取路径）
      const res = await runtime.app.request(/* ... 同上 harness，改造成 503 upstream-rate-limited fixture ... */)
      expect(res.status).toBe(503)
      expect(res.headers.get("retry-after")).toBe("60")
      expect(res.headers.get("x-should-retry")).toBe("true")
    })

    test("429 rate_limited without a parseable retry-after → x-should-retry:true set, Retry-After header absent (not fabricated)", async () => {
      state.errorShapingEnabled = true
      const res = await runtime.app.request(/* 429 fixture 无 retry-after 信息 */)
      expect(res.status).toBe(429)
      expect(res.headers.get("retry-after")).toBeNull()
      expect(res.headers.get("x-should-retry")).toBe("true")
    })

    test("402 quota_exceeded（B类，非A）→ 不设 x-should-retry / Retry-After 头（维持 spec N-1：CC 从不重试 402）", async () => {
      state.errorShapingEnabled = true
      const res = await runtime.app.request(/* 402 fixture */)
      expect(res.headers.get("x-should-retry")).toBeNull()
    })

    test("token_limit (C类) → 无 retry 头，body 与禁用态完全一致", async () => {
      state.errorShapingEnabled = true
      const res = await runtime.app.request(/* 400 token-limit fixture */)
      expect(res.headers.get("x-should-retry")).toBeNull()
    })
  })
  ```
- [ ] 跑测试确认红（`classifyError` 目前对 503/429 的 `retryAfter` 提取路径需要与 `mapHttpErrorToEnvelope` 内联提取的 `parseRetryAfterHeader` 结果一致——若 `classify.ts` 的 503/429 分支尚未把 `retryAfter` 填进 `ApiError.retryAfter` 字段，先确认 `classify.ts:114-237` 的既有实现是否已经做到；若已做到，此步应直接部分变绿，红的只是 header 断言部分）
- [ ] 最小实现：上一任务的 glue 代码已覆盖全部分支（`decision.kind==="retry-signal"` 才设头），本步只需确认 `classifyError` 对 503 (`upstream_rate_limited`) 与 429 (`rate_limited`) 正确回填 `error.retryAfter`（若发现 `classify.ts` 未回填，属于**门控问题**——`classify.ts` 是本计划的依赖前提而非本计划改动范围，若确实存在此缺口，须记录进 README 待裁决节而非本 Phase 内擅自扩大 `classify.ts` 改动面；先跑一次确认，多数情况下 `classify.ts:114-237` 已经在分类时调用了 `parseRetryAfterHeader`，只是从未传导到 HTTP 响应头，这正是本 Phase 要接的线）
- [ ] 确认绿
- [ ] 提交（`feat: emit real Retry-After + x-should-retry headers for A-class pre-commit errors`）

## 任务 2.3：单测层覆盖 `shapePrecommitError` 的分支穷尽（不依赖真实 HTTP，纯函数级）

- [ ] 写失败测试 `tests/routes/messages/error-shaping-glue.unit.test.ts`：用 Hono `new Hono()` + 手工 mock `Context`（或直接 `app.request()` 走最短路径）覆盖 `shapePrecommitError` 对 11 种 `ApiErrorType` 的分支路由结果（复用 Phase 1 真值表的 11 类错误构造 helper，避免重复造轮子——可以从 `tests/anthropic/error-shaping.unit.test.ts` 里把 `mk()` 提到共享 test-support 文件）
- [ ] 跑测试确认红
- [ ] 最小实现：如需要，将 `mk()` helper 提到 `tests/support/error-shaping-fixtures.ts` 共享
- [ ] 确认绿
- [ ] 提交（`test: exhaustive branch coverage for shapePrecommitError`）

## Phase 2 完成检查

- [ ] `bun run typecheck` 全绿
- [ ] `bunx eslint src/routes/messages/error-shaping-glue.ts src/routes/messages/route.ts tests/routes/messages/error-shaping-glue.unit.test.ts tests/routes/messages/error-shaping-precommit.it.test.ts`
- [ ] 确认 `src/lib/error/forward.ts` 无任何改动（`git diff --stat -- src/lib/error/forward.ts` 应为空）——这是本 Phase 最重要的守卫，直接验证 Global Constraint #3
- [ ] 确认 `src/routes/azure-openai/`、`src/routes/chat-completions/`、`src/routes/embeddings/`、`src/routes/gemini/`、`src/routes/responses/`、`src/routes/models/` 六个非-Anthropic 路由目录零改动（`git diff --stat` 逐一确认为空）
- [ ] 跑一遍既有 `tests/lib/error/` 下的 `forward`/`classify` 回归测试确认零意外破坏
