# Task 3 独立代码复审

## 结论

- **评审范围**：冻结范围 `1e7b527a..7e87c3c9`（14 commits），重点复核修复提交 `7e87c3c9`、原 2 个 Critical、4 项 acceptance finding、dead inputs、shared helper、Task 4 边界，以及最终 live／buffered／hedge 接缝。
- **已读取／执行的证据**：读取更新后的 brief、readiness、report、progress、14-commit full diff、frozen spec §4.1–4.4 和最终代码；从 `7e87c3c9` 导出 `/tmp/copilot-api-js-task3-review-7e87c3c9`，运行定向 7-file suite（41 pass／0 fail）、driver suite（46 pass／0 fail）、`bun run typecheck`（通过）、owner-bound capability 跨实例 probe（pass）。另运行 Chat finish production-seam probe及既有 Responses buffered boundary 正样本，均发现失败。base 对照同一 Responses boundary test 为 1 pass／0 fail，确认是 Task 3 回归而非既有失败。
- **总体 verdict**：**Spec FAIL；Quality CHANGES_REQUIRED；存在 blocker。**
- **blocker 数量**：2（Critical 2 项）；Important 0；Minor 2。

## 原 Critical 复核

| 原 finding | 当前证据 | 复核结论 |
|---|---|---|
| C1：finish frame 被 processor 和 consumer 重复分类 | `/tmp/copilot-api-js-task3-review-7e87c3c9/src/lib/pipeline/stream/response-processor.ts:109-116,223-247` 让 ordinary／finish frame 共用唯一 `emit→postRender` 门；driver live／buffered 在 `/tmp/copilot-api-js-task3-review-7e87c3c9/src/lib/pipeline/driver.ts:1115-1128,1370-1399` 直接消费 frame；hedge 在 `/tmp/copilot-api-js-task3-review-7e87c3c9/src/lib/pipeline/generation/candidate-race.ts:31-84` 不再重调 callback。candidate regression `:217-253` 断言 finish terminal classify 恰一次、唯一 terminal outcome、`sawUpstreamError=false`。 | **RESOLVED** |
| C2：`classifyFinish` throw 原样 reject | `/tmp/copilot-api-js-task3-review-7e87c3c9/src/lib/pipeline/generation/candidate-response-session.ts:189-205` 捕获 throw，转换为 `terminal-failure` class 内的 `adapter-exception`，保留 `sourceFrame:null` 与原 cause；frame throw 在 `:132-160` 保留触发 frame与 cause；测试 `:255-300` 证明 finish 不 reject且产 typed outcome。 | **RESOLVED** |

## Acceptance finding 对账

| Finding | 证据 | 裁决 |
|---|---|---|
| Responses `output_index`-only added／delta／done identity 一致 | `/tmp/copilot-api-js-task3-review-7e87c3c9/src/lib/pipeline/delivery/adapters/responses.ts:28-42,88-93` 统一 `item.id → item_id → output_index`；adapter test `:126-154` 的三帧均为 key `"0"` | **PASS（primitive）**；但真实 buffered path 的已有 `item.id` fixture回归，见 Critical 1 |
| Chat `finish_reason→usage` 合法，finish verdict 唯一 terminal | adapter `/tmp/copilot-api-js-task3-review-7e87c3c9/src/lib/pipeline/delivery/adapters/chat-completions.ts:18-28` 把 finish chunk归 `response-append`，usage归 structural；unit test `:209-220` 仅分别测 class与 finish class | **FAIL（production seam）**；默认 `complete→natural-drain` 仍使 grammar `finish-before-terminal`，见 Critical 2 |
| 四 adapter getter throw vs JSON malformed 分流正确 | shared parser `/tmp/copilot-api-js-task3-review-7e87c3c9/src/lib/pipeline/delivery/adapters/shared.ts:10-27` 先单独读取 getter，再 JSON.parse；getter throw测试覆盖五个 mode，malformed JSON测试覆盖 Anthropic，shared implementation统一 | **PASS** |
| 通用 control exports消失、authority owner-bound且不可伪造 | `/tmp/copilot-api-js-task3-review-7e87c3c9/src/lib/pipeline/delivery/control-capability.ts:1-5` 无生产 export；Anthropic adapter `/tmp/copilot-api-js-task3-review-7e87c3c9/src/lib/pipeline/delivery/adapters/anthropic.ts:16-40` 每实例 closure持有 private class + WeakSet；我额外验证跨 adapter 实例 capability 被拒绝 | **PASS** |
| dead inputs删净 | `CreateCandidateResponseSessionInput` 已无 `sawMessageStop`／`sawUpstreamError`／`commitBoundaries`；route live callbacks/imports已删除。残存旧名字仅在陈旧注释和退役 helper定义中，不是活输入 | **PASS** |
| shared helper无语义漂移 | parse与四 finish variant映射集中到 `/tmp/copilot-api-js-task3-review-7e87c3c9/src/lib/pipeline/delivery/adapters/shared.ts:29-69`；255／258-byte对五个 mode双控 | **局部 PASS**；`complete→natural-drain` 的共享语义暴露 Chat wiring缺口，见 Critical 2 |
| Task 4边界未越界 | compatibility projections仍在 candidate session `:206-210`，driver仍消费；adapter renderers尚未成为唯一 sink owner，route terminus仍保留 | **PASS** |

## 事实性发现

### Critical

[Critical] `/tmp/copilot-api-js-task3-review-7e87c3c9/src/lib/pipeline/generation/candidate-response-session.ts:132-160,206-210`、`/tmp/copilot-api-js-task3-review-7e87c3c9/src/lib/pipeline/stream/response-processor.ts:223-247`、`/tmp/copilot-api-js-task3-review-7e87c3c9/src/routes/responses/candidate-response-session.ts:120-150` — 把唯一 post-render/classification 门移进 processor 后，Responses HTTP 的 `commitBoundaries` projection 仍以**变换后的 frame identity**建 WeakSet，但 `responseOpts.commitBoundaries` 被 buffered driver调用时拿到同一最终 frame，本应成立；实际已有生产集成测试 `tests/responses/responses-buffered.it.test.ts:521-548` 在 `7e87c3c9` 确定性失败：item0 的完整 block未在 RST 前提交，客户端只收到 error，`BLOCK_ZERO` 丢失。相同测试在 base `1e7b527a` 为 1 pass／0 fail，故这是本任务引入的用户可见回归。根因需进一步沿 `responseFrame` 对象替换、grammar完成 frame identity和 buffered loop所见 frame identity三者取证；目前不能把 41 条定向绿当作修复完成。**修复建议**：先由 `gpt-souls:debugger` 在该既有 failing integration test上记录 added/delta/done 进入 `consumeFrame`、`completedBoundaryFrames.add` 与 `commitBoundaries(toWrite)` 的对象身份/normalized unit key，再把 compatibility projection改成由 ordered outcome和稳定 sequence/token关联，而不是脆弱的 object identity；修复必须让该 base-positive integration test恢复，并补 Task 3 定向 suite中的真实 driver/buffered正样本。

[Critical] `/tmp/copilot-api-js-task3-review-7e87c3c9/src/lib/pipeline/delivery/adapters/chat-completions.ts:18-28`、`/tmp/copilot-api-js-task3-review-7e87c3c9/src/lib/pipeline/delivery/adapters/shared.ts:29-56`、`/tmp/copilot-api-js-task3-review-7e87c3c9/src/lib/pipeline/generation/candidate-response-session.ts:185-205` — Chat acceptance只修了“finish_reason不是wire terminal”，却没有让 production finish verdict成为唯一 terminal。普通 Chat candidate未定义自有 `finish()`（route `/tmp/copilot-api-js-task3-review-7e87c3c9/src/routes/chat-completions/handler-v4.ts:334-367`），因此 candidate默认返回 `{kind:"complete"}`；shared helper把它映成 `natural-drain`，grammar在尚无 terminal时产生 `discard-open-unit + protocol-error(finish-before-terminal)`。我用真实 candidate seam喂 finish_reason→usage，复现 outcomes 为 `buffer-real-frame, stage-structural-frame, discard-open-unit, protocol-error`，而不是声称的唯一 `response-terminal`，且 `sawUpstreamError=true`。现有 adapter test是假绿：它单独调用了一个 production没有生产者的 `valid-terminal-without-boundary("stop")`，没有经过 route candidate的实际 `finishResponse`。**修复建议**：Chat candidate的 finish callback必须从其 accumulator `finishReason` 产生 `valid-terminal-without-boundary`（无 finish reason则 truncated，stream error则 terminal-failure），并保留 renderer finish frames；补 route-factory/candidate integration test，断言 finish_reason→usage→finish verdict只产生一个 terminal、responseFrames含前两帧、`sawMessageStop=true`、`sawUpstreamError=false`。

### Important

未发现独立于上述 Critical 的 Important。

### Minor

[Minor] `/tmp/copilot-api-js-task3-review-7e87c3c9/src/routes/chat-completions/handler-v4.ts:1-25,470-481,540-620`、`/tmp/copilot-api-js-task3-review-7e87c3c9/src/routes/responses/ws.ts:377` — dead inputs虽已删，注释仍声称 `ccCommitBoundaries`／`sawUpstreamError` 或 `isResponsesCommitBoundary` 是当前接线，已与代码不符。**修复建议**：本轮同步为 grammar-derived compatibility projection，避免后续维护者回接退役 predicate。

[Minor] `/tmp/copilot-api-js-task3-review-7e87c3c9/src/lib/pipeline/delivery/adapters/anthropic.ts:16-35` — capability authority已正确实例绑定，但正式测试只测结构伪造，没有测“另一 adapter实例签发的真实 capability”也必须拒绝；我的独立 probe为绿。**修复建议**：把跨实例正／负 control纳入正式 table，防未来把 closure提升成模块全局 WeakSet而测试仍绿。

## 双向判据审计

- **假绿**：41条定向测试没有运行已有 `responses-buffered.it` 的 committed-prefix正样本，漏掉 Critical 1；Chat test只拼接 adapter primitive，没有运行真实 candidate默认 finish，漏掉 Critical 2。
- **假红控制**：相同 Responses boundary test在 base `1e7b527a`通过而在 head失败，证明不是测试本身过严；owner-bound capability的签发 adapter正样本通过、跨实例与结构伪造负样本拒绝；原两 Critical的正样本在 head均转绿。
- **仍有效的绿证据**：定向 41／41、driver 46／46、typecheck通过，证明普通门迁移、throw typed conversion、getter error分流、shared UTF-8 validator和基础 route编译均成立，但不足以覆盖上述两个集成缝。

## 结构怪味

- `/tmp/copilot-api-js-task3-review-7e87c3c9/src/lib/pipeline/generation/candidate-response-session.ts:119,132-160,206-210`：**canonical outcome与object-identity compatibility projection耦合**；处置：**本轮修**，已有 committed-prefix回归，不能留到 Task 4。
- `/tmp/copilot-api-js-task3-review-7e87c3c9/src/lib/pipeline/delivery/adapters/shared.ts:29-56` + route-specific finish producers：**共享映射正确但协议完成事实未在producer端闭合**；处置：**本轮修 Chat candidate finish producer**，不要在shared helper里猜协议。
- `/tmp/copilot-api-js-task3-review-7e87c3c9/src/routes/chat-completions/handler-v4.ts` 与 `/tmp/copilot-api-js-task3-review-7e87c3c9/src/routes/responses/ws.ts`：**注释复述旧接线**；处置：本轮同步。

## 推荐修复路由

Critical 1 根因尚需运行时身份追踪，建议派 `gpt-souls:debugger`；Critical 2 改法明确，可派 `gpt-souls:implementer`。修后由本 reviewer再次复评，并至少运行：Task 3 7-file suite、`tests/pipeline/driver.unit.test.ts`、目标 Chat candidate seam、`tests/responses/responses-buffered.it.test.ts` 的 block-level正样本、typecheck。