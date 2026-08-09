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
