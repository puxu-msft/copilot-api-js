# Batch 1b 收尾整改复审（Round 4）

- **评审范围：** 整改提交 `b98fe5bb`、其相对 `9a6226b6` 的文档改动、当前两份整改后文档、上一轮 4 条 major，以及 user-level `closing-a-development-session` 的 canonical `closeout-contract`。
- **已读取／执行的证据：** `git show b98fe5bb` 完整 diff；当前终态报告、临时清单、上一轮评审全文；`/home/xp/.claude/skills/closing-a-development-session/SKILL.md:15-117`；逐项 stage／requires 对账、branch reachability、manifest 56 行字节独立求和。
- **总体 verdict：修复 major 后可进入下一阶段。**
- **blocker 数量：0。**

## 事实性发现

[major] `/home/xp/src/copilot-api-js/.claude/worktrees/history-worker-batch-1b-resume/docs/tmp/2026-08-08-history-worker-batch-1b-terminal-report.md:103-119` — 阶段表仍违反 canonical `requires` 图，把未满足依赖的后续 stage 标为完成。
证据：`/home/xp/.claude/skills/closing-a-development-session/SKILL.md:41-88` 明定 `review_temp_manifest → clean_temp → resolve_branch → draft_terminal_report → review_closeout_draft → verify_installed_location → recommend_assets → update_terminal_report → review_closeout_final → report_terminal`，且 `freeze_truth → inventory_job_tmp` 开始另一条覆盖全链的依赖。
失败场景：stage 8 为 ❌ 时，9–17 均不得宣告达成；更早的 stage 1 又是“部分”，因此严格按 contract，2–17 全部受未满足前置阻断。报告却把 2–7、9–15 标为 ✅，并称只有 8／16／17 未达成。
修复建议：区分“动作／证据已发生”与“contract stage 已达成”；先完成 stage 1、8，再按 requires 顺序更新，或将受阻阶段标为未达成并同步修正状态行、尚待动作和复验清单的“三项”口径。

[major] `/home/xp/src/copilot-api-js/.claude/worktrees/history-worker-batch-1b-resume/docs/tmp/2026-08-08-history-worker-batch-1b-terminal-report.md:41,87-91,138` — `head_reachable` 的局部修正成立，但全文仍保留相反的 worktree 清理门，终态断言未统一。
证据：当前 `git branch --contains 9a6226b6` 与 `git branch --contains b98fe5bb` 都输出 `* worktree-history-worker-batch-1b-resume`；`:87-91` 因此正确断言三条移除前置已具备，且明确说 `master` ancestry 不是 `head_reachable` 的门。
矛盾：`:41` 仍写“收尾提交确认在 `master` 祖先后”才可决定清理 worktree；`:138` 又把 fast-forward 称为“可清理本 branch／worktree”的门。两处继续把 branch 集成条件错误施加到 worktree。
陈旧性：`:89` 写死 `9a6226b6` 只证明旧候选可达，当前 `HEAD=b98fe5bb` 已前进；当前命令虽也证明 `b98fe5bb` 被同一 durable branch 包含，但文档没有记录该当前对象。
修复建议：把 `:41`、`:138` 拆成 branch 与 worktree 两套结论；branch 等待 master ancestry，worktree 仅受 clean／current-HEAD reachable／owned 与用户决定约束，并用当前 HEAD 或动态命令取代 `9a6226b6`。

[major] `/home/xp/src/copilot-api-js/.claude/worktrees/history-worker-batch-1b-resume/docs/tmp/2026-08-08-history-worker-batch-1b-terminal-report.md:46,117-119,137-143` — 上一轮“终态断言矛盾”整改未完整覆盖旧终审引用，并把未闭合整改写成“全额整改”。
证据：`:46` 仍把已经被第三轮 4 major 推翻的 `2026-08-08-history-worker-batch-1b-closeout-review-final.md` 单独称为“终审报告”；真正第三轮报告只在 `:118,137` 作为未闭合评审出现。
矛盾：`:117` 与 `:137` 声称四条 major 已“整改／全额整改”，但本复审已证 stage requires 传播与 worktree 清理门两条仍未闭合；`:140-143` 的“终审处置”也只列更早的 D1／D2，不列本次四条。
失败场景：读者从“临时证据”或“终审处置”进入，会把旧 0 major 报告当当前最终 verdict，绕过当前待复审状态。
修复建议：将 `:46` 明确标为“前两轮历史评审”，把第三轮与本轮复审设为当前评审链；四条逐项列 disposition，未通过本轮复审前不得写“全额整改”。
补充证据：同一矛盾还出现在 `/home/xp/src/copilot-api-js/.claude/worktrees/history-worker-batch-1b-resume/docs/tmp/2026-08-08-history-worker-batch-1b-terminal-report.md:49`，该行也把 `master` ancestry 写成“可清理本 branch／worktree”的门。

## Claims 核验结果

- **C1 已确认：** canonical stages 位于 `/home/xp/.claude/skills/closing-a-development-session/SKILL.md:97-115`；脚本解析 contract 与报告 `/home/xp/src/copilot-api-js/.claude/worktrees/history-worker-batch-1b-resume/docs/tmp/2026-08-08-history-worker-batch-1b-terminal-report.md:101-119`，两侧均为 17 项且 `exact_order_equal=True`。
- **C2 已推翻：** requires 传播结果见 finding 1；仅由 stage 8 未达成就会连带阻断 9–17，另有 stage 1“部分”独立阻断 2–17，故不只是 8／16／17 未达成。
- **C3 已收窄：** `git branch --contains 9a6226b6` 实际输出 `* worktree-history-worker-batch-1b-resume`，所以针对旧 commit 的论证成立；当前 `HEAD=b98fe5bb`，同命令对 `b98fe5bb` 也输出该 branch，但正文仍锚旧 commit，且跨章节保留相反清理门，见 finding 2。
- **C4 已推翻：** 状态行 `:2-5`、尚待动作 `:76-80`、阶段表 `:103-119`、清单 5／6 `:137-138` 主线方向一致地承认未闭环；但 `:41,49,87-91,138` 对 worktree 门互斥，`:46,117,137,140-143` 对当前终审／整改完成度互斥，见 findings 2–3。
- **C5 已确认：** 独立脚本从 manifest Markdown 数据行解析出 `row_count=56`、`sum=6568699`；目标路径在 `/home/xp/src/copilot-api-js/.claude/worktrees/history-worker-batch-1b-resume/docs/tmp/2026-08-08-history-worker-batch-1b-temp-manifest.md:73`，值为 `431517`。
- **C6 已确认无静默删除：** `git diff b98fe5bb^ b98fe5bb --unified=80` 显示 manifest 仅替换一个数值；终态报告整改前后均保留 11 个 `#` 标题及复验清单 1–6 行，文件由 135 行增至 159 行，未丢小节标题或列表行首。

## 数字口径审计

本轮新增数字中，17-stage 集合有 canonical contract 锚点，56 行／6,568,699 bytes 有独立解析求和，431,517 有逐行值；未另发现可独立成 major 的无口径数字。`12 条`、`89 pass` 等未改动历史断言虽未在原句完整内嵌命令，但分别指向既有评审／“Git、发布与工作树状态”证据，本轮未据其关闭新结论。

## 结构怪味扫描

扫描范围为整改 diff、终态报告的状态／尚待动作／branch-worktree／stage table／复验清单／终审处置接缝。怪味类型是“同一状态跨章节重复且同步不完整”；处置为本轮修复，具体落点即 findings 1–3，不宜记 backlog，因为它直接阻止 closeout contract 闭环。

### C4 终态表述逐项清点

1. 状态行 `terminal-report.md:2-5`：交付内容已进主线；closeout 未闭环；8／16／17 未达成；当前不是终态件。结论：其中“只三项”受 finding 1 推翻。
2. 「Git、发布与工作树状态」`:32`：五次历史 fast-forward 已完成，但本报告／清单修订再次领先 master；`:40`：未发布；`:41`：保留 branch／worktree，且把 master ancestry 设为 worktree 清理条件。结论：`:32,40` 与草稿状态相容；`:41` 与 `:87-91` 冲突。
3. 「临时证据」`:46`：旧前两轮报告被无限定称为“终审报告”；`:49-50`：master ancestry 被称为可清理 branch／worktree 的门。结论：前者与当前第三／四轮评审链冲突，后者与 `:87-91` 冲突。
4. 「尚待动作」`:76-80`：交付内容无待办；closeout 尚有 8／16／17 三项，随后须 fast-forward。结论：方向正确，但“只有三项”受 finding 1 推翻。
5. `resolve_branch` `:86-91`：branch 待 master ancestry，worktree clean／reachable／owned 已齐备且去留交用户。结论：这是正确拆分；与 `:41,49,138` 冲突，reachable 锚点又陈旧。
6. 阶段表 `:103-119`：1 部分、2–7 ✅、8 ❌、9–15 ✅、16–17 ❌。结论：集合与顺序正确；stage 1“部分”使 2–17 受阻，stage 8 又独立使 9–17 受阻，表内 ✅ 违反 requires 传播。
7. 复验清单 `:133-138`：1–4 已完成，5 尚未闭环，6 尚待提交／复审／fast-forward。结论：5／6 的 pending 方向正确；`:138` 的 worktree 门错误，且“四条全额整改”被本轮 findings 证否。
8. 「终审处置」`:140-143`：只记录更早轮次 D1／D2 已采纳，未处置上一轮四条 major。结论：与 `:117,137` 的“本轮四条已整改／全额整改”不相符。
