# Stage A — Phase Kick-off Prompts

每节是一个**可直接粘给独立实现者**的完整 kick-off prompt。设计稿见 [response-pipeline-driver-owned.md](./response-pipeline-driver-owned.md)（RFC），实现计划见 [response-pipeline-stage-a-plan.md](./response-pipeline-stage-a-plan.md)（master plan，含每 Task 的 TDD 步骤）。

## 阶段依赖 DAG（排实现者参考）

```
Task 0 (golden 基线) ──► 一切的前置(所有迁移的字节等价基准)
Task 2 (A0 请求侧)   ──► 独立、最低风险，可最先并行(OQ2:可独立先行)
Task 1 (flushChain-finally) ──► Task 3 ──► Task 4 (A1 原子迁) ──► Task 5 (A.B 非流式)   [Anthropic 响应链，严格串行]
Task 0 + Task 1 ──► Task 6 (A.C Responses/WS)   [非 buffer，与 Anthropic 链格式独立]
```

**并行边界**：Task 2（请求侧）、Anthropic 响应链（1→3→4→5）、Responses/WS（6）格式上独立可分派给不同实现者，但都**改共享文件** `rewrite-registry.ts`/`driver.ts`/`types.ts`——需协调合并顺序（建议 driver/types 的接口改动先合，registry 填充各格式分支后合）。Anthropic 响应链内部 1→3→4 **严格串行、不可并行**（byte-critical 顺序契约）。

---

## 通用红线（每个 phase 都遵守，复制进实现会话或依赖项目 CLAUDE.md）

1. **中文对话**回答与思考。
2. **绝不**未经同意 `git checkout/restore <file>`、`reset --hard`、`clean -f`、`rm` 工作区文件（不可逆，原则1）；删源文件用 `git rm`（无 -f 自保护）且仅在确认 committed-clean 时。
3. `git add`/本地 `commit` 允许；`push`/改写已推送历史/`gh pr` 需明确同意。**细粒度暂存**：`git add -- <精确路径>`，**绝不** `-A`/`-am`；提交前 `git diff --cached --stat` 复核仅含本次改动。
4. **不自动启服务器**（`bun run dev`/`start`）、不 `kill`/`pkill` 本项目进程。验证用 `bun run typecheck`、`bun run test:backend`、`bunx eslint --fix`（**不用 `prettier --write`**）。
5. **byte-critical 核心纪律**：每个迁移**先 golden-fixture-pre-capture**（在**改动前**的代码上锁字节，Task 0 已建基线 + 各 Task 自捕该 phase 场景），改后**逐字节 golden 等价是硬 gate**，diff 即 fail。流式/时序 fixture 连跑 10-25× 确认确定性。
6. **修复后必做 subagent 对抗 review**（多视角），并**亲自复核 reviewer 引用的每个 file:line**（原则6，不信声音权威）。**派 subagent 一律用全量工具类型**（`claude`/`general-purpose`，非 `ecc:architect` 受限），prompt 里写"只读"作行为约束但工具不设限。
7. 测试隔离：DI/fetch-mock，**不用 `mock.module`**；mutate 全局 state 用 `autoRestoreState()`；fs I/O 用注入临时目录，**绝不碰真实 `$HOME`/`~/.claude`**。
8. 不使用分号、三元行首、`printWidth` 160；严格 TS、避免 `any`；同目录导入用相对路径；不删有意义的注释。
9. 不忽视既有错误（原则10）——遇到的所有 typecheck/test/import 错误都修。
10. 三大能力守卫每 commit 必过：`/history/api/entries/:id` 双轨、`/api/logs`+`/api/status` 形状、WS wire 协议不变。

## 通用必读（每个 phase 开场先读）

```
docs/rfc/response-pipeline-driver-owned.md   # RFC 设计稿(尤其 §3 接口 / §4 Stage A / §7 验证 / §8 deferred 关系)
docs/rfc/response-pipeline-stage-a-plan.md   # master plan(本 phase 对应 Task 的 TDD 步骤 + factory 锚点表)
docs/v4/05-progress.md                       # v4 deferred items(P3.2b-D1/P1.5-OQ1/P2.1-M2/P2.2-D1 是本重构的来由)
docs/DESIGN.md                               # v4 七阶段管线现状
```
实现前**复核 file:line**（代码会漂移）。

---

## Phase 0 — Golden 预捕获基线

我要实现响应管线 transform registry 激活（Stage A）的 **Task 0：激活态 golden 基线**。遵守上面通用红线 + 必读。

**背景**：v4 重构 P0-P3 已完成，driver 编排七阶段 + 各格式 codec 已在生产。现在 Stage A 要激活休眠的 `rewrite-registry`（`REQUEST_REWRITES`/`RESPONSE_REWRITES` 至今空），把散在 handler pump 的响应改写迁进 registry。这是 byte-critical 重构，**所有迁移的字节等价基准就是本 phase 建的 golden**。RFC §7 审计指出：现有 golden（`tests/anthropic/anthropic-v4.http.test.ts`）只锁了 ok/thinking 两条 **no-op-rewrite 透传流**，所有**激活态** byte-critical 路径零覆盖。

**目标**：在**当前（改动前）**的 handler-v4 路径上，新建 `tests/anthropic/response-rewrite-golden.http.test.ts`，逐字节锁定激活态场景（这些场景在后续每个迁移 commit 后重跑必须仍全绿）：
- `server_tool_use` block 流 → suppress + 后续块 index densify（核 `server-tool-filter.ts:102` createServerToolBlockFilter 的 index 重映射）
- AskUserQuestion tool_use 流（`decodeToolInputFields` 默认）→ buffer/flush mid-stream finalize
- 降级文本流（设 `recoverToolCallText: true`）→ CANDIDATE/COMMIT 合成 tool_use + **rollback**（candidate 被 content_block_start 打断吐 `[stopFrame, ...buffered]`）
- recover + decode 同激活 + 流末 → 双 flush 顺序
- recover × filter index 空间交互（recover 用 `maxUpstreamIndexSeen+k` + filter densify）
- 非流式各场景（server-tool 过滤、tool-input decode、name restore、recover）
- heartbeat ping 穿插场景用 0 间隔或 fake timer 隔离（避免逐字节比对 flaky）

**手法**：仿 P3.3a/P3 收尾——临时 `console.error("###CAP_*###"+JSON.stringify(text))` 跑一次抓真实字节 → 转 inline golden 常量 → 删临时打印（前向编辑，不用 git checkout）。mock/app 范式参照 `anthropic-v4.http.test.ts`。

**验收**：`bun test tests/anthropic/response-rewrite-golden.http.test.ts` 当前代码全绿（这是改前基线，PASS 即正确）；typecheck + eslint 绿。

**提交**：`git add -- tests/anthropic/response-rewrite-golden.http.test.ts && git commit -m "test(pipeline): Stage A Task0 激活态响应改写 golden 基线(改前锁字节)"`

---

## Phase 1 — flushChain 进 try/finally（H3 前置）

我要实现 Stage A 的 **Task 1：flushChain 进 try/finally**。遵守通用红线 + 必读。**前置**：Phase 0 golden 已建。

**背景 + 为什么**：RFC §4.0.5 + 审计核实——`src/lib/pipeline/driver.ts:284` 的 `flushChain` 在 `runResponse` 的 `for await` 之后但**不在 try/finally**，异常时不执行。Stage A 后续把 buffering rewrite（decode/recover）迁进 registry 后，**异常路径下 driver 的 buffer 既不被 driver flush（不在 finally）、handler 又拿不到 registry state → buffer 静默丢失**，客户端少收 tool_use 片段（破 H3，现状 handler-v4.ts:695-710 靠 handler 内 flush 兜底）。必须把此修复**前置**（generator 模型下即可做，当前 RESPONSE_REWRITES 空、行为 no-op）。

**目标**：`runResponse`（driver.ts）的 `for await` + `flushChain` 包进 `try { for await(...) } finally { for (const flushed of flushChain(...)) yield* renderFrames(...) }`，正常 + 异常两路都 drain registry buffer。**保持 P3.2b 的 upstreamSse 采样别名逻辑 + [DONE] skip 不变**。

**TDD**：`tests/pipeline/driver.unit.test.ts` 加测试——mock 一个 buffering ResponseRewrite（transform 返回 `{kind:"buffer"}`、flush 返回缓冲帧）+ 一个 N 帧后抛错的 upstream；断言异常**前** flush 的帧已 yield。先跑验证 FAIL（现状不在 finally），实现后 PASS。

**验收**：新测试 PASS + `bun test tests/pipeline/driver.unit.test.ts` 全绿 + Phase 0 golden 全绿（行为 no-op 应无变化）+ `bun run test:backend` 绿 + typecheck/eslint 绿 + subagent 核验"finally 里 yield 不破正常路径采样/forwarded 时序"。

**提交**：`git add -- src/lib/pipeline/driver.ts tests/pipeline/driver.unit.test.ts && git commit -m "fix(pipeline): Stage A Task1 flushChain 进 try/finally(H3 前置)"`

---

## Phase 2 — A0 请求侧 registry 激活

我要实现 Stage A 的 **Task 2（A0）：请求改写从 codec.parse 迁进 driver S3 registry**。遵守通用红线 + 必读。可独立先行（OQ2，最低风险）。

**背景 + 风险**：RFC §4.A0——`driver.ts:131` 的 `runRewriteIn` 跑空 `REQUEST_REWRITES`，真实 Anthropic 请求改写在 `codec.parse` 里调 `runAnthropicRequestRewrites`（`anthropic.ts` 内，约 :287）——driver S3 骨架空转、逻辑在 codec 的确凿割裂。**风险点**：codec.parse 现在还在 sanitize 时记 `setPipelineInfo`/`messageMapping`，迁到 S3 改变记录时机 → golden 必须覆盖**请求 history**（effectiveRequest + pipelineInfo + messageMapping）。**明确排除**：prepareWire 的 B1-B12（per-attempt + betaProbe 副作用，是正确的 PrepareStep）+ normalizeCallIds（P2.2-D1 卡在 strategy 接口）。

**目标**：把 `runAnthropicRequestRewrites`（request-rewrites.ts:150）包成 `RequestRewrite{name, order, appliesTo: env=>env.clientFormat==="anthropic", apply: env=>({env: env.with({body}), changed, stats})}` 填进 `REQUEST_REWRITES`；codec.parse 移除内联调用，依赖 driver S3。pipelineInfo/messageMapping 记录点（迁 apply 或留 codec.parse）**二选一需 golden 锁定哪个时机字节等价**——若迁移复杂，可先只迁 body 改写、记录时机暂留 codec（更小步）。

**TDD**：`tests/pipeline/request-rewrite-registry.it.test.ts` 新建——先捕获当前 codec.parse 路径的 `effectiveRequest.payload`+`pipelineInfo`+`messageMapping`（含 sanitize 实改场景：system-reminder 去除、tool-name fix、orphan 过滤）作基线；迁移后断言字节等价。

**验收**：请求 golden + Phase 0 响应 golden + `bun run test:backend`（anthropic 套件经 driver S3）全绿 + typecheck/eslint + subagent 核验"sanitize 记录时机迁移字节等价"。

**提交**：`git add -- src/lib/pipeline/rewrite-registry.ts src/lib/codec/anthropic.ts tests/pipeline/request-rewrite-registry.it.test.ts && git commit -m "feat(pipeline): Stage A Task2(A0) 请求改写迁进 driver S3 registry"`

---

## Phase 3 — flushChain 双 buffer 确定契约 + processEvent↔transform 映射

我要实现 Stage A 的 **Task 3：双 buffer 确定契约**。遵守通用红线 + 必读。**前置 Phase 4 的必要条件。**

**背景**：RFC §4.A1——Phase 4 同时注册 recover + decode 两个 buffering rewrite，触发 P2.1-M2（`flushChain` driver.ts:336 的"至多一个 buffering rewrite"假设失效）。先锁确定契约 + 适配规约。

**目标**：
1. `tests/pipeline/driver.unit.test.ts` 加 **buffer→buffer 链测试**：两个 buffering mock rewrite（order 100/200），断言升序 flush、rewrite[100] flushed 帧穿过 rewrite[200]（含其 buffer、复用同一 state 实例），与"recover.flush 输出喂 decode、decode 再 flush"（handler-v4.ts:655-663）同构。
2. **processEvent↔transform 映射测试**：锁规约——现有 recover/decode 用 `processEvent` 返回 `Array`，registry `transform` 返回 `FrameAction`：空 array→`suppress`、单帧→`emit{[f]}`、多帧→`emit{frames}`、buffer→`buffer`。
3. 更新 `flushChain` JSDoc：把单 buffer 假设替换为 §4.A1 确定契约文字（flush 严格 order 升序；flushed 帧必穿所有更大 order 的下游 rewrite 含其 buffer；跨 buffer 依赖编码进 order；禁回喂环）。

**验收**：测试 PASS（若现 flushChain 升序语义已满足直接锁契约；否则修 flushChain）+ typecheck/eslint + subagent review。

**提交**：`git add -- src/lib/pipeline/driver.ts tests/pipeline/driver.unit.test.ts && git commit -m "feat(pipeline): Stage A Task3 flushChain 双 buffer 确定契约 + processEvent↔transform 映射"`

---

## Phase 4 — A1 原子迁互依赖响应改写集（最 byte-critical）

我要实现 Stage A 的 **Task 4（A1）：原子迁 Anthropic 响应改写集**。遵守通用红线 + 必读。**前置 Phase 0/1/3 全部完成。这是 Stage A 最 byte-critical 的 commit。**

**背景 + 为什么原子**：RFC §4.0——recover/decode/filter 有硬顺序契约（`recover-tool-call/stream.ts:40` 明文"假设跑在 serverToolFilter 之前"），核实 `driver.ts:277` driver 先跑完整条 registry 链才 yield，故单迁中间态会**颠倒顺序**（filter 跑到 recover 上游）、只默认配置无害，一旦用户开 `recover_tool_call_text`+server_tool 就破字节。**故 recover(100)/thinking(150)/decode(200)/filter(300) 必须一个 commit 原子迁，中间态不存在。**

**目标**（factory 锚点见 master plan 表）：
1. 新建 `src/lib/codec/anthropic-response-rewrites.ts`：4 个 `ResponseRewrite` 包装，复用现有 factory（`createToolCallTextRecoverer`/`applyThinkingSignatureCompat`/`createToolInputStreamDecoder`/`createServerToolBlockFilter`），`createState` 持各 factory 闭包态，`transform` 用 Phase 3 映射规约适配，recover/decode 有 `flush`。
2. 拆 `streaming-pump.ts:248-280` 的 `forwardToClient`：filter 逻辑上移 registry；handler 留**简化版**"采 forwarded（driver 已应用 registry 链的帧）+ heartbeat noteRealFrame/写出"；suppress 帧不到 handler（passThrough suppress 不 yield）→ 不采不写，与现状等价。
3. 填 `RESPONSE_REWRITES` Anthropic 部分；`handler-v4.ts` 的 `processOneStreamEvent` 调用链去掉 recover/decode/filter/thinking（driver S5 跑）。

**验收（硬 gate）**：Phase 0 golden **逐字节等价**（`bun test tests/anthropic/response-rewrite-golden.http.test.ts` 全绿）+ `bun run test:backend` + 流式/时序 fixture **连跑 10-25× 确定性**。**≥2 个全量工具 subagent 对抗 review**（byte-safety + 顺序契约视角）+ 主线亲自核验每个 file:line（index densify、suppress 时机、双 flush 顺序、recover rollback）。

**提交**：`git add -- src/lib/codec/anthropic-response-rewrites.ts src/lib/pipeline/rewrite-registry.ts src/routes/messages/streaming-pump.ts src/routes/messages/handler-v4.ts && git commit -m "feat(pipeline): Stage A Task4(A1) 原子迁 Anthropic 响应改写集进 registry"`

---

## Phase 5 — A.B 非流式覆盖（transformWhole）

我要实现 Stage A 的 **Task 5（A.B）：非流式响应改写经 transformWhole 统一**。遵守通用红线 + 必读。**前置 Phase 4。**

**背景**：RFC §3.1+§4.B——现状各 `renderNonStreamingV4` 手写序列调 whole-response helper（`prependMarkerToResponse`→`filterServerToolBlocksFromResponse`→`recoverToolCallTextInResponse`→`restoreToolNamesInResponse`→`decodeToolInputBlocksInResponse`），与流式版同文件、同逻辑——"流式在 registry、非流式在 handler"的不对称。

**目标**：
1. `ResponseRewrite` 加 `transformWhole?(response, env): unknown`（`types.ts` + `rewrite-registry.ts`，RFC §3.1）。
2. `anthropic-response-rewrites.ts` 给 recover/decode/filter 实现 `transformWhole`（装载同文件 whole-response helper）。**核 OQ3**：非流式应用序（`renderNonStreamingV4` 现状）vs 流式 order 一致——不一致则核实等价或为非流式单独声明序。
3. driver `runResponseNonStreaming`（driver.ts:90）在 `codec.renderResponseNonStreaming` 后按同一 order 链跑各 rewrite 的 `transformWhole`；`handler-v4.ts` 的 `renderNonStreamingV4` 移除手写序列。marker 仍走 `prependMarkerToResponse`（**不进 registry**，RFC §3.1）。

**验收**：非流式 golden（Phase 0 含）+ 全套 + typecheck/eslint + subagent review。

**提交**：`git add -- src/lib/pipeline/types.ts src/lib/pipeline/rewrite-registry.ts src/lib/codec/anthropic-response-rewrites.ts src/lib/pipeline/driver.ts src/routes/messages/handler-v4.ts && git commit -m "feat(pipeline): Stage A Task5(A.B) 非流式响应改写经 transformWhole 统一进 registry"`

---

## Phase 6 — A.C Responses 逐帧改写 + WS 覆盖

我要实现 Stage A 的 **Task 6（A.C）：Responses 逐帧改写进 registry（HTTP+WS 共享）**。遵守通用红线 + 必读。**前置 Phase 0（需先预捕获 Responses/WS 激活态 golden）+ Phase 1。** 与 Anthropic 链格式独立。

**背景**：RFC §4.C——WS（`responses/ws.ts`）消费同一 `driver.runResponse`（同 Responses HTTP）。把 Responses 逐帧改写（`fixStreamEventIds`/`restoreResponsesEventToolNames`，非 buffer）进 registry 后 **HTTP+WS 都自动受益**。WS/HTTP 写出层仍 handler-side（Stage B 统一）。

**目标**：
1. 先 Phase 0 式预捕获 Responses + WS 激活态 golden（fixStreamEventIds id 映射、tool-name restore），加进 `responses-v4.http.test.ts` / `responses-ws.http.test.ts`。
2. 新建 `src/lib/codec/openai-responses-rewrites.ts`：`fixStreamEventIds`（仅直连、跨帧 id state）+ `restoreResponsesEventToolNames`（逐帧）包成 `ResponseRewrite`，`appliesTo: env=>env.clientFormat==="openai-responses"`。
3. 填 `RESPONSE_REWRITES` Responses 部分；`handler-v4.ts` 的 `forwardFrame`（HTTP）+ `ws.ts` 的 `forwardWsFrame`（WS）去掉 fixIds/restore（driver S5 跑），只留采样 + 写出。

**验收**：Responses + WS golden + 全套 + typecheck/eslint + subagent review（核 fixStreamEventIds 跨帧 id state 进 registry RewriteState 字节等价）。

**提交**：`git add -- src/lib/codec/openai-responses-rewrites.ts src/lib/pipeline/rewrite-registry.ts src/routes/responses/handler-v4.ts src/routes/responses/ws.ts tests/responses/responses-v4.http.test.ts tests/responses/responses-ws.http.test.ts && git commit -m "feat(pipeline): Stage A Task6(A.C) Responses 逐帧改写进 registry(HTTP+WS 共享)"`

---

## Phase 7 — Stage A 收尾 + 重走 OQ1

我要做 Stage A **收尾**。遵守通用红线 + 必读。**前置 Phase 0-6 全部完成。**

**目标**：
1. 更新 `docs/v4/05-progress.md`：标 Stage A 各 deferred item 处置（P2.4-D2 解决、P2.1-M2 解决）；记 Stage A 出口状态（请求+响应+非流式+WS 改写全经 registry、新增拦截/修复=注册一个 ResponseRewrite）。
2. 更新 RFC `response-pipeline-driver-owned.md` §5/§10：A 已落地，**重走 OQ1**——拿真实体验诚实评估 Stage B（driver-owned-writeout）的增量是否值 byte-critical 代价，把评估带回用户定夺（不默认执行）。
3. 全套最终 subagent review（factual/senior-engineer/security/consistency 多视角，全量工具）+ 全 backend 绿。
4. 提炼可复用教训进 memory（registry 激活的 byte-critical 手法、原子迁互依赖集的纪律等）。

**提交**：文档同步 commit（细粒度暂存各 doc）。
