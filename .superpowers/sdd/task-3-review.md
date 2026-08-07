# Task 3 独立代码复审

## 结论

- **评审范围**：候选 `1e7b527a..2543ec46`，本轮只复核此前 C1／C2、两个 Minor、相邻同类契约和 Task 4 边界；重点提交 `f8be1941`、`2543ec46`。
- **已读取／执行的证据**：读取原报告及两修复提交最终代码／测试；在 `2543ec46` frozen snapshot `/tmp/copilot-api-js-task3-review-2543ec46` 运行 Task 3 + Chat + driver 目标套件（88 pass／0 fail）、Responses block-level tests（2 pass／0 fail）、RST before／after boundary正反控（2 pass／0 fail）、typecheck（通过）；另运行 Responses output-index复用／跨 item token probe（1 pass）及 Chat success／truncated／terminal-failure + renderer-frames probe（1 pass）。
- **总体 verdict**：**Spec PASS；Quality APPROVED；可集成。**
- **blocker 数量**：0。Critical 0；Important 0；Minor 2（均为测试加固，不阻断）。

## Finding 闭合

### C1：Responses committed prefix／stable ordered unit token

**RESOLVED。** `/tmp/copilot-api-js-task3-review-2543ec46/src/lib/pipeline/delivery/adapters/responses.ts:15-49,94-96` 以 adapter-local 单调 `nextUnitKey` 签发 unit token，并只用 `output_index` 在 added 时登记、delta／done时查同一 token、done后删除。它不再依赖 `item.id` 在不同事件上是否存在，也不把可复用 `output_index` 本身当永久 identity。

- 既有用户可见回归 `tests/responses/responses-buffered.it.test.ts:521-548` 已恢复：`BLOCK_ZERO` 在后续 RST 前提交，目标 block-level 组 2／2 绿。
- RST 在首个 done 前会 retry、done 后会 partial-degrade且保留首块，正反控 2／2 绿。
- output-index-only added／delta／done统一 token；同一 index close后复用会得到新 token；跨 item token单调不碰撞。独立 probe观察 `0/0`、复用后 `1/1`、另一 item `2/2`。
- 同时 open多个 item仍由 frozen grammar 的 single-open-unit规则拒绝为 nested unit；adapter token本身不碰撞，也不会把一个 item的 close误配到另一 item。

### C2：Chat 真实 finish producer

**RESOLVED。** `/tmp/copilot-api-js-task3-review-2543ec46/src/routes/chat-completions/handler-v4.ts:332-370` 在真实 direct Chat candidate上按 accumulator事实产生 finish：

- `streamError` → `terminal-failure`，保留 `rendererFrames` 和原 error；
- 无 `finishReason` → `truncated`，保留 `rendererFrames`；
- 有 `finishReason` → `valid-terminal-without-boundary`，逐字保留 reason。

正式 route-candidate test `/tmp/copilot-api-js-task3-review-2543ec46/tests/chat-completions/candidate-response-session.unit.test.ts:68-88` 证明 `finish_reason→usage→finish` 产生恰一个 successful `response-terminal`，其 `responseFrames` 顺序为 finish chunk、usage，`sawMessageStop=true`、`sawUpstreamError=false`。补充 probe覆盖三 finish分支并确认 closing renderer frame不丢。对于 in-band wire error，adapter先产生 failed terminal，随后 `terminal-failure` finish按 frozen grammar记录 `post-terminal-frame` diagnostic；没有第二个 response terminal，也不写第二 terminus，符合 terminal后非-natural finish的冻结状态表。

### Minor 1：陈旧接线注释

**RESOLVED。** `/tmp/copilot-api-js-task3-review-2543ec46/src/routes/chat-completions/handler-v4.ts` 已把 `ccCommitBoundaries`／旧 `saw*` 叙述改为 grammar-derived terminal/error projections；`/tmp/copilot-api-js-task3-review-2543ec46/src/routes/responses/ws.ts:372-384` 同步说明 WS terminal-only grammar projection，不再把退役 predicate描述成活接线。

### Minor 2：跨 adapter 实例 capability 正式 control

**RESOLVED。** `/tmp/copilot-api-js-task3-review-2543ec46/tests/pipeline/delivery-adapters.unit.test.ts:72-89` 已正式断言：签发实例接受自己的 capability，兄弟实例签发的真实 capability与结构伪造对象均拒绝。authority仍是 Anthropic adapter实例私有 class + WeakSet closure，通用 production mint／validate exports未恢复。

## 双向判据

- **正样本**：完整 Responses item在 RST 前提交；Chat finish_reason+usage产生唯一成功 terminal；签发 adapter接受自身 capability；全部通过。
- **负样本**：Responses首个 done前 RST可 retry、done后 RST不可 retry；Chat无 finish→truncated、stream error→terminal-failure；重复 output_index复用不沿用旧 token；兄弟 capability与伪造 capability拒绝；全部通过。
- 目标套件、driver suite与typecheck均绿；本轮未发现 false-red。

## 事实性发现

### Critical／Important

未发现问题。

### Minor

[Minor] `/tmp/copilot-api-js-task3-review-2543ec46/tests/chat-completions/candidate-response-session.unit.test.ts:68-88` — 正式测试只固化成功 finish分支；truncated／terminal-failure 与非空 `rendererFrames` 目前仅由本轮独立 probe验证 — 预期影响：后续 finish producer改动可能让失败分支漂移而目标 suite仍绿 — 推荐把这三个分支改为 table-driven 正式回归。

[Minor] `/tmp/copilot-api-js-task3-review-2543ec46/tests/pipeline/delivery-adapters.unit.test.ts:132-160` — 正式 Responses adapter测试覆盖 output-index-only三帧，但未固化同 index close后复用及跨 item token不碰撞；本轮独立 probe已通过 — 预期影响：未来把单调 token退化为裸 output_index时，现有测试仍可能绿 — 推荐加入复用／跨 item case。

## 结构怪味

- `/tmp/copilot-api-js-task3-review-2543ec46/src/lib/pipeline/delivery/adapters/responses.ts:17-18,30-47`：adapter-local token registry是有状态 classifier，职责与 candidate-local生命周期一致；无跨 candidate共享，**本轮无需处置**。
- `/tmp/copilot-api-js-task3-review-2543ec46/src/routes/chat-completions/handler-v4.ts:342-346`：协议 finish producer仍在 route candidate factory，符合 Task 3 的 factory wiring边界；Task 4 owner尚未提前接管，**无越界**。
