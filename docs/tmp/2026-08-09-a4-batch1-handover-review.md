# A4 Batch 1 交接状态更新评审

- **评审范围：** `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-nghttp2-cancel-series/HANDOVER.md` 的 `### B.5.2 A4 canonical diagnostics`，以提交 `bb184933f691bcf32a50ed8917a9055a2eed3687` 中的第 269–285 行为准。
- **已读取／执行的证据：** `git show bb184933`、`git show c9a115a5`、`git rev-parse master`、两次 `git merge-base --is-ancestor`、针对 `master` 的生产符号与调用点 `git grep`、正式计划第 141–176 行、`src/lib/context/request.ts:1474-1482`、`tests/context/request-context.unit.test.ts:230-266`；另从 `7f7a073003618f290bfe1881a7adcd310e165ff1` 导出 `/tmp/copilot-a4-review-7f7a0730`，在临时副本完成 C5 基线与变异实跑。
- **总体 verdict：** 修复 major 后可进入下一阶段。
- **blocker 数量：** 0。
- **发现计数：** 0 blocker，2 major。

## 当前状态断言逐条核验

| Claim | 结论与证据 |
|---|---|
| C1 | **已确认。** `master` 解析为 `7f7a073003618f290bfe1881a7adcd310e165ff1`；`git merge-base --is-ancestor c9a115a5 master` 与对 `7f7a0730` 的同一命令均退出 0。对应状态位于 `bb184933:docs/plan/2026-08-06-nghttp2-cancel-series/HANDOVER.md:277`。 |
| C2 | **已确认，但只锚定当前 `master=7f7a0730`。** `git grep -n -E 'H2StreamDiagnostic|H2SessionDiagnostic|onTransportDiagnostic|releaseStreamSlot|transportFailure' master -- src packages ui ui-v4 tests` 无输出；`recordGenerationDispatchDiagnostic` 在生产代码中仅有 `/home/xp/src/copilot-api-js/src/lib/context/types.ts:577` 的契约和 `/home/xp/src/copilot-api-js/src/lib/context/request.ts:1474-1482` 的 ownership 接缝，没有 transport 生产者。对应状态位于第 278–281 行。 |
| C3 | **已确认。** 第 273 行明确把批次标为执行会话所拟；正式计划 `/home/xp/src/copilot-api-js/docs/plan/2026-08-06-history-read-path-and-h2-diagnostics.md:141-176` 只有主题小节，没有 A4-1～A4-5 或其他批次结构。 |
| C4 | **按“H2 transport session”这一窄义已确认。** A4-1 只落了显式 dispatch ownership；生产代码没有 `recordGenerationDispatchDiagnostic` 调用者，也没有 A4 stream/session schema 或生产者。因此当前 History 仍不能回答取消发起方及 H2 transport session 关联。原句的术语歧义另见 Major 1。 |
| C5 | **已亲自复现。** 临时副本基线命令通过：1 pass、0 fail、4 个 `expect()`；将实现改为 `selectGenerationAttempt(dispatch)` 后通过 ambient current attempt 记录，目标测试退出 1，首个失败为第 263 行：expected recovery transport `upstream-ws`，received `http`。第 257–262 行的 primary 归属与 recovery 无诊断断言已先执行且未失败，故归属断言在该变异下仍绿。仓库工作区未做变异。 |
| C6 | **在仓库可核验范围内确认，且文内自洽。** 第 283 行明确记录三类独立检查未做；第 285 行及正式计划第 183 行都要求它们在 A4 最终 commit／最后 merged state 闭合。`bb184933` 树中的 `docs/tmp` 没有 A4 Batch 1 对应 reviewer／verifier／merged-state 报告。仓库证据无法证明未落盘的会话内活动，但未发现与文档状态冲突的证据。 |

## 事实性发现

[major] `/home/xp/src/copilot-api-js/.claude/worktrees/a4-h2-diagnostics/docs/plan/2026-08-06-nghttp2-cancel-series/HANDOVER.md:271` — “session 关联”没有限定为 **H2 transport session**，会与既有客户端会话字段混淆。  
证据：当前 History 已有 `/home/xp/src/copilot-api-js/src/lib/history/types.ts:467` 的 `sessionId`，并由 `/home/xp/src/copilot-api-js/src/lib/history/v3/projection.ts:387` 投影；A4 正式计划第 167–170 行要新增的是 H2 session ref。  
失败场景：后继者可能认为 History 完全没有 session 关联，或复用现有客户端 `sessionId` 承载 H2 connection identity，造成两个不同身份域碰撞。  
修复建议：把第 271 行两处 “session 关联” 改成 “H2 transport session 关联／H2 session ref”，并在批次表首次出现时明确它不同于客户端 conversation `sessionId`。建议由 `gpt-souls:doc-writer` 修订。

[major] `/home/xp/src/copilot-api-js/.claude/worktrees/a4-h2-diagnostics/docs/plan/2026-08-06-nghttp2-cancel-series/HANDOVER.md:273-283` — 易变批次状态缺少统一的 snapshot 基线与可复制重取命令，“未开始”无法由后继者一条命令可靠自证。  
证据：A4-1 只给两个短 SHA；A4-2～A4-5 仅写“未开始”，没有明确其核验基线是 `7f7a0730`，也没有检索范围、命令或替代命名的人工复核条件。精确符号 `git grep` 为空只能证明这些拼写不存在，不能证明等价实现未以别名落地。  
失败场景：master 前进后表格仍以当前态语气显示“未开始”；后继者按冻结的五个符号 grep 得到空结果，会把采用不同命名的已落实现误判为未开始并重复施工。  
修复建议：把表格标成“状态核验于完整 SHA `7f7a…`”，附 C1 ancestry 命令；对 C2 附相关路径的 `git log 7f7a…..master -- <paths>` 与符号检索命令，并明确任何命中或相关路径提交都触发源码复核，空 grep 不单独证明“未开始”。建议由 `gpt-souls:doc-writer` 修订。

## 主观建议

无。本轮只报告 blocker 与 major。

## 结构怪味扫描

扫描范围为本轮新增的状态段、批次表与证据段；判据为“状态权威是否变成无 provenance 的第二写入点”“同名字段是否跨身份域复用”“批次投影是否冒充冻结计划”。发现的身份域术语泄漏与易变状态无重取接缝已分别列为 Major 1、Major 2；未发现批次表被表述为冻结计划，也未发现会把 A4-1 直接读成 A4 全部完成的句子。
