# 收尾指令文本独立评审

## 总结

- **评审范围：** 固定 commit `5405056b137c93d646314ebc5878952dd0827c05` 的 `.claude/skills/process-lifecycle-shutdown/SKILL.md:140-142`、`docs/memory/methodology-false-red-from-process-global-quantities-not-the-mechanism.md:1-20` 与 `docs/memory/MEMORY.md:90`。
- **已读取／执行的证据：** 精确 diff；两份 patch 全文；相关测试、处置记录与 timing XML；`git apply --check`、`git apply --numstat`、`git ls-tree`、`rg`、`git log -S/-G`。评审开始时 `pwd -P` 为 `/home/xp/src/copilot-api-js/.claude/worktrees/fix-shutdown-review-findings`，`HEAD` 为固定 commit，目标文件无工作区 diff。
- **总体 verdict：** 修复 major 后可定稿。
- **blocker 数量：** 0。

## 可核验断言逐条结论

- **C1 已确认：** `docs/tmp/2026-08-08-lossless-shutdown-mutation-drop-generation.patch` 与 `docs/tmp/2026-08-08-lossless-shutdown-mutation-drop-lightweight.patch` 均存在；在固定 commit 分别执行 `git apply --check <patch>` 均退出 0。
- **C2 已收窄：** 两份 patch 的 `git apply --numstat` 都是 `1 1 src/lib/shutdown.ts`，patch 各自只把 `getActive()` 的 registry union 改成单侧 registry（patch `:9-10`）；apply→目标测试变红→reverse-check→reverse→复绿与变异方向一致，但文字协议本身不完整，见 M1。
- **C3 已确认：** `git ls-tree -r --name-only 5405056b docs/tmp | rg -i 'sigusr2.*patch|patch.*sigusr2|\.patch$'` 只列出上述两份 registry patch；patch 内检索 `SIGUSR2|isTerminationSignal` 也无命中，故 `SKILL.md:142` 的“①的 patch 未归档”成立。
- **C4 已确认：** 当前 `tests/pipeline/driver.unit.test.ts:468-497` 的四个参数化 408 负样本已改为 constructor identity、`classifyError`、attempt、`recordAttemptFailure` 与原错误 rejection，不再断言空 timer；`git log -G 'liveTimerDelaysMs.*\[\]'` 显示旧空集合断言由 `77d6d479` 删除。`tests/infra/validate-entry-evidence.unit.test.ts:38-43` 当前确有文件级 `setDefaultTimeout(30_000)`，与正文的历史描述相符。
- **C5 部分确认：** `docs/tmp/2026-08-08-validate-entry-evidence-timings.xml:2-4,21` 支持 43 个用例、45.395 秒与最慢 4.561754 秒；源码静态 `test(` 声明数也为 43。7.3／9.5／7.4 秒没有可达原始输出，见 M3。
- **C6 已确认：** `docs/memory/methodology-false-red-from-process-global-quantities-not-the-mechanism.md:20` 的三个 `[[...]]` 均解析到现存的同名 `docs/memory/*.md`；`docs/memory/MEMORY.md:90` 的相对链接目标也存在。
- **C7 已确认：** `docs/memory/methodology-false-red-from-process-global-quantities-not-the-mechanism.md:1,5` 的 `name` 与文件 basename 完全一致；`type: feedback` 在本库大量既有 memory 中使用，是现行取值之一。
- **语言规范：** 对本轮新增段、memory 正文及新增索引行执行中英文相邻半角标点扫描，未发现中文句子混用半角 `,.:;?!()`；技术标识符与 code 保持 ASCII。

## 事实性发现

[major] `/home/xp/src/copilot-api-js/.claude/worktrees/fix-shutdown-review-findings/.claude/skills/process-lifecycle-shutdown/SKILL.md:142` — 复跑协议引用了一个未列入序列的 `--check`，且失败处理与“目标测试”选择不可机械执行。— 列出的前置动作是直接 `git apply <patch>`，随后却说“若 `--check` 失败说明该行已变”；序列里唯一的 check 是注入后的 `--reverse --check`，其失败不表示注入前“该行已变”。“只跑目标测试”也未逐 patch 给出命令／selector，`--reverse --check` 失败后是否必须停止未写明。— 明列前置 `git apply --check <patch>`、每份 patch 的目标测试命令、任何 apply/check 非零即停止，以及恢复后复绿与目标源码 diff 为空；把“需要时”改成由具体触发条件判定，避免自行宣称“这次不算”。

[major] `/home/xp/src/copilot-api-js/.claude/worktrees/fix-shutdown-review-findings/docs/memory/methodology-false-red-from-process-global-quantities-not-the-mechanism.md:7,9,14` — “最常见的根因不是污染”“别先找污染源”把尚未排除的跨文件全局状态泄漏排除在诊断顺序之外。— 同文 `:9` 的证据恰是前置 fixture 异步注册的无关 process-global timer；既有 `docs/memory/methodology-full-suite-red-classify-before-pollution-playbook.md:17` 要求逐失败分类，而 `.claude/skills/debugging-test-pollution/SKILL.md:11-13` 把单跑绿、全套件红和顺序变化列为污染信号。直接 oracle 确实能消除本例 false-red，但不能证明 fixture 无需清理或该类症状通常“不是污染”。— 改成并列假设：先判 oracle 是否直接观测目标机制，同时检查全局量由谁留下；oracle 错配与资源泄漏可同时成立，按独立证据分别处置。

[major] `/home/xp/src/copilot-api-js/.claude/worktrees/fix-shutdown-review-findings/docs/memory/methodology-false-red-from-process-global-quantities-not-the-mechanism.md:10,20` — 7.3／9.5／7.4 秒被写成“实测”，但正文指向的“耗时原始数据”不含这三次 shard 超时。— 可达来源只有 `docs/tmp/2026-08-08-lossless-shutdown-review-dispositions.md:63` 对同一数字的再次转述；XML 的 `:2-4,21` 仅记录单文件 46.113／45.395／4.561754 秒，`git log -S '7.3／9.5／7.4'` 也只追到转述提交，无法独立复现或检查口径。— 归档三次 shard 失败的原始 test 输出并注明命令、commit、shard 与统计字段；若原始证据已不可得，保留现象但把精确数字显式标为“未交叉验证／仅见处置记录转述”。

## 主观建议

无。上述三项均为可验证的指令可执行性、诊断冲突或证据来源问题。

## 结构怪味与方案反思

- **结构怪味：** `SKILL.md:140-142` 的事实声明、证据位置与复跑步骤分成两段，第二段又靠“上述形态／目标测试／需要时”回指，属于可执行契约的隐式依赖；本轮应修为同一处显式命令与失败分支，不建议删除证据边界条款。
- **更好的内部替代方案：** 继续使用项目现有 exact patch + `git apply`，无需新增证明基础设施；把现有原语写成无歧义、逐 patch 的命令即可。
- **判据判别力：** 正确基线要能 apply-check，目标 omission 必须让指定测试因目标机制变红，reverse 后必须复绿；三段缺一都不能声称 patch 可复跑。
- **成熟第三方方案：** 不需要引入第三方库；Git 原生 patch/check/reverse 能完整表达该流程，问题在指令接线而非工具能力。


## 未卷入第三方复评：M1（固定 commit `2c248536`）

- **结论：FIXED。** `.claude/skills/process-lifecycle-shutdown/SKILL.md:142-154` 已闭合原 M1；0 blocker／0 major。
- `:150` 明列前置 `git apply --check <patch>`；失败时要求停止、按当前源码重新构造 exact patch，并禁止修改旧 patch 去凑。
- `:144-147` 逐 patch 给出目标命令；`git ls-tree 2c248536` 确认 `tests/shutdown/shutdown-messages-lossless.http.test.ts` 与 `tests/history/model-operation-bypass.http.test.ts` 均存在。
- `:142` 明定任何一步非零即停止；`:153-154` 要求 reverse-check／恢复、同一测试复绿，并确认 `git diff -- src/lib/shutdown.ts` 为空。


## 未卷入第三方复评：M2（固定 commit `2c248536`）

- **结论：FIXED。** `docs/memory/methodology-false-red-from-process-global-quantities-not-the-mechanism.md:3,8,15-18` 与 `docs/memory/MEMORY.md:90` 均不再把污染后置。
- frontmatter 明写“两侧并行查”，正文写成“两个并列的嫌疑”及“两条假设并行推进，不要按顺序排除”，索引同步为“与污染并列查、可同时成立”。
- 正文 `:8` 以 driver 实例明确两者叠加：fixture 留下全局 timer，同时 retry oracle 不应观测全局 timer；只修任一侧都留坑。
- `:17` 明确指向 skill `debugging-test-pollution` 与 `methodology-full-suite-red-classify-before-pollution-playbook` 逐失败分类；这保留污染诊断入口，也不再与既有 playbook 冲突。


## 未卷入第三方复评：M3（固定 commit `2c248536`）

- **结论：FIXED。** `docs/tmp/2026-08-08-validate-entry-evidence-shard-timeouts.md:9-24` 的两段摘录与当前仍可达的 `/home/xp/.claude/jobs/149c3057/tmp/backend-timeout-final.log:159-161`、`final-backend-after-review.log:162-164` 逐字一致：用例名分别对应 7369.01ms 与 7355.61ms。
- 归档文件 `:3,27-31` 写清 `bun run test:backend`／底层 runner、16 shards、两个用例名、单文件 43/43、45.395 秒及最慢 4.561754 秒；后四项亦与 timing XML `:2-4,21` 一致。
- memory `:11` 与处置记录 `:63` 均已删除无来源的第三个精确数字；处置记录明确写“未交叉验证、不作为证据引用”，memory 则只引用两次有来源数字，并由 `:26` 链到明确同一边界的归档文件。
- `git grep` 在固定 commit 全仓检索 `7.3／9.5／7.4` 及等价斜线形态无命中；未发现残留。三条 major 均闭合，**总体 verdict：可定稿；0 blocker／0 major**。
