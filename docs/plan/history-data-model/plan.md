# History 数据模型重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 history 记录的 `inbound/outbound/wire/effective` 命名坐标系重构为 client/upstream 双腿 + 逐 attempt 上游轨，分离「attempt 成败 / entry 客户端结局」两条正交轴，`clientResponse` 提为一等公民。

**Architecture:** 目标结构见 [RFC §3](../../rfc/2026-07-07-history-data-model-restructure.md)。存储读路径本就是反投影（顶层 leg 不单独落库）；改动集中在 type 表面 + serialize 写路径 + 生产者（`context/request.ts` + `observability/sinks/history.ts`）+ 消费者。承重风险：`fail()`/`abort()` 生产者与 `complete()` 不对称——**生产者对齐（P2.5）必须严格前置于 consumer re-point（P2.6）**。

**Tech Stack:** TypeScript / Bun / bun:sqlite / zstd blob / Umzug 迁移。前端 ui-v4（React）+ ui（Vue）经 `~backend/*` re-export 后端类型。

## Global Constraints

- **命名定稿（不可改）**：`clientRequest` / `clientResponse` / `effectiveSource` / `upstreamRequest` / `upstreamResponse` / `model{}` / `_index.{derived,aux}`。
- **无向后兼容负担**：可强制迁移旧→新；但过渡 commit 每步终态不半破碎（RFC §6 invariant ①③）。
- **golden 硬 gate**：`EntryRow` 逐列等价（invariant ②）、`assembleFullEntry` 结构等价、`rewrites-req` 索引等价——P0 在旧代码预捕获。
- **不建 aspirational 空槽**：`model.capabilities`、raw upstream model 本计划**不实现**（RFC §5 future enrichment）。
- **红线**：见 [README §通用红线](README.md#通用红线各-phase-引用不在-prompt-里重复)。

> **实施状态总览（2026-07-07，已完成）**：全计划落地于分支 `history-data-model`，commit 范围 `a87b2aa2..18b70f6e`。P0（golden 预捕获）/ P1（新 type 并存）/ P2（serialize 新 stage）/ P2.5（生产者对齐 fail/abort 写 final attempt）/ P2.6（consumer re-point）/ P3（clientResponse 捕获）/ P4a-c（消费者迁移 + 删旧 leg 写路径 + Group-A 标量下沉 `_index.derived` + 读适配器 `adaptLegacyLegsInPlace`）全绿。**Group-B 标量**（requestBytes/responseBytes/multiplier/warningMessages）暂留 `HistoryEntry` 顶层列支撑/扁平，迁 `_index.aux`/`model.multiplier` 入 `docs/todo/deferred-backlog.md`。P5（本 doc-sync + golden 回归收尾）见文末。各阶段执行报告见 `/tmp/hdm-P*`。

---

## Factory / 锚点表

实现以本表为准（评审期核准的最新 `file:line`）。

### 生产者 —— `src/lib/context/request.ts`
| 符号 | 行 | 作用 / 改动 |
|---|---|---|
| `legFromEffective(ep)` | :76 | effective → `HistoryEntryData.effectiveRequest`（旧）。P1 新增 `legFromEffectiveSource`。 |
| `legFromWire(wp)` | :87 | wire → `outboundRequest`（旧）。P1 新增 `legFromUpstreamRequest`（补 messages 投影）。 |
| `synthesizeAttemptErrorResponse(a)` | :116 | mid-attempt 失败合成 response。**P2.5 复用**：fail/abort 走同款合成写 final attempt。 |
| `setAttemptResponse(response)` | :442 | 写 `attempt.response`。**P2.5 承重**：fail/abort 须调它。 |
| `complete()` | :515 | 调 `setAttemptResponse`（对称范本）。 |
| `fail(model,error,partial,opts)` | :529（`_response=` :541/:550） | **P2.5：增 `ctx.setAttemptResponse(_response)`**。 |
| `abort(model,partial)` | :593（`_response=` :602） | **P2.5：增 `ctx.setAttemptResponse(_response)`**。 |
| `toHistoryEntry()` | :617（顶层 leg :687/:692、per-attempt :714/:715、`response ?? synth` :720、`currentStrategy` :634） | P2.6 顶层 leg 改由 attempts[final] 派生；P4 删旧顶层字段。 |

### 写入方 —— `src/lib/observability/sinks/history.ts`
| 符号 | 行 | 作用 / 改动 |
|---|---|---|
| import `legFromEffective/legFromWire` | :40-41 | P1/P4 换新 leg builder。 |
| **`collectAttemptStages(ctx)`** | **:297（eager 写路径调用点 :209）** | **第二条 stage 生产路径（in-flight/eager，per-attempt）——P2 必须与 `extractStagePayloads` 同步落新 stage，否则 eager/interrupted 行与 finalized 行 stage 形状分叉（违 `partitionStagesForWrite` 不变量）。P2 Step 1 测试须覆盖 eager 路径。** |
| `responseDataToHistory(r)` | :312（塑 `outboundResponse` 含 rawBody/status） | P2/P4 → 塑 `upstreamResponse`（success/status/rawBody 已在此）。 |
| `toHistoryResponse(entryData)` | :307 | P4 → `upstreamResponse`。 |
| `toHistoryAttempts(attempts)` | :331 | P4 → 逐 attempt leg（effectiveSource/upstreamRequest/upstreamResponse）。 |
| 组装 `outboundResponse: response`（onTerminal） | :248 | P2/P4 → `attempts[].upstreamResponse`。 |
| `inboundResponse` | :258 | P4 → `clientResponse`。 |
| `effectiveRequest{model,format,messageCount,messages}` | :260-265 | P1/P4 → `effectiveSource`（保结构化投影）。 |
| **invariant ④ 三处同步点** | `toHistoryEntry`（request.ts:617）+ onTerminal 投影（history.ts:238）+ `updateEntry` Pick allowlist（entries.ts:77-80） | 新增 `_index.derived` 顶层派生字段时**三处都要动**（skill `persistence-async-invariants`）。 |

### serialize —— `src/lib/history/sqlite/serialize.ts`
| 符号 | 行 | 改动 |
|---|---|---|
| `STAGE_TOP_KEYS` | :145 | P2 增 `clientRequest/clientResponse`，调整 stage 剥离。 |
| `ATTEMPT_BODY_KEYS` | :147 | P2 增 `upstreamResponse` 子键。 |
| `deriveRequestBytes` | :173 | P2.6 → 读 `attempts[final].upstreamRequest.body`/`effectiveSource.body`。 |
| `deriveResponseBytes` | :184 | P2.6 → 读 `attempts[final].upstreamResponse.{sseEvents,rawBody,body}`。 |
| `buildHeadRow` | :214（列派生 :215-256） | P2.6 → 索引列改从 `attempts[final].upstreamResponse` 派生。 |
| `assembleFullEntry` | :313（读侧反投影 :364-377） | P2 新 stage 组装；反投影改为新结构。 |
| `extractStagePayloads` | :486（final-attempt slot 写侧 :508-518） | P2 落新 stage（clientResponse / upstreamResponse 富字段）。 |
| `partitionStagesForWrite` | :443 | request_group 去重维持。 |
| **serialize 内 `inboundRequest` 直读点** | `buildHeadRow` :223/:241、`extractStagePayloads` :489、`deserializeEntry` :296 | **P4 删旧时重指 `clientRequest`/`model.requested`**（P4 grep gate 兜底，但此处预锚）。 |

### 消费者（P4 迁移，完整 62 文件见 RFC §7.4）
| 文件 | 锚点 | 改动 |
|---|---|---|
| `src/lib/history/sqlite/search-index-write.ts` | `buildRewritesReq` :137（读 `outboundRequest?.messages` :139）、`buildRewritesResp` :173（`sseEvents` :174 / `inboundResponse.sseEvents` :175 / `outboundResponse.content` :181） | → `attempts[final].upstreamRequest.messages` / `.upstreamResponse.sseEvents` / `clientResponse.sseEvents`。**golden 锁 rewrites-req**。 |
| `src/lib/history/stats.ts` | :43 model、:46-49 usage+`success===true/false`、:99-102 CSV | → `attempts.at(-1).upstreamResponse.{model,usage,success}` 或 `_index.derived`。 |
| `src/lib/history/queries.ts` | :65-66 success 过滤 | → `_index.derived.responseSuccess`。 |
| `src/lib/history/in-flight.ts` | `toEntrySummary` :136（attemptCount :151 / currentStrategy :152） | → `_index.derived.{attemptCount,currentStrategy}`。 |
| `src/lib/observability/telemetry-dimensions.ts` | :161 model 维度 | → `model.resolved ?? model.requested`。 |
| ui-v4 detail segments / ui detail composables | — | 渲染新结构（见 RFC §7.4 清单）。 |

### codec sampleRequest（effectiveSource/upstreamRequest 数据源）
| codec | sampleRequest | 备注 |
|---|---|---|
| anthropic | `codec.ts:227`（`sampleAnthropicRequest` :451） | P1 产出改填 `effectiveSource`/`upstreamRequest`（含 format）。 |
| openai-cc | `codec.ts:231` | 同上；env.body=CC。 |
| openai-responses | `codec.ts:262` | 同上。 |
| openai-gemini | `codec.ts:203` | **env.body 已是 CC**（`effectiveSource.format='cc'`，RFC §2.3）。 |

---

## P0 — golden 预捕获（在旧代码上锁行为）

> **实施状态**：已落地。三 golden（`entryRowSnapshot`/`assembledStructureSnapshot`/`rewritesReqSnapshot`）在 `tests/history/restructure-golden.it.test.ts` 锁定；`entryRowSnapshot`/`rewritesReqSnapshot` baked 值经全程 P1-P4 逐字节不变（证无行为漂移），`assembledStructureSnapshot` 随新 stage 结构性更新。

**Files:** Create `tests/history/restructure-golden.it.test.ts`

**Interfaces:** Produces 三个 golden 快照函数供 P2.6/P4 复用：`entryRowSnapshot(entry)`、`assembledStructureSnapshot(row, stageRows)`、`rewritesReqSnapshot(entry)`。

- [ ] **Step 1**：写捕获测试——对代表性 fixture（1 成功流 / 1 失败 HTTP / 1 网络错误 / 1 aborted / 1 多-attempt 重试成功 / **1「proxy 实际改写了 messages」即 inbound≠outbound（B1-B12 触达，如 cache_control 注入或 memory 重写）**）跑**当前** `serializeHeadEntry` → 断言 `EntryRow` 逐列快照；跑 `assembleFullEntry` → 断言结构快照（stage 种类 + attempt 索引 + 顶层 leg 存在性）；跑 `buildRewritesReq` → 断言索引串。归一化易变字段（id/时间戳/durationMs）。**WARN-1 防空证：第 6 个 fixture 的 `rewritesReqSnapshot` 必须非空**（先证 `buildRewritesReq` 触达目标，否则 P4 丢 messages 投影时 golden 是 `""==""` 空证）。
- [ ] **Step 2**：`bun test tests/history/restructure-golden.it.test.ts` —— **在旧代码上必须全绿**（golden 锁定当前行为）。
- [ ] **Step 3**：commit `test: pre-capture golden for history restructure (EntryRow/assemble/rewrites-req)`。

**Gate:** 此三 golden 是 P2.6/P4 的硬 gate——改后须等价（allow 结构等价、字节 diff 仅结构字段）。

---

## P1 — 新 type 并存（RFC §3）

> **实施状态**：已落地（`ModelInfo`/`ClientRequestLeg`/`ClientResponseLeg`/`EffectiveSourceLeg`/`UpstreamRequestLeg`/`UpstreamResponseData`/`IndexProjection` 于 `src/lib/history/types.ts`；旧 leg 字段已在 P4c-3 从 `HistoryEntry` 删除，仅 live `RequestContext`/`Attempt` 保留旧名 + 读适配器 scratch view 用旧名读旧行）。

**Files:** Modify `src/lib/history/types.ts`、`src/lib/context/types.ts`（`HistoryEntryData`）；新增 leg builder 于 `src/lib/context/request.ts`。

**Interfaces:** Produces `HistoryEntry` 新字段（`clientRequest/clientResponse/model{}/attempts[].{effectiveSource,upstreamRequest,upstreamResponse}/_index`），旧字段（`inboundRequest/effectiveRequest/outboundRequest/outboundResponse/inboundResponse/sseEvents/attempts[].{effectiveRequest,wireRequest,response}`）**保留为 deprecated 别名**。

- [ ] **Step 1**：按 RFC §3 结构 + §4 映射，在 `types.ts` 新增全部新字段（`upstreamResponse` 含 `success`/`status?`/`trailers?`/`rawBody?`/`sseEvents?` + usage 等；`upstreamRequest` 含 `format?/model?/messages?/system?/headers/body`；`effectiveSource` 含 `format?/model?/messageCount?/messages?/system?/body/pipeline?`；`clientResponse.status?`；`_index.{derived,aux}`）。旧字段加 `/** @deprecated 迁移中，见 RFC §4 */`。
- [ ] **Step 2**：`bun run typecheck` —— 新旧并存应绿（新字段全 optional 或与旧并列）。
- [ ] **Step 3**：新增 `legFromEffectiveSource(ep)` / `legFromUpstreamRequest(wp)`（`request.ts`，复制 :76/:87 并**给 upstreamRequest 补 `messages/model/system` 投影**）。
- [ ] **Step 4**：`bun run typecheck` 绿。
- [ ] **Step 5**：commit `feat(history): add client/upstream leg types alongside deprecated legacy fields`。

**Commit invariant:** typecheck 绿、旧字段仍可读（并存）。

---

## P2 — serialize/assemble 新 stage 语义

> **实施状态**：已落地（`STAGE` 增 `client_request`/`client_response`/`effective_source`/`upstream_request`/`upstream_response`；`extractStagePayloads`/`assembleFullEntry`/`collectAttemptStages` 落新 stage；eager 与 finalized 路径 stage 形状一致）。

**Files:** Modify `src/lib/history/sqlite/serialize.ts`、`src/lib/observability/sinks/history.ts`；Test `tests/history/persistence.it.test.ts`（扩）。

**Interfaces:** Consumes P1 类型。Produces 新 stage 落库：`clientResponse` 独立 stage、上游帧统一进 `attempts[i].upstreamResponse.sseEvents`、`upstreamResponse` 富字段（success/trailers/rawBody）落 stage、`upstreamRequest.messages` 投影落 stage。

- [ ] **Step 1**：写测试——一个含 clientResponse + 2 attempt（1 失败带 sseEvents + 1 成功）的 entry 经 `extractStagePayloads` → `assembleFullEntry` 往返，断言：上游帧在 `attempts[i].upstreamResponse.sseEvents`（非顶层）、`upstreamRequest.messages` 保留、`upstreamResponse.success/trailers/rawBody` 保留。**+ eager 路径断言（FAIL-1）**：模拟 in-flight `field==="attempts"` 触发 `collectAttemptStages` → 断其产出的 stage 形状与 finalized `extractStagePayloads` **一致**（否则 eager/interrupted 行分叉）。
- [ ] **Step 2**：`bun test …persistence…` 见新测试 FAIL。
- [ ] **Step 3**：改 `extractStagePayloads`（:486）落新 stage；`assembleFullEntry`（:313）组装新结构；`STAGE_TOP_KEYS`/`ATTEMPT_BODY_KEYS`（:145/:147）纳入新键。**同步改 `collectAttemptStages`（history.ts:297）+ `responseDataToHistory`（:312）产同款新 stage 形状（FAIL-1）**。sink（`history.ts` :248-265）从 `HistoryEntryData` 组装新 leg（用新 builder）。
- [ ] **Step 4**：新测试 + P0 golden 的 `assembledStructureSnapshot` 全绿（结构等价——新增字段允许，既有不丢）。
- [ ] **Step 5**：commit `feat(history): serialize/assemble client/upstream leg stages`。

**Commit invariant:** ③ legacy 单-blob 行 + 新 stage 行 assemble 输出等价（旧 fixture 仍过）。

---

## P2.5 — 生产者对齐（**承重、严格串行、P2.6 前置**）

> **实施状态**：已落地（`fail()`/`abort()` 单点调 `setAttemptResponse`，final settled attempt 恒载裁决，与 `complete()` 对称；覆盖 `upstreamSucceeded:true` 诚实腿与 HTTPError 富化两支）。

**Files:** Modify `src/lib/context/request.ts`（`fail`/`abort`）；Test `tests/context/request-context.unit.test.ts`。

**Interfaces:** Produces `fail()`/`abort()` 后 `attempts[last].response`（→新 `upstreamResponse`）**恒载裁决**（与 `complete()` 对称），使 P2.6 的 `attempts[final]` 派生对失败/中止条目成立。

- [ ] **Step 1**：写测试——`ctx.fail(model, new HTTPError("x",400,"body"))` 后，`ctx.toHistoryEntry()` 的 `attempts.at(-1)?.response`（现状）应 == 裁决（success:false/error/status:400/model），而非 undefined。同款 `abort` 测试；同款 `fail(...,{upstreamSucceeded:true})` 断 `success:true` 且无 error。
- [ ] **Step 2**：`bun test …request-context…` 见 FAIL（现状 fail/abort 不写 attempt）。
- [ ] **Step 3**：在 `fail()` 里 **else 分支关闭后（:574 之后）、`ctx.transition("failed")`（:581）之前** 单点加 `ctx.setAttemptResponse(_response)`——此位置**同时覆盖 `if(upstreamSucceeded)`（:535-548，success:true 诚实腿）与 else（:550-573，含 HTTPError 富化）两支**（WARN-3：`:559 后`落在 else 内、漏 upstreamSucceeded 腿）。`abort()` 在 `:609 后`（单分支）加同款。确认 `settled` 守卫下不重复。
- [ ] **Step 4**：`bun test …request-context…` + 全 `tests/history` 绿；连跑 3× 确认确定性（settle 快照时序）。
- [ ] **Step 5**：commit `fix(history): fail()/abort() populate final attempt response (symmetric with complete)`。

**Commit invariant:** ① 全绿；② 尚未 re-point 消费者，故顶层 leg 仍在、行为不变（本 commit 纯增写 attempt、不删顶层）——**过渡态显式无害**。

---

## P2.6 — consumer re-point（依赖 P2.5）

> **实施状态**：已落地（`buildHeadRow`/`deriveRequestBytes`/`deriveResponseBytes` 重指 `attempts[final]` 的 upstreamRequest/upstreamResponse；P0 golden `entryRowSnapshot` 逐列等价证无回归）。

**Files:** Modify `src/lib/history/sqlite/serialize.ts`（`buildHeadRow`/`deriveBytes`）、`src/lib/context/request.ts`（`toHistoryEntry` 顶层 leg 派生）；Test P0 golden。

**Interfaces:** Consumes P2.5（final attempt 恒载裁决）。Produces `buildHeadRow`/`deriveBytes`/顶层 leg 全部从 `attempts[final]` 派生。

- [ ] **Step 1**：改 `buildHeadRow`（:215-256）——`usage/model/stop_reason/error` 改读 `attempts.at(-1)?.upstreamResponse?.…`（回落 `inboundRequest.model` 保留）；`deriveRequestBytes`（:173）读 `attempts[final].upstreamRequest.body ?? effectiveSource.body`；`deriveResponseBytes`（:184）读 `attempts[final].upstreamResponse.{sseEvents,rawBody,body}`。
- [ ] **Step 2**：跑 P0 golden `entryRowSnapshot` —— **`EntryRow` 逐列等价**（invariant ②，依赖 P2.5 已让失败/中止条目的 final attempt 有裁决）。
- [ ] **Step 3**：改 `toHistoryEntry` 顶层 leg 派生（:687/:692）改从 attempts[final]（或保留投影供过渡）。
- [ ] **Step 4**：全 `tests/history` + golden 绿；对 5 类 fixture（成功/失败/网络错误/aborted/多-attempt）逐列核 EntryRow。
- [ ] **Step 5**：commit `refactor(history): re-point index columns + byte derivation to attempts[final]`。

**Commit invariant:** ② `EntryRow` 逐列等价（golden 硬 gate）。

---

## P3 — clientResponse 捕获（可与 P2.x 并行，不同文件）

> **实施状态**：已落地（`clientResponse.status`/`headers`/`body`/`sseEvents` 在转发边界捕获；`status?` optional，legacy 行缺省 undefined）。

**Files:** Modify transport/route 层（clientResponse.status 捕获点——实现者先 grep 客户端 `Response` 构造点：`src/routes/*/handler-v4.ts` 返回 status / `src/lib/pipeline/client-sink.ts`）；Test 相应 http test。

**Interfaces:** Produces `clientResponse.status`（转发给客户端的 HTTP status）+ `clientResponse.body`（已有 `inboundResponse.content` → 迁移）。

- [ ] **Step 1**：定位客户端 `Response` status 来源（route handler 的 `c.json(...,status)` / stream 200）。写测试断 `clientResponse.status` 在成功 200 与失败转发时被捕获。
- [ ] **Step 2**：跑测试见 FAIL（现无捕获点）。
- [ ] **Step 3**：在转发点写 `ctx.setClientResponseStatus(status)`（新 setter，`request.ts`）。`status?` optional，legacy 行反序列化缺省 undefined。
- [ ] **Step 4**：测试绿。
- [ ] **Step 5**：commit `feat(history): capture clientResponse.status at forward boundary`。

---

## P4 — 消费者迁移 + 删旧顶层（依赖 P2.6 + P3）

> **实施状态（2026-07-07）**：P4a（后端读侧）/ P4b（前端）/ P4c-1（producer 补全）/ P4c-2（读时适配器）已落地（各阶段报告见 `/tmp/hdm-P4*`）。**P4c-3（删旧 leg 写路径 + Group-A 标量）已完成**——按 coordinator 决策 option 1（prepared-only）：删 legacy leg 字段 + `attemptCount`/`currentStrategy`/`failureReason`（Group-A，`_index.derived` 支撑），**保留** `requestBytes`/`responseBytes`/`multiplier`/`warningMessages`（Group-B，列支撑/扁平运营字段，`_index.aux`/`model.multiplier` 迁移入 backlog 独立跟进，见 `docs/todo/deferred-backlog.md`）。读适配器 `adaptLegacyLegsInPlace` 保留（改从 serialize 内部 `LegacyEntryView`/`LegacyAttemptView` scratch 读旧 stage）。golden `entryRowSnapshot`/`rewritesReqSnapshot` baked 值逐字节不变（证删旧无行为漂移），`assembledStructureSnapshot` 结构性更新。全绿：backend 3720 pass / typecheck（+:ui/:ui-v4）/ build:ui/:ui-v4 / grep 收敛。附带修复：单-blob usage-normalize backfill 净化 per-attempt `response.usage`（读适配器现经 `upstreamResponse.usage` 呈现）、Phase-5 in-flight header 镜像重指 client 腿、tombstone stage 过滤重指 `client_request`/`upstream_response`、barrel 导出新腿类型、clientResponse.headers 接线。

**Files:** 见 Factory 表消费者段 + RFC §7.4 全 62 文件。**分组并行**：(a) 后端读侧（search-index / stats / queries / in-flight / telemetry），(b) 前端（ui-v4 segments / ui composables），(c) 删旧顶层字段 + 投影逻辑（最后）。

**Interfaces:** Consumes 新结构全绿。Produces 零旧字段引用。

- [x] **Step 1（rewrites-req，golden 锁）**：`buildRewritesReq`（search-index-write.ts:139）改读 `attempts.at(-1)?.upstreamRequest?.messages`；`buildRewritesResp`（:174-181）改读 `attempts[final].upstreamResponse.sseEvents` / `clientResponse.sseEvents` / `attempts[final].upstreamResponse.body`。跑 P0 golden `rewritesReqSnapshot` 等价。
- [x] **Step 2**：迁 stats/queries/in-flight/telemetry（Factory 表锚点）→ `_index.derived` / `attempts.at(-1)` / `model.resolved`。各自单测绿。**+ 生产者侧变换（WARN-4，`toHistoryEntry` attempts 映射 :705-723 + sink）**：① `attempts[].startedAt?`/`waitMs?` 新捕获（`beginAttempt` 已存 `startTime`/`waitMs` :403-404，但当前不输出——补进 attempts 映射）；② `attempts[].{truncation,sanitization}`（:712-713）→ `effectiveSource.pipeline`；③ 顶层 `pipelineInfo.{truncation,messageMapping}`/`entry.truncation`（:673）去顶层化 → `attempts[final].effectiveSource.pipeline`，`preprocessing` → entry 级。
- [x] **Step 3**：迁前端（ui-v4 detail segments、ui composables）。`bun run build:ui`（`~backend/*` 纯度 + rollup 暴露真错，skill `debugging-frontend-tests`）。
- [x] **Step 4（删旧）**：grep 收敛——src 残留仅：live `RequestContext`/`Attempt` 字段（context/types，未删）+ live `_httpHeaders` 捕获袋映射进新腿 + 新腿（upstreamResponse/clientResponse）+ per-attempt `sseEvents`（保留）+ usage-normalize backfill 读 legacy 存储 blob（历史行）+ serialize 内部 `LegacyEntryView` 适配器 scratch；均合法。删 types 旧 leg 字段 + Group-A 标量 + `toHistoryEntry`/sink 投影逻辑。typecheck 绿。
- [x] **Step 5**：全 `bun test`（3720 pass）+ golden + `build:ui`/`build:ui-v4` 绿。

**Commit invariant:** ② golden 全绿；grep 旧字段零代码残留（仅合法读适配器 scratch + live-context + 历史行 backfill）。

---

## P5 — doc-sync + golden 回归（收尾）

> **实施状态（2026-07-07，已完成）**：doc-sync + golden 回归全绿。updated `docs/DESIGN.md`（类型架构新增 History 数据模型子节 + 活的架构现状表 9+ 处 leg 名 + 请求流采样 + 响应腿数据模型 + HTTP header 捕获 + 遥测 thinking-block 源 + dry-run + 运行时选项表 7 处 history leg 引用）、`docs/history.md`（代理管线命名整节重写为 client/upstream 双腿 + stage 表 + 读适配 + eager/tombstone stage 名 + 暂缓项）、`.claude/skills/history-sqlite-schema/`（stage 名 + 读适配器 + dedup 成员）、RFC 头部标「已实施」、plan 各 phase 加实施状态注解。**附带**：跨文档 grep 发现并同步 5 个权威 on-demand skill 的旧 leg 陈述（telemetry-architecture 是真 doc-vs-code drift——model 维度 key 已迁 `model.resolved ?? model.requested`、persistence-async-invariants / ghc-anthropic-upstream / empirical-verification / history-backfill 的调试/oracle 指针）。残留 legacy 引用仅在 `docs/{spec,plan,archive}/*`（landed-state 记录 / 历史计划 / 归档，非当前架构叙述）与 live-context 字段名（`Attempt.{effectiveRequest,wireRequest,response}` 未重构，已显式标注）。**验证全绿**：backend `bun test` 3678 pass/1 skip/0 fail、`typecheck`（+:ui/:ui-v4）clean、`build:ui`/`build:ui-v4` exit 0、P0 golden 6 pass（18 snapshots）。

- [x] **Step 1**：更新 DESIGN.md 类型架构 + history.md leg 描述 + skill schema（stage 名/字段）。
- [x] **Step 2**：跨文档 grep 验证无 `inbound/outbound/wire/effective` leg 旧述残留（skill `session-closeout` 步②）——3 目标 doc + 5 权威 skill 清；spec/plan/archive 残留为 landed-state/历史记录（合法）。
- [x] **Step 3**：全 `bun test` + `bun run typecheck` + `build:ui`/`build:ui-v4` + P0 golden 终跑绿；RFC 头部标「已实施」。
- [x] **Step 4**：commit `docs(history): sync live docs to client/upstream data model`。

---

## Self-Review 检查

- **Spec 覆盖**：RFC §3 每字段 → P1 建 type、P2 落 stage、P4 迁消费者，全覆盖。§4 迁移表每行 → Factory 表锚点。§6 commit 序 → P1-P5 phase。§7 open questions 全已解（OQ1 实测 / OQ2-3 定 / OQ4→P4 / OQ5 命名定稿）。
- **承重项**：P2.5 前置 P2.6（DAG 红线）；rewrites-req golden（P0/P4）；`_index.derived` 三处同步（invariant ④，P4 Step 2 落实）。
- **类型一致**：leg 名跨 phase 一致（`upstreamRequest.messages` P1 建、P2 落 stage、P4 read）。
- **无 aspirational**：`model.capabilities`/raw upstream model 不在任何 task（RFC §5 future）。
