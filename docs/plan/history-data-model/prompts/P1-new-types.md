# P1 kick-off — 新 type 并存

**前置**：P0 完成。先读 [../README.md](../README.md) + [../plan.md](../plan.md)「P1」+ Factory 表 + [RFC §3/§4](../../../rfc/2026-07-07-history-data-model-restructure.md)。

**为什么**：先落 type 骨架、新旧并存，让后续 phase 在编译绿的前提下逐步切换（无向后兼容负担，但过渡态不半破碎）。

**目标**：`src/lib/history/types.ts` + `src/lib/context/types.ts`（HistoryEntryData）按 RFC §3 新增全部新字段；旧字段（inboundRequest/effectiveRequest/outboundRequest/outboundResponse/inboundResponse/sseEvents/attempts[].{effectiveRequest,wireRequest,response}）留 `@deprecated` 别名。新增 leg builder `legFromEffectiveSource`/`legFromUpstreamRequest`（request.ts，复制 :76/:87，**给 upstreamRequest 补 messages/model/system 投影**——修 R4-FAIL-A）。

**关键字段**（RFC §3）：`upstreamResponse.{success, status?, trailers?, rawBody?, sseEvents?, usage?, ...}`；`upstreamRequest.{format?, model?, messages?, system?, headers, body}`；`effectiveSource.{format?, model?, messageCount?, messages?, system?, body, pipeline?}`；`clientResponse.status?`；`_index.{derived, aux}`。**不建** `model.capabilities`/raw upstream model（RFC §5 future）。

**TDD + 验收**：plan.md P1 Step 1-5。gate：`bun run typecheck` 绿、旧字段仍可读。

**提交**：`feat(history): add client/upstream leg types alongside deprecated legacy fields`（显式 pathspec）。

**红线**：../README.md。
