# Kick-off：auto-truncate 移除遗留死代码 review + cleanup

> **✅ 已完成（2026-07-13，master `3ecda617`，分支 chore/auto-truncate-deadcode-cleanup rebase+FF 已并入并删除）。** 实际裁决**与本 kickoff 预期不同**：独立 reviewer 对抗裁决 + 主会话亲手复核后，4 项中**只 1 项该删、3 项保留**——① orphan-filter **删 4 函数**（非 kickoff 说的「五函数」，`isLegalLeadingUserMessage` 有间接生产消费者须留）；② preSend **保留**（在飞 cell-assembly 重构 RFC 明确保留为 OutboundLeg 方法槽）；③ PipelineInfo.truncation **保留**（richest-data-flow 旧库读侧 + Vue ui/ 10 处活消费，非「惰性 inert」）；④ countTotalTokens **保留+注释**（roadmap 复用锚点 + 级联孤儿）。权威裁决与订正见 [docs/todo/deferred-backlog.md](../todo/deferred-backlog.md)「✅ 已裁决：auto-truncate 移除后遗留的死代码」条。副产：learn-by-analogy 确认 OpenAI 版 orphan-filter 是活 sanitize 代码、不动。

> 复制本文件正文作为新会话的起始提示词。这是一个**小到中等的清理任务**（删除移除 auto-truncate 后无消费者的死代码），走「调研 → review 裁决 → 删除 → 复核 → 提交」的轻量流水线，不需要完整 SDD。

---

## 背景

`copilot-api-js` 已于 2026-07-13 移除 auto-truncate 截断本体、保留 calibration 因子模型（合并 master `06c56644`，RFC `docs/rfc/2026-07-13-remove-auto-truncate-keep-calibration.md`）。移除时为**避免仓促删除已测代码**，把四处「无生产消费者但有测试覆盖 / 有独立价值」的符号显式**暂缓**，完整记录在 [docs/todo/deferred-backlog.md](../todo/deferred-backlog.md) 的「auto-truncate 移除后遗留的死代码」条目（含补充的 `countTotalTokens`）。本任务是对这批暂缓项做一次**集中裁决 + 清理**。

**权威单一事实源**：先读 `docs/todo/deferred-backlog.md` 该条目全文（根因 / 当前行为 / 理想架构 / 为何暂缓 / 若做需改什么），本提示词只是它的执行入口，判据以 backlog 条目为准。

## 四个待裁决项

1. **orphan-filter 原语**（`src/lib/anthropic/message-tool-utils.ts`）：`filterAnthropicOrphanedToolResults` / `filterAnthropicOrphanedToolUse` / `getAnthropicToolResultIds` / `getAnthropicToolUseIds` / `isLegalLeadingUserMessage`——截断算法删除后仅 `ensureAnthropicStartsWithUser` 有生产消费者（`sanitize/system-messages.ts`），其余只被 `tests/anthropic/message-sanitizer.it.test.ts` + `tests/anthropic/leading-user-message.unit.test.ts` 单测。
2. **`FormatCodec.preSend?` 扩展缝**（`src/lib/pipeline/types.ts` + `src/lib/pipeline/driver.ts` 的 `if (deps.codec.preSend)` 守卫）：唯一实现（anthropic 预截断）已删，现无 codec 实现它。
3. **`PipelineInfo.truncation` 字段**：`recordRetryPipelineStateV4` 已不再 populate；类型字段 + history 序列化 + 前端 `~backend/*` re-export / ui-v4 展示（若有）现为惰性 inert。
4. **`countTotalTokens` 死导出**（`src/lib/anthropic/token-counting.ts`）：caliber 统一为 `countTotalInputTokens` 后无生产/测试消费者（只剩注释提及）。

## 判据轴（务必按此）

- **长远正确 + 无死代码 > 短期将就**——这是清理任务，倾向删净；但**不豁免 `no-destructive-workspace-loss`**：这些是**有测试覆盖 / 可能有独立价值的原语**，删除须是**深思熟虑 + 经 review** 的删除，绝不「无消费者就反射式删」。
- **`verifying-authoritative-claims`**：任何「0 消费者 / 可安全删除」的绝对断言（无论来自你自己的 grep、subagent、还是 backlog 记述）都**不自证**——亲手 `grep -rn` 全仓（含 `tests/`、`ui/`、`ui-v4/src`、`docs/` 引用）逐处核实，读每个候选删除点的所有引用 `file:line` 后再动手。
- **区分「删」vs「保留并注释」**：某原语若判为通用消息卫生 / 扩展缝且有合理未来复用意图，可**保留 + 加注释说明「有意保留、当前无消费者」**（而非删），把判断显式化。逐项给出「删 / 保留」的理由。

## 建议流程

1. **调研**：读 backlog 条目 + 四项的每个引用点（含 test 消费者）。确认 master 当前状态（可能已被后续会话改动）。
2. **派 reviewer 裁决**（`subagent-explicit-rubric`）：把四项 + 上述判据轴交独立 reviewer，让它对每项给「删 / 保留 + 理由」建议 + 核实「无生产消费者」是否属实。**吸收其客观事实、对其判断谨慎取舍**；它的绝对断言你亲自复核。
3. **执行删除**（对判为删的项）：
   - orphan-filter：`git rm` 相关函数段 + 两测试文件对应 describe 块（保留 `ensureAnthropicStartsWithUser` + 其测试）。注意 `message-tool-utils.ts` 若只剩 `ensureAnthropicStartsWithUser` 可考虑合并/改名。
   - `preSend`：删接口方法 + driver 守卫 + 相关注释。
   - `PipelineInfo.truncation`：端到端删（类型 + `history/sqlite/serialize.ts` 往返 + 前端 `~backend/*` + ui-v4 消费点），更新 history serialize 往返测试；**注意** ui-v4 穷尽 Record 可能因删字段报错，须跑 `typecheck:ui-v4`。
   - `countTotalTokens`：删导出（先确认删除不级联使内部 helper 变孤儿；若级联，一并评估）。
4. **验证**：`bun run typecheck` + `bun run typecheck:ui-v4`（+ `typecheck:ui` 若动 Vue）+ 相关 `bun test` 全绿；全仓 grep 确认无悬空引用。**并发 master 常移动**——收尾合并走 rebase + FF（rerere 助力），参考本次 [[project-remove-auto-truncate-keep-calibration]] 的集成经验。
5. **收尾**（`session-closeout`）：删干净后从 backlog 条目移除该项（或标注「已清理」）；DESIGN.md 若有对应模块表述同步；细粒度提交（显式 pathspec、conventional commits、无模型署名）。

## 工程纪律（本项目）

- 隔离 worktree（`.worktrees/`）+ 独立分支，避与并发会话冲突；共享文件行级共存、显式 pathspec commit。
- 绝不杀 4141 主服务器；起测试实例用非 4141 端口、按 PID 精确清理。
- 中文正文，ASCII 保留标识符 / 路径 / 代码。
