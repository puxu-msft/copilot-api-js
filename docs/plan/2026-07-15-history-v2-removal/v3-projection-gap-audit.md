# History V3 Projection 字段级完备性审计（V2-removal D 步前置）

状态：**审计完成，待用户裁决执行授权**。只读分析，未改任何代码。
分支 `feat/history-v2-removal` @ `4cc27b24`（只读）。作者：architect-advisor（Claude）。

## 0. 结论速览（TL;DR）

- Phase 1 报告的 5 个字段缺口（queueWaitMs / warningMessages / pipelineInfo / attempts[].responseHeaders+rawBody / effectiveSource.messageCount）**已全部证实为真缺口**，但**远不止 5 个**——系统性逐字段核对 `HistoryEntry` vs `recordToHistoryEntry` 发现 **20+ 个投影缺口**，分两类根因。
- 报告把 4 个「streaming 时序类」失败标为「根因未查明、疑似异步竞态」。**本审计静态定位到确定性根因，全部不是时序问题**：
  - `attempts[].transport` 是**投影读错字段**——projection 读 `metadata(attempt.metadata)?.transport`（永远 undefined），而 record 的一等字段 `attempt.transport` 才有值（`projection.ts:108`）。每个 attempt 的 transport 都被丢，不只是 upstream-ws 那个测试。
  - `clientResponse.sseEvents` 的 `synthetic` 标记（refusal-recovery / hook-replay）被 `canonicalFrameValue`（`request.ts:447`）**结构性剥除**——它只保留 `event/data/id/retry`，丢掉 `synthetic`；projection 的 `frames()` 读 `value.synthetic` 恒得 undefined。这是 S8 end_turn/error、offline-replay 三个失败的共同根因，是确定性投影缺陷。
- **没有发现任何「合法 V2-only、应从类型删掉」的字段**。P4c-3 已清理过弃用标量；现存声明字段都有活消费者（ui-v4 / search / 诊断）。唯一「写侧合法不产出」的是 `pipelineInfo.truncation`（auto-truncate 已退役，读侧为旧行保留）——那不是缺口，是读兼容，V3 新写不产出是正确的。
- **裁决轴（richest-data-flow）**：声明了却从不存储的字段一律是**真缺陷、要修**，不进 backlog。本审计据此给出完整修复清单 + 执行序列。
- **D 步安全性**：移除 `attachHistorySink` 在完成本审计的 src 投影修复（§C 步骤 4-5）+ 两处测试基建修复（步骤 1-2）+ 两个 in-flight 测试重分类删除（步骤 3）**之后**变安全。当前直接做 D 步会新增 19 个失败（已实测）。

> 方法论说明：本审计以**静态源码追踪**为主，复用 implementer 保留的 `/tmp/failure-details.txt`、`/tmp/phase1-d-norm.txt`、`/tmp/baseline-norm.txt`（19 个新增失败 = phase1-d 全集 comm-diff baseline）作为实测锚点。未重跑全套件（D 步 patch 未落工作区）。transport-projection-bug 与 synthetic-strip 两个根因是本审计新增的静态发现，超出报告结论。执行者落地前应对每个 projection 修复补正样本断言（先证检查触达目标）。

---

## A. 字段级完备性矩阵

数据流三段：**record**（`ModelOperationRecord` 上是否有数据） → **producer**（`request.ts` 是否把数据喂进 recorder） → **projection**（`recordToHistoryEntry` 是否投影出来）。verdict 只看 V3 单条读面（不含 HistorySink）。

### A.1 顶层标量 / 结构

| 字段 | record 有数据？ | producer 接线 | projection 投影？ | verdict |
|---|---|---|---|---|
| `id` | ✓ identity.operationId | ✓ | ✓ `:142` | projected-ok |
| `operationKind` | ✓ identity.kind | ✓ | ✓ `:143` | projected-ok |
| `sessionId`/`agentId` | ✓ identity | ✓ | ✓ `:144-145` | projected-ok |
| `rawPath` | ✗ 无字段 | ✗ `opts.rawPath` 从未喂 recorder | ✗ | **GAP**（需 record+producer+proj） |
| `startedAt` | ✓ identity.createdAt | ✓ | ✓ `:146` | projected-ok |
| `endedAt` | ~ 由 sequence 合成 | ~ | ✓ `:147` | projected-ok（近似，非真墙钟；可接受） |
| `endpoint` | ✓ ingress.format | ✓ | ✓ `:149` | projected-ok |
| `state` | ✓ terminal.outcome | ✓ | ✓ `:150` | projected-ok |
| `active` | — | — | ✓ 恒 false `:151` | projected-ok（终态投影，in-flight 另管） |
| `pinned` | ✓ stored | ✓ | ✓ `:152` | projected-ok |
| `lastUpdatedAt` | ~ = createdAt | ~ | ✓ `:153`（近似） | projected-ok（近似） |
| `queueWaitMs` | ✗ | ✗ `_queueWaitMs`(`:303`,`:1324`) 从不喂 recorder | ✗ | **GAP**（record+producer+proj）＝报告桶 A |
| `durationMs`（顶层） | ✗ terminal.metadata 未设 | ✗ `commitTerminal`(`:648`) 不传 metadata | ✗（proj `:148` 读 terminal.metadata.durationMs，恒 undefined） | **GAP**（producer 设 terminal.metadata；proj 已就绪） |
| `requestBytes`/`responseBytes` | ✗ | ✗（V2 在 serialize 期算） | ✗ | **GAP**（派生，proj 或 store 层算） |
| `multiplier`（顶层） | ✗ | ✗ billing.multiplier 未进 routing metadata | ✗ | **GAP** |
| `transport`（顶层） | ✗ routing.transport 未设 | ✗ `setRouteInfo` 不传 transport | ✗（proj `:158` 读 routing.transport） | **GAP**（低优先，真值在 per-attempt） |
| `warningMessages`（顶层） | ✗（仅 per-attempt diagnostic） | ✗ `_warningMessages`(`:304`) 未作一等喂入 | ✗ | **GAP**＝报告桶 A |
| `process` | ✓ identity.process | ✓ | ✓ `:154` | projected-ok |
| `preprocessing`（顶层） | ✗ | ✗（V2 从 `_pipelineInfo.preprocessing` 取） | ✗ | **GAP** |
| `pipelineInfo`（顶层） | ~ 仅落 attempt diagnostic 且需 attempt 活跃 | ✗ 无一等接线 | ✗ | **GAP**＝报告桶 A |
| `timing.client` | ✗（仅 diagnostic） | ✗ `_clientTimingEpochs` 未一等喂入 | ✗ | **GAP** |
| `_index.derived.*` | ✓ 重算 | ✓ | ✓ `:184-190` | projected-ok |
| `_index.aux.*`（requestBytes/responseBytes/previewText/warningMessages） | ✗ | ✗ | ✗ 恒 `{}` `:191` | **GAP**（派生/aux） |

### A.2 `model`（ModelInfo）

| 子字段 | verdict | 备注 |
|---|---|---|
| `requested`/`resolved`/`outboundEndpoint` | projected-ok | `:160-162` |
| `translated` | projected-ok | `:163` 读 routing.metadata.translated |
| `routeOverride` | **GAP** | 数据在 routing.metadata（`setRouteInfo` metadata=info 含 routeOverride），proj 未读 → 纯 projection 修复 |
| `multiplier` | **GAP** | 数据不在 record（同顶层 multiplier）|

### A.3 `clientRequest`（ClientRequestLeg）

| 子字段 | verdict | 备注 |
|---|---|---|
| method/path/format/headers/body/model/messages/stream/tools/system | projected-ok | `:165-176` |
| `max_tokens`/`temperature`/`thinking` | **GAP** | 声明但 `ingressMeta` 只抽 model/messages/stream/tools/system；可从 body 派生 → projection 修复 |

### A.4 `clientResponse`（ClientResponseLeg）

| 子字段 | verdict | 备注 |
|---|---|---|
| status/headers/body | projected-ok | `:177-181` |
| `sseEvents`（帧内容） | projected-ok（帧在） | `:181` frames(clientTrack) |
| `sseEvents[].synthetic` | **GAP（承重）** | `canonicalFrameValue`(`request.ts:447-457`) 剥掉 synthetic → refusal-recovery/hook-replay 标记全丢。S8/replay 三失败根因 |

### A.5 `attempts[]`

| 子字段 | record 有数据？ | projection？ | verdict |
|---|---|---|---|
| `index`/`strategy`/`error` | ✓ | ✓ `:104-109` | projected-ok |
| `durationMs` | ✗ latencyMs 从未设（settle metadata 只有 {response,error}） | proj `:107` 读 responseMeta.latencyMs → 恒 0 | **GAP** |
| `transport` | ✓ **一等字段** attempt.transport（beginAttempt `:997` + setAttemptTransport `:1080`） | proj `:108` 读**错**字段 `metadata(attempt.metadata).transport`（恒 undefined） | **GAP（承重，纯投影 BUG）**＝upstream-ws 失败根因 |
| `startedAt` | ✓ attempt.metadata.startedAt（`:1001`） | ✗ 未投影 | **GAP**（纯投影） |
| `waitMs` | ✓ attempt.metadata.waitMs（`:999`） | ✗ 未投影 | **GAP**（纯投影） |
| `effectiveSource.{format,model,messages,body}` | ✓ | ✓ `...effectiveMeta`+body `:110-113` | projected-ok |
| `effectiveSource.messageCount` | ✗ `EffectiveRequest`(types.ts:45) 无此字段 | ✗（可从 messages.length 派生） | **GAP**（纯投影派生）＝报告桶 A |
| `effectiveSource.pipeline` | ~ 仅 diagnostic | ✗ | **GAP**（per-attempt 管线） |
| `upstreamRequest.{format,model,messages,system,headers,body}` | ✓ | ✓ `:114-118` | projected-ok |
| `upstreamResponse.{success,status,headers,body,sseEvents,usage,stopReason,model,responseId}` | ✓ | ✓ `:119-133` | projected-ok |
| `upstreamResponse.rawBody` | ~ 原始载荷/metadata.response.rawBody | ✗ 未投影 | **GAP**＝报告桶 A |
| `upstreamResponse.trailers` | ✓ track.trailers（settle `:556`） | ✗ 未投影 | **GAP**（纯投影） |
| `upstreamResponse.toolSearchRequests`/`copilotAnnotations` | ~ metadata.response | ✗ 未投影 | **GAP**（纯投影/producer） |
| `attempts[].responseHeaders` | ✓ 数据在 upstreamResponse.headers | ✗ 只填 upstreamResponse.headers、未填 attempts[].responseHeaders | **GAP（纯投影 shape）**＝报告桶 A / Phase 3 失败 |
| `attempts[].sseEvents`（失败非终 attempt 帧） | ~ 失败 attempt 帧走 upstreamResponse.frames | ✗ 未单独投影 attempts[].sseEvents | **GAP**（纯投影）＝L2 buffered-retry 失败根因 |
| `upstreamHeadersAt`/`upstreamMessageStartAt`/`upstreamFirstTokenAt`/`upstreamLastTokenAt` | ~ diagnostic | ✗ | **GAP**（首包埋点） |

### A.6 「合法 V2-only、应删类型」审计（对抗性）

逐一质疑是否有字段该从 `HistoryEntry` 删掉而非补投影：

- **无一字段应删**。所有 leg 字段是 RFC §3 新模型，活消费者：ui-v4 详情页、`/api/search` 五 facet（`rewrites-req` 读 upstreamRequest.messages）、诊断埋点。删任何一个都破坏现有读面。
- 唯一「V3 写侧合法不产出」：`PipelineInfo.truncation`（auto-truncate 退役，`types.ts:121` 注释明载读侧为旧 history.db 保留）。→ 不是 V3 projection 缺口，保留读兼容即可。
- `endedAt`/`lastUpdatedAt` 目前是 sequence/createdAt 近似而非真墙钟——**不是缺口分类**，但记为「精度债」：若未来要精确终止时刻，须 producer 在 terminal.metadata 带真 epoch（可搭 durationMs 修复一起做）。

---

## B. 19 个新增失败分类表

映射：phase1-d 全集（`/tmp/phase1-d-norm.txt`，29）− baseline（`/tmp/baseline-norm.txt`，13，去掉本轮偶过的 perf flaky）＝ 19 新增。

| # | 失败（简） | 类别 | 根因 → 矩阵字段 | 修复 |
|---|---|---|---|---|
| 1 | Anthropic v4 history double-track byte-fidelity | 真-投影 | effectiveSource.messageCount | proj 派生 |
| 2 | CC v4 double-track via-responses | 真-投影 | effectiveSource.messageCount | proj 派生 |
| 3 | CC v4 double-track effective+outbound | 真-投影 | effectiveSource.messageCount | proj 派生 |
| 4 | CC v4 network-retry (2 hits + queueWaitMs) | 真-record | queueWaitMs | producer+proj（terminal.metadata） |
| 5 | Gemini v4 dropped-params warning | 真-record | warningMessages | producer+proj |
| 6 | Gemini v4 double-track cc | 真-投影 | effectiveSource.messageCount(+queueWaitMs) | proj+producer |
| 7 | L2 buffered retry 2 RST then complete | 真-投影（**非时序**） | attempts[0].sseEvents（失败 attempt 帧） | proj |
| 8 | P3 pre-response client abort → 499 aborted | **测试基建** | test-app 未挂 observabilityMiddleware，abort 路径靠中间件 finalize | 挂中间件 |
| 9 | /chat/completions via /responses translation | 真-record | warningMessages | producer+proj |
| 10 | Phase 3 per-attempt ②③ headers | 真-投影 | attempts[].responseHeaders（shape） | proj |
| 11 | Phase 5 headers in-flight (setInboundRequestHeaders) | **重分类删除** | 测 HistorySink `getInFlight` 镜像机制（V2-only） | git rm |
| 12 | Phase 5 headers in-flight (setInboundResponseHeaders) | **重分类删除** | 同上 | git rm |
| 13 | Responses v4 double-track direct | 真-投影 | effectiveSource.messageCount(+queueWaitMs) | proj+producer |
| 14 | Responses v4 upstream-ws transport | 真-投影（**非时序**） | attempts[].transport（读错字段 BUG） | proj `:108` |
| 15 | Task 5.1 reactive-retry-leg via getEntry() | **测试基建** | 手写 driver.runRequest+complete()，漏 finalizeModelOperationDelivery() → entry 不落 | 测试补 finalize 调用 |
| 16 | Task 5.2 offline replay via getEntry() | **测试基建**＋真-投影 | 同上漏 finalize（entry 不落）＋synthetic:hook-replay 标记被剥 | 补 finalize＋proj synthetic |
| 17 | request-rewrite migration golden pipelineInfo | 真-record | pipelineInfo（顶层） | producer+proj（terminal.metadata） |
| 18 | response-rewrite S8 end_turn synthetic:refusal-recovery | 真-投影（**非时序**） | clientResponse.sseEvents[].synthetic 被 canonicalFrameValue 剥 | proj/capture |
| 19 | response-rewrite S8 error synthetic:refusal-recovery | 真-投影（**非时序**） | 同 #18 | proj/capture |

分桶小计：真-投影（纯 projection.ts / capture）**9**（#1,2,3,7,10,13(部分),14,18,19）＋真-record（producer+proj）**4**（#4,5,9,17，另 #6/13 的 queueWaitMs）＋测试基建 **3**（#8,15,16）＋重分类删除 **2**（#11,12）。（#6/#13/#16 跨桶。）

**关键纠正报告**：报告把 #7/#14/#18/#19 归为「streaming 时序、根因未明、疑走 debugger」。静态追踪证明它们是**确定性投影缺陷**（读错字段 / 结构剥标记 / 未投影 per-attempt 帧），**不需要 debugger、不是竞态**——直接改 projection 即可。这消除了报告的最大不确定性。

---

## C. 修复清单执行序列（每步收尾绿）

原则：先测试基建（不碰 src、立即消化一批失败），再 projection-only（数据已在 record、最低风险），再 record+producer（触达 3 文件），最后完备性补全（无失败测试但 richest-data-flow 要求）。授权边界：步骤 4-6 触达 `projection.ts`/`request.ts`/`model-operation-record.ts`——超出 Phase 1「仅测试文件」原契约，需用户扩大授权。

**步骤 0（前置，必须先做）**：给每个待修 projection 字段写**正样本断言**（先证「HistorySink 在场时该字段可读」），确保后续断言真触达目标而非恒假绿。→ user-rule empirical-verification「通过/空不自证」。

**步骤 1 — 测试基建：挂 observabilityMiddleware**（消化 #8）
- `tests/helpers/test-app.ts` `createFullTestApp` 在 `registerHttpRoutes` 前 `app.use(observabilityMiddleware())`，镜像 `server.ts:137`。
- 先验证安全：中间件短路 synthetic 路径、跳过 WS/SSE finalize、幂等（settled guard）——理论安全且**提升测试对生产的保真度**（长远正确）。落地后跑**全量 http 测试**确认无中间件引入的回归（双 finalize / 状态覆盖）。
- 收尾：#8 绿，无新增失败。

**步骤 2 — 测试基建：直连 driver 测试补 finalize**（消化 #15、#16 的 entry-not-found 部分）
- `tests/history/reactive-retry-leg.it.test.ts`（Task 5.1）、`tests/history/replay.it.test.ts`（Task 5.2）：手动 `ctx.complete()` 后补 `ctx.finalizeModelOperationDelivery()`（镜像 handler post-stream）。这是测试漏调生产终结步骤，非生产缺陷。
- 收尾：#15 绿；#16 的 entry 可读，但 synthetic:hook-replay 断言仍红（留给步骤 4）。

**步骤 3 — 重分类删除**（消化 #11、#12）
- `git rm tests/history/http-headers-in-flight.it.test.ts`（2 test 全测 HistorySink `getInFlight` in-flight 镜像，是 V2-only 契约测试，Phase 1 分类看漏）。删前逐 test 核实 docstring（报告已确认）。
- 收尾：#11/#12 消失，非「修绿」而是「合法退役」。

**步骤 4 — src 投影修复（projection.ts / capture，数据已在 record，最低风险）**（消化 #1,2,3,7,10,13-msgCount,14,16-synthetic,18,19）
- `projection.ts:108` transport：`attempt.transport ?? metadata(attempt.metadata)?.transport`。
- `projection.ts` attempt：加 `startedAt`（metadata.startedAt）、`waitMs`（metadata.waitMs）、`responseHeaders: headers(attempt.upstreamResponse)`、`effectiveSource.messageCount`（effectiveMeta.messages?.length）、`upstreamResponse.{rawBody,trailers,toolSearchRequests,copilotAnnotations}`、`attempts[].sseEvents`（失败非终 attempt 的 upstreamFrames 投影）、首包 4 刻（若 producer 已带）。
- synthetic 标记（#16/18/19）：`request.ts:1238` captureForwardedGenerationFrame 把 syntheticKind 写进帧值（`{...canonicalFrameValue(frame), synthetic: syntheticKind}`），或 projection `frames()` 从节点 origin.detail/transformId 反推。**推荐前者**（frames() 契约不变）。注意 `error-shaping-glue.ts` 传的是 string `"error-shaping-auq"`，类型对齐 `SseEventRecord["synthetic"]` 联合。
- `model.routeOverride`：projection 读 routing.metadata.routeOverride（数据已在）。
- 收尾：上述失败绿。每字段配步骤 0 正样本 + 独立 oracle（wire 正确性别自证）。

**步骤 5 — src record+producer+projection（terminal.metadata 载体）**（消化 #4,5,9,17 + durationMs/preprocessing/multiplier/timing/rawPath 完备性）
- 架构选择：`finalizeGenerationDelivery` 的 `commitTerminal`(`request.ts:648`) 传 `metadata: { durationMs, queueWaitMs, warningMessages, pipelineInfo(合并版 getter `:287`), preprocessing, timing, rawPath }`。projection 已就绪读 terminal.metadata.durationMs（`:148`），扩展读其余。**这是最小改面**：复用现有 terminal.metadata 通道（当前完全未用），一处 producer + 一处 projection。
- `multiplier`/`model.multiplier`：billing.multiplier 进 `recordRouting` metadata（`setRouteInfo`）或随 terminal.metadata；projection 补 model.multiplier + 顶层 multiplier。
- `rawPath`：随 terminal.metadata 或 recordIngress。
- 收尾：#4/5/9/17 绿 + 顶层 durationMs/preprocessing/timing 非空。

**步骤 6 — 完备性补全（无失败测试，richest-data-flow 要求）**
- `requestBytes`/`responseBytes` + `_index.aux`（proj 或 store 层从载荷字节算）、`clientRequest.{max_tokens,temperature,thinking}`（从 body 派生）、`effectiveSource.pipeline`（per-attempt 管线）。
- 每项补 TDD 断言（当前无测试覆盖 → 先写红）。这些是声明未存的真缺陷，按裁决轴要修，**不进 backlog**。

**步骤 7 — D 步 + 合并态审**
- 落 D-step patch（`/tmp/d-step-patch.diff`：移除 `attachHistorySink` from `test-bootstrap.ts`）。
- 全量 `test:backend`：失败集应 == baseline（19 全消化）。派异模型 reviewer 做合并态审（doc-vs-code + 投影 wire oracle）。

---

## D. D 步安全性判定

- **当前直接做 D 步：不安全**（实测 +19 失败，已复现锚定）。
- **完成步骤 1-3（测试侧）后**：消化 5 个（#8,11,12,15 + #16 部分）——但真投影/record 缺口仍在，D 步仍红。
- **完成步骤 1-5 后**：19 全绿，D 步**安全**。步骤 6 是 richest-data-flow 完整性补全，不阻塞 D 步（无对应失败测试），但按项目「有意义且完整」哲学应紧随其后、不留双轨包袱。
- **独立并存的 D-2 缺口（不阻塞、须记录）**：生产从不挂 HistorySink，V3 in-flight（streaming 活跃行）可见性依赖 V3 store 的 recent/terminal-bus 通道——terminal-bus 只在**终态**触发，故生产 History 列表**不显示进行中请求**。这是比报告 D-2 更明确的结论：不是「投影缺字段」，是「in-flight 活跃行在生产根本没接线进 V3 读面」。#11/#12 删除的正是测这条 V2-only 机制的测试。→ 若要恢复生产 in-flight 可见性，须新建 V3-native active 订阅（记 `docs/todo/deferred-backlog.md`，独立于本次 D 步）。

## E. 与报告选项的关系

报告列了 3 选项（选 1 扩权修 / 选 2 暂缓另开阶段 + 先审计 / 选 3 记录暂缓）。本审计即**选项 2 的前置产物**（「先做一次独立 V3 projection gap 审计，产出修复清单再执行」）。审计完成后，建议路径 = **选项 1 的扩权版**：授权步骤 4-6 的 src 投影修复，与 D 步同阶段落地，一次到位、不留缺口——契合项目「无向后兼容负担 + 完整 > 最小」哲学。是否扩权触达 `projection.ts`/`request.ts`/`model-operation-record.ts` 需用户明确裁决。

## F. 引用（file:line，只读核实）

- 类型声明：`src/lib/history/types.ts:455-560`（HistoryEntry + 嵌套）。
- 投影：`src/lib/history/v3/projection.ts:86-194`（recordToHistoryEntry），缺口点 `:108`（transport 读错源）、`:181`（frames synthetic）、`:191`（aux 恒空）。
- record 契约：`src/lib/context/model-operation-record.ts`（commitTerminal metadata 通道 `:801-825` 当前未用）。
- producer：`src/lib/context/request.ts` — finalize/commitTerminal `:607-656`、settle `:533-565`、beginAttempt `:977-1007`、setAttemptTransport `:1074-1085`、setAttemptResponseHeaders `:1127-1137`、canonicalFrameValue `:447-457`（剥 synthetic）、captureForwardedGenerationFrame `:1238-1269`、queueWaitMs `:303/1324`、warningMessages `:304/968`、pipelineInfo getter `:287`、model/multiplier `:1520-1540`、setRouteInfo/recordRouting `:1700-1720`。
- 测试基建：`tests/helpers/test-app.ts:14-44`（无 observabilityMiddleware）、`src/lib/observability/middleware.ts:65-119`（生产 finalize 路径）、`src/server.ts:137`（生产挂载）。
- 生产持久化通道：`src/lib/history/state.ts`（terminal-bus 订阅 enqueueModelOperation）、`src/lib/history/v3/terminal-bus.ts`、`src/lib/history/in-flight.ts`（HistorySink-fed，测试专用）。
- 实测锚点：`/tmp/failure-details.txt`、`/tmp/phase1-d-norm.txt`、`/tmp/baseline-norm.txt`、`/tmp/d-step-patch.diff`。
