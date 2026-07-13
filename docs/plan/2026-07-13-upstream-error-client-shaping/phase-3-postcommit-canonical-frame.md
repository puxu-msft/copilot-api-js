# Phase 3：post-commit 上游 `event:error` 帧 canonical 化（S5 rewrite 拦截，非 H2 事后补救）

**依赖**：Phase 0（config）、Phase 1（`error-shaping.ts` 的 `buildCanonicalErrorFrame`/`classifyStreamErrorType`）
**产出**：新 `ResponseRewrite`（`errorFrameCanonical`，order=50）+ 终点①②三处 handler-v4.ts 收编调用

> **D-0.5 跨 worktree 冲突提示（重复一遍，勿漏）**：`src/routes/messages/handler-v4.ts` 的 1090-1330 行区间正是 block-level buffered retry P1 Task 6（`docs/spec/2026-07-11-block-level-buffered-retry.md`）计划要重构的同一区间（commit 边界谓词 `commitBoundaries(frame)` 要在这里接线）。若 P1 Task 6 与本 Phase 并发在不同 worktree 推进，**同文件同区间**大概率行级冲突。推荐排序（非强制，若两条线都要推进则采纳）：先落地本 Phase（改动集中在"新增一个 S5 rewrite + 三处 `writeSynthetic` 调用替换成一行委托"，绝对行数改动小），block-level P1 Task 6 rebase 到本 Phase 之后；或反之但本 Phase 实现者需在动手前 `git log --oneline -5 -- src/routes/messages/handler-v4.ts` 确认无冲突中的并发提交。

## 探索确认的关键事实（本 Phase 设计的直接依据，非转述 spec）

- **`event:error` 帧确实流经 S5 `ResponseRewrite` 链**：`driver.ts:856-875` 的 `passThrough()` 对**每一个** `UpstreamFrame`（`type UpstreamFrame = SseFrame`，无特殊排除 `event:"error"`）依次调用 `rewrites[i].transform(frame, states[i])`。这意味着上游主动下发的 `event:error` 帧（H2 场景，`stream-accumulator.ts:186-193` 只记录进 `acc.streamError` 用于 bookkeeping、从不拦截改写）与其余内容帧走同一条链，可以在此处插入拦截。
- **必须排在最前面（`order` 最小），而非排在 `refusalRewrite`(400) 之后**：`refusalRewrite` 自己在某些配置下会**合成**一个 `event:error` 帧（`handler-v4.ts:1232` 注释"the S5 rewrite layer already emitted the Anthropic `event: error` frame"）。若新 rewrite 排在它之后，会对 `refusalRewrite` 刚合成的、已经是 canonical 形状的帧再次"重整形"，属于对已处理帧的错误二次加工。`passThrough` 只单向前进（`driver.ts:856-875` 的 for 循环不回头），所以只要新 rewrite 排在最前，它看到的 `event:error` 帧必然是**未经任何其他 rewrite 处理的原始上游帧**，往后游的 `refusalRewrite` 合成帧永远不会倒流回来给它二次处理。故 `RESPONSE_REWRITE_ORDER` 新增 `errorFrameCanonical: 50`（早于 `recoverToolCall: 100`）。
- **`acc.streamError`（`stream-accumulator.ts`）保持不变、继续记录原始上游帧**：这是 history/上游轨的 bookkeeping（richest-data-flow：上游轨永远存真实原始帧），与本 Phase 改的"客户端可见轨"（S5 rewrite 产出）是两个正交轨道，互不影响、无需改动 `stream-accumulator.ts`。
- **`H2` 分支（`handler-v4.ts:1213-1224`）本身不需要再写帧**：新 rewrite 已经在 S5 阶段把 canonical 帧写给客户端了，H2 分支只需要保留其现有的 `env.ctx.fail(...)` 结算逻辑（帧已经走了新路径，不是"事后补救"）。**唯一需要改的是 log 措辞**（可选：不改也不影响功能，因为 log 只是 consola 输出不是协议行为，若嫌"a terminal upstream error SSE event was forwarded as a content frame"的注释已经过时可以顺手更新，非强制项）。
- **`H3`（`handler-v4.ts:1172-1201`）与终点①（`handler-v4.ts:560-566`）与 truncation（`handler-v4.ts:1279-1305`）三处仍需要主动 `writeSynthetic`**——因为这三处的错误根本不是"流经 S5 rewrite 链的一个上游帧"，而是本地合成的全新帧（H3=本地捕获的抛出异常、终点①=`await p` 失败前尚未进入 pump、truncation=EOF without message_stop）。这三处继续需要显式调用 builder，只是改为调用 `error-shaping.ts` 的统一 builder（G-3"唯一所有权"），不再各自手搓 JSON。

## 涉及文件

- `src/lib/anthropic/error-shaping.ts`（Phase 1 已建，本 Phase 追加 `buildCanonicalErrorFrameFromRaw`）
- `src/lib/codec/anthropic/error-frame-canonical-rewrite.ts`（新增，`ResponseRewrite` 实现）
- `src/lib/codec/anthropic/response-rewrite-adapters.ts`（`ANTHROPIC_RESPONSE_REWRITES` 数组头部插入新 rewrite）
- `src/lib/pipeline/rewrite-registry.ts`（`RESPONSE_REWRITE_ORDER` 新增 `errorFrameCanonical: 50`）
- `src/routes/messages/handler-v4.ts`（终点①566 行、终点②H3-1189 行、truncation-1294 行三处 `writeSynthetic` 调用改为委托 `error-shaping.ts` builder）
- `tests/codec/anthropic/error-frame-canonical-rewrite.unit.test.ts`（新增）
- `tests/routes/messages/postcommit-error-shaping.it.test.ts`（新增，golden 字节锁 + 三终点端到端）

## 任务 3.1：新增 S5 rewrite——上游 `event:error` 帧 canonical 化（golden 锁 + 启用态）

- [ ] 写失败测试 `tests/codec/anthropic/error-frame-canonical-rewrite.unit.test.ts`：
  ```ts
  import { describe, expect, test } from "bun:test"
  import { errorFrameCanonicalRewrite } from "~/lib/codec/anthropic/error-frame-canonical-rewrite"
  import type { RequestEnvelope } from "~/lib/pipeline/types"

  const envDisabled = { /* 最小 RequestEnvelope stub，配置 error_shaping_enabled=false */ } as RequestEnvelope
  const envEnabled = { /* 同上，error_shaping_enabled=true */ } as RequestEnvelope

  describe("errorFrameCanonicalRewrite", () => {
    test("appliesTo(env) false when error_shaping_enabled=false — golden lock, chain skips this rewrite entirely", () => {
      expect(errorFrameCanonicalRewrite.appliesTo(envDisabled)).toBe(false)
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
    import { state } from "~/lib/state"

    export const errorFrameCanonicalRewrite: ResponseRewrite = {
      name: "errorFrameCanonical",
      order: 50,
      appliesTo: (_env: RequestEnvelope) => state.errorShapingEnabled,
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

## 任务 3.2：终点①②③收编——三处手搓 JSON 改为委托 error-shaping builder

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
  })
  ```
- [ ] 跑测试确认红
- [ ] 最小实现：
  - `handler-v4.ts:565` 终点①：`await sink.writeSynthetic?.(anthropicHttpErrorFrame(error))` 改为先 `classifyError(error)` → `decide({error: apiError, commitPhase:"post-commit", clientVisibleStopEmitted: false, config: errorShapingConfigFromState()})`（复用 Phase 2 的 `errorShapingConfigFromState`，从 `error-shaping-glue.ts` 导出）→ 若 `state.errorShapingEnabled` 为 false 或 decide 结果非预期分支，回退调用原 `anthropicHttpErrorFrame(error)`（golden 锁）；否则 `await sink.writeSynthetic?.(buildCanonicalErrorFrame(decision))`（decision.kind 必为 `"canonical-error"`，因为 Phase 1 真值表已确认 post-commit 无 retry-signal 选项）
  - `handler-v4.ts:1188-1190` 终点②H3：`errorType = anthropicStreamErrorType(error)` 保持（Phase 1 已 re-export），`writeSynthetic` 的手搓 JSON 改为 `buildCanonicalErrorFrame({ kind: "canonical-error", errorType, message: errorMessage })`（`state.errorShapingEnabled` 为 false 时 `buildCanonicalErrorFrame` 产出的 JSON 必须与原手搓字面量逐字节相同——这是本任务的 golden 断言核心，需要在实现 `buildCanonicalErrorFrame` 时特别核对字段顺序 `{type, error: {type, message}}` 与原字面量一致）
  - `handler-v4.ts:1294-1299` truncation：手搓 JSON 改为 `buildCanonicalErrorFrame({ kind: "canonical-error", errorType: "api_error", message: "Upstream stream truncated before completion (no message_stop)" })`
- [ ] 确认绿
- [ ] 提交（`refactor: delegate post-commit terminal error frames to error-shaping builders (G-3 sole ownership)`）

## 任务 3.3：H2 分支日志措辞更新（非强制但建议顺手做，避免注释与代码脱节）

- [ ] 更新 `handler-v4.ts:1213-1214` 注释，去掉"forwarded as a content frame"的过时描述（S5 rewrite 已介入），改为准确描述"reshaped by errorFrameCanonicalRewrite at S5, this branch only settles ctx"
- [ ] `bun run typecheck` 确认无副作用
- [ ] 提交（`docs: update H2 branch comment to reflect S5 canonical reshape`）——若认为不值得单独一提交，可并入任务 3.2 的提交，不强制拆分

## Phase 3 完成检查

- [ ] `bun run typecheck` 全绿
- [ ] `bunx eslint` 覆盖本 Phase 全部改动文件
- [ ] 三终点 golden 字节锁测试（`error_shaping_enabled=false`）全绿——这是本 Phase 最关键的回归防线
- [ ] 确认 `stream-accumulator.ts` 零改动（`git diff --stat -- src/lib/anthropic/stream-accumulator.ts` 应为空——上游轨记录逻辑不受影响）
- [ ] 确认 `errorFrameCanonicalRewrite` 排在 `RESPONSE_REWRITE_ORDER` 最前（`order: 50` < 其余 5 个既有值），并有一条专门测试断言"refusalRewrite 合成的 event:error 帧不会被 errorFrameCanonicalRewrite 二次改写"（因为链单向前进，这条测试是对该不变量的显式回归锁，而不仅仅是逻辑推理）
