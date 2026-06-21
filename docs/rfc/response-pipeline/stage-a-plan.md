# Stage A — Transform Registry 激活 实现计划

> **For agentic workers:** 用 superpowers:subagent-driven-development 或 executing-plans 逐任务实现。本计划是 [docs/rfc/response-pipeline-driver-owned.md](./design.md) 的 **Stage A**（Stage B 不在本计划，A 落地后重走 OQ1）。

**Goal:** 激活休眠的 `rewrite-registry`，把请求 + 响应（流式 + 非流式）改写从 codec/handler 内联迁进 driver 的 transform registry，让"新增拦截/修复 = 注册一个 ResponseRewrite"，generator 模型不变。

**Architecture:** driver 的 S3（`runRewriteIn`）/ S5（`passThrough`+`flushChain`）/ 非流式链装载注册的 transform；改写**实现复用现有命名 factory**（`src/lib/anthropic/*`），只新建 registry 包装 + 装配。byte-critical：每个迁移任务靠 **golden-fixture-pre-capture**（Task 0 在改前代码锁字节）+ 改后逐字节断言兜底。

**Tech Stack:** TypeScript（strict）、bun test、`~/lib/pipeline/{driver,rewrite-registry,types}`、`~/lib/anthropic/*` factory。

**核心纪律（每 commit 必过）：** ① `bun run typecheck` 绿 ② `bun run test:backend` 绿（2 个预存 FileSink 失败除外，与本工作正交）③ golden 字节等价 ④ 三大能力守卫（`/history/api/entries/:id` 双轨、`/api/logs`+`/api/status`、WS wire）⑤ 可独立 revert ⑥ 提交前 subagent 对抗 review + 主线亲自核验 file:line ⑦ 细粒度暂存（`git add -- <精确路径>`，绝不 `-A`）。

**改写 factory 锚点（实现复用，不重写）：**
| 改写 | 流式 factory | 非流式 helper | order |
|---|---|---|---|
| recover-tool-call | `createToolCallTextRecoverer` (recover-tool-call/stream.ts:46) | `recoverToolCallTextInResponse` (recover-tool-call/response.ts:21) | 100 |
| thinking-signature-compat | `applyThinkingSignatureCompat` (thinking-signature-compat.ts:69) | —（非流式无） | 150 |
| tool-input-decode | `createToolInputStreamDecoder` (decode-tool-input.ts:91) | `decodeToolInputBlocksInResponse` (decode-tool-input.ts:172) | 200 |
| server-tool-filter | `createServerToolBlockFilter` (server-tool-filter.ts:102) | `filterServerToolBlocksFromResponse` (server-tool-filter.ts:176) | 300 |

---

## Task 0 — Golden 预捕获基线（test-only，零生产改动）

**Files:**
- Create: `tests/anthropic/response-rewrite-golden.http.test.ts`（激活态 golden fixtures，捕获**当前** handler-v4 路径）
- Reference: `tests/anthropic/anthropic-v4.http.test.ts`（现有 mock/app 范式）、`tests/helpers/sse.ts`

**为什么先做：** RFC §7 审计指出现有 golden 只锁 no-op 透传流；所有激活态 byte-critical 路径零覆盖。必须在**改动前**的代码上锁字节，否则后续迁移无等价基线（golden-fixture-pre-capture 纪律）。

- [x] **Step 1: 写激活态 golden 测试（断言当前 handler-v4 输出的真实字节）**，覆盖场景：
  - `server_tool_use` block 流（`state.webSearchEnabled` 关、但请求含 server tool）→ suppress + 后续块 index densify
  - AskUserQuestion tool_use 流（`decodeToolInputFields` 默认）→ buffer/flush mid-stream finalize
  - 降级文本流（`recoverToolCallText: true`）→ CANDIDATE/COMMIT 合成 tool_use + rollback（candidate 被 content_block_start 打断）
  - recover + decode 同激活 + 流末 → 双 flush 顺序
  - recover × filter index 空间交互（recover 用 `maxUpstreamIndexSeen+k` + filter densify）
  - 非流式各场景（server-tool 过滤、tool-input decode、name restore、recover）
  - 用临时 `console.error("###CAP_*###"+JSON.stringify(text))` 跑一次抓真实字节，转成 inline golden 常量，删临时打印（同 P3.3a 手法）
- [x] **Step 2: 跑通（当前代码全绿）** — `bun test tests/anthropic/response-rewrite-golden.http.test.ts`，Expected: all PASS（这是改前基线）
- [x] **Step 3: Commit** — `git add -- tests/anthropic/response-rewrite-golden.http.test.ts && git commit -m "test(pipeline): Stage A Task0 激活态响应改写 golden 基线(改前锁字节)"`

> 这些 golden 在后续每个迁移任务后**重跑必须仍全绿**（字节等价 gate）。

---

## Task 1 — flushChain 进 try/finally（H3 前置，driver.ts）

**Files:**
- Modify: `src/lib/pipeline/driver.ts`（`runResponse` 的 `for await` + `flushChain`，~第 265-287 行）
- Test: `tests/pipeline/driver.unit.test.ts`（加异常路径 flush 断言）

**为什么：** RFC §4.0.5——`flushChain`(driver.ts:284) 在 for-await 之后但**不在 try/finally**，异常时不执行。任何 buffering rewrite 入 registry 后异常路径 buffer 静默丢失。前置此修复（generator 模型下即可做，当前 RESPONSE_REWRITES 空、行为 no-op）。

- [x] **Step 1: 写失败测试** — mock 一个 buffering ResponseRewrite（transform 返回 `{kind:"buffer"}`、flush 返回缓冲帧）+ 一个在 N 帧后抛错的 upstream；断言：异常抛出**前** flush 的帧已 yield（catch 到异常 + 收到 flushed 帧）。
- [x] **Step 2: 跑验证失败** — `bun test tests/pipeline/driver.unit.test.ts -t "flush on exception"`，Expected: FAIL（现状 flushChain 不在 finally，异常时 flushed 帧丢失）
- [x] **Step 3: 实现** — `runResponse` 改为 `try { for await(...) {...} } finally { for (const flushed of flushChain(rewrites, states)) yield* renderFrames(...) }`。注意：finally 里 yield 在 generator 中合法；正常路径 + 异常路径都 drain。**保持 upstreamSse 采样别名逻辑不变**（[DONE] skip 等，P3.2b/P3 收尾）。
- [x] **Step 4: 跑验证通过** — 上述测试 PASS + `bun test tests/pipeline/driver.unit.test.ts` 全绿 + Task0 golden 全绿（行为 no-op，应无变化）
- [x] **Step 5: typecheck + eslint --fix** — `bun run typecheck` 绿；`bunx eslint --fix src/lib/pipeline/driver.ts`
- [x] **Step 6: subagent review + Commit** — 派全量工具 subagent 核验"finally 里 yield 不破坏正常路径采样/forwarded 时序"；`git add -- src/lib/pipeline/driver.ts tests/pipeline/driver.unit.test.ts && git commit -m "fix(pipeline): Stage A Task1 flushChain 进 try/finally(H3 前置,异常路径也 drain registry buffer)"`

---

## Task 2 — A0 请求侧 registry 激活（driver runRewriteIn 接真实改写）

**Files:**
- Modify: `src/lib/pipeline/rewrite-registry.ts`（填 `REQUEST_REWRITES` — Anthropic system/tool/sanitize 三组包成 `RequestRewrite`）
- Modify: `src/lib/codec/anthropic.ts`（`parse` 不再内联跑 `runAnthropicRequestRewrites`；改由 driver S3 跑）
- Reference: `runAnthropicRequestRewrites` (request-rewrites.ts:150)、driver `runRewriteIn` (driver.ts:129)
- Test: `tests/pipeline/request-rewrite-registry.it.test.ts`（新建）

**为什么 + 风险：** RFC §4.A0——`driver.ts:131` 跑空 `REQUEST_REWRITES`，真实改写在 codec.parse（确凿割裂）。**风险点（审计 OQ3）：** codec.parse 现在还在 sanitize 时记 `setPipelineInfo`/`messageMapping`（anthropic.ts:287+）。迁到 S3 改变记录时机 → golden 必须覆盖**请求 history**（effectiveRequest + pipelineInfo + messageMapping）。**明确排除** B1-B12（PrepareStep）+ normalizeCallIds（P2.2-D1 卡）。

- [x] **Step 1: 写 golden（请求侧改前基线）** — 捕获当前 codec.parse 路径的 `effectiveRequest.payload` + `pipelineInfo` + `messageMapping`（含 sanitize 实际改动的场景：system-reminder 去除、tool-name fix、orphan 过滤）
- [x] **Step 2: 跑通基线** — Expected: PASS（改前）
- [x] **Step 3: 包 RequestRewrite + 填 REQUEST_REWRITES** — 把 `runAnthropicRequestRewrites` 包成 `RequestRewrite{name:"anthropic-sanitize", order, appliesTo: env=>env.clientFormat==="anthropic", apply: env => ({env: env.with({body: rewritten}), changed, stats})}`；保持 pipelineInfo/messageMapping 记录（迁进 apply 或保留 codec.parse 记录点——**二选一需 golden 锁定哪个时机字节等价**）
- [x] **Step 4: codec.parse 去内联** — 移除 parse 里的 `runAnthropicRequestRewrites` 调用，依赖 driver S3
- [x] **Step 5: 跑验证** — 请求 golden 全绿 + Task0 响应 golden 全绿 + `bun run test:backend`（anthropic 套件经 driver S3）
- [x] **Step 6: typecheck + eslint + subagent review + Commit** — subagent 核验"sanitize 记录时机迁移字节等价"；`git add -- src/lib/pipeline/rewrite-registry.ts src/lib/codec/anthropic.ts tests/pipeline/request-rewrite-registry.it.test.ts && git commit -m "feat(pipeline): Stage A Task2(A0) 请求改写从 codec.parse 迁进 driver S3 registry"`

> **OQ2：A0 可作独立先行 commit**——它最低风险、修真实割裂、不碰响应字节。若实现中发现 pipelineInfo 时机迁移复杂，可把"记录时机保留 codec、仅 body 改写迁 registry"作为更小步。

---

## Task 3 — flushChain 双 buffer 确定契约 + processEvent↔transform 映射（前置 Task 4）

**Files:**
- Modify: `src/lib/pipeline/driver.ts`（`flushChain` JSDoc 契约 + 多 buffer 断言）
- Test: `tests/pipeline/driver.unit.test.ts`（buffer→buffer 链测试 + processEvent↔transform 映射测试）

**为什么：** RFC §4.A1——Task 4 同时注册 recover + decode 两个 buffering rewrite（触发 P2.1-M2 单 buffer 假设失效）。先锁定确定契约。

- [x] **Step 1: 写 buffer→buffer 链测试** — 两个 buffering mock rewrite（order 100/200），断言：升序 flush，rewrite[100] 的 flushed 帧穿过 rewrite[200]（含其 buffer），用同一 state 实例；与"recover.flush 输出喂 decode、decode 再 flush"语义同构。
- [x] **Step 2: 写 processEvent↔transform 映射测试** — 断言映射规约：空 array→`suppress`、单帧→`emit{[f]}`、多帧→`emit{frames}`、buffer→`buffer`（这是 Task 4 包装 factory 时的适配规约）。
- [x] **Step 3: 跑验证失败/通过** — 若现 flushChain 升序语义已满足，测试直接 PASS（锁契约）；若不满足，修 flushChain 使其满足。
- [x] **Step 4: 更新 flushChain JSDoc** — 把"至多一个 buffering rewrite"假设替换为 §4.A1 确定契约文字。
- [x] **Step 5: typecheck + Commit** — `git add -- src/lib/pipeline/driver.ts tests/pipeline/driver.unit.test.ts && git commit -m "feat(pipeline): Stage A Task3 flushChain 双 buffer 确定契约 + processEvent↔transform 映射(P2.1-M2 锁定)"`

---

## Task 4 — A1 原子迁互依赖响应改写集（recover+decode+filter+thinking）

**Files:**
- Create: `src/lib/codec/anthropic-response-rewrites.ts`（4 个 `ResponseRewrite` 包装，复用 factory）
- Modify: `src/lib/pipeline/rewrite-registry.ts`（填 `RESPONSE_REWRITES` Anthropic 部分）
- Modify: `src/routes/messages/streaming-pump.ts`（拆 `forwardToClient`:248-280：filter 逻辑上移、采样+心跳写出留 handler 简化版）+ `handler-v4.ts`（pump 去内联改写）
- Test: 重跑 Task 0 golden

**为什么原子：** RFC §4.0——recover/decode/filter 有硬顺序契约（recover-tool-call/stream.ts:40"假设跑在 serverToolFilter 之前"），单迁中间态颠倒顺序、只默认配置无害。原子迁消除中间态。thinking(order 150)夹在中间，一并迁。

- [x] **Step 1: 包 4 个 ResponseRewrite**（anthropic-response-rewrites.ts）：每个 `{name, order(100/150/200/300), appliesTo, createState(持 factory 闭包态), transform(适配 factory 的 processEvent→FrameAction，用 Task3 映射规约), flush?(factory.flush→帧)}`。recover/decode 有 flush；filter/thinking 无 buffer。
- [x] **Step 2: 拆 forwardToClient**（streaming-pump.ts）：移除 filter 调用（→registry）；handler 简化版只"采 forwarded（driver 已应用 registry 链的帧）+ heartbeat noteRealFrame/写出"；suppress 帧不到 handler（passThrough suppress 不 yield）→ 不采不写，与现状等价。
- [x] **Step 3: 填 RESPONSE_REWRITES + handler 去内联** — registry 装配 4 个；handler-v4 的 `processOneStreamEvent` 调用链去掉 recover/decode/filter/thinking（driver S5 跑）。
- [x] **Step 4: 跑 Task0 golden + 全套** — **逐字节等价是硬 gate**：`bun test tests/anthropic/response-rewrite-golden.http.test.ts` 全绿 + `bun run test:backend`。流式/时序 fixture 连跑 10-25× 确定性。
- [x] **Step 5: typecheck + eslint + 多视角 subagent 对抗 review** — 这是 Stage A 最 byte-critical 的 commit，派 ≥2 个全量工具 subagent（byte-safety + 顺序契约视角）+ 主线亲自核验每个 file:line（尤其 index densify、suppress 时机、双 flush 顺序、recover rollback）。
- [x] **Step 6: Commit** — `git add -- src/lib/codec/anthropic-response-rewrites.ts src/lib/pipeline/rewrite-registry.ts src/routes/messages/streaming-pump.ts src/routes/messages/handler-v4.ts && git commit -m "feat(pipeline): Stage A Task4(A1) 原子迁 Anthropic 响应改写集进 registry(recover/thinking/decode/filter)"`

---

## Task 5 — A.B 非流式覆盖（transformWhole）

**Files:**
- Modify: `src/lib/pipeline/rewrite-registry.ts`（`ResponseRewrite` 加 `transformWhole?` — RFC §3.1）+ `src/lib/pipeline/types.ts`（接口签名）
- Modify: `src/lib/codec/anthropic-response-rewrites.ts`（给 3 个改写实现 `transformWhole`，装载 whole-response helper）
- Modify: `src/lib/pipeline/driver.ts`（`runResponseNonStreaming` 在 codec render 后按 order 链跑 `transformWhole`）+ `src/routes/messages/handler-v4.ts`（`renderNonStreamingV4` 去内联 whole-response 序列）
- Test: 重跑 Task0 非流式 golden

- [x] **Step 1: 接口加 transformWhole** — `rewrite-registry.ts`（`ResponseRewrite` 接口就在此文件，非 types.ts）。
- [x] **Step 2: 实现 transformWhole** — recover/decode/filter 装载 `recoverToolCallTextInResponse`/`decodeToolInputBlocksInResponse`/`filterServerToolBlocksFromResponse`+`restoreToolNamesInResponse`（同文件 helper）。**OQ3 已裁决（实测核对）**：非流式现状序（`filter→recover→restore→decode`，decode 在 restore 之后=client-name 匹配）与流式升序（`recover→decode→filter+restore`，decode 在 restore 之前=wire-name 匹配）**确实不一致**——restore 在流式被 bundle 进 filter@300，无法用单一 order 同时满足两序。用户裁决：**统一到流式升序**（非流式 decode 改为先于 restore=wire-name 匹配，与流式一致），收敛了一处既有的流式/非流式不一致。仅 `sanitizeToolNames:true`+被清洗的 decode-target tool 这一极窄角可观测（默认 decode-target `AskUserQuestion` 名干净，不触发）；golden 用干净名，两序字节等价。
- [x] **Step 3: driver `runResponseWhole` 跑链 + handler 去内联** — 新增独立 `driver.runResponseWhole(response, env)`（按 `assembleResponseRewrites` 升序跑各 `transformWhole`），**未折进 `runResponseNonStreaming`**：handler 需保留 codec-render 后的 upstream-原始 `response` 给 `complete`、把 rewritten `finalResponse` 给 `setForwardedResponse`/`c.json`。`renderNonStreamingV4` 只剩 marker（`prependMarkerToResponse`，不进 registry）+ 调 `runResponseWhole`。
- [x] **Step 4: 跑非流式 golden + 全套 + Step5 typecheck/eslint/subagent/Commit** — golden 10/10 pass；全 offline 2797 pass（唯一 fail `file-sink.unit.test.ts` 是无关 `/tmp` ENOTDIR 环境问题，与本改动无 import 关系，pre-existing）；typecheck+eslint 绿；subagent 对抗 review 无 CRITICAL/HIGH（逐条实测核验顺序/gating/marker/commute）。**遗留（deferred，不在 A.B 范围）**：web_search 双跳 `[bypass]`（`handler.ts` 的 `handleDirectAnthropicNonStreamingResponse`）仍用旧序 `filter→recover→restore→decode`——它是 legacy 子树、自有 ctx、不建 driver，待 web_search 迁 driver（P2.6-D1）时随之收敛；当前与主路径仅在上述极窄角分歧。

---

## Task 6 — A.C WS + Responses 逐帧改写覆盖

**Files:**
- Create: `src/lib/codec/openai-responses-rewrites.ts`（`fixStreamEventIds`/`restoreResponsesEventToolNames` 包成 ResponseRewrite，appliesTo: openai-responses）
- Modify: `src/lib/pipeline/rewrite-registry.ts`（填 Responses 部分）+ `src/routes/responses/handler-v4.ts` + `src/routes/responses/ws.ts`（去内联，driver S5 跑）
- Test: 重跑 `responses-v4.http.test.ts` + `responses-ws.http.test.ts` golden（先 Task0 式预捕获 Responses/WS 激活态）

**为什么 WS 一并：** RFC §4.C——WS 消费同一 `driver.runResponse`，Responses 逐帧改写进 registry 后 HTTP+WS 都受益。WS/HTTP 写出层仍 handler-side（Stage B 统一）。

- [x] **Step 1: 预捕获 Responses + WS 激活态 golden**（fixStreamEventIds id 映射、tool-name restore）。HTTP fixIds 已有 `responses-v4.http.test.ts:229`（direct .done id 校正）锁；WS fixIds 此前无覆盖，本 phase **新增** `responses-ws.http.test.ts` 的 "stream-id-sync over WS" 测试锁住共享-registry 收益（WS 经同一 S5 registry 拿到 fixIds）。
- [x] **Step 2: 包 Responses ResponseRewrite + 填 registry** — 新建 `src/lib/codec/openai-responses-rewrites.ts`：`fixStreamIdsRewrite`（ResponseRewrite，`createState` 持 `StreamIdTracker` 跨帧，`appliesTo` = openai-responses + `targetEndpoint===RESPONSES`(direct) + `state.fixResponsesStreamIds`）+ `RESPONSES_RESPONSE_REWRITES`。**裁决（实测）**：只有 fixIds 进 registry，**restore 不进**——driver S5 在 `renderResponse`(S6) **之前**跑，direct 的 renderResponse=identity（S5 帧=Responses），但 fallback 的 renderResponse=CC→Responses 翻译（S5 帧=CC），restore 进 S5 会在 fallback 静默 no-op（CC 帧无 Responses 事件类型）→ 名字还原丢失。且 accumulator 读 `event.item.id`（dedup）+ `event.item.name`，accumulate 必须在 fixIds 之后、restore 之前。故 fixIds→S5（accumulate 看已修复帧，dedup 保持），restore 留 handler-side（forwarded-only、post-accumulate、作用于 render 后帧）。用户拍板"不纠结逐字节、要长远对的设计"——这正是长远对的形状（restore 留 handler 是 fallback 正确性约束，非字节洁癖）。
- [x] **Step 3: handler-v4 + ws.ts 去内联** — 两处 `forwardFrame`/`forwardWsFrame` 删掉 inline `idTracker`+`fixStreamEventIds`（driver S5 跑），accumulate 改在 driver-yielded(已修复)帧上；两处重复的 restore 函数 dedup 成共享 `restoreResponsesStreamFrameToolNames`（`tool-name-sanitize.ts`）。WS `forwardWsFrame` 去掉无用的 `rawEvent` 形参。
- [x] **Step 4: 跑 Responses + WS golden + 全套 + Step5 typecheck/eslint/subagent/Commit** — 231 responses 测试绿（含 fixIds direct + 新 WS fixIds）；WS 套件连跑 15×/15 clean（连接时序无 flaky）；全 offline 2798 pass（唯一 fail `file-sink.unit.test.ts` 同 A.B，无关 `/tmp` ENOTDIR）；typecheck+eslint 绿；subagent 对抗 review 无 CRITICAL/HIGH（核 fixIds direct-only/tracker 生命周期/accumulate 看修复帧/restore post-accumulate/HTTP-WS 共享同一 registry/[DONE] no-op/fallback closing 旁路），唯一 gap=3 处陈旧 docstring 已回填。

---

## Stage A 收尾

- [x] 更新 `docs/v4/05-progress.md`：标 Stage A 各 deferred item 处置（P2.4-D2 解决、P2.1-M2 解决）；记 Stage A 出口状态。
- [x] 更新 RFC §5/§10：A 已落地，**重走 OQ1**——用户 2026-06-21 裁决 **GO**（启动 Stage B，价值观"长远架构正确 > 字节代价"覆盖 reviewer 的 ROI 保守判断）；实施计划见 `stage-b-plan.md`。
- [x] 全套最终 subagent review（多视角）+ 全 backend 绿。（Phase 7 audit：死代码=0、三 home 边界成立；golden 34 pass；全 backend 2798 pass，唯一 fail 为无关 file-sink ENOTDIR）

---

## Self-Review（spec 覆盖核对）

- **RFC §4.0 原子迁** → Task 4 ✓
- **RFC §4.0.5 flushChain-finally** → Task 1 ✓
- **RFC §4.A0 请求侧** → Task 2 ✓
- **RFC §4.A1 forwardToClient 拆解 + 映射/双buffer契约** → Task 3 + Task 4 ✓
- **RFC §3.1 transformWhole / §4.B 非流式** → Task 5 ✓
- **RFC §4.C WS** → Task 6 ✓
- **RFC §7 golden 激活态清单** → Task 0（+ 各任务 Step1 预捕获）✓
- **RFC §3.1 marker 出 registry** → Task 5 Step3（marker 仍 prependMarkerToResponse）✓
- **Stage B** → 不在本计划（A 后重走 OQ1）✓
- 类型一致性：`ResponseRewrite.transformWhole?` 在 Task 5 定义、Task 5 实现，无前后签名漂移 ✓
