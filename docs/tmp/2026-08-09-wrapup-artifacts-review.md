# 收尾产物独立评审

## 评审范围

- `docs/memory/methodology-missing-evidence-counted-as-zero.md` 与 `docs/memory/MEMORY.md` 的新增索引钩子。
- `docs/todo/deferred-backlog.md` 的本轮 tally、History lifecycle 与 timing 改动。
- `docs/coding-conventions.md` 的 JUnit tally 约定。
- `exp/junit-tally-false-green/README.md` 及其 artifact。
- `docs/tmp/2026-08-08-mandatory-block-delivery-h2-progress-task9-ready-snapshot.md`。
- 复评轮次 2：整改提交 `7016435e`、`30559e07`，重点检查整改是否引入新缺陷。

## 轮次 1 结论摘要

轮次 1 verdict：修复 MAJOR 后可进入下一阶段，BLOCKER 0、MAJOR 7、MINOR 1。七条 MAJOR 分别是：实验 README 将人工转录称作原始证据；稳定约定漏掉 `INCOMPLETE` 前提；“任何部分退化全绿”被反例推翻；单次 timing 被升格成稳定值；checkpoint 混用两个时间锚；progress 仍标进行中并保留已完成队列；同一旧全称在多个载体传播。MINOR 是复算配方硬编码 16 shards。完整原始发现仍可从提交 `30559e07^:docs/tmp/2026-08-09-wrapup-artifacts-review.md` 读取。

# 复评轮次 2（整改提交 `7016435e`、`30559e07`）

## 已读取／执行的证据

- `git status --short`：复评开始时无输出。
- 已读两个整改 commit 的完整 diff，以及整改后 README、memory、coding conventions、backlog、progress 和测试注释全文。
- 对仓库 artifact、Git object 和仍存临时原件分别取 SHA256；逐字执行整改后的复算配方。
- 全仓搜索旧全称断言；构造 `unexpected-only` 文件身份错配；对 progress 的关闭 commit 和当前时态语句做 Git object 级核对。

## 总体 verdict

**修复 MAJOR 后可进入下一阶段。BLOCKER：0。复评新增 MAJOR 4、MINOR 2。**

## 事实性发现

### [MAJOR] `docs/coding-conventions.md:50-52`、`docs/todo/deferred-backlog.md:1258` — “无 INCOMPLETE 即可引用 tally”仍漏掉 `unexpected` identity mismatch

- **现象**：整改把引用条件写成“tally 行不带 `INCOMPLETE`”，但代码只在 `fileComparison.missing.length > 0` 时添加该标记；`unexpected.length > 0` 只在上方打印错误并令进程退出 1，tally 行仍无任何不完整／集合错配标记。
- **证据／命令输出**：当前 `scripts/parallel-test.ts:213-217,242-254` 把 `missingFiles` 传给 `formatTallyLine`，没有传 `unexpectedFiles`。独立运行 `compareFileIdentities(["tests/a.unit.test.ts"], ["tests/a.unit.test.ts", "tests/extra.unit.test.ts"])` 得 `missing: [] / unexpected: [extra]`；随后按真实参数格式化 tally，输出仍是 `2 tests · 2 pass · 0 fail`，没有 `INCOMPLETE`。
- **接手方错误动作**：报告作者按新约定看到“无 INCOMPLETE”便会引用这 2 条作为目标发现集合的总量或“全绿”证据，尽管运行时集合含一个 discovery 未授权／未预期文件且命令实际退出 1。
- **建议处置**：把 tally 的 completeness 状态扩成完整 identity mismatch（missing + unexpected），任一非空都在同一行标 `INCOMPLETE` 或 `IDENTITY MISMATCH`；文档引用条件写成“无 `INCOMPLETE`／identity mismatch 且命令 exit 0”。补 unexpected-only 单测，不能只改文档。代码修复建议 `gpt-souls:implementer`，文档同步建议 `gpt-souls:doc-writer`。

### [MAJOR] `docs/tmp/2026-08-08-mandatory-block-delivery-h2-progress-task9-ready-snapshot.md:3-4` — `closed-at: 7016435e` 指向关闭动作发生前的 commit

- **现象**：frontmatter 声称文件“闭合于 `7016435e`”，但 `7016435e` 只提交实验 artifact；progress 状态关闭、剩余项划销和写入权移交实际都在其子提交 `30559e07`。
- **证据／命令输出**：`git show 7016435e:<progress-file> | rg '^status:|^closed-at:|剩余项'` 输出仍是 `status: in-progress`、无 `closed-at`、`## 剩余项`；`git show 30559e07:<progress-file>` 才出现“已完成”与错误的 `closed-at: 7016435e`。`git rev-parse 30559e07^` 精确等于 `7016435e`。
- **接手方错误动作**：接手方 checkout `closed-at` 所指 commit 核验，会得到仍在进行中的档案与未关闭队列，进而认为状态回退或关闭记录不可信。
- **建议处置**：把 `closed-at` 改为实际完成关闭动作的 `30559e07`；若 `7016435e` 想表达 artifact／工作内容基线，应另命名为 `evidence-complete-at` 或 `work-complete-at`，不要冒充关闭提交。修复方建议 `gpt-souls:doc-writer`。

### [MAJOR] `docs/tmp/2026-08-09-merge-state-review-claims.md:169-175` — 第四处权威报告仍保留已被反例推翻的“任何部分退化全绿”结论

- **现象**：memory、progress 和测试注释已收窄，但其引用的判据评审报告仍写“任何部分性的 dedup 退化……两条断言都绿”，并据此给出约 11 倍沉默区间。该报告是 progress 第 207 行直接链接的裁决依据，不是无关归档。
- **证据／命令输出**：全仓搜索旧全称，除用于留痕的更正句外，仍命中 `docs/tmp/2026-08-09-merge-state-review-claims.md:170` 的肯定断言。独立 47/48 反例已得 `physicalRatio=9.516`，旧 `>=10` physical 断言会红，直接推翻该句。
- **接手方错误动作**：接手方沿 progress 的“报告”链接追溯裁决时，会重新采信已被正文其他位置撤回的错误全称，并可能据此设计阈值或声称覆盖整个退化区间。
- **建议处置**：评审报告需追加醒目的更正／superseded 段，明确 169-175 的外推已被 47/48 反例推翻；保留端点事实与“live 对完全失效无鉴别力、physical 余量薄”的窄结论。修复方建议 `gpt-souls:doc-writer`。

### [MAJOR] `docs/tmp/2026-08-08-mandatory-block-delivery-h2-progress-task9-ready-snapshot.md:44-80` — 关闭后仍保留当前时态的“在途意图／待跑／未审不得关闭／继续更新”指令

- **现象**：frontmatter 与“剩余项”说文件已停止更新，但紧接着仍有标题 `## 在途意图`，第 50 行写“合并前必须由独立 reviewer 裁决，未审不得提交或关闭 Task 9”，第 52 行命令“继续每个语义 commit 同步本文件”，第 68 行写“完整 backend 与 architecture 门禁待跑，不能据此提前关闭 Task 9”；第 74、80 行也保留“待独立 reviewer 最终裁决／官方门仍未绿”的当前时态。顶部没有把这些后续章节整体标成“历史快照、已被后文取代”。
- **证据／命令输出**：`git show 30559e07:<progress-file> | rg '继续每个语义 commit|合并前必须由独立reviewer|待跑|不得.*关闭|待独立reviewer'` 精确命中上述行；同一文件第 36-42 行又声称门禁与评审全部闭合。
- **接手方错误动作**：接手方无法确定这些是已失效历史约束还是仍承重的未闭合 gate，可能重复评审、继续更新已封存文件，或反过来忽略真正仍开放的历史债。仅在“剩余项”内写“下面三项不是当前队列”不足以覆盖后面的独立章节。
- **建议处置**：把 `在途意图` 改为“历史在途意图（快照于 <sha>，均由后文收口取代）”，在 `本轮红绿证据` 前加覆盖整个章节的历史边界；对明确已失效的命令句逐条加 `已完成／已 superseded`，尤其删除或划销“继续更新本文件”。保留历史证据不等于保留可执行现在时。修复方建议 `gpt-souls:doc-writer`。

### [MINOR] `exp/junit-tally-false-green/README.md:7,16,43` — “本文数字都可从原件复算”与 `7529` 不可复算自相矛盾

- **现象**：第 7 行仍全称“本文的数字都可以从原件复算”，第 16、43 行却正确说明仅保存 1/16 XML，`7529 executed` 不能从本目录复算，只能从 run.log 读取。
- **证据／命令输出**：整改配方对仓库 artifact 实跑得到 `1 shard / 429 executed / 1 failed / 428 pass`，不能得到 7529；对仍存在的 `/tmp/parallel-test-VZxJ3f` 全 16 份实跑才得到 `7529/1/7528`。
- **接手方错误动作**：读者只看开头会把“原日志中记载 7529”升级成“仓库 artifact 可独立重算 7529”。
- **建议处置**：第 7 行改为“本文引用的原始 tally 行与 shard-06 失败可从原件直接核对；只有 shard-06 计数可复算，全量 7529 仅在 run.log 中留痕、不可由本目录 XML 重算”。

### [MINOR] `exp/junit-tally-false-green/README.md:51-68` — 新枚举配方仍未检查 shard 编号连续，缺一份时会静默把子集当批次复算

- **现象**：整改从硬编码 16 改为枚举并检查非空，解决了机器 CPU 数差异；但没有检查编号连续或声明期望 shard 集。若一个完整 artifact 目录丢失中间某份 XML，配方会照常输出较小总量。
- **证据／命令输出**：配方只执行 `filter(...).sort()` 与 `length === 0` 检查；没有验证 `shard-01..NN` 连续。对本目录只有 `shard-06.xml` 的刻意子集也会正常输出 `shards: 1`，说明配方无法区分“有意保存一份”和“完整批次丢了 15 份”。
- **接手方错误动作**：接手方会把缺 shard 的目录当“任意一批完整产物”复算，并再次把没读到的 shard 计为零。
- **建议处置**：配方增加模式参数：`--partial` 明确允许证据子集；默认完整模式要求编号从 01 连续，并最好读取 runner metadata／run.log 的 shard 总数交叉核对。README 当前仓库样本使用 partial 模式，避免把“故意只存一份”与“意外缺失”混为一谈。

## 已确认的整改

- artifact 两个提交文件与仍存源文件逐字节 SHA256 相同：run.log `8cd82fae2ef5f5160920c9d587e7ebb73126da293effcf9904d8b94a82ac4773`、shard-06.xml `101d99a32862ecb29cad62b608ac9c1cc46e0a36361987b3f825b2d609db7bdf`；从 `7016435e` Git object 直接取内容的 hash 也一致。run.log 确有 1330 行、真实 ANSI、末行 exit 1 和 artifact 路径；XML 确有 688 行及目标 TimeoutError。
- 仍存的 16 份 `/tmp/parallel-test-VZxJ3f/shard-*.xml` 独立复算为 `7529 executed / 1 failed / 7528 pass`，仅 shard-06 含 `<failure|error>`；README 关于“本仓只保留 1/16，故本目录不能复算 7529”的边界正确。
- 环境声明与探针一致：Linux 6.18 WSL2、16 CPU、Bun 1.3.14 revision `0d9b296a`。
- timing 条目已改成三读数、各带口径与 commit，未再把 9.51s 当稳定值；本轮未发现新问题。
- 三个指定载体（memory、progress、测试注释）的收窄措辞一致，均只保留端点事实并记录 47/48 反例；问题是第四处评审报告漏改，已单列 MAJOR。

## 最终计数

- 轮次 1：BLOCKER 0、MAJOR 7、MINOR 1。
- 复评轮次 2：BLOCKER 0、MAJOR 4、MINOR 2。
- 当前 verdict：修复 MAJOR 后可进入下一阶段。


# 复评轮次 3（整改提交 `dd0bcd2d`、`4f90642b`）

## 复评范围与方法

- 读取两个整改 commit 的完整 diff，并通读 tally 实现、全部新增测试、coding conventions、backlog、实验 README、claims 更正和 progress 全文。
- 核对所有 runner 提前退出点：零发现集合、artifact 缺失、XML parse throw、child 非零、JUnit failure、missing identity、unexpected identity。
- 运行当前定向测试；在 `/home/xp/.claude/jobs/a7c2cc1a/tmp/` 制作仅移除 `OUT-OF-SCOPE` 机制的副本做正向 mutation；从 README 逐字复制配方分别跑单 shard、完整 16 shard 和缺少末尾 shard 的 1..15 集合。
- 以构造 XML 检验“exit 0 是 tally 可信度唯一充分判据”的反方向。

## 总体 verdict

**修复 MAJOR 后可进入下一阶段。BLOCKER：0。复评新增 MAJOR 4。**

## 事实性发现

### [MAJOR] `docs/coding-conventions.md:52`、`docs/todo/deferred-backlog.md:1258` — “退出码 0 是 tally 可信度唯一充分判据”仍是 false-green

- **现象**：整改覆盖了 missing／unexpected 两个**文件集合**方向，却没有覆盖“文件存在于两侧，但该文件内部部分 testcase 行被 parser 忽略”的计数失真。`parseJUnit` 明确把缺 `classname` 或 `name` 的 well-formed testcase 当 `other` 丢弃，且不校验 `<testsuite tests=…>`／根 `tests=…` 属性；只要同文件还有一个正常 testcase，文件身份对账仍完全相等，child 退出 0，最终 runner 也退出 0，但计数偏小。
- **证据／命令输出**：构造一个声明 `tests="2"` 的同文件 XML，含一条完整 testcase 与一条缺 `classname` 的 testcase。当前 `parseJUnit` 输出 `files:[tests/a.unit.test.ts], executed:1, failed:0`；`compareFileIdentities` 输出 `missing:[], unexpected:[]`；代入 `parallel-test.ts:255` 的退出条件得到 `wouldExitNonzero:false`。仓库现有测试 `tests/infra/parallel-test-artifacts.unit.test.ts:88-95` 还把“忽略缺 legacy identity 字段的 well-formed testcase”冻结为预期行为。
- **接手方错误动作**：报告作者会因 exit 0 把 `executed/pass` 当完整总量；Bun reporter 一旦改变／遗漏 testcase identity 字段，或 artifact 出现语义残缺但 XML 语法仍合法，runner 会再次把“没读到行”计成零。
- **建议处置**：不要把 exit 0 宣称为 tally 完整性的充分证明。生产 runner 应 fail-closed：遇到任何 `<testcase>` 缺必需 identity 字段就抛错，且把 parser 统计的 executed/skipped 与 suite/root 声明计数做一致性检查；至少冻结一个“同文件一条正常＋一条缺字段”负控，旧实现必须红。文档只可说“exit 0 表明当前已实现的退出门均未触发”，不能说“唯一充分判据”。代码修复建议 `gpt-souls:implementer`。

### [MAJOR] `exp/junit-tally-false-green/README.md:51-73` — “编号从 1 连续”仍检不出缺少末尾 shard，配方会把 1..15 子集当完整批次

- **现象**：新配方能拒绝只有 `shard-06` 或中间断号，却不知道预期最大编号；缺最后一份时，`01..15` 仍满足“从 1 连续”，会正常出数。
- **证据／命令输出**：从 README 逐字复制配方：对仓库单 shard 如期抛 `got 6 — this batch is a SUBSET`；对完整 `/tmp/parallel-test-VZxJ3f` 输出 `16 / 7529 / 1 / 7528`；再复制原件的 shard-01..15、只省略 shard-16，**同一配方退出 0**并输出 `{shards:15, executed:6934, failed:1, pass:6933}`。
- **接手方错误动作**：artifact 目录若只丢最后一份，接手方会把 6934 当总量；这正是该 README 要防的“没读到却当作零”。
- **建议处置**：完整模式必须从独立 metadata 读取 expected shard count（例如 runner 原子写 manifest，或解析同批 run.log 的 `N shards`）并断言集合精确等于 `1..N`；没有 expected count 时只能标“可枚举子集”，不得声称完整。配方应同时保留 single/middle/trailing 三种缺失负控。

### [MAJOR] `docs/tmp/2026-08-08-mandatory-block-delivery-h2-progress-task9-ready-snapshot.md:3-4,70-82` — progress 仍有冲突的关闭锚与未被历史边界覆盖的陈旧门禁结论

- **现象**：`closed-at` 已改为 `30559e07`，但同一 frontmatter 的 `status` 字符串仍写“闭合于 `7016435e`”。“在途意图”已正确标历史，但独立的“本轮红绿证据”章节仍在第 75、76、82 行以当前语气声称官方门未绿、guard 待最终裁决；第 96 行才说“官方门未绿已过期”。
- **证据／命令输出**：`rg '7016435e|30559e07|closed-at|闭合于'` 同时命中 status 的 701 与字段的 305。`rg '待独立|未绿|待跑|不得.*关闭'` 命中第 70、75、76、82 行；只有第 70 行加了“写于当时／已跑完”，第 75、76、82 没有被“在途意图”标题覆盖。
- **接手方错误动作**：按 status checkout 701 会看到文件仍未关闭；按正文搜索“官方门”会同时得到“仍未绿”和“已过期”两个权威声音，可能重复 gate／review 或把正确闭合状态当成后来的误写。
- **建议处置**：status 与 `closed-at` 统一为 305；给整个“本轮红绿证据”章节加明确快照基线和 superseded 指针，或逐条给 75、76、82 添加“后续已推翻／已闭合”标记。历史证据可以保留，但不能继续使用无时间限定的现在时。

### [MAJOR] `docs/tmp/2026-08-09-merge-state-review-claims.md:173-181` — 更正正文准确，但下游结论仍重复被推翻的“只能拦彻底失效”

- **现象**：追加更正确地保留了两项仍成立的核心事实：live 对完全失效无鉴别力，physical 在完全失效端只有 0.49 余量；没有过度撤销原发现。但更正后的第 180 行仍肯定地说该用例“实际只能拦住去重彻底失效”，与第 173 行承认 47/48 部分退化也会红直接矛盾。
- **证据／命令输出**：`rg '只能拦住|47/48|更正'` 同时命中 173 的反例与 180 的旧后果描述。47/48 实测 `physicalRatio=9.516 < 10`，所以“只能拦彻底失效”已被同一个反例推翻。
- **接手方错误动作**：接手方读完更正继续往下，会再次得到旧结论，误判旧 guard 对所有 partial degradation 都无覆盖。
- **建议处置**：不改写历史原文也可以，但更正必须显式声明它同时 supersede 第 169-171 **及第 180-181**；把当前有效结论收窄为端点鉴别力与余量，不再断言 partial 区间覆盖。

## 已确认无问题的整改

- `OUT-OF-SCOPE` 与 `INCOMPLETE` 的方向语义正确，二者同时出现时也都展示。当前 focused suite 为 `20 pass / 0 fail`。
- 鉴别力正控成立：在树外副本只把 `unexpectedNote` 强制为空，新加的 unexpected-only 与 both-directions 两条测试恰好 `2 fail`；恢复后的当前实现 20 条全绿。第一次全文件副本 mutation 因树外依赖解析失败，不作为证据；随后用只含 `TallyInput/formatTallyLine` 的聚焦副本排除了该混淆。
- artifact 缺失会 `process.exit(1)`；`parseJUnit` 语法错误未被捕获，会令顶层异常退出非零；发现集合为空会退出 1；child 非零、JUnit failure、missing、unexpected 都进入最终非零条件。问题只在 parser 可静默接受的语义漏行，因此“exit 0 充分”仍不成立。
- claims 追加更正没有否定原本成立的 live/physical 端点事实；问题仅是后续旧结论未同步 supersede。
- README 当前配方与实跑版本逐字一致；partial 与完整两个用户点名的控制均得到预期结果，但 trailing omission 暴露第三个方向。
- `runner_git_blob` 三处一致为 `a27bf46dc41649c90090d6670b391b5b8bf57517`。

## 最终计数

- 轮次 1：BLOCKER 0、MAJOR 7、MINOR 1。
- 复评轮次 2：BLOCKER 0、MAJOR 4、MINOR 2。
- 复评轮次 3：BLOCKER 0、MAJOR 4、MINOR 0。
- 当前 verdict：修复 MAJOR 后可进入下一阶段。


# 复评轮次 4（整改提交 `eb2493ad`、`bb1f81f3`）

## 复评范围与方法

- 读取两个整改 commit 的完整 diff，通读 `parseJUnit`、全部新增测试、README 配方、coding conventions、backlog、progress 与 claims 全文。
- 用 Bun 1.3.14 实际生成并解析四类产物：单文件 todo+skip+pass、全文件 skip、`--isolate` 两文件、既有 16 份真实 shard；另检查 nested suites 与 root 三属性缺失／部分缺失时的条件边界。
- 从 README 逐字复制配方，分别运行完整 16 份、缺末尾 shard、单 shard；结果为 complete、missing 63、missing 671，与整改说明一致。
- 在 `/home/xp/.claude/jobs/a7c2cc1a/tmp/` 建树外副本，分别移除 declared-total 整体门、failure 分支和 skipped 分支，检验新增测试的判别力。
- 复核 `scripts/parallel-test.ts` 工作树 blob、HEAD blob 与 baseline `runner_git_blob`，三者均为 `a27bf46dc41649c90090d6670b391b5b8bf57517`；本轮确实未改 runner。

## 总体 verdict

**修复 MAJOR 后可进入下一阶段。BLOCKER：0。复评新增 MAJOR 1、MINOR 1。**

## 事实性发现

### [MAJOR] `tests/infra/parallel-test-artifacts.unit.test.ts:195-224` — 新门只对 rows mismatch 有负控，`failures` 与 `skipped` 两个承重分支可删除而测试照绿

- **现象**：新增四条里，只有“parsed rows 与 declared tests 不同”会在门被删除时红；“matching failures”与“matching skips”都是正样本，不能证明各自的不一致分支存在。实现中的三臂条件 `rows !== tests || failedCount !== failures || skippedCount !== skipped` 有两臂缺目标 mutation。
- **证据／命令输出**：当前定向 suite 为 `24 pass / 0 fail`。树外副本删除整个 declared-total 对账门，三个自建 mismatch 负控（rows/failures/skipped）均按目标红，证明 harness 触达正确实现。随后只删除 `failedCount !== declared.failures`，运行仓库新增的 `-t 'declared|document'` 测试仍为 `3 pass / 0 fail`；只删除 `skippedCount !== declared.skipped`，同样 `3 pass / 0 fail`。因此现有新增测试无法阻止这两臂回归。
- **接手方错误动作**：后续重构若漏掉 failure 或 skipped 对账，维护者会看到全部测试绿，误以为“三项对账”仍完整；正是这轮试图修复的 tally 假绿会从另一个字段重新出现。
- **建议处置**：增加两个独立负控：① root `failures=1`、实际无 failure 必须抛；② root `skipped=1`、实际无 skipped 必须抛。分别做单臂 mutation，确保每条只因目标分支缺失而红。保留 matching 正样本防 false-red。代码／测试修复建议 `gpt-souls:implementer`。

### [MINOR] `docs/tmp/2026-08-08-mandatory-block-delivery-h2-progress-task9-ready-snapshot.md:58` — 新增历史边界中的门禁数字无 commit 锚且已落后一轮

- **现象**：整改新增警告称后续官方门已全绿 `7538 tests`，但未注明该次运行的 commit；同一批整改的前一提交 `eb2493ad` 又新增 4 条测试并在提交信息记录 `7542`。该文件虽已归档，新增警告却用无锚点的完成态数字，读者无法判断 7538 是哪个阶段。
- **证据／命令输出**：`eb2493ad` commit message 明记 `7542 tests · 7542 pass`；`bb1f81f3` 新增的 progress 警告写 `7538`。`git diff eb2493ad^..eb2493ad` 显示新增 4 条 `test(...)`，解释了数值前进但也证明 7538 不是 `bb1f81f3` 所处 HEAD 的规模。
- **接手方错误动作**：接手方会把 7538 当关闭态／当前完整规模，与 7542 门禁记录冲突后重新调查是否丢测试。
- **建议处置**：给 7538 明确锚定为 `dd0bcd2d` 的历史运行，或改引用关闭／最新门禁的具名 SHA；不要在归档警告里放无基线的易变数字。

## 已确认无新增问题的范围

- **新 oracle 的 false-red 扫描**：Bun 1.3.14 的 todo 作为 skipped 计入 root totals；全文件 skipped、普通单文件、`--isolate` 多文件、嵌套 `testsuite` 均被当前 parser 接受且对账一致。16/16 份真实历史 shard 全部通过三项对账。未发现适用 Bun 形态的 false-red。
- **条件边界**：root 三属性全缺、部分缺失或根为单个 `testsuite` 时，对账门不生效；代码注释和约定明确要求“三项全部声明”，未把该条件门写成普遍保证。既有“缺 legacy identity 字段时忽略”契约未被删除，只在生产者同时声明完整 totals 时从“静默忽略”升级为“整体自洽失败”；该分层恰当。
- **README 配方**：逐字执行完整、末尾缺失、单 shard 三个方向，分别得到 `file identity: complete`、63 missing、671 missing。backend baseline 的 `unit+it+http` 口径说明准确；对 `test:fast` 使用该基线会产生口径型 missing，文档已警告。
- **progress 全文**：status 与 `closed-at` 已统一为 `30559e07`；“在途意图”和整段“本轮红绿证据”均有历史边界与 superseded 指针，旧现在时已被上层语境明确降为历史。除 7538 数字缺锚外，未发现第五处可导致接手动作错误的当前指令。
- **claims 全文**：第二段更正显式 supersede 第 180-181 行，当前有效结论只保留两个端点事实；未发现仍会被误读为当前结论的第五载体。

## 最终计数

- 轮次 1：BLOCKER 0、MAJOR 7、MINOR 1。
- 复评轮次 2：BLOCKER 0、MAJOR 4、MINOR 2。
- 复评轮次 3：BLOCKER 0、MAJOR 4、MINOR 0。
- 复评轮次 4：BLOCKER 0、MAJOR 1、MINOR 1。
- 当前 verdict：修复 MAJOR 后可进入下一阶段。


# 复评轮次 5（整改提交 `eba4f21a`）

## 复评范围与方法

- 读取 `eba4f21a` 完整 diff、两条新增负控、progress 与 claims 全文，并核对 30559e07→dd0bcd2d→eb2493ad→bb1f81f3→eba4f21a 的 first-parent 顺序和各提交改动路径。
- 在 `/home/xp/.claude/jobs/a7c2cc1a/tmp/round5-independent/` 独立复制当前实现和完整测试，分别删除 tests／failures／skipped 单臂后运行；没有执行会写仓库的 `arm-mutation.py`。
- 直接取得 failure-only 与 skipped-only 两条真实错误消息，让两条 `toThrow` regex 交叉匹配，检查是否可能由兄弟臂误咬。

## 总体 verdict

**修复 MAJOR 后可进入下一阶段。BLOCKER：0。复评新增 MAJOR 1、MINOR 1。**

## 事实性发现

### [MAJOR] `docs/tmp/2026-08-08-mandatory-block-delivery-h2-progress-task9-ready-snapshot.md:40` — 又把“退出码与标记”写成验收判据，与权威约定的“必要但不充分”冲突

- **现象**：同一行先正确说数字不是判据，却接着写“判据是退出码与标记”。作为“验收判据”，这会被接手方理解为满足二者即可引用 tally；但 `docs/coding-conventions.md:52` 与 backlog 已明确退出 0 只是必要条件，不是充分条件，且产出方不声明 totals 时仍有已知缺口。
- **证据／命令输出**：`rg '判据是退出码|必要条件|充分条件'` 同时命中 progress 的“判据是退出码与标记”和 coding conventions/backlog 的“必要条件，不是充分条件”。本轮没有新增能把 exit+markers 升级为充分条件的机制；`parseJUnit` 的 declared-total 门仍在三属性缺失时条件性停用。
- **接手方错误动作**：接手方会按归档 progress 的“验收判据”引用某次 tally，而忽略权威约定明确保留的条件盲区；这正是前三轮反复证伪的充分性主张换了一种措辞回流。
- **建议处置**：把该句改为“核验记录的是退出码与完整性标记；二者为必要信号，不构成 tally 完整性的充分证明，边界以 coding conventions 为准”。不要再使用单数“判据”给它封口。修复方建议 `gpt-souls:doc-writer`。

### [MINOR] `docs/tmp/2026-08-08-mandatory-block-delivery-h2-progress-task9-ready-snapshot.md:40,58` — `7538@bb1f81f3` 的 commit 锚错误，且漏记本提交的 7544

- **现象**：时间线写 `7536@30559e07 → 7538@bb1f81f3 → 7542@eb2493ad`，但 first-parent 顺序是 dd0bcd2d（先新增 2 条）→ eb2493ad（再新增 4 条）→ bb1f81f3（后续纯文档）。因此 7538 对应 dd0bcd2d；到 bb1f81f3 时，eb2493ad 的 4 条早已存在，规模仍是 7542，不可能回到 7538。当前 eba4f21a 又新增 2 条并记录 7544，但“每轮整改都复跑”的表没有这一项。
- **证据／命令输出**：`git log --first-parent 30559e07^..eba4f21a` 顺序为 `dd0bcd2d → eb2493ad → bb1f81f3 → eba4f21a`。`git show --name-only` 显示 dd0bcd2d 改测试并新增 2 条；eb2493ad 改同测试并新增 4 条；bb1f81f3 只改文档；eba4f21a 再新增 2 条。对应提交信息分别记录 7538、7542、7544。
- **接手方错误动作**：接手方会认为 bb1f81f3 后测试数下降 4 又在其父提交更高，进而怀疑 discovery 回归或历史改写；表声称“每个数字都锚到 commit”，反而放大错误权威感。
- **建议处置**：改为 `7536@30559e07 → 7538@dd0bcd2d → 7542@eb2493ad（bb1f81f3 纯文档，仍为 7542）→ 7544@eba4f21a`。如果不准备持续维护，删掉逐轮数字表，仅保留具名历史证据指针与必要但不充分的核验纪律。

## 已确认无新增问题的范围

- **逐臂鉴别力成立**：当前基线 `26 pass / 0 fail`。独立树外 mutation 分别删除 tests、failures、skipped 臂，三次均为 `25 pass / 1 fail`；红的分别是 rows mismatch、failure-count mismatch、skip-count mismatch 对应用例，没有兄弟断言代咬。
- **错误 regex 可区分**：failure-only 消息只匹配 failure regex，不匹配 skipped regex；skipped-only 消息只匹配 skipped regex，不匹配 failure regex。两条 regex 都同时约束 parsed 与 declared 的目标字段，不是宽泛 `self-inconsistency`。
- **progress/claims 全文**：除上述“验收判据”回流和数字锚错误外，历史章节边界、closed-at、claims 两段 supersede 均保持自洽，未发现新的当前时态残留会改变接手动作。

## 最终计数

- 轮次 1：BLOCKER 0、MAJOR 7、MINOR 1。
- 复评轮次 2：BLOCKER 0、MAJOR 4、MINOR 2。
- 复评轮次 3：BLOCKER 0、MAJOR 4、MINOR 0。
- 复评轮次 4：BLOCKER 0、MAJOR 1、MINOR 1。
- 复评轮次 5：BLOCKER 0、MAJOR 1、MINOR 1。
- 当前 verdict：修复 MAJOR 后可进入下一阶段。


# 复评轮次 6（整改提交 `45c9114a`）

## 复评范围与方法

- 读取 `45c9114a` 完整 diff，通读 tally 权威段、backlog 当前入口、progress 完成态入口和 memory 新增教训。
- 全仓搜索 `退出码 0`、`exit 0`、`充分判据/条件`、`判据是退出码与标记`、`无 INCOMPLETE 即可` 等同义载体；区分 tally 语境与其他命令的普通 exit-code 记录。
- 用 Git object 核对数字谱系和改测试文件的提交集合；复核 runner blob 三处仍为 `a27bf46dc41649c90090d6670b391b5b8bf57517`。
- 以接手方第一人称从 backlog 与 progress 两个入口走到权威段，判断指针是否削掉执行所需上下文。

## 总体 verdict

**修复 MAJOR 后可进入下一阶段。BLOCKER：0。复评新增 MAJOR 1。**

## 事实性发现

### [MAJOR] `docs/coding-conventions.md:52`、`docs/todo/deferred-backlog.md:1258` — 单一权威建立了，但“有条件解除”仍没有可执行的终端条件

- **现象**：backlog 说 tally 引用纪律“有条件解除”，并正确把条件路由到唯一权威；权威段却只定义“exit 0 是必要非充分”、三道部分门和一个已知缺口，没有回答接手方最终要问的“在什么限定下可以引用、允许把数字表述成什么强度”。消除重复载体解决了漂移，却把原本过强的 gate 变成了未闭合的 action contract。
- **证据／命令输出**：`docs/coding-conventions.md:52` 明写 necessary-not-sufficient 和 producer 不声明 totals 时门不生效；`docs/todo/deferred-backlog.md:1258` 明写“有条件解除”但刻意不复述条件。沿指针读完后仍只有必要条件，没有充分条件或允许的窄 claim 形状。全仓同义搜索确认没有另一个当前载体补上这个终端动作，因此不是“我漏读了另一份定义”。
- **接手方错误动作**：谨慎的接手方会因条件永远未定义而不敢引用任何新 tally；激进的接手方会自行把“exit 0 + 三道门”补成充分条件，重新制造第五种未经批准的充分性主张。两种动作都不是文档明确授权的结果。
- **建议处置**：不要再寻找一个跨版本／跨 producer 的万能充分判据。权威段应定义**允许的窄结论**：例如“可按 `<commit> + <command> + 原始 tally 行` 引用为该次运行的 observed count；不得称完整总量、不得作增减证据，除非另有与目标集合对齐的独立 completeness oracle”。若要对当前 Bun 1.3.14/backend 口径给更强结论，则把版本、三属性存在、逐 artifact 对账、文件集合精确相等与 exit 0 全部写进限定命题，并明确不外推。backlog 的“有条件解除”随后只需指向这个 claim policy。文档修订建议 `gpt-souls:doc-writer`。

## 指针取舍判定

- **progress 指针没有削成裸指针**：它保留了要运行的命令、历史数字及 commit provenance、为什么不在此复述、权威文档的精确章节，并显式提醒 necessary-not-sufficient。接手方无需猜“去哪读”或“为什么要读”。
- **backlog 指针也没有削过头**：它保留当前处置状态、旧数字不追认、3-run consistency 未建立且不是 completeness 替代、权威路径与路由理由。对 backlog 读者而言，这些是决定是否开工／是否继续调查所需的本地上下文。
- 因此问题不在“指针太短”，而在**被指向的权威仍缺终端 claim policy**。不要通过把完整条件复制回两个入口来修；应在 authority 补齐一次。

## 已确认无新增问题的范围

- 数字谱系已正确：`7536@30559e07 → 7538@dd0bcd2d → 7542@eb2493ad → 7544@eba4f21a`；`bb1f81f3` 为纯文档提交、沿用 7542。Git first-parent 顺序与测试文件 path log 均支持该表。
- 同义搜索未发现 progress/backlog 之外仍把 tally 的 exit code／marker 写成充分条件的第五载体；历史 review 原文均有时间点或更正链，不冒充当前权威。
- memory 的“四轮／四种措辞”与实际四次 sufficiency 失效相符；多臂逐臂负控教训与当前测试事实一致。
- runner 本轮未改，工作树 blob、HEAD blob、baseline `runner_git_blob` 三处一致。

## 收敛判定

- **当前没有未闭合 BLOCKER。**
- **当前仍有 1 个未闭合 MAJOR**：tally 引用政策缺少终端、可执行的 claim scope；所以本轮不能给出最终收口。
- 其余前五轮 BLOCKER/MAJOR 均已由当前代码或带 provenance 的文档更正闭合，没有因“改成指针”重新打开。

## 最终计数

- 轮次 1：BLOCKER 0、MAJOR 7、MINOR 1。
- 复评轮次 2：BLOCKER 0、MAJOR 4、MINOR 2。
- 复评轮次 3：BLOCKER 0、MAJOR 4、MINOR 0。
- 复评轮次 4：BLOCKER 0、MAJOR 1、MINOR 1。
- 复评轮次 5：BLOCKER 0、MAJOR 1、MINOR 1。
- 复评轮次 6：BLOCKER 0、MAJOR 1、MINOR 0。
- 当前 verdict：修复 MAJOR 后可进入下一阶段。


# 复评轮次 7（整改提交 `b3855a86`）

## 复评范围与方法

- 读取 `b3855a86` 完整 diff，并通读 claim scope 表、其前后机制说明、backlog 当前入口、progress 指针和 memory 教训。
- 用两个具体接手场景走查：PR 描述如何引用一次 backend 运行；重构验收如何判断“用例没有减少”。
- 全仓搜索 observed/总量/增减/完整性 oracle/同一 commit 连跑等复述，核对权威表与 backlog 是否给出相反动作。
- 核对当前交付话术是否满足表内四项：窄 claim、commit、命令、原始 tally 行。

## 总体 verdict

**修复 MAJOR 后可进入下一阶段。BLOCKER：0。复评新增 MAJOR 1、MINOR 1。**

## 事实性发现

### [MAJOR] `docs/coding-conventions.md:66` — 把“同一 commit 连跑 N 次集合一致”列作独立 completeness oracle 候选，与本仓已证边界相反

- **现象**：claim scope 表本身正确地禁止用 tally 证明总量或不减；但紧接着说升级到总量需要独立 completeness oracle，并把“同一 commit 连跑 N 次集合一致”列作示例。该检查仍由同一 runner／producer／parser 产生，两次可稳定漏掉同一个文件或 testcase，不独立，也不能证明完整性。
- **证据／命令输出**：`docs/todo/deferred-backlog.md:1258` 已明确写“三次一致仍可能三次都少同一个文件”，且 `:1190-1197` 只把该守卫定位为稳定性／漂移检查，不是 completeness 证明。权威段的“例如”却把它升级为可把观察量变成总量的候选，两个当前载体给接手方相反路线。
- **接手方错误动作**：要证明重构“用例没有减少”的人会按权威示例实现 N-run consistency，三次都稳定漏同一测试后就把 observed count 升级成 total／no-decrease，重新制造这组文档一直在防的同源假绿。
- **建议处置**：删除这个示例并明确 N-run consistency 只能检测随机漂移，不能证明 completeness。总量／不减需要来源独立、能枚举目标集合成员的 oracle，例如冻结并比较 runtime test identity multiset，且其生产链不得复用 tally parser；具体 oracle 仍未设计时就保持“未决”，不要放一个已知不合格的候选。文档修订建议 `gpt-souls:doc-writer`。

### [MINOR] 当前协调方交付话术 — 缺少政策要求的“原始 tally 行”，尚未完全符合 claim scope 表

- **现象**：本轮给出的门禁话术是“门禁 @`b3855a86`：`lint:all` 零 error、`bun run test:backend` 观察到 7544 通过 / 0 失败、退出码 0、无任何完整性标记”。它具备 commit、命令和窄 observed claim，但没有逐字附上表要求的 raw tally line。
- **证据／命令输出**：claim scope 表第 56 行要求 commit、命令与“原始 tally 行”三项同时存在。当前话术是人工摘要，不是形如 `[parallel-test] 16 shards · ...` 的原始行；历史 artifact 证明原始行还包含 shards、executed、skipped、wall 与标记位置，这些被摘要省略。
- **接手方错误动作**：PR 读者无法确认摘要有没有漏掉同一行上的 `INCOMPLETE`／`OUT-OF-SCOPE` 或其他限定，只能再次相信作者转录。
- **建议处置**：PR／交付描述逐字粘贴原始 tally 行，或附仓库内 artifact 路径与行号；保持“观察到”措辞。当前话术只需补这一项，不应升级成“全量 7544”。

## 场景走查

- **PR 描述测试结果**：表能给出明确动作——写“在 `b3855a86`，运行 `bun run test:backend`，观察到 N pass／0 fail”，并附原始 tally 行；不得写“项目共有 N 条测试”。政策可执行。
- **证明重构没有减少用例**：表也给出明确否决——不能用两个 tally 数之差；必须另取独立 completeness oracle。当前唯一问题是紧随其后的候选示例本身不独立，已列 MAJOR。
- **话术边界**：协调方的“观察到 7544 通过／0 失败”没有越界成 total 或 no-decrease；只缺 raw line，故定 MINOR。

## 已确认无新增问题的范围

- claim scope 表已从“信任谓词”正确改成“允许／禁止的结论强度”，观察量与总量、单次报告与增减验收分界清楚。
- backlog 指针保留旧数字不追认、N-run 未建立及其非 completeness 边界，未削成裸指针；progress 仍保留命令、带 commit 的历史读数和路由理由。
- 未发现第五份当前文档重新定义 tally 引用政策；其他命中是历史报告、普通命令 exit code 或非 tally 语境。
- runner blob 三处仍为 `a27bf46dc41649c90090d6670b391b5b8bf57517`；`b3855a86` 只改文档，没有改变门禁实现。

## 收敛判定

- **当前无未闭合 BLOCKER。**
- **当前仍有 1 个未闭合 MAJOR**：权威 claim policy 推荐了已知不独立的 completeness oracle 候选。因此尚不能最终收口。
- 除该候选外，前六轮所有 BLOCKER/MAJOR 均已闭合；本轮未发现新的实现正确性缺陷。

## 最终计数

- 复评轮次 7：BLOCKER 0、MAJOR 1、MINOR 1。
- 当前 verdict：修复 MAJOR 后可进入下一阶段。


# 复评轮次 8（整改提交 `727cdbba`）

## 复评范围与方法

- 读取 `727cdbba` 完整 diff，并通读 claim policy 的文件级／用例级分层、backlog 三条 tally 条目及实验 README 配方。
- 为两侧画 provenance：expected file set 的 producer／观测点／上游，对照 runtime JUnit identity 的 producer／观测点／上游；核实生产 runner 门 ② 实际读取什么。
- 用三种方法交叉枚举当前 backend 文件集合：baseline JSON、runner 同形 `Bun.Glob`、`git ls-files tests | rg '\.(unit|it|http)\.test\.ts$'`，三者均为 727 且集合全等。
- 核验 commit message 是否逐字携带 raw tally line，并按 claim scope 表走查本轮交付话术。

## 总体 verdict

**修复 MAJOR 后可进入下一阶段。BLOCKER：0。复评新增 MAJOR 1。**

## 事实性发现

### [MAJOR] `docs/coding-conventions.md:68`、`docs/todo/deferred-backlog.md:1190-1197` — 文件级只能判“live discovery 后是否漏报”，不能称 baseline 与 runtime 来源独立；旧条目还把同源 testcase 名单当可靠替代

- **现象**：权威段说发现 baseline “独立枚举”应有文件且门 ② 正拿它对账。实际生产 runner 不读取 baseline；门 ② 用的是**同一次 `discover()` 返回的 live `files`**，而这些路径又直接作为 child Bun 的 argv。baseline 只是另一个持久载体，并由同样的 `Bun.Glob(**/*.{unit,it,http}.test.ts)` 规则从同一 checkout 生成／校验。两侧在 discovery 边界上有共同上游和共同控制者，只在“Bun 收到 argv 后有没有为每个已发现文件写 JUnit identity”这一后半段使用不同观测通道。
- **provenance 证据**：
  - expected/live side：`scripts/parallel-test.ts:59-65 discover()` 扫当前 `tests/` 文件系统；`files` 在 `:157` 作为 child Bun argv，并在 `:213` 直接送入 `compareFileIdentities`。生产门 ②没有读取 `entry-test-discovery-baseline.json`。
  - baseline side：`tests/infra/entry-evidence-schema.unit.test.ts:16-25` 和 `scripts/capture-entry-evidence.ts:145-150,265` 用同一目录、同一 suffix 集和同形 `Bun.Glob` 重新扫描；baseline 还 pin runner blob。它能防 baseline 陈旧，但不是“不同上游”的独立枚举。
  - runtime side：Bun 消费上述 argv，JUnit `testsuite/testcase file=` 由 `parseJUnit` 观测。若 discover 系统性漏一个文件，它既不进 expected set、也不进 argv/JUnit，门 ②全绿；若文件已被 discover 但 Bun 未产任何行，门 ②会红。
- **额外冲突**：`docs/todo/deferred-backlog.md:1195,1197` 仍把“JUnit 用例名集合枚举／diff”称作增减验收的可靠替代并声明配套纪律继续有效；但权威段第 69 行已正确认定 testcase 名单与 tally 同源、用例级总量不可判。后续第 1260 行否定 N-run completeness，却未显式撤销 1195/1197 的同源 testcase-name oracle。
- **接手方错误动作**：接手方会把门 ②或 baseline 当成能证明“所有应有测试文件都进入运行”的独立 oracle；若 discovery 规则自身漏文件，仍会宣布文件级完整。另一位接手方会按 1197 用 JUnit name diff 证明“用例没减少”，直接违反当前 claim scope。
- **建议处置**：把分层收窄为：① **discovery 后文件覆盖可判**——对 live-discovered argv 集合，JUnit 是否逐文件回报；② **仓库应发现文件集合只有部分独立交叉检查**——baseline／Git tracked paths／Glob 可发现陈旧或部分规则漂移，但 baseline 与 runner Glob 同源，不能单独证明 discovery 完备；③ **用例级仍不可判**。文档中不要说门 ②拿 baseline 对账，改成 live discovery↔runtime；baseline 另列为持久快照／交叉绊线。同步在 1190-1197 追加 superseded 注记，撤销“JUnit 名称 diff 是增减验收可靠替代”，保留其随机漂移诊断用途。修订建议 `gpt-souls:doc-writer`。

## 交付话术复核

- 本轮话术符合 claim scope：锚定 `727cdbba`，点名命令 `bun run test:backend`，使用“观察到 7544 通过／0 失败”而非“共有 7544”，并逐字附上 raw line：`[parallel-test] 16 shards · 7544 tests · 7544 pass · 0 fail · 7544 executed · 35 skipped · 64.62s`。
- “退出码 0、无完整性标记”只是该次运行的附加观测，没有被写成总量或 no-decrease 证明；未越界。

## 已确认无新增问题的范围

- **用例级分层正确**：root declared totals 与 testcase rows 同属 Bun/JUnit artifact；没有独立 expected testcase population，故不能主张 testcase total 或 no-decrease。
- **N-run 定位正确**：只能检测随机漂移，不能检测系统性缺失；权威段与 backlog 1260 当前一致。
- **当前集合事实**：baseline、Bun Glob、Git tracked backend paths 均为 727 且集合全等；这支持当前 snapshot 自洽，不把同源关系升级为结构性独立。
- runner blob 三处仍为 `a27bf46dc41649c90090d6670b391b5b8bf57517`；`727cdbba` 仅改文档。

## 收敛判定

- **当前无未闭合 BLOCKER。**
- **当前仍有 1 个未闭合 MAJOR**：文件级 provenance 被写强一档，且旧 backlog 仍保留同源 testcase-name 增减 oracle。因此尚不能最终收口。
- 除本条外，前七轮 BLOCKER/MAJOR 均已闭合；本轮未发现实现行为新缺陷。

## 最终计数

- 复评轮次 8：BLOCKER 0、MAJOR 1、MINOR 0。
- 当前 verdict：修复 MAJOR 后可进入下一阶段。


# 复评轮次 9（整改提交 `b45ff4e9`）

## 复评范围与方法

- 已完整读取前 8 轮报告；读取 `b45ff4e9` 完整 diff、commit message 与最终文件，并直接核对 `scripts/parallel-test.ts` 的 `discover()`、child argv、JUnit 解析及文件身份对账接线。
- 独立性判据统一采用 provenance：逐侧追溯 producer、observation point 与 upstream；共享生产者或共享上游的证据只算同源佐证，不升级为独立 oracle。
- 已确认 `b45ff4e9` 只修改 `docs/coding-conventions.md`、`docs/todo/deferred-backlog.md` 与本评审报告；未修改 runner。

## 总体 verdict

**修复 MAJOR 后可进入下一阶段。BLOCKER：0。复评新增 MAJOR 3。**

## 事实性发现

### [MAJOR] `docs/coding-conventions.md:68` — 第 1 层仍把 argv↔JUnit identity acknowledgement 写强成“文件启动／写行可判”

- **现象**：同一份 `discover()` 结果既形成 child argv，又形成 expected set，确实是同源；但同源本身不使“请求集合与回报 identity 集合是否相等”不可判，因为这道门测的就是 acknowledgement。问题在于正文把这个窄关系写成了“启动了的文件有没有回报”“让它跑的文件里，有谁一行都没写”，而实现只检查该路径是否至少出现在任一 `<testsuite file>`／`<testcase file>` identity 中，不证明文件已启动、模块已加载、或写出了 testcase row。
- **证据**：`scripts/parallel-test.ts:123,149-158,212-214` 显示 `files = discover()` 经 `balance()` 进入 argv，并原样作为 `compareFileIdentities` expected；`scripts/parallel-test-artifacts.ts:101-105` 在看到 `<testsuite file>` 时就把路径加入 `files`，无需任何 testcase。实跑 `parseJUnit("<testsuites><testsuite name=\"suite\" file=\"/repo/tests/a.unit.test.ts\"/></testsuites>")` 得 `files:["tests/a.unit.test.ts"], executed:0`，随后 identity comparison 为 `missing:[], unexpected:[]`。
- **接手方错误动作**：接手方会把门 ② 绿升级成“每个 argv 文件确实启动／产出了测试行”，据此排除空 suite、reporter 预登记 identity、或加载前后语义缺失；该门实际只能证明 JUnit artifact **提到了**每个 requested path。
- **建议处置**：第 1 层不要整体降成不可判，也不要称独立 oracle；改名为“post-discovery argv↔JUnit file-identity acknowledgement 可判”，精确写成“每个 requested path 是否至少出现在 artifact 的 file identity 集合”。显式声明它不证明启动、加载或 testcase rows。若目标确实是“启动／加载成功”，需另取能观察模块执行的来源，不能从 echo identity 反推。

### [MAJOR] `scripts/parallel-test-artifacts.ts:77,211-216`、`tests/infra/parallel-test-artifacts.unit.test.ts:190-195`、`docs/memory/methodology-missing-evidence-counted-as-zero.md:22` — 同一 JUnit 产物的 root totals 仍被称作 independent count／oracle

- **现象**：本轮文档已经正确说“声明属性与行都出自同一份产物”，但生产代码注释、承重测试注释与记忆仍把 producer-declared totals 称为 `INDEPENDENT oracle`／`independent count`／“同一份产物里的独立计数”。两侧的 producer 都是同一个 Bun JUnit reporter，同一 artifact 同时承载 root attributes 与 testcase rows；parser 只是两个 observation point，不改变共同上游。
- **证据**：`scripts/parallel-test-artifacts.ts:77-78` 写 `INDEPENDENT oracle for our parse`，`:211-216` 写 `independent count from the same artifact`；`tests/infra/parallel-test-artifacts.unit.test.ts:190-195` 重复同一主张；`docs/memory/methodology-missing-evidence-counted-as-zero.md:22` 进一步指导未来会话“去找同一份产物里的独立计数”。按 provenance：两侧 producer 均为 Bun reporter，artifact 为同一 XML，故只能算**同源内部一致性检查**。
- **接手方错误动作**：维护者会把“root totals 与 rows 一致”升级成结构独立的完整性证明；若 Bun reporter 在生产 root totals 与 rows 时共享同一个漏计／过滤缺陷，两侧会一起错而门全绿。该检查仍能有效发现**我方 parser 丢行或误计**，但不能证明 producer／artifact 完备。
- **建议处置**：同步把三处改成“producer-relative self-consistency oracle”或“同源内部计数”；写明它独立于**我方 parser 的计数实现**，不独立于 Bun producer，不支持 artifact completeness。尤其修正 memory 的未来动作指令，否则本轮文档收窄后，记忆仍会诱导下一轮立同一个假独立性。代码注释／测试注释建议由 `gpt-souls:implementer` 同步，记忆／文档建议由 `gpt-souls:doc-writer`。

### [MAJOR] `docs/memory/methodology-merge-invalidates-branch-frozen-test-floor.md:11-13`、`docs/memory/MEMORY.md:113` — runner tally 与同批 JUnit leaf recount 被写成“第二种原理交叉验证”

- **现象**：该记忆要求先跑 `bun run test:backend` 取得 executed/skipped，再以 16 份 shard JUnit 叶节点复算，称为“第二种原理交叉验证”；索引也概括成“JUnit 交叉验证”。当前 runner 的 tally 本身就由同一批 JUnit artifacts 调 `parseJUnit` 汇总，手工／脚本重数 leaf nodes 与 runner 共享 producer、artifact 和大部分语义，只是第二个 parser。它能交叉检查 runner parser／聚合实现，不能把 observed count 升级成独立 completeness 证据，也不能满足该文件所引 `feedback-pass-null-clean-not-self-validating` 的独立 oracle 要求。
- **证据**：`scripts/parallel-test.ts:202-220,228+` 从 shard JUnit identities 汇总 executed/skipped/failed；记忆 `methodology-merge-invalidates-branch-frozen-test-floor.md:11` 明写 runner 数后再数同 16 份 JUnit，`:13` 把它归入“数字口径须第二方法交叉验证”；`docs/memory/MEMORY.md:113` 继续以“JUnit 交叉验证”召回。provenance 两侧共同上游是同一次 Bun JUnit 产物。
- **接手方错误动作**：合并后冻结 `minimum_executed` 的人会把同一 artifact 的两次解析当成两个独立来源，在 producer 系统性漏掉文件／testcase 时仍将偏低数冻结为合法地板。
- **建议处置**：把该步骤降为“第二 parser 的同源复算，防 runner parser／聚合错误，不证明 producer completeness”；索引同步收窄。若 `minimum_executed` 要承担“测试没减少”的门，按当前 `docs/coding-conventions.md:62,66-70` 诚实标为缺独立用例级 oracle，不能再靠同批 JUnit 自举。修订建议 `gpt-souls:doc-writer`。

### [MAJOR] `docs/todo/deferred-backlog.md:1190,1195-1198` — 新增收窄句准确，但没有撤销前面的当前指令，backlog 同时要求和禁止用 JUnit name diff 做增减验收

- **现象**：`:1198` 新增的限定本身准确：JUnit names 只能比较已回报成员，不能证明 testcase 总量；但同一当前处置块的 `:1190` 仍说“用 junit 枚举、别用汇总数做增减验收”的纪律继续有效直到 N-run guard 落地，`:1195-1197` 仍把 JUnit name set 称为“可靠替代”，并命令“凡用例数增减类验收，一律用 junit”。这不是纯历史原文：`:1190` 明标“处置”，`:1196-1197` 仍是未划销的触发条件／配套纪律。
- **证据**：`:1197` 的全称动作与紧随其后的 `:1198`“不能回答用例总数有没有减少”直接相反；`:1190` 又把纪律的解除错误绑到 N-run consistency，而同文件 `:1261` 已正确说 N-run 永远不能证明 completeness。
- **接手方错误动作**：接手方按 `:1190` 或 `:1197` 做重构的 no-decrease 验收，会用同源 JUnit names 放行；按 `:1198` 则会拒绝。文档没有给出唯一动作，正是轮次 8 要求撤销旧 oracle 而本提交只追加限定未完整闭合。
- **建议处置**：显式 supersede／划销 `:1190` 中“该纪律继续有效直到 N-run 落地”、`:1195` 的方案中把 name set 当总量替代、`:1196` 的“可靠替代”、`:1197` 的“一律用于增减验收”。保留窄用途：诊断已回报名集合的随机漂移／变化；增减总量继续标“缺独立 testcase population oracle”。修订建议 `gpt-souls:doc-writer`。

### [MAJOR] `exp/junit-tally-false-green/README.md:50,68-73` — 复算配方仍错误声称 runner 用 committed baseline，并把部分绊线称为“正确的完整性 oracle”

- **现象**：README 说“正确的完整性 oracle 是 runner 自己用的那个：把产物文件集合与仓库发现基线对账”，配方随后确实读取 committed baseline；但生产 runner 根本不读该 baseline，它拿本次 live `discover()` 结果对本次 JUnit identities。该 README 因而保留了轮次 8 已证伪的同一事实错误，并把共享 discovery 规则的 baseline 绊线写成无边界的“完整性 oracle”。
- **证据**：README `:50` 的原句与 `scripts/parallel-test.ts:123,212-214` 冲突；后者 expected set 是本次 `files = discover()`。baseline 只在 README 配方 `:68-73` 与 `capture-entry-evidence.ts` 中使用。`docs/coding-conventions.md:69` 已正确说明 baseline 与 runner Glob 共享 checkout／suffix／同形 Glob，只是部分独立 tripwire，不是结构独立 oracle。
- **接手方错误动作**：读者会误以为生产门已接入 committed baseline，并把配方输出 `file identity: complete` 理解成仓库 discovery／test population 完整；实际上它只说明“这些 artifacts 覆盖了该 baseline 列出的文件”，baseline 自己可能同源漏项或陈旧。
- **建议处置**：改成“artifact-batch 相对 committed baseline 的 coverage check”；说明这是离线复算配方额外做的检查，**不是 runner 的门**，也不证明 baseline／仓库应有集合完备。输出把 `file identity: complete` 收窄为 `artifact files match the committed baseline`。修订建议 `gpt-souls:doc-writer`。

> **计数更正**：继续全范围扫描后又发现 backlog 当前指令冲突与实验 README 的同一事实错误；本轮新增 MAJOR 最终为 **5**，不是本节开头暂记的 3。逐条追加纪律下不回改已写段落，以此处及末尾最终计数为准。另：backlog 同类旧话术还命中 `docs/todo/deferred-backlog.md:1267` 的“验收有可靠替代（exit code + 定向套件 + junit 枚举）”，处置时应与 `:1190,1195-1198` 一并收窄，避免另一入口继续把 JUnit 枚举升级成总量 oracle。

## 已确认的整改与证据

- **`discover()` 一处两用描述准确**：`scripts/parallel-test.ts:123` 只调用一次，结果经 `balance()`／bucket 展开进入 child argv（`:149-158`），并在 `:212-214` 原样充当 file identity expected set；生产 runner 不读 committed discovery baseline。
- **三层中的第 2、3 层方向正确**：baseline 与 runner discovery 共享 checkout／suffix／同形 Glob，只能作部分绊线；testcase population 没有来源独立的枚举者，不可判总量。问题集中在第 1 层谓词写强和其他载体仍冒充独立。
- **backlog 新增限定句本身准确**：JUnit name set 只能比较已回报名，不能证明 testcase total；但旧当前指令未同步 supersede，故列为 MAJOR。
- **定向测试**：`bun test tests/infra/parallel-test-artifacts.unit.test.ts` 在本 worktree、commit `b45ff4e9` 下为 `26 pass / 0 fail`。这只确认现实现／测试通过，不消除上述 provenance 与文档合同缺陷。
- **实现未变**：`scripts/parallel-test.ts` 在 `b45ff4e9^` 与 `b45ff4e9` 的 Git blob 均为 `a27bf46dc41649c90090d6670b391b5b8bf57517`；`scripts/parallel-test-artifacts.ts` 两侧均为 `58def4a954eab7190ade7deb6a6136f7a42b6e2d`。
- **门禁当前状态只作窄观测**：提交信息逐字含 raw line `[parallel-test] 16 shards · 7544 tests · 7544 pass · 0 fail · 7544 executed · 35 skipped · 64.66s`；按当前 claim policy，这只支持该 commit／命令观察到的计数，不支持总量。未重跑 backend 全量，遵守本轮约束。

## 全仓范围扫描 disposition

- 扫描范围：`docs/todo/deferred-backlog.md`、整个 `docs/memory/`、`exp/junit-tally-false-green/README.md`、`docs/tmp/2026-08-08-mandatory-block-delivery-h2-progress-task9-ready-snapshot.md`、`docs/coding-conventions.md`；另为核验承重注释扫描 `scripts/parallel-test-artifacts.ts` 与 `tests/infra/parallel-test-artifacts.unit.test.ts`。
- 判据：逐条问 producer／observation point／upstream，重点搜索“独立、交叉验证、第二种原理、完整性 oracle、可靠替代、同源、baseline/runtime/JUnit”。
- 发现并单列的同源冒充独立：① Bun root totals vs testcase rows；② runner tally vs 同批 JUnit leaf recount；③ baseline／live discovery／runtime 的过强描述；④ JUnit names vs tally；⑤ README 把 baseline coverage 写成 runner oracle。
- 其余命中 disposition：真实外部 counterpart／官方 SDK／精确数学重算等明显不同上游的 oracle 不属于本轮同源缺陷；“独立评审”描述的是评审参与方而非数据 provenance；普通“同源”用于类比关系而非交叉证明。未发现另一个会影响本轮收口、且未被上述 5 条覆盖的 tally 同源主张。

## 结构怪味扫描

- `docs/coding-conventions.md:68` — **抽象泄漏／谓词名实不符**：identity acknowledgement 被命名为“启动／写行”；处置：本轮必须收窄，理由见 MAJOR 1。
- `scripts/parallel-test-artifacts.ts:77,211-216` 与 `docs/memory/methodology-missing-evidence-counted-as-zero.md:22` — **同一事实多载体且强度不一**：authority 已收窄，代码／测试／memory 仍写 independent；处置：本轮同步修，不留 backlog，因为它会直接诱导下一位复发。
- `docs/todo/deferred-backlog.md:1190-1198,1267` — **同一段双合同**：旧动作与新限定并存；处置：本轮 supersede 旧动作，不能靠读者自行择一。
- `exp/junit-tally-false-green/README.md:50` — **陈旧实现叙述**：离线配方被冒充 production runner；处置：本轮同步修。

## 收敛判定

- **当前没有未闭合 BLOCKER。**
- **当前仍有 5 个未闭合 MAJOR**：第 1 层谓词写强；producer root totals 被冒充 independent；同批 JUnit leaf recount 被冒充第二原理；backlog 旧增减动作未撤销；实验 README 仍误述 runner／baseline。
- 因而本轮不能收口。前八轮已闭合项未因本轮重新打开；未发现实现行为新缺陷，但文档／注释会直接导致接手方继续用同源证据作独立完整性判断。

## 最终计数

- 复评轮次 9：BLOCKER 0、MAJOR 5、MINOR 0、NIT 0。
- 当前 verdict：**修复 MAJOR 后可进入下一阶段**。
