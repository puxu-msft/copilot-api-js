# 评审报告：thinking drop summary

## 评审范围

- Commit 范围：`f0c799a507d3fbaa301be47512d3aad04d679d20..1b248ac1100375e0d404bd0bb0b7eed1dbf3b20a`。
- `pwd -P`：`/home/xp/src/copilot-api-js/.worktree/agent-ae254b3b878702268`。
- `git rev-parse --show-toplevel`：`/home/xp/src/copilot-api-js/.worktree/agent-ae254b3b878702268`。
- 初始 `git rev-parse HEAD`：`1b248ac1100375e0d404bd0bb0b7eed1dbf3b20a`，与要求一致。

## 已读取／执行的证据

- 读取了本范围全部 11 个改动文件、对应 parent diff，以及 `src/lib/pipeline/driver.ts`、`src/lib/history/v3/projection.ts`、`src/lib/anthropic/synthetic-reasoning.ts` 的生产接线。
- `git diff --check f0c799a507d3fbaa301be47512d3aad04d679d20..1b248ac1100375e0d404bd0bb0b7eed1dbf3b20a`：通过。
- 初始 focused test：`bun test tests/openai/anthropic-to-responses-request.unit.test.ts tests/context/request-buffered-merge-info.unit.test.ts tests/anthropic/anthropic-codec-forward-leg.it.test.ts`，36 tests／3 files 通过。
- `bun run typecheck`：通过。
- `bun run test:backend`：`16 shards · 5539 tests · 5539 pass · 0 fail · 44.67s`。
- 正控：用冻结 exact patch 删除 `src/lib/openai/translate/anthropic-to-responses-request.ts:135` 的 `opts?.onTranslationDegradation?.(degradation)`；`bun test tests/openai/anthropic-to-responses-request.unit.test.ts tests/anthropic/anthropic-codec-forward-leg.it.test.ts` 变红，纯转换测试在 `:123`／`:162` 收到空 degradation 数组，forward-leg IT 在 `:156` 收到 `undefined` 而非 History diagnostic。随后 `git apply --reverse --check` 和反向 apply 成功恢复。
- 恢复后 `bun test tests/openai/anthropic-to-responses-request.unit.test.ts tests/anthropic/anthropic-codec-forward-leg.it.test.ts`：31 pass／0 fail。

## 总体 verdict

可合并。blocker 数量：0；major 数量：0；minor／nit 未列出（按本轮输出范围）。

## 原 MAJOR 处置

原 `[major] tests/anthropic/anthropic-codec-forward-leg.it.test.ts:140-162`：**fixed**。该 finding 质疑 callback 接线是否被测试真正咬住；冻结 patch 删除唯一回调调用后，纯 translator 测试和真实 codec／cell／driver forward-leg IT 均因预期的结构化 degradation 缺失而红，且反向精确 patch 恢复后 31／31 绿。因此，手工 exact-patch 正控已直接验证此提交的目标机制，不需要把 mutation harness 作为产品合并硬门。

## 结构怪味扫描

- `tests/anthropic/anthropic-codec-forward-leg.it.test.ts:140-162` — 原测试接缝正控缺失，处置：本轮以 exact-patch 正控实测闭合；无需产品改动。
- 其余已扫描范围（translator、hub、Responses cell、RequestContext／History 投影）未发现重复计数源、死接口或新增职责错位：计数只在 `translateAnthropicToResponses` 的单次遍历产生，结构化投影通过单一 callback 进入 context。

## C1–C9 当前状态命题

- C1：通过。`src/lib/openai/translate/anthropic-to-responses-request.ts:127-143` 仅在计数大于零时调用一次 callback，并对 source-signed 合计仅发一次 `consola.info`；`tests/openai/anthropic-to-responses-request.unit.test.ts:98-139` 断言三块只一次 INFO、零 WARN。
- C2：通过。`src/lib/openai/translate/anthropic-to-responses-request.ts:141-143` 对 unsigned 合计仅发一次 WARN；`tests/openai/anthropic-to-responses-request.unit.test.ts:142-179` 断言 mixed 输入只一次 WARN 且严重度仍为 WARN。
- C3：通过。`src/lib/openai/translate/anthropic-to-responses-request.ts:231-235,268-275` 先识别 sentinel 并重建 `reasoning`，因此不计入两种 dropped 类；`src/lib/anthropic/synthetic-reasoning.ts:49-52` 定义 sentinel 谓词；`tests/openai/anthropic-to-responses-request.unit.test.ts:44-95` 覆盖 payload 与 bare-prefix 两种合法 sentinel。
- C4：通过。schema 在 `src/lib/pipeline/translation-degradation.ts:1-9` 与 `src/lib/history/types.ts:213-237`；累计在 `src/lib/openai/translate/anthropic-to-responses-request.ts:117-135`；独立 merge slot 在 `src/lib/context/request.ts:328-352`，终态 metadata 投影在 `src/lib/context/request.ts:939-946`，History V3 投影在 `src/lib/history/v3/projection.ts:353-386`；`tests/context/request-buffered-merge-info.unit.test.ts:45-79` 覆盖全量替换与 terminal entry。
- C5：通过。唯一生产 callback 安装点为 `src/lib/codec/openai-responses/openai-responses-cell.ts:96-101`；`src/lib/pipeline/hub-translate.ts:148-153` 仅 Anthropic→Responses bridge 消费它，其他 cell 分派记录在 `src/lib/pipeline/hub-translate.ts:171-199`；集成测试在 `tests/anthropic/anthropic-codec-forward-leg.it.test.ts:140-162` 走真实 codec、driver 与 Responses target。
- C6：通过。普通块转换的分支仍分别为 `src/lib/openai/translate/anthropic-to-responses-request.ts:221-255,278-306`；`tests/openai/anthropic-to-responses-request.unit.test.ts:282-408` 覆盖 text、tool_use、tool_result、image 与其独立 degradation WARN；本 commit 对这些分支未作行为性改动。
- C7：通过。纯转换、RequestContext 持久化和真实 codec/cell 接线分别由 `tests/openai/anthropic-to-responses-request.unit.test.ts:98-179`、`tests/context/request-buffered-merge-info.unit.test.ts:45-79`、`tests/anthropic/anthropic-codec-forward-leg.it.test.ts:140-162` 覆盖。冻结 exact-patch 正控删除 translator callback 后，纯转换断言 degradation 数组为空而红，forward-leg IT 断言 `pipelineInfo.translation.anthropicToResponses` 为 `undefined` 而红；恢复后两文件 31／31 绿。
- C8：通过。parent 的逐块 `dropWarn("dropping a thinking block with a non-sentinel signature…")` 位于 `f0c799a…:src/lib/openai/translate/anthropic-to-responses-request.ts:224`，现代码已无该生产路径，改由 `src/lib/openai/translate/anthropic-to-responses-request.ts:136-143` 汇总；独立 `server_tool_use`、tool_result image、native server tool WARN 仍在 `:243-245,331-348,399-420`，且测试在 `tests/openai/anthropic-to-responses-request.unit.test.ts:227-248,324-357,387-405` 保留。
- C9：通过。`src/lib/openai/translate/anthropic-to-responses-request.ts:127-144` 以 `droppedThinkingBlockCount > 0` 为唯一新增 callback／INFO／WARN gate；零 dropped 的纯文本与 sentinel 路径不会进入该分支，且 sentinel 测试 `tests/openai/anthropic-to-responses-request.unit.test.ts:44-95` 可重建 reasoning 而未创建 degradation。
