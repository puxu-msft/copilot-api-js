# Phase 1：error-shaping.ts 核心决策引擎 + canonical 构造 + 类型扩展

> **评审 HIGH-3 共享文件提示**：本 Phase 新建的 `error-shaping.ts` 是 Phase 3/4/5 三方共同追加的共享基座（Phase 3 追加 `buildCanonicalErrorFrameFromRaw`/`parseRawUpstreamErrorFrame`，Phase 4 追加 `buildAskUserQuestionFrames`/`buildAskUserQuestionResponse`，Phase 5 追加 `filterDelegatedStrategies`）。本 Phase 本身与 Phase 2/3/4/5 无编辑冲突（此文件在本 Phase 是新建，尚无人追加），但**必须先于 Phase 3/4/5 全部完成并提交**，且完成后建议按 3→4→5 顺序串行推进下游三个 Phase（详见 README §3 Phase DAG「订正」段），不要假设三者可以各自独立并行追加同一文件而不产生合并冲突。

**依赖**：Phase 0（需要 `state.errorShapingEnabled` 等 4 个字段存在，供测试组装 `ErrorShapingConfig`；决策引擎本身是纯函数，不直接 import `state`）
**产出**：`src/lib/anthropic/error-shaping.ts`（新文件）+ `SyntheticOriginKind`/`FeatureKind` 扩展

## decide() 的输入语义说明（重要，供实现者理解为何 clientVisibleStopEmitted 在本 Phase 「看似不生效」）

Spec 规定 `decide()` 输入为 `ApiError + config + commitPhase + clientVisibleStopEmitted` 四元组。探索代码后发现：

- **`ApiError` 类型的输入只出现在两个调用点**：`forward.ts`（pre-commit）与 `handler-v4.ts` 终点①（`await p` 抛出 `HTTPError`，post-commit，此时 pump 还未开始，`clientVisibleStopEmitted` 恒为 `false`——没有任何 block 曾经开始过）。
- **终点②的 H2（`acc.streamError`，upstream 主动下发 `event:error` 帧）和 truncation（`!acc.sawMessageStop`）两个分支根本不产生 `ApiError`**——前者是从 SSE 帧体直接解析的 `{type, message}`（`stream-accumulator.ts:186-192`），后者是硬编码 `"api_error"` 的合成 `Error`。这两处不经过 `classifyError`，因此不适用 `decide()` 的 11 型真值表；G-3 已经把 H2 的结果无条件定为 canonical（不是「决策」，是「整形」），truncation 则无条件 `defer-to-block-level`（G-4 gated）。
- 结论：**`clientVisibleStopEmitted` 对 Phase 0-5 覆盖的两个 `ApiError` 调用点恒为 `false`，真值表须显式测试「传 `true` 与传 `false` 结果一致」这一当前不变量**，把该参数保留为 Phase 6（block-level 的 `defer-to-block-level` 子决策——回放 vs `partial-degrade`）预留的前向兼容位。这一发现记录于 README 第 1 节「探索阶段的新发现」，本文档不重复展开设计动机，只给出可执行任务。
- `buildCanonicalErrorFrame` 因此设计为**独立于 `decide()` 真值表**的构造函数——H2 场景由 Phase 3 直接构造一个 `{kind:"canonical-error", errorType, message, retryAfterSec}` 决策对象传入，不经过 `decide()`。

## 涉及文件

- `src/lib/anthropic/error-shaping.ts`（新增）
- `src/routes/messages/streaming-pump.ts`（**订正（评审 MEDIUM-2）**：文件路径原文误写为 `src/lib/anthropic/streaming-pump.ts`，实际是 `src/routes/messages/streaming-pump.ts:24`；`anthropicStreamErrorType` 改为委托 `error-shaping.ts` 的内部辅助，保留导出签名 `(error: unknown) => string` 不变。真实调用方是 `handler-v4.ts:1193`（`pumpAnthropicStreamingV4` 的 H3 分支）+ `handler-v4.ts:1452`（`pumpTranslateLegStreamingV4` 反向翻译腿），并非 `codec.ts`——`codec.ts:619` 只是一行注释"mirrors legacy anthropicStreamErrorType"，不是调用点，两处真实调用方零改动）
- `src/lib/pipeline/frame-origin.ts`（`SyntheticOriginKind` 扩两个成员）
- `src/lib/observability/events.ts`（`FeatureKind` 扩若干成员）
- `tests/anthropic/error-shaping.unit.test.ts`（新增）

## 任务 1.1：决策引擎真值表（11 型 × 2 phase × config）

- [ ] 写失败测试 `tests/anthropic/error-shaping.unit.test.ts`：
  ```ts
  import { describe, expect, test } from "bun:test"
  import type { ApiError, ApiErrorType } from "~/lib/error"
  import { decide, type ErrorShapingConfig } from "~/lib/anthropic/error-shaping"

  const baseConfig: ErrorShapingConfig = { enabled: true, askUserQuestion: false, auqTemplate: "", selfhealDelegate: {} }
  const mk = (type: ApiErrorType, status: number, extra: Partial<ApiError> = {}): ApiError => ({ type, status, message: "boom", raw: null, ...extra })

  describe("decide() — pre-commit truth table", () => {
    test.each([
      ["rate_limited", 429],
      ["server_error", 500],
      ["upstream_rate_limited", 503],
      ["network_error", 0],
    ] as const)("A类可重试(%s) pre-commit → retry-signal", (type, status) => {
      const d = decide({ error: mk(type, status, { retryAfter: 30 }), commitPhase: "pre-commit", clientVisibleStopEmitted: false, config: baseConfig })
      expect(d.kind).toBe("retry-signal")
      if (d.kind === "retry-signal") expect(d.retryAfterSec).toBe(30)
    })

    test("quota_exceeded(402) pre-commit, askUserQuestion=false → canonical-error（非目标：402 从不算 A 类）", () => {
      const d = decide({ error: mk("quota_exceeded", 402, { retryAfter: 3600 }), commitPhase: "pre-commit", clientVisibleStopEmitted: false, config: baseConfig })
      expect(d.kind).toBe("canonical-error")
    })

    test("quota_exceeded(402) pre-commit, askUserQuestion=true → ask-user-question", () => {
      const d = decide({ error: mk("quota_exceeded", 402), commitPhase: "pre-commit", clientVisibleStopEmitted: false, config: { ...baseConfig, askUserQuestion: true } })
      expect(d.kind).toBe("ask-user-question")
    })

    test("content_filtered(422) pre-commit, askUserQuestion=true → ask-user-question", () => {
      const d = decide({ error: mk("content_filtered", 422), commitPhase: "pre-commit", clientVisibleStopEmitted: false, config: { ...baseConfig, askUserQuestion: true } })
      expect(d.kind).toBe("ask-user-question")
    })

    test.each([401, 403])("auth_expired(%i) pre-commit, askUserQuestion=true → ask-user-question（token-refresh 已在更早的 RetryStrategy 层耗尽才会走到这里，decide() 不区分 401/403）", (status) => {
      const d = decide({ error: mk("auth_expired", status), commitPhase: "pre-commit", clientVisibleStopEmitted: false, config: { ...baseConfig, askUserQuestion: true } })
      expect(d.kind).toBe("ask-user-question")
    })

    test.each(["token_limit", "payload_too_large", "bad_request"] as const)("C类(%s) pre-commit → canonical-error 且 askUserQuestion 开关不影响结果", (type) => {
      const d1 = decide({ error: mk(type, 400), commitPhase: "pre-commit", clientVisibleStopEmitted: false, config: baseConfig })
      const d2 = decide({ error: mk(type, 400), commitPhase: "pre-commit", clientVisibleStopEmitted: false, config: { ...baseConfig, askUserQuestion: true } })
      expect(d1.kind).toBe("canonical-error")
      expect(d2.kind).toBe("canonical-error")
    })

    test("aborted 从不应调用 decide()（非目标）— 传入抛出，作为误用护栏", () => {
      expect(() => decide({ error: mk("aborted", 0), commitPhase: "pre-commit", clientVisibleStopEmitted: false, config: baseConfig })).toThrow(/aborted/i)
    })
  })

  describe("decide() — post-commit：status 已锁定，A类不再有 retry-signal 选项", () => {
    test.each(["rate_limited", "server_error", "upstream_rate_limited", "network_error"] as const)("A类(%s) post-commit → canonical-error（不是 retry-signal，也不是 defer-to-block-level——这两者只属于非 ApiError 的截断/RST 分支，见 Phase 3 说明）", (type) => {
      const d = decide({ error: mk(type, 500), commitPhase: "post-commit", clientVisibleStopEmitted: false, config: baseConfig })
      expect(d.kind).toBe("canonical-error")
    })

    test("quota_exceeded(402) post-commit — 无论 askUserQuestion 开关，恒 canonical-error（AUQ 是 pre-commit 整段合成，post-commit 状态已锁定无法整段替换）", () => {
      const d = decide({ error: mk("quota_exceeded", 402), commitPhase: "post-commit", clientVisibleStopEmitted: false, config: { ...baseConfig, askUserQuestion: true } })
      expect(d.kind).toBe("canonical-error")
    })

    test.each([true, false])("clientVisibleStopEmitted=%s 对 post-commit ApiError 真值表结果无影响（当前不变量；Phase 6 的 defer-to-block-level 子决策不经过这张真值表，见本文档说明）", (stop) => {
      const d = decide({ error: mk("server_error", 500), commitPhase: "post-commit", clientVisibleStopEmitted: stop, config: baseConfig })
      expect(d.kind).toBe("canonical-error")
    })
  })
  ```
- [ ] 跑测试确认红（`error-shaping.ts` 不存在 → import 报错也算红）
- [ ] 最小实现：新建 `src/lib/anthropic/error-shaping.ts`，实现 `ErrorShapingConfig`/`ShapingInput`/`ShapingDecision`/`decide()`（README 第 4 节的类型草图为准，逻辑按上述测试用例展开：先判 `aborted` 抛错误 → 判 A 类集合（`rate_limited`/`server_error`/`upstream_rate_limited`/`network_error`）→ `pre-commit` 出 `retry-signal`（`retryAfterSec: error.retryAfter`）、`post-commit` 出 `canonical-error` → 判 B 类候选集合（`content_filtered`/`quota_exceeded`/`auth_expired`）→ `pre-commit && config.askUserQuestion` 出 `ask-user-question`，否则出 `canonical-error` → 其余（`token_limit`/`payload_too_large`/`bad_request`）恒 `canonical-error`）
- [ ] 确认绿
- [ ] 提交（`feat: add error-shaping decide() core truth table`）

## 任务 1.2：buildCanonicalErrorFrame + 收编 anthropicStreamErrorType

- [ ] 写失败测试（同文件追加）：
  ```ts
  import { buildCanonicalErrorFrame, classifyStreamErrorType } from "~/lib/anthropic/error-shaping"

  describe("buildCanonicalErrorFrame", () => {
    test("canonical-error decision → Anthropic event:error frame, retry_after preserved", () => {
      const frame = buildCanonicalErrorFrame({ kind: "canonical-error", errorType: "rate_limit_error", message: "slow down", retryAfterSec: 30 })
      expect(frame.event).toBe("error")
      const data = JSON.parse(frame.data ?? "{}")
      expect(data).toEqual({ type: "error", error: { type: "rate_limit_error", message: "slow down", retry_after: 30 } })
    })

    test("no retryAfterSec → retry_after field omitted (not null/undefined literal)", () => {
      const frame = buildCanonicalErrorFrame({ kind: "canonical-error", errorType: "api_error", message: "boom" })
      const data = JSON.parse(frame.data ?? "{}")
      expect(data.error).toEqual({ type: "api_error", message: "boom" })
    })
  })

  describe("classifyStreamErrorType — 收编 streaming-pump.ts:anthropicStreamErrorType 的逻辑", () => {
    test("idle-timeout → timeout_error, shutdown → overloaded_error, other → api_error", () => {
      // 复用既有 classifyStreamError 分类结果作为输入(construct 与 streaming-pump.ts 原实现同款用例)
    })
  })
  ```
  （第二个 describe 的具体断言需要参照 `~/lib/stream` 的 `classifyStreamError` 输入构造既有等价用例——直接照搬 `streaming-pump.ts:24-36` 现有逻辑搬迁，不改变行为，故此测试的核心目的是「确认搬迁后行为不变」而非探索新分支。**（评审 MEDIUM-2 补充）**：`anthropicStreamErrorType` 是纯函数（`(error: unknown) => string`），re-export 后对同一输入返回同一输出与调用方无关，因此本 describe 的等价性断言天然覆盖 `handler-v4.ts:1193`（H3 分支）与 `handler-v4.ts:1452`（translate-leg）两个真实调用点——不需要为每个调用点各写一条集成测试，只需确认现有 Phase 3 任务 3.2 里对 `:1193` 的端到端回归测试（golden 锁）与本任务的纯函数单测共同锁定该不变量；`:1452` 因不在本计划改动范围内（全局约束 5），不需要新增集成测试，只依赖此处的纯函数单测保证其消费的实现未变。）
- [ ] 跑测试确认红
- [ ] 最小实现：
  - `error-shaping.ts` 内新增 `export function buildCanonicalErrorFrame(d: Extract<ShapingDecision, {kind:"canonical-error"}>): ClientFrame` —— 复用 `post-commit-error.ts` 里 `anthropicErrorFrame`/`anthropicHttpErrorFrame` 已确立的手搓 JSON 模式（不 import `routes/`，遵循 `recover-refusal.ts:212-219` 同款注释约定：「手搓 canonical，因为 `lib/` 不得依赖 `routes/`」）
  - `error-shaping.ts` 内新增 `export function classifyStreamErrorType(error: unknown): string`（把 `streaming-pump.ts:24-36` 的 switch 逻辑原样搬来）
  - `streaming-pump.ts` 的 `anthropicStreamErrorType` 改为 `export const anthropicStreamErrorType = classifyStreamErrorType`（re-export，保持原导出名/签名；**订正（评审 MEDIUM-2）**：真实调用方零改动的是 `handler-v4.ts:1193` + `handler-v4.ts:1452` 两处，非"`codec.ts` + `handler-v4.ts`"——`codec.ts:619` 只是注释，见上方「涉及文件」订正说明）
- [ ] 确认绿
- [ ] 提交（`refactor: absorb anthropicStreamErrorType into error-shaping (G-3)`）

## 任务 1.3：SyntheticOriginKind + FeatureKind 扩展

- [ ] 写失败测试：
  ```ts
  import { tagFrameSynthetic, readSyntheticKind } from "~/lib/pipeline/frame-origin"

  test("SyntheticOriginKind accepts error-shaping-auq / error-shaping-canonical", () => {
    const f = tagFrameSynthetic({ event: "error", data: "{}" }, "error-shaping-canonical")
    expect(readSyntheticKind(f)).toBe("error-shaping-canonical")
  })
  ```
- [ ] 跑测试确认红（TS 编译期即报错，因为字面量不在联合类型里——这是"类型系统前置逼出"的实例，不必等运行时）
- [ ] 最小实现：`frame-origin.ts` 的 `SyntheticOriginKind` 追加 `| "error-shaping-auq" | "error-shaping-canonical"`
- [ ] `events.ts` 的 `FeatureKind` 追加（紧邻 `"refusal-errored"` 之后）：
  ```ts
  /** error-shaping 决策命中 — detail: { decision: "retry-signal"|"ask-user-question"|"canonical-error"|"defer-to-block-level", errorType: ApiErrorType, commitPhase: "pre-commit"|"post-commit" } */
  | "error-shaping-decided"
  /** error-shaping B类 AskUserQuestion 合成命中 — detail: { errorType: ApiErrorType } */
  | "error-shaping-auq-synthesized"
  /** error-shaping D类自愈委派命中（策略被强制 canHandle=false）— detail: { strategyName: string } */
  | "error-shaping-selfheal-delegated"
  ```
  （具体 `recordFeature` 调用点在 Phase 2/3/4/5 各自任务里接线，本任务只扩类型。）
- [ ] 确认绿
- [ ] 提交（`feat: extend SyntheticOriginKind + FeatureKind for error-shaping`）

## 任务 1.4：`renderAuqQuestion` + `AuqQuestion` 内容构造（decide() B 类分支产出真实 questions）

**背景（本任务在 README 定稿后才发现的缺口，记录说明供实现者不必重新推导）**：任务 1.1 的真值表只断言 `d.kind === "ask-user-question"`，未构造 `ShapingDecision` 的 `ask-user-question` 变体真正需要携带的 `questions: ReadonlyArray<AuqQuestion>` 内容。同时 `ShapingInput` 只含 `ApiError`/`commitPhase`/`clientVisibleStopEmitted`/`config` 四元组——没有 `model`/`request_id`（这两个是请求级上下文，不属于错误分类维度），而 spec 的 AUQ 模板占位符集合是 `{model}`/`{request_id}`/`{error_type}`/`{status}` 四个（单花括号，复用 `renderRefusalTemplate` 语法，**没有 `{message}`**）。解法：**两遍渲染**——`decide()`（本任务）只完成 `{error_type}`/`{status}` 这两个它拿得到数据的占位符；`{model}`/`{request_id}` 留给 Phase 4 的 builder 函数在拿到请求级 `ctx` 后做第二遍渲染。两遍复用同一个 `renderAuqQuestion(tmpl, vars)`，其 regex 语义与 `recover-refusal.ts:96-98` 的 `renderRefusalTemplate` 完全一致（`key in vars ? String(vars[key]) : whole`——键不在 vars 里就原样保留 `{key}` 字面量），因此"partial vars 分两遍调用"不需要任何特殊设计，直接复用既有语义即可达成。

- [ ] 写失败测试（追加 `tests/anthropic/error-shaping.unit.test.ts`）：
  ```ts
  import { decide, renderAuqQuestion, DEFAULT_AUQ_TEMPLATE, type AuqQuestion } from "~/lib/anthropic/error-shaping"

  describe("renderAuqQuestion — 两遍渲染语义", () => {
    test("只传 error_type/status → {model}/{request_id} 原样保留未渲染", () => {
      const text = renderAuqQuestion("model={model} req={request_id} type={error_type} status={status}", { error_type: "quota_exceeded", status: "402" })
      expect(text).toBe("model={model} req={request_id} type=quota_exceeded status=402")
    })

    test("第二遍只传 model/request_id → 补全剩余占位符，得到完全渲染结果", () => {
      const pass1 = renderAuqQuestion("model={model} req={request_id} type={error_type} status={status}", { error_type: "quota_exceeded", status: "402" })
      const pass2 = renderAuqQuestion(pass1, { model: "claude-3-5-sonnet-latest", request_id: "req_test" })
      expect(pass2).toBe("model=claude-3-5-sonnet-latest req=req_test type=quota_exceeded status=402")
    })

    test("不存在 {message} 占位符——DEFAULT_AUQ_TEMPLATE 只使用 spec 给定的 4 个占位符", () => {
      expect(DEFAULT_AUQ_TEMPLATE).not.toContain("{message}")
      expect(DEFAULT_AUQ_TEMPLATE).not.toContain("{{message}}")
    })
  })

  describe("decide() B 类分支 — questions 内容构造", () => {
    const baseConfig: ErrorShapingConfig = { enabled: true, askUserQuestion: true, auqTemplate: "", selfhealDelegate: {} }
    const mk = (type: ApiErrorType, status: number): ApiError => ({ type, status, message: "boom", raw: null })

    test("quota_exceeded(402) → questions 长度 1，header/options 按 errorType 分派，question 文本含未渲染的 {model}/{request_id}", () => {
      const d = decide({ error: mk("quota_exceeded", 402), commitPhase: "pre-commit", clientVisibleStopEmitted: false, config: baseConfig })
      if (d.kind !== "ask-user-question") throw new Error("expected ask-user-question")
      expect(d.questions).toHaveLength(1)
      const q = d.questions[0] as AuqQuestion
      expect(q.question).toContain("{model}")
      expect(q.question).toContain("{request_id}")
      expect(q.question).not.toContain("{error_type}") // 已被第一遍渲染替换
      expect(q.question).not.toContain("{status}")
      expect(q.multiSelect).toBe(false)
      expect(q.options.length).toBeGreaterThan(0)
    })

    test("content_filtered(422) 与 auth_expired(401/403) 的 options 各自不同（errorType 分派，非同一份文案）", () => {
      const d1 = decide({ error: mk("content_filtered", 422), commitPhase: "pre-commit", clientVisibleStopEmitted: false, config: baseConfig })
      const d2 = decide({ error: mk("auth_expired", 401), commitPhase: "pre-commit", clientVisibleStopEmitted: false, config: baseConfig })
      if (d1.kind !== "ask-user-question" || d2.kind !== "ask-user-question") throw new Error("expected ask-user-question")
      expect(d1.questions[0]?.options).not.toEqual(d2.questions[0]?.options)
    })

    test("config.auqTemplate 非空时覆盖 DEFAULT_AUQ_TEMPLATE", () => {
      const d = decide({ error: mk("quota_exceeded", 402), commitPhase: "pre-commit", clientVisibleStopEmitted: false, config: { ...baseConfig, auqTemplate: "自定义：{error_type}/{status}，{model}/{request_id}" } })
      if (d.kind !== "ask-user-question") throw new Error("expected ask-user-question")
      expect(d.questions[0]?.question).toBe("自定义：quota_exceeded/402，{model}/{request_id}")
    })
  })
  ```
- [ ] 跑测试确认红
- [ ] 最小实现：
  - `error-shaping.ts` 内新增 `export function renderAuqQuestion(tmpl, vars): string`（原样复刻 `recover-refusal.ts:96-98` 的 regex：`tmpl.replaceAll(/\{(\w+)\}/g, (whole, key) => key in vars ? String(vars[key]) : whole)`——不 import `recover-refusal.ts`，避免引入不必要的跨文件耦合，两文件同层独立实现同一小段逻辑，符合 `recover-refusal.ts:212-219` 一贯的"手搓小函数、不跨层复用"约定）
  - `error-shaping.ts` 内新增 `export const DEFAULT_AUQ_TEMPLATE = "..."`（含 `{error_type}`/`{status}`/`{model}`/`{request_id}` 四占位符的默认问句文案，中文措辞，不含 `{message}`）
  - `error-shaping.ts` 内新增按 `errorType` 分派的 `options` 表（模块内私有常量或 `switch`，覆盖 `quota_exceeded`/`content_filtered`/`auth_expired` 三个候选 errorType；具体文案属于**用户可见措辞细节**，非协议行为，本计划推荐最小集合作为起点，如与 spec 附录冲突以 spec 为准——已记入 README 待裁决节补充条目，不阻塞本任务）
  - `decide()` 的 B 类分支改为：`questions: [{ question: renderAuqQuestion(config.auqTemplate || DEFAULT_AUQ_TEMPLATE, { error_type: error.type, status: String(error.status) }), header: "如何继续？", multiSelect: false, options: optionsForErrorType(error.type) }]`
- [ ] 确认绿
- [ ] 提交（`feat: construct real AuqQuestion content in decide() B-branch (two-pass template render)`）

## Phase 1 完成检查

- [ ] `bun run typecheck` 全绿
- [ ] `bunx eslint src/lib/anthropic/error-shaping.ts src/lib/anthropic/streaming-pump.ts src/lib/pipeline/frame-origin.ts src/lib/observability/events.ts tests/anthropic/error-shaping.unit.test.ts`
- [ ] 跑 `tests/anthropic/post-commit-error.unit.test.ts`（既有测试）确认未破坏 `anthropicHttpErrorFrame` 等既有构造函数（本 Phase 未改该文件，仅新增依赖关系，回归测试用于确认零意外耦合）
- [ ] 确认 `error-shaping.ts` 顶部 import 不含任何 `~/routes/*` 路径（`grep -n "^import" src/lib/anthropic/error-shaping.ts | grep routes` 应为空）
