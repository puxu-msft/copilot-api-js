---
base: 1e7b527a78d166b6e5ed0f8c6142754a79a3ca6f
status: complete
owner: task-3-implementer
---

# Task 3 implementation progress

## Closed checkpoints

- Response processor finish ordering：新增失败优先测试，证明 `finish.frames` 逐帧 yield 恰一次后才发布 `onFinishResolved` verdict；保留 throwing upstream 不调用 finish 的既有测试。

## Verification

- RED：`pwd -P && bun test tests/pipeline/response-processor.unit.test.ts`，目标测试按预期失败，实际顺序为 verdict 先于两个 closing frames。
- GREEN：`pwd -P && bun test tests/pipeline/response-processor.unit.test.ts && bun run typecheck`，6 tests passed、0 failed，TypeScript compilation 通过。

## Recovery checkpoint after adapter investigation

- Adapter checkpoint 尚未进入测试编写：工作树审计为 clean，没有未提交 adapter WIP；已核对 Responses factory 现有 `transport: "http" | "ws"` 接缝、四协议 terminal/error renderer 来源与冻结 spec §4.3 映射。
- RED checkpoint：新建 `tests/pipeline/delivery-adapters.unit.test.ts` 的单一用例，要求 `createAnthropicDeliveryProtocolAdapter` 把 `content_block_start@index=7` 分类为携带原 source frame 的 `unit-open` 与 identity `{ boundary: "content-block", key: "7" }`。`pwd -P && bun test tests/pipeline/delivery-adapters.unit.test.ts` 按预期 0 pass／1 fail，唯一错误为 `Cannot find module '~/lib/pipeline/delivery/adapters/anthropic'`，并非测试语法或断言错误。
- GREEN checkpoint：新增最小 `src/lib/pipeline/delivery/adapters/anthropic.ts` constructor，仅实现上述 `content_block_start` class，未实现其他未测试 classes／renderers，也未接 production wiring。`pwd -P && bun test tests/pipeline/delivery-adapters.unit.test.ts && bun run typecheck` 通过，1 test passed、0 failed，TypeScript compilation 通过。
- Anthropic classification checkpoint：RED 为 1 pass／3 fail，分别命中缺失 block lifecycle、malformed fail-closed、finish mapping；GREEN 实现 delta／stop、message structure／terminal、malformed／unknown／adapter exception 与四种 finish 映射。`pwd -P && bun test tests/pipeline/delivery-adapters.unit.test.ts && bun run typecheck` 通过，4 tests passed、0 failed，TypeScript compilation 通过；renderers、control、其他协议及 production wiring 未触碰。
- Anthropic ownership checkpoint：RED 精确命中缺失 runtime capability module；GREEN 新增 WeakSet + private class identity capability、伪造拒绝、256 UTF-8 byte finish diagnostic fail-closed、adapter-owned terminal/error/no-DONE renderers，并将 `anthropicErrorFrame` 下沉至 `src/lib/anthropic/stream-error-frame.ts` 后从 route compatibility re-export，delivery 不 import routes。`pwd -P && bun test tests/pipeline/delivery-adapters.unit.test.ts tests/anthropic/post-commit-error.unit.test.ts && bun run typecheck` 通过，adapter 与既有 builder 回归及 TypeScript compilation 全绿。
- Responses adapter checkpoint：RED 精确命中缺失 `adapters/responses` module；GREEN 以显式 `{ transport: "http" | "ws" }` 选择 HTTP `unit` output-item lifecycle 与 WS `response-terminal` buffering，覆盖 lifecycle classes、complete／incomplete／failed／error terminal、四种 finish、adapter-owned terminal/error/no-DONE renderers并复用 `openAIStreamErrorFrame`。`pwd -P && bun test tests/pipeline/delivery-adapters.unit.test.ts && bun run typecheck` 通过，9 tests passed、0 failed，TypeScript compilation 通过。
- Chat Completions adapter checkpoint：RED 精确命中缺失 `adapters/chat-completions` module；GREEN 实现 `response-terminal` mode 的 delta／usage／finish_reason／error classification、四种 finish、owner-only terminal/error renderers，并让 Chat adapter 独占 `renderDone() → [{data:"[DONE]"}]`，复用 `openAIStreamErrorFrame`。`pwd -P && bun test tests/pipeline/delivery-adapters.unit.test.ts && bun run typecheck` 通过，11 tests passed、0 failed，TypeScript compilation 通过。
- Gemini adapter checkpoint：RED 精确命中缺失 `adapters/gemini` module；GREEN 实现 `response-terminal` mode 的 candidate content／finishReason／error classification、四种 finish、owner-only terminal/error renderers，复用 `geminiStreamErrorFromError`，且 `renderDone()` 为空。`pwd -P && bun test tests/pipeline/delivery-adapters.unit.test.ts && bun run typecheck` 通过，13 tests passed、0 failed，TypeScript compilation 通过。
- Candidate production wiring checkpoint：RED 精确命中 `session.outcomes` 缺失；GREEN 在 candidate session 安装 adapter + grammar，逐 rendered wire frame 生成 ordered typed outcomes，boundary classifier 改为只投影 `complete-unit`／successful `response-terminal`、无 JSON 解析；legacy `commitBoundaries`／`sawMessageStop`／`sawUpstreamError` 只读 grammar 派生状态。四 route factories 显式传 adapter，Responses factory 以 transport 参数选 HTTP unit／WS response-terminal；`withCandidateResponseOpts` 保留 adapter/outcomes rich context。`pwd -P && bun test tests/pipeline/delivery-adapters.unit.test.ts tests/pipeline/candidate-response-session.unit.test.ts tests/pipeline/boundary-classifier.unit.test.ts tests/pipeline/coordinator-hedge.unit.test.ts tests/responses/candidate-response-session.unit.test.ts && bun run typecheck` 通过，全部定向测试与 TypeScript compilation 全绿。
- Finish single-consumption checkpoint：RED 证明 processor 未触发 finish-frame classification；GREEN 新增 `onFinishFrame` candidate-local seam，processor 对 `finish.frames` 按序逐帧 callback 后 yield 各一次，再发布同一 finish result；candidate seam 复用同一 `consumeFrame` 执行 adapter.classify→grammar.consume，再由 `onFinishResolved` 唯一执行 classifyFinish→consume。throwing upstream 的 finish、frame classification、verdict classification 均为 0。`pwd -P && bun test tests/pipeline/response-processor.unit.test.ts tests/pipeline/delivery-adapters.unit.test.ts tests/pipeline/candidate-response-session.unit.test.ts tests/pipeline/boundary-classifier.unit.test.ts && bun run typecheck` 通过，24 tests passed、0 failed，TypeScript compilation 通过。

## Closeout

- 四个 protocol adapters、runtime-branded control capability、candidate production wiring、typed boundary projection、compatibility projections 与 finish single-consumption 已完成。
- Exact mutation controls：第二 JSON classifier 使 boundary tests 2/2 红；重复 finish yield 使 processor tests 2 条红；移除 WeakSet identity 使伪造 capability gate 红。三项均在反向恢复前通过 `git apply --reverse --check`，恢复后各自定向测试转绿。
- 完整定向验证：adapter／processor／candidate-session／boundary／hedge／Responses route candidate／buffered-merge wiring 共 37 tests passed、0 failed；`bun run typecheck` 通过；目标 ESLint 通过，仅输出 third-party `baseline-browser-mapping` 数据陈旧 warning；`git diff --check` 通过。
- Task1b projection seam：candidate 只将最终 post-transform wire `ClientFrame` 传入 adapter；outcomes 不保存 parsed provenance，符合未来 parsed→wire projection 在 classification 之前的接缝。
- §6b 初次收口快照：base `1e7b527a` 后 first-parent 共 12 个实现／checkpoint commits；后续 code-review fix 的最终计数见下方更新。
- 未决：Task 4 才允许删除 compatibility projections并让唯一 delivery owner 直接消费 outcomes。
- Code review Critical 修复：processor 内部成为所有普通／finish `ClientFrame` 的唯一 post-render／classification gate；driver live／buffered 与 hedge consumer 不再二次调用 `onRenderedFrame`。production seam 证明 finish terminal frame classify 一次、outcome 仅一个 terminal、`sawUpstreamError=false`。
- Code review Critical 修复：frame／finish adapter throw 均在 candidate 边界转换为保留 cause 的 typed `adapter-exception`；finish throw 不再 reject processor。恢复 consumer reclassification 与 finish throw escape 两项 exact mutation 均使目标测试红，reverse-check 恢复后绿。
- Acceptance findings：Responses HTTP identity 优先 `item.id → item_id → output_index`，added／delta／done 使用同 key；Chat finish_reason 作为 response buffer frame，尾随 usage 合法，finish verdict 才产生 terminal；共享 safe payload parser 令四 adapter 的 data getter throw 都归 `adapter-exception`；UTF-8 255／258 bytes 对五个 mode 全表双控。
- Control capability authority 收进 Anthropic adapter 实例的私有 class + WeakSet closure；production 不再导出通用 mint／validate API，测试只经 adapter owner-bound capability seam。
- Task1b integration：本树只验证 adapter 接收 post-transform wire frame；跨 Task1b parsed→wire 合并接缝留给 merged-seam gate，不在当前树伪造 provenance。
- §6b 对账：review fix 前 first-parent 13 commits；本修复提交后共 14 commits。
- Production-shaped probes：live owner、buffered block-level、hedge 共 9 tests passed、0 failed。
- Second review Critical C1：Responses adapter不再以 `item.id`／裸 `output_index`直接作为 grammar identity；每个 `response.output_item.added` 分配 candidate-local ordered unit token，并以 `output_index→token` 状态关联 delta／done。既有 `responses-buffered.it` committed-prefix正样本由稳定失败转为通过，`BLOCK_ZERO` 在后续 RST 前提交。
- Second review Critical C2：Chat production candidate新增 finish producer：streamError→terminal-failure，无 finishReason→truncated，有 finishReason→valid-terminal-without-boundary，并保留 renderer finish frames。真实 route-factory seam 的 finish_reason→usage→finish产生一个 successful terminal，responseFrames含两帧，兼容 projection为 messageStop true／upstreamError false。
- Second review Minors：同步 Chat／Responses WS旧接线注释；正式测试加入同实例 capability正样本、跨 adapter实例真实 capability与结构伪造负样本。
- Second review验证：Task3／Chat seam／Responses committed-prefix选择集通过；driver suite 46／46；typecheck、target lint、diff-check通过。结构怪味处置：Chat shared finish mapping缺producer已在route candidate层闭合，未把协议事实塞入shared helper。
- §6b 对账：second-review fix前 first-parent 14 commits；C1 `f8be1941` 后15 commits；本提交后共16 commits。
