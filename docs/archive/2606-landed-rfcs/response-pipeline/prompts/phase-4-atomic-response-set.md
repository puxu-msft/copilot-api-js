# Phase 4 — 原子迁 Anthropic 响应改写集（A1，最 byte-critical）

> Stage A 的 Task 4 / 设计稿的 A1。开场先读 [README.md](./README.md) 的通用红线 + 通用必读。**前置**：Phase 0（golden）、Phase 1（flushChain-finally）、Phase 3（buffer 契约）。**本 phase 是整个 Stage A 风险最高、最 byte-critical 的一步。**

## 背景 + 为什么必须原子

四条 Anthropic 流式响应改写当前在 `src/routes/messages/streaming-pump.ts:195-228` 手写嵌套：
```
recover-tool-call → tool-input-decode → server-tool-filter   (forwardToClient 还焊接 forwarded 采样 + heartbeat 写, :248-280)
```
要迁进 `RESPONSE_REWRITES` 由 driver `passThrough`/`flushChain` 驱动。

**为什么不能逐条迁**（审计 §4.0.4 实测结论）：`passThrough`（`driver.ts:277`）对每帧跑**整条已注册链**。若只迁一条（如先迁 filter），中间态会变成 `recover(闭包) → decode(闭包) → [driver: filter]`，但 driver 的 filter 在 handler 闭包**之后**跑——而正确序是 recover→decode→filter 全在一起。逐条迁会在中间 commit 让**执行顺序反转**（只有 default config 下恰好 no-op 才侥幸不炸），违反 commit-invariants"中间 commit 不半坏"。**故四条必须在同一 commit 原子迁入 + 同步删 handler 嵌套。**

## 目标

单个 commit 内完成：
1. 四条改写按 stage-a-plan.md **factory 锚点表**注册进 `RESPONSE_REWRITES`，order 用 Phase 3 固化的常量：

   | rewrite | stream factory（现有,直接包装） | order |
   |---|---|---|
   | recover-tool-call | `createToolCallTextRecoverer`（`recover-tool-call/stream.ts:46`） | 100 |
   | thinking-signature-compat | `applyThinkingSignatureCompat`（`thinking-signature-compat.ts:69`） | 150 |
   | tool-input-decode | `createToolInputStreamDecoder`（`decode-tool-input.ts:91`） | 200 |
   | server-tool-filter | `createServerToolBlockFilter`（`server-tool-filter.ts:102`） | 300 |

   每条 `appliesTo(env)` 守卫复刻现有触发条件（如 recover 仅 `state.recoverToolCallText` 真、decode 看 `decodeToolInputFields`/`decodeAllToolInputFields`、filter 总开）。`createState()` 包装现有 factory 的闭包状态。`transform(frame,state)` 适配现有逐帧函数到 `FrameAction`（`{kind:"emit"|"buffer"|"drop"}`）、`flush(state)` 适配现有 finalize。
2. **同步删** `streaming-pump.ts:195-228` 的手写嵌套调用（recover/decode/filter 三层）。
3. **forwarded 采样 + heartbeat 写**（`:248-280`）——按设计稿，driver-owned-writeout 是 Stage A 之后的事；本 phase heartbeat/forwarded 仍 **handler-side**，保留 `forwardToClient` 里这部分，只把 filter（已迁 registry）从焊接中摘出。确认 forwarded 采样仍发生在 registry 链**之后**（客户端实收侧），不污染 upstream `sseEvents`。

## 复用现有核、不重写

四个 factory 全部已存在、经测试。**只做适配包装**（现有逐帧函数 → `ResponseRewrite.transform/flush`），**绝不重写算法核**（recover 的 CANDIDATE/COMMIT/rollback、filter 的 index densify、decode 的 buffer 边界）。是 battle-tested-over-hand-rolled：只换驱动壳，保留领域核。

## TDD + 验证 gate

1. 改前：Phase 0 golden 已锁全部激活态字节（含 recover×filter index 交互、双 flush、rollback）。
2. 实现原子迁移 + 删嵌套。
3. **硬 gate**：Phase 0 golden **逐字节全绿**（任何 diff = fail，byte-critical）。
4. **连跑 10-25×** `bun test tests/anthropic/response-rewrite-golden.http.test.ts`（buffer/flush/heartbeat 时序，确认无 flaky）。
5. `bun run test:backend` 全绿（2 个预存 FileSink 失败正交）。

## 验收

- Phase 0 golden 逐字节等价（硬 gate）+ 契约测试（Phase 3）绿 + 连跑确定。
- `bun run typecheck` 绿；`bunx eslint --fix`。
- **subagent 多轮对抗 review**（全量工具，本 phase 至少 2 轮）：重点核 (a) order 是否真复刻闭包嵌套序；(b) appliesTo 守卫是否覆盖所有原触发分支；(c) flush 级联（recover.flush→decode）是否等价 handler-v4.ts:655-663；(d) index 空间是否一致。**主线亲自读 reviewer 引用的每个 file:line**，对"等价""无影响"绝对断言对照 golden 实测复核。

## 提交

```bash
git add -- src/lib/pipeline/rewrite-registry.ts src/routes/messages/streaming-pump.ts <四个 factory 若有适配改动> tests/...
git commit -m "refactor(pipeline): Stage A A1 原子迁 Anthropic 响应改写集进 RESPONSE_REWRITES(recover/thinking/decode/filter)"
```
