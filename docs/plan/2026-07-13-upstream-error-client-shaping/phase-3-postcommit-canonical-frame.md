# Phase 3：post-commit 上游 `event:error` 帧 canonical 化（S5 rewrite 拦截，非 H2 事后补救）

> **评审 HIGH-3 共享文件提示**：本 Phase 追加 `error-shaping.ts`（新增 `buildCanonicalErrorFrameFromRaw`/`parseRawUpstreamErrorFrame`）+ 编辑 `handler-v4.ts`（4 个 post-commit 终点收编，见任务 3.2）。这两个文件同时被 Phase 4（AUQ 接线）+ Phase 5（`buildMessagesDriverStrategies` 接线）追加/编辑，**不是「不同文件不重叠」的独立并行单元**——建议按 3→4→5 顺序串行落地，或各自开隔离 worktree 后按文件段合并，合并前人工核对 diff 有无相邻行覆盖。详见 README §3 Phase DAG「订正」段。

**依赖**：Phase 0（config）、Phase 1（`error-shaping.ts` 的 `buildCanonicalErrorFrame`/`classifyStreamErrorType`）
**产出**：新 `ResponseRewrite`（`errorFrameCanonical`，order=50）+ 终点①①'②③四处 handler-v4.ts 收编调用（评审 MEDIUM-1 后从三处订正为四处，见下方「探索确认的关键事实」）

> **D-0.5 跨 worktree 冲突提示（重复一遍，勿漏）**：`src/routes/messages/handler-v4.ts` 的 1090-1330 行区间正是 block-level buffered retry P1 Task 6（`docs/spec/2026-07-11-block-level-buffered-retry.md`）计划要重构的同一区间（commit 边界谓词 `commitBoundaries(frame)` 要在这里接线）。若 P1 Task 6 与本 Phase 并发在不同 worktree 推进，**同文件同区间**大概率行级冲突。推荐排序（非强制，若两条线都要推进则采纳）：先落地本 Phase（改动集中在"新增一个 S5 rewrite + 四处 `writeSynthetic` 调用替换成一行委托"，绝对行数改动小），block-level P1 Task 6 rebase 到本 Phase 之后；或反之但本 Phase 实现者需在动手前 `git log --oneline -5 -- src/routes/messages/handler-v4.ts` 确认无冲突中的并发提交。

## 探索确认的关键事实（本 Phase 设计的直接依据，非转述 spec）

- **`event:error` 帧确实流经 S5 `ResponseRewrite` 链**：`driver.ts:856-875` 的 `passThrough()` 对**每一个** `UpstreamFrame`（`type UpstreamFrame = SseFrame`，无特殊排除 `event:"error"`）依次调用 `rewrites[i].transform(frame, states[i])`。这意味着上游主动下发的 `event:error` 帧（H2 场景，`stream-accumulator.ts:186-193` 只记录进 `acc.streamError` 用于 bookkeeping、从不拦截改写）与其余内容帧走同一条链，可以在此处插入拦截。
- **必须排在最前面（`order` 最小），而非排在 `refusalRewrite`(400) 之后**：`refusalRewrite` 自己在某些配置下会**合成**一个 `event:error` 帧（`handler-v4.ts:1232` 注释"the S5 rewrite layer already emitted the Anthropic `event: error` frame"）。若新 rewrite 排在它之后，会对 `refusalRewrite` 刚合成的、已经是 canonical 形状的帧再次"重整形"，属于对已处理帧的错误二次加工。`passThrough` 只单向前进（`driver.ts:856-875` 的 for 循环不回头），所以只要新 rewrite 排在最前，它看到的 `event:error` 帧必然是**未经任何其他 rewrite 处理的原始上游帧**，往后游的 `refusalRewrite` 合成帧永远不会倒流回来给它二次处理。故 `RESPONSE_REWRITE_ORDER` 新增 `errorFrameCanonical: 50`（早于 `recoverToolCall: 100`）。
- **`acc.streamError`（`stream-accumulator.ts`）保持不变、继续记录原始上游帧**：这是 history/上游轨的 bookkeeping（richest-data-flow：上游轨永远存真实原始帧），与本 Phase 改的"客户端可见轨"（S5 rewrite 产出）是两个正交轨道，互不影响、无需改动 `stream-accumulator.ts`。
- **`H2` 分支（`handler-v4.ts:1213-1224`）本身不需要再写帧**：新 rewrite 已经在 S5 阶段把 canonical 帧写给客户端了，H2 分支只需要保留其现有的 `env.ctx.fail(...)` 结算逻辑（帧已经走了新路径，不是"事后补救"）。**唯一需要改的是 log 措辞**（可选：不改也不影响功能，因为 log 只是 consola 输出不是协议行为，若嫌"a terminal upstream error SSE event was forwarded as a content frame"的注释已经过时可以顺手更新，非强制项）。
- **`H3`（`handler-v4.ts:1172-1201`）与终点①（`handler-v4.ts:560-566`）与终点①'（`handler-v4.ts:568-570`，评审 MEDIUM-1 新增收编，见下方条目 17）与 truncation（`handler-v4.ts:1279-1305`）四处仍需要主动 `writeSynthetic`**——因为这四处的错误根本不是"流经 S5 rewrite 链的一个上游帧"，而是本地合成的全新帧（H3=本地捕获的抛出异常、终点①=`await p` 失败前尚未进入 pump 的 HTTPError、终点①'=同处但非 HTTPError 的 unknown 错误、truncation=EOF without message_stop）。这四处继续需要显式调用 builder，只是改为调用 `error-shaping.ts` 的统一 builder（G-3"所有权"收编范围之一），不再各自手搓 JSON。
- **（评审 MEDIUM-1）本 Phase 实际收编 4 个 post-commit 终点，非 3 个——README 全局约束 3 已订正"唯一所有权"为"已收编 4 个 + 明确排除 3 个"，具体到本 Phase**：
  1. `handler-v4.ts:565` 终点①HTTPError（既定，见任务 3.2）
  2. `handler-v4.ts:1193` H3（既定，见任务 3.2；行号较早期草案的 1189 略有漂移，已按现行代码核实）
  3. `handler-v4.ts:1295` truncation（既定，见任务 3.2）
  4. **`handler-v4.ts:568-570`（终点①'unknown-non-HTTP，非 HTTPError、非 abort 的 catch 分支）——本轮新增收编（原计划遗漏，非仅措辞问题）**：`classifyError`（`~/lib/error/classify.ts:49-95`）对 `network_error` 类型只从非 `HTTPError` 分支产出（socket 关闭/连接重置/HTTP2 REFUSED_STREAM），故 post-commit 的 `network_error` 错误必然落在这条分支而非终点①HTTPError；Phase 1 真值表（任务 1.1）已经把 `network_error` post-commit 设计为 `canonical-error`，若不收编这条分支，该真值表承诺永远兑现不了（`decide()` 从未被这条路径调用到）。已并入任务 3.2（见下）。

  **明确排除（不收编，非本 Phase/本计划范围）**：`handler-v4.ts:573-579`（`decideRoute` reject，非上游 `ApiError`，是代理内部路由决策）、`handler-v4.ts:1262-1278`（unrepairable-tool，没有可分类的 `error` 对象，是代理自身校验失败）、`handler-v4.ts:1309-1322`（外层 catch-all 防御性兜底，非受支持错误分类）。三处排除理由详见 README 全局约束 3 附近的「探索新发现」，此处不重复展开。

## 涉及文件

- `src/lib/anthropic/error-shaping.ts`（Phase 1 已建，本 Phase 追加 `buildCanonicalErrorFrameFromRaw`）
- `src/lib/codec/anthropic/error-frame-canonical-rewrite.ts`（新增，`ResponseRewrite` 实现）
- `src/lib/codec/anthropic/response-rewrite-adapters.ts`（`ANTHROPIC_RESPONSE_REWRITES` 数组头部插入新 rewrite）
- `src/lib/pipeline/rewrite-registry.ts`（`RESPONSE_REWRITE_ORDER` 新增 `errorFrameCanonical: 50`）
- `src/routes/messages/handler-v4.ts`（终点①565 行、**终点①'568-570 行（unknown-non-HTTP，本轮新增收编，见 MEDIUM-1）**、终点②H3-1193 行、truncation-1295 行四处 `writeSynthetic` 调用改为委托 `error-shaping.ts` builder）
- `tests/codec/anthropic/error-frame-canonical-rewrite.unit.test.ts`（新增）
- `tests/routes/messages/postcommit-error-shaping.it.test.ts`（新增，golden 字节锁 + 四终点端到端）

## 任务 3.1：新增 S5 rewrite——上游 `event:error` 帧 canonical 化（golden 锁 + 启用态）

- [ ] 写失败测试 `tests/codec/anthropic/error-frame-canonical-rewrite.unit.test.ts`：
  ```ts
  import { describe, expect, test } from "bun:test"
  import { errorFrameCanonicalRewrite } from "~/lib/codec/anthropic/error-frame-canonical-rewrite"
  import { ENDPOINT } from "~/lib/models/endpoint"
  import type { RequestEnvelope } from "~/lib/pipeline/types"

  const envDisabled = { targetEndpoint: ENDPOINT.MESSAGES /* 最小 RequestEnvelope stub，配置 error_shaping_enabled=false */ } as RequestEnvelope
  const envEnabled = { targetEndpoint: ENDPOINT.MESSAGES /* 同上，error_shaping_enabled=true */ } as RequestEnvelope

  describe("errorFrameCanonicalRewrite", () => {
    test("appliesTo(env) false when error_shaping_enabled=false — golden lock, chain skips this rewrite entirely", () => {
      expect(errorFrameCanonicalRewrite.appliesTo(envDisabled)).toBe(false)
    })

    test("appliesTo(env) false for non-MESSAGES targetEndpoint even when error_shaping_enabled=true — HIGH-2 endpoint gate regression (this rewrite must never fire on gemini/chat-completions/responses legs sharing ALL_RESPONSE_REWRITES)", () => {
      const envNonAnthropic = { ...envEnabled, targetEndpoint: ENDPOINT.CHAT_COMPLETIONS } as RequestEnvelope
      expect(errorFrameCanonicalRewrite.appliesTo(envNonAnthropic)).toBe(false)
    })

    test("non-error frame → emit unchanged (passthrough)", () => {
      const state = errorFrameCanonicalRewrite.createState?.(envEnabled)
      const action = errorFrameCanonicalRewrite.transform({ event: "content_block_delta", data: "{}" }, state)
      expect(action).toEqual({ kind: "emit", frames: [{ event: "content_block_delta", data: "{}" }] })
    })

    test("raw upstream event:error frame (arbitrary shape) → reshaped into canonical Anthropic envelope, original type/message preserved where present", () => {
      const state = errorFrameCanonicalRewrite.createState?.(envEnabled)
      const raw = { event: "error", data: JSON.stringify({ error: { code: "rate_limited", message: "slow down" } }) } // 上游任意形状，非 Anthropic canonical
      const action = errorFrameCanonicalRewrite.transform(raw, state)
      expect(action.kind).toBe("emit")
      if (action.kind !== "emit") throw new Error("unreachable")
      const data = JSON.parse(action.frames[0].data ?? "{}")
      expect(data.type).toBe("error")
      expect(typeof data.error.type).toBe("string")
      expect(data.error.message).toBe("slow down")
    })
  })
  ```
- [ ] 跑测试确认红（文件不存在）
- [ ] 最小实现：
  - `error-shaping.ts` 追加：
    ```ts
    /** Best-effort extraction of an upstream-sent `event:error` frame's `{type, message}` — tolerant of
     * non-Anthropic-shaped bodies (raw GHC/Copilot error JSON), mirrors stream-accumulator.ts:186-193's
     * parsing so both consumers agree on what "the upstream said" means. */
    export function parseRawUpstreamErrorFrame(frame: UpstreamFrame): { type?: string; message?: string } {
      try {
        const parsed = JSON.parse(frame.data ?? "{}") as { type?: string; error?: { type?: string; message?: string }; message?: string }
        return { type: parsed.error?.type ?? parsed.type, message: parsed.error?.message ?? parsed.message }
      } catch {
        return {}
      }
    }

    /** G-3 sole-ownership canonical builder for a raw upstream error frame — always resolves to
     * a valid Anthropic `event:error` envelope, falling back to "api_error"/a generic message when
     * the upstream shape is unrecognized (never throws, never drops the frame). */
    export function buildCanonicalErrorFrameFromRaw(frame: UpstreamFrame): ClientFrame {
      const { type, message } = parseRawUpstreamErrorFrame(frame)
      return buildCanonicalErrorFrame({ kind: "canonical-error", errorType: type ?? "api_error", message: message ?? "Upstream reported an error" })
    }
    ```
  - 新建 `error-frame-canonical-rewrite.ts`：
    ```ts
    import type { ResponseRewrite } from "~/lib/pipeline/rewrite-registry"
    import type { RequestEnvelope } from "~/lib/pipeline/types"
    import { buildCanonicalErrorFrameFromRaw } from "~/lib/anthropic/error-shaping"
    import { ENDPOINT } from "~/lib/models/endpoint"
    import { state } from "~/lib/state"

    export const errorFrameCanonicalRewrite: ResponseRewrite = {
      name: "errorFrameCanonical",
      order: 50,
      // HIGH-2（评审）：ALL_RESPONSE_REWRITES 数组被 gemini/chat-completions/responses driver 复用，
      // 缺 endpoint 门控会让本 rewrite 误伤这些非-Anthropic 路径。既有 5 条 rewrite 全部用
      // `ANTHROPIC(env) = env.targetEndpoint === ENDPOINT.MESSAGES && ...` 门控（adapters.ts:108），
      // 但该 helper 是 response-rewrite-adapters.ts 内未导出的私有 const，本文件是独立新文件，
      // 故按同目录既有先例（thinking-quarantine/proactive-filter.ts:110、
      // openai-cc/reverse-anthropic-rewrite.ts:88、anthropic/request-rewrite-adapter.ts:65 均各自
      // inline 同一谓词，不共享私有 helper）直接内联同一判据，不新增跨文件导出面。
      appliesTo: (env: RequestEnvelope) => env.targetEndpoint === ENDPOINT.MESSAGES && state.errorShapingEnabled,
      transform: (frame, _rewriteState) => {
        if (frame.event !== "error") return { kind: "emit", frames: [frame] }
        return { kind: "emit", frames: [buildCanonicalErrorFrameFromRaw(frame)] }
      },
    }
    ```
  - `rewrite-registry.ts` 的 `RESPONSE_REWRITE_ORDER` 追加 `errorFrameCanonical: 50,`（置于对象字面量最前，值最小）
  - `response-rewrite-adapters.ts` 的 `ANTHROPIC_RESPONSE_REWRITES` 数组头部插入：`[errorFrameCanonicalRewrite, recoverRewrite, thinkingRewrite, decodeRewrite, filterRewrite, refusalRewrite]`
- [ ] 确认绿
- [ ] 提交（`feat: add errorFrameCanonical S5 rewrite for upstream event:error frames (G-3)`）

## 任务 3.2：终点①①'②③收编——4 处手搓 JSON 改为委托 error-shaping builder（评审 MEDIUM-1：新增①'）

- [ ] 写失败测试 `tests/routes/messages/postcommit-error-shaping.it.test.ts`：
  ```ts
  import { describe, expect, test } from "bun:test"
  import { useIsolatedRuntime } from "~~tests/support/isolated-runtime"
  import { state } from "~/lib/state"

  describe("post-commit error shaping — golden lock (disabled)", () => {
    const runtime = useIsolatedRuntime()

    test("error_shaping_enabled=false → terminus①(HTTPError post-commit) byte-identical SSE error frame", async () => {
      state.errorShapingEnabled = false
      // 驱动一个 delayed-commit 场景：commit 后 upstream 抛 HTTPError（复用 exp/cc-error-retry-surface fake server 的 post-commit fixture 手法）
      // 断言 SSE 帧序列与当前基线完全一致（byte-for-byte body 比对）
    })

    test("error_shaping_enabled=false → terminus①'(non-HTTPError post-commit, e.g. network_error/socket reset) byte-identical synthetic api_error frame — MEDIUM-1 新增收编的回归锁", async () => {
      state.errorShapingEnabled = false
      // 驱动 commit 后上游连接被重置（非 HTTPError 的 Error，classifyError 会分类为 network_error）
      // 断言帧仍是今日的 anthropicErrorFrame("api_error", error.message) 逐字节形状
    })

    test("error_shaping_enabled=false → H2(upstream mid-stream event:error) forwarded VERBATIM as today (no S5 reshape)", async () => {
      state.errorShapingEnabled = false
      // 上游中途下发一个非-canonical 形状的 event:error 帧，断言客户端原样收到未经改写的帧
    })

    test("error_shaping_enabled=false → truncation (no message_stop) byte-identical synthetic frame", async () => {
      state.errorShapingEnabled = false
      // 断言 truncation 分支仍产出与今日一致的硬编码 api_error 帧
    })
  })

  describe("post-commit error shaping — enabled", () => {
    const runtime = useIsolatedRuntime()

    test("H2 upstream mid-stream non-canonical event:error → reshaped to canonical Anthropic envelope (via S5, not H2 branch writeSynthetic)", async () => {
      state.errorShapingEnabled = true
      // 同上 fixture，断言客户端收到的帧现在是 canonical 形状（{type:"error", error:{type, message}}）
    })

    test("terminus①(HTTPError post-commit) → still emits via error-shaping builder, same shape as before (regression, not just golden — confirms delegation didn't change output)", async () => {
      state.errorShapingEnabled = true
      // 断言 body 与 disabled 态语义等价（canonical shape 相同，因为 terminus① 走的是 decide()→canonical-error 分支，非重整形新逻辑）
    })

    test("terminus①'(network_error post-commit) → decide() 命中 canonical-error 分支，errorType 反映 network_error 的 canonical 映射（不再硬编码 'api_error'）——MEDIUM-1 核心验证：这条测试证明 network_error post-commit 真的经过了 decide()，而不是绕过它落到旧的手搓分支", async () => {
      state.errorShapingEnabled = true
      // 驱动同上 network_error fixture，断言 decide() 被调用（可通过 spy 或断言 errorType 映射结果与 rate_limited/server_error 等其它 A 类共享同一映射函数产出）
    })
  })
  ```
- [ ] 跑测试确认红
- [ ] 最小实现：
  - `handler-v4.ts:565` 终点①：`await sink.writeSynthetic?.(anthropicHttpErrorFrame(error))` 改为先 `classifyError(error)` → `decide({error: apiError, commitPhase:"post-commit", clientVisibleStopEmitted: false, config: errorShapingConfigFromState()})`（复用 Phase 2 的 `errorShapingConfigFromState`，从 `error-shaping-glue.ts` 导出）→ 若 `state.errorShapingEnabled` 为 false 或 decide 结果非预期分支，回退调用原 `anthropicHttpErrorFrame(error)`（golden 锁）；否则 `await sink.writeSynthetic?.(buildCanonicalErrorFrame(decision))`（decision.kind 必为 `"canonical-error"`，因为 Phase 1 真值表已确认 post-commit 无 retry-signal 选项）
  - **`handler-v4.ts:568-570` 终点①'（评审 MEDIUM-1 新增收编）**：`await sink.writeSynthetic?.(anthropicErrorFrame("api_error", error instanceof Error ? error.message : String(error)))` 改为与终点①同构的委托——先 `classifyError(error)`（此处 `error` 已知非 `HTTPError`、非 abort，`classifyError` 会产出 `network_error`/`bad_request` 等类型）→ `decide({error: apiError, commitPhase:"post-commit", ...})` → `state.errorShapingEnabled` 为 false 时回退原 `anthropicErrorFrame("api_error", message)`（golden 锁，逐字节）；启用时 `await sink.writeSynthetic?.(buildCanonicalErrorFrame(decision))`。终点①与①'可以共享同一段"classify→decide→buildCanonicalErrorFrame，否则回退原 legacy 构造"的小函数，避免重复代码（建议抽一个本地 helper，如 `shapePostcommitFrame(error, legacyFrame)`，供①/①'共用，H3/truncation 因为没有原始 `error` 对象或走不同 legacy 构造，不强制复用同一 helper）
  - `handler-v4.ts:1193` 终点②H3：`errorType = anthropicStreamErrorType(error)` 保持（Phase 1 已 re-export），`writeSynthetic` 的手搓 JSON 改为 `buildCanonicalErrorFrame({ kind: "canonical-error", errorType, message: errorMessage })`（`state.errorShapingEnabled` 为 false 时 `buildCanonicalErrorFrame` 产出的 JSON 必须与原手搓字面量逐字节相同——这是本任务的 golden 断言核心，需要在实现 `buildCanonicalErrorFrame` 时特别核对字段顺序 `{type, error: {type, message}}` 与原字面量一致）
  - `handler-v4.ts:1295` truncation：手搓 JSON 改为 `buildCanonicalErrorFrame({ kind: "canonical-error", errorType: "api_error", message: "Upstream stream truncated before completion (no message_stop)" })`
- [ ] 确认绿
- [ ] 提交（`refactor: delegate post-commit terminal error frames to error-shaping builders (G-3 canonical ownership, 4 termini)`）

## 任务 3.3：H2 分支日志措辞更新（非强制但建议顺手做，避免注释与代码脱节）

- [ ] 更新 `handler-v4.ts:1213-1214` 注释，去掉"forwarded as a content frame"的过时描述（S5 rewrite 已介入），改为准确描述"reshaped by errorFrameCanonicalRewrite at S5, this branch only settles ctx"
- [ ] `bun run typecheck` 确认无副作用
- [ ] 提交（`docs: update H2 branch comment to reflect S5 canonical reshape`）——若认为不值得单独一提交，可并入任务 3.2 的提交，不强制拆分

## Phase 3 完成检查

- [ ] `bun run typecheck` 全绿
- [ ] `bunx eslint` 覆盖本 Phase 全部改动文件
- [ ] 四终点 golden 字节锁测试（`error_shaping_enabled=false`）全绿——这是本 Phase 最关键的回归防线
- [ ] **（评审 LOW-1）本 Phase 的 golden/回归测试只用默认 `streamKeepaliveMode` 驱动 fixture，不逐一切换 `empty_text`/`ping` 两种 keepalive 模式**——spec 第 125 行要求 oracle 覆盖两种模式以避免"只测一种假绿"，但那条要求针对的是**依赖 block-level buffered-retry 重放的 post-commit 截断/RST 场景 oracle**，属于 Phase 6（GATED，依赖 block-level P1 落地）的领域，不在本 Phase（S5 canonical 整形，不涉及重放）范围内。本 Phase 的四个终点（HTTPError/network_error/H3/truncation）都是"提交失败尾帧一次性整形"，与 keepalive anchor 的 open/close 时序无关，故本 Phase 无需重复覆盖双模式；Phase 6 落地时须显式验证 `empty_text` 与 `ping` 两种模式下 buffered 重放 + canonical 尾帧整形均正确。
- [ ] 确认 `stream-accumulator.ts` 零改动（`git diff --stat -- src/lib/anthropic/stream-accumulator.ts` 应为空——上游轨记录逻辑不受影响）
- [ ] 确认 `errorFrameCanonicalRewrite` 排在 `RESPONSE_REWRITE_ORDER` 最前（`order: 50` < 其余 5 个既有值），并有一条专门测试断言"refusalRewrite 合成的 event:error 帧不会被 errorFrameCanonicalRewrite 二次改写"（因为链单向前进，这条测试是对该不变量的显式回归锁，而不仅仅是逻辑推理）
- [ ] 确认任务 3.1 的 endpoint 门控回归测试（"appliesTo(env) false for non-MESSAGES targetEndpoint even when error_shaping_enabled=true"）已落地且绿——这是 HIGH-2 修复的直接验证，缺此测试视为本任务未完成
