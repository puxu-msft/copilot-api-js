# Task 3 acceptance rereview

## Re-verification at `b8ae7e8c`

**Acceptance PASS**，target `b8ae7e8cf14db15faf3c844ccd6281e1c0b28f9e`，range `300d01a3..b8ae7e8c`。Critical 0、Important 0、Minor 0。

- **PASS——Chat 5／Responses 11。** Chat zero-leak、retry／exhaustion、`[DONE]`、wire error、live partial：5/5；Responses committed-prefix／partial RST／identity：11/11。
- **PASS——Anthropic buffered／driver fence。** `buffered-sink.unit` 9/9；final winner finish、current-attempt callbacks、零泄漏保持。`driver.unit` 46/46。
- **PASS——无 candidate live exact shape。** Compatibility live path恢复精确 `{kind:"complete",headers}`，不无条件新增 `finish`；有 candidate／finish producer时仍保留最终 finish。
- **PASS——branded entry。** `AssembledCandidateResponseOpts` 只封闭“已组装一次”内部入口，observable frame/outcome/callback 顺序未变；Chat／Responses／Anthropic suites全绿。
- **正反控。** 旧 `4967548f` Responses clean/retry 稳定红；`b8ae7e8c` 正确状态全绿。总定向：91 pass、0 fail，397 assertions。

## Re-verification at `8572b892`（superseded）

**Acceptance PASS**，target `8572b892b0be0651d317c7b8d84bb45a881bb61b`，range `300d01a3..8572b892`。Critical 0、Important 0、Minor 0。

- **PASS——Chat buffered 五类。** 首 attempt truncation 零泄漏、retry 后只交最终 response＋`[DONE]`；all-truncate 穷尽只给唯一 error、无 partial／`[DONE]`；clean first try、wire error、live partial 均符合冻结契约。5 pass、0 fail，44 assertions。
- **PASS——Responses buffered 11 类。** Clean／retry／exhaustion、wire error、pre/post item RST、committed prefix 与 partial zero-leak 全绿。11 pass、0 fail，92 assertions。
- **PASS——final winner finish／attempt fence。** Chat 真实 retry 流证明 `ResponseOutcome.finish` 来自 recovery winner；旧 attempt truncated finish 未污染最终 `[DONE]`。Driver buffered controls 9 pass、0 fail，33 assertions；每 attempt 仅解析当前 upstream session，outer callbacks 与当前 candidate callbacks additive。
- **PASS——Responses identity。** `output_index` ordered token 在 wire `item.id/item_id` 漂移、sequential／duplicate integrated fail-closed 下未回归。
- **正反控。** `4967548f` 的错误状态稳定使 Responses clean/retry 红；`8572b892` 正确状态恢复 11/11。未发现新 Critical／Important／Minor。

## Re-verification at `4967548f`（superseded）

**Acceptance FAIL**，target `4967548fcf34389e4ffbce8591df70add00f4e9e`。Critical 0、Important 1、Minor 0。

- **PASS——Chat buffered 五类。** 首 attempt truncation 零泄漏并 retry 后唯一完成＋`[DONE]`；all-truncate 穷尽只给唯一 error 且无 partial／`[DONE]`；clean first try、wire error、live partial 均符合冻结行为。`cc-buffered.it`：5 pass、0 fail，44 assertions。
- **PASS——最终 winner finish。** Retry 后 `ResponseOutcome.finish` 来自 recovery winner 的 `valid-terminal-without-boundary`，handler 据其补最终 `finishReason`；旧 session 的 truncated finish 不再污染提交判定。该性质由首 attempt truncation→第二 attempt success 的真实 HTTP 流验证。
- **PASS——Task 3 定向 controls。** Chat candidate／adapter／single-classification 正样本保持绿。

### Important：本轮 driver 重接后 Responses buffered production seam 回归

单独运行 `tests/responses/responses-buffered.it.test.ts` 即红：完整 `response.completed` 被判 `upstream stream truncated: closed without message_stop`；clean first try 客户端只收到 `event:error`，retry recovery 也无法交付 `COMPLETE_ATTEMPT_2`。根因表面在 `/tmp/task3-4967548f-verify/src/lib/pipeline/driver.ts:1367` 新增 `currentSession(...).responseOpts` 二次 merge 后，Responses terminal projection 未进入本 attempt 的 commit gate。该正确状态在上一 target 为绿，本轮新回归，Task 3 不可放行。

## Re-verification at `c0d52d22`（superseded）

**Acceptance PASS**，target `c0d52d229fd60b39b2489c2653a7e1c1137f8457`。Critical 0、Important 0、Minor 0。

- **PASS——wire error + nonempty renderer flush。** `flushResponse` 恰调用一次，但 flush frame 不进入 output／outcomes；恰一个 failed `response-terminal`、零 `protocol-error`，`sawUpstreamError=true`。
- **PASS——其他 nonempty finish frames。** success 的 flush frame 保留于 terminal `responseFrames`；truncated 与显式 nonwire terminal-failure 的 flush frame先进入 `buffer-real-frame`，随后各保持唯一 typed error semantic/cause。
- **PASS——相邻回归。** Chat success、Responses RST complete-prefix／partial-tail、Responses identity、capability/getter/UTF-8/single-classification 均未回归。
- 命令：`env -C /tmp/task3-c0d52d22-verify bun test <chat-candidate,responses-buffered,delivery-adapters,candidate-session>` → **35 pass、0 fail**，222 assertions。

## Re-verification at `41e79a60`（superseded）

**Acceptance PASS**，target `41e79a60c193de97775f9e61a9aea2e12cf405a7`。Critical 0、Important 0、Minor 0。

- **PASS——原 Important 闭合。** Production Chat in-band error 产生恰一个 failed `response-terminal`，finish `complete→natural-drain` 只确认闭合；零 `protocol-error`／`post-terminal-frame`，`sawUpstreamError=true`。
- **PASS——显式 terminal-failure。** 非 wire finish failure 仍产生恰一个 typed `protocol-error/terminal-failure`，无 response terminal，cause 保持原 Error。
- **PASS——相邻契约。** Chat success `finish_reason→usage` 保留两帧并产生唯一 complete terminal；no-finish truncation、Responses RST complete-prefix／partial-tail、identity/capability/getter/UTF-8/single-classification controls 未回归。
- 命令：`env -C /tmp/task3-41e79a60-verify bun test <chat-candidate,responses-buffered,delivery-adapters,candidate-session>` → **34 pass、0 fail**，215 assertions。

## Prior verdict at `2543ec46`（superseded）

此前 **Acceptance FAIL**：Critical 0、Important 1、Minor 0；该 Important 已由 `41e79a60` 修复并以上述真实 production seam 复验闭合。

## Acceptance matrix and evidence

- **PASS——Responses production complete-prefix／partial-tail。** `tests/responses/responses-buffered.it.test.ts` 11/11 绿；pre-first-item RST 不泄漏 `BLOCK_ZERO_ATTEMPT1` 且 retry 后交付完整两 item；post-first-item RST 保留 `BLOCK_ZERO`、不泄漏 `BLOCK_ONE`、不 retry、唯一 error terminus。
- **PASS——Responses ordered token on valid sequential items。** 独立 frame matrix 使用 `added.item.id=A → delta.item_id=B → done.item.id=C`，身份仍由 `output_index` 稳定为同一 token；下一 item 即使复用 wire id 也得到新 token。正确状态 16/16 绿。
- **PASS——Chat successful production seam。** `finish_reason → usage → finish` 产生唯一 `response-terminal`，`responseFrames` 精确保留 `[finish, usage]`，`sawMessageStop=true`、`sawUpstreamError=false`。
- **PASS——Chat no-finish。** 独立 production candidate 输入仅 partial delta 后 drain，最终 typed `protocol-error/truncated`，messageStop=false、upstreamError=true。
- **PASS——既有回归。** owner-bound capability 跨实例拒绝；getter throw 归 `adapter-exception`；五 adapter 255-byte diagnostic 接受、258-byte 拒绝；single classification 保持定向测试绿。

## Findings

### Important 1：Chat wire error 被消费两次，冻结的 terminal-failure 被降格成 post-terminal-frame

**State → wrong result：** production Chat candidate 收到 `event:error` 后，adapter frame classification先产生 failed `response-terminal`；route finish 又因 `state.acc.streamError` 返回 `terminal-failure`，grammar 在 terminal 状态把它改写为 `post-terminal-frame`。最小复现实测 outcomes 为 `[response-terminal(failed), protocol-error(post-terminal-frame)]`，不是冻结的唯一 `terminal-failure` typed result。位置：`/tmp/task3-2543ec46-verify/src/routes/chat-completions/handler-v4.ts:342-346` 与 adapter error classification。命令 `bun test tests/chat-completions/candidate-response-session.unit.test.ts`：原正确样本通过，新增 wire-error probe 红，exit 1。

## Commands

- `env -C /tmp/task3-2543ec46-verify bun test tests/responses/responses-buffered.it.test.ts` → 11 pass、0 fail。
- 独立 Responses 正矩阵并入 adapter test → 16 pass、0 fail；重复 active index 经真实 adapter→grammar seam fail closed 为 `nested-unit`，16 pass、0 fail。
- 独立 Chat production probes：success 与 no-finish 绿；wire-error typed probe 红，实际 `post-terminal-frame`。

## Controls

正确状态和错误状态均已运行：sequential／wire-ID 漂移 items、完整 Chat 与 duplicate active index 的 integrated fail-closed 均绿；wire-error typed semantic 红。未修改生产代码，临时 probes 已从 scratch tree 恢复。