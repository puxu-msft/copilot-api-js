# Task 3 acceptance rereview

## Verdict

**Acceptance FAIL**，target `2543ec46ee06f6dca1d94b85ea6d5904d3d70151`。Critical 0、Important 1、Minor 0。

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