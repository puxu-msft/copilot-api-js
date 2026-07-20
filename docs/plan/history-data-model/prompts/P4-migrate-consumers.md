# P4 kick-off — 消费者迁移 + 删旧顶层（依赖 P2.6 + P3）

**前置**：P2.6 + P3 完成。读 [../README.md](../README.md) + [../plan.md](../plan.md)「P4」+ Factory（消费者段）+ RFC §7.4 全 62 文件清单。**分组并行**：(a) 后端读侧、(b) 前端、(c) 删旧（最后串行）。

**为什么**：新结构就位后迁全部消费者、删旧顶层。**关键 R4-FAIL-A**：`rewrites-req` 搜索 facet 读 wire 腿 messages，失败是**静默降级**（返空串、零命中无报错）——必须 golden 锁。

**目标 + 锚点**（Factory 表消费者段）：
- rewrites：`buildRewritesReq`（search-index-write.ts:139）→ `attempts.at(-1).upstreamRequest.messages`；`buildRewritesResp`（:174-181）→ `attempts[final].upstreamResponse.sseEvents`/`clientResponse.sseEvents`/`upstreamResponse.body`。**golden 锁 `rewritesReqSnapshot` 等价**。
- 后端：stats（:43/:46-49/:99）→ `attempts.at(-1).upstreamResponse.{model,usage,success}`；queries（:65-66）+ in-flight（:151-152）→ `_index.derived`；telemetry-dimensions（:161）→ `model.resolved ?? model.requested`。
- 前端：ui-v4 detail segments + ui composables（RFC §7.4）；`bun run build:ui`（rollup 暴露真错，skill `debugging-frontend-tests`）。
- 删旧：grep（**补全正则含 inboundRequest|wireRequest|sseEvents**）应仅剩注释后，删 types 旧字段 + toHistoryEntry/sink 投影逻辑。**含 serialize.ts 内 `inboundRequest` 直读点重指（WARN-5）：`buildHeadRow` :223/:241、`extractStagePayloads` :489、`deserializeEntry` :296 → `clientRequest`/`model.requested`**。
- 生产者侧变换（WARN-4，`toHistoryEntry` :705-723 + sink）：`attempts[].startedAt?`/`waitMs?` 新捕获（`beginAttempt` 已存 :403-404、当前不输出）；`attempts[].{truncation,sanitization}`（:712-713）→ `effectiveSource.pipeline`；顶层 `pipelineInfo.{truncation,messageMapping}`/`entry.truncation`（:673）去顶层化 + `preprocessing` → entry 级。

**invariant ④（_index.derived 三处同步）**：派生子集只重算不独立写，`toHistoryEntry` + `onTerminal` 投影 + `updateEntry` allowlist 三处（skill `persistence-async-invariants`）。

**TDD + 验收**：plan.md P4 Step 1-5。gate：全 `bun test` + P0 三 golden + `build:ui` 绿；旧字段 grep 零代码残留。分组提交（rewrites / backend-consumers / frontend / drop-legacy 各一）。

**红线**：../README.md。
