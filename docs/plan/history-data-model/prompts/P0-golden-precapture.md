# P0 kick-off — golden 预捕获

**你是独立实现者，假设零项目上下文。** 先读 [../README.md](../README.md)（通用红线 + 必读）与 [../plan.md](../plan.md) 的「P0」段 + Factory 表。

**为什么**：本重构改 serialize/生产者/消费者，字节等价靠 golden 证明。必须在**旧代码**上先锁当前行为，否则改后无对照（large-refactor §4：只在改后存在的 golden 什么都证明不了）。

**目标**：新增 `tests/history/restructure-golden.it.test.ts`，对 6 类 fixture（成功流 / 失败 HTTP / 网络错误 / aborted / 多-attempt 重试成功 / **inbound≠outbound 即 proxy 实际改写了 messages（B1-B12 触达，如 cache_control 注入 / memory 重写）**）锁三个快照：`EntryRow` 逐列、`assembleFullEntry` 结构（stage 种类 + attempt 索引 + 顶层 leg 存在性）、`buildRewritesReq` 索引串。归一化 id/时间戳/durationMs。**WARN-1 防空证：第 6 个 fixture 的 `rewritesReqSnapshot` 必须非空**（先证 `buildRewritesReq` 触达目标，否则 P4 丢 messages 投影时 golden 是 `""==""` 空证——撞项目「通过/空不自证」红线）。

**改动锚点**：`serializeHeadEntry`/`buildHeadRow`（serialize.ts:203/:214）、`assembleFullEntry`（:313）、`buildRewritesReq`（search-index-write.ts:137）。测试隔离用临时 DB（skill `test-isolation`，不碰真实库）。

**TDD + 验收**：按 plan.md P0 Step 1-3。**硬 gate：测试须在当前（未改）代码上全绿**——它就是 golden 锁。导出三快照 helper 供后续 phase 复用。

**提交**：`git add -- tests/history/restructure-golden.it.test.ts && git commit -F <msg> -- tests/history/restructure-golden.it.test.ts`，msg：`test: pre-capture golden for history restructure (EntryRow/assemble/rewrites-req)`。

**红线**：见 ../README.md（no-auto-server / 显式 pathspec / 测试隔离）。
