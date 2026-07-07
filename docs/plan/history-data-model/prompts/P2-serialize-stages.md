# P2 kick-off — serialize/assemble 新 stage 语义

**前置**：P1 完成。读 [../README.md](../README.md) + [../plan.md](../plan.md)「P2」+ Factory（serialize + 写入方 sink 段）+ skill `history-sqlite-schema`。

**为什么**：把上游帧统一进 attempt、clientResponse 提为独立 stage、upstreamResponse 富字段（success/trailers/rawBody）+ upstreamRequest.messages 投影落库——消除旧的顶层/per-attempt 帧割裂（RFC §S1）。

**目标 + 锚点**：`extractStagePayloads`（serialize.ts:486）落新 stage；`assembleFullEntry`（:313，反投影 :364-377）组装新结构；`STAGE_TOP_KEYS`/`ATTEMPT_BODY_KEYS`（:145/:147）纳新键；写入方 `observability/sinks/history.ts`（:248-265）用新 leg builder 从 HistoryEntryData 组装。

**TDD + 验收**：plan.md P2 Step 1-5。gate：新往返测试 + P0 golden `assembledStructureSnapshot` 绿（结构等价，新增允许、既有不丢）；**invariant ③**：legacy 单-blob 行仍能 assemble（旧 fixture 过）。

**提交**：`feat(history): serialize/assemble client/upstream leg stages`。

**红线**：../README.md。**注意 sed 踩坑**（large-refactor §6）：跨行/含中文注释改动用 Edit 不用 sed/perl。
