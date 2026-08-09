# 收尾产物独立评审

## 评审范围

- `docs/memory/methodology-missing-evidence-counted-as-zero.md` 与 `docs/memory/MEMORY.md` 的新增索引钩子（`a8b846ce`）。
- `docs/todo/deferred-backlog.md` 在 `63568fee`、`53ae4903` 的全部改动。
- `docs/coding-conventions.md` 在 `ca2653ec` 的新增段。
- `exp/junit-tally-false-green/README.md`（`bac4732e`）。
- `docs/tmp/2026-08-08-mandatory-block-delivery-h2-progress-task9-ready-snapshot.md` 的 checkpoint 节（`f7932527`，并对照当前 HEAD 上的后续修订）。

## 已读取／执行的证据

- 仓库 HEAD：`a8b846ce8ca12c78eb856c9b7316e0c0b3bd398a`；评审开始时 `git status --short` 无输出。
- 已读上述五类产物的当前全文或本轮 diff，并读 `docs/tmp/2026-08-09-merge-state-review-{seams,claims}.md` 对账。
- 后续各发现逐条列出命令与输出；所有仓库命令均绑定 `/home/xp/src/copilot-api-js/.claude/worktrees/placeholder`。

## 总体 verdict

**修复 MAJOR 后可进入下一阶段。BLOCKER：0。**

## 事实性发现

### 已验证的承重前提：加载期抛错确实不会进入 JUnit XML

- **命题**：`docs/memory/methodology-missing-evidence-counted-as-zero.md:17` 与 `exp/junit-tally-false-green/README.md:33` 声称，测试文件在加载期抛错时，Bun 会在自身 summary 计失败，但该文件不产生任何 JUnit 行。
- **命令**：在 `/home/xp/.claude/jobs/a7c2cc1a/tmp/wrapup-junit-load-probe/` 创建一个顶层 `throw new Error("load boom")` 的文件和一个普通通过文件，然后运行 `bun test --reporter=junit --reporter-outfile=.../result.xml <load-boom> <ordinary>`。
- **输出**：Bun 1.3.14 退出码 1，summary 为 `1 pass / 1 fail / 1 error / Ran 2 tests across 2 files`；`result.xml` 的根节点却是 `tests="1" failures="0"`，且只包含 `ordinary.unit.test.ts`，全文没有 `load-boom.unit.test.ts`。
- **结论**：该承重前提成立，不构成 BLOCKER。接手方据此保留 `INCOMPLETE` 标记是正确动作。

### 已验证的复跑路径：README 配方在当前 16-shard 产物上可执行

- **命令**：`PARALLEL_TEST_ARTIFACT_DIR=/home/xp/.claude/jobs/a7c2cc1a/tmp/wrapup-fast-artifacts bun run test:fast`；随后逐字执行 README 第 41-52 行的 `bun -e` 配方，仅把 `<artifacts-dir>` 替换为该绝对路径。
- **输出**：runner 为 `16 shards · 5360 tests · 5360 pass · 0 fail · 5360 executed · 1 skipped · 52.63s`；配方输出 `{ executed: 5360, failed: 0, pass: 5360 }`，与 tally 一致。
- **结论**：配方本身可执行；它依赖当前机器恰为 16 shards，这一可移植性边界另见后续发现。

### [MAJOR] `exp/junit-tally-false-green/README.md:3-27` — 自称“原始证据”，实际只保存了事后人工转录，核心历史数字仍不可独立核实

- **现象**：README 说“本目录保存的是……那次运行的原始证据”，并把 `3337`、`7529`、`16.29342` 与特定 XML 行作为已坐实事实；但仓库只保存了一份事后写成的 Markdown，没有原 stdout、XML、哈希、附件或可由当前仓库重建该次运行的输入。第 34、55 行又明确承认 16 份 XML 未收仓、完整日志已失效。
- **证据／命令输出**：`git log --all --oneline -- exp/junit-tally-false-green/README.md` 只有 `bac4732e` 这一笔，即这份 README 自身；全仓排除本轮互相转述的 memory／progress／review／conventions 后，`rg -n "3337|7529|16\.29342|merge-backend2|parallel-test-VZxJ3f" ...` 仅命中 `scripts/parallel-test.ts:232` 的同源注释与 backlog 的同源复述，没有原始 artifact。`git show --no-patch --format=fuller e24de3a1` 证明提交信息早已声称同一组数，但提交信息与后来 README 同属作者转述，不是独立 ground truth。
- **接手方错误动作**：接手方会把“已固化原始证据”当成可以独立审计的 primary evidence，进而把 `3337/7529/16.29342` 写入新的规范、基线或根因说明；实际只能确认“作者在多个载体重复了同一说法”。这正好重犯该记忆要防的“没读到却当成已读到”。
- **建议处置**：不要再称“原始证据”。若原 artifact 仍能从 job/transcript/tool-result 恢复，收进 `exp/` 并附生成环境、命令、文件哈希；若已不可恢复，把精确数字统一降级为“同一轮记录的未独立核实转录”，将可独立复现的加载期抛错 PoC 与当前 parser 行为作为现存强证据。修复方建议 `gpt-souls:doc-writer`；数字真实性无法补证时不得靠更多同源复述升级证据等级。

### [MAJOR] `docs/coding-conventions.md:48`、`docs/todo/deferred-backlog.md:1258` — 稳定约定仍把 JUnit tally 写成无条件可信，漏掉已知的 `INCOMPLETE` 条件

- **现象**：约定文档说“tally 的真相源是 JUnit XML”，只把“nonzero 且没有 `N fail`”的 crash 重跑称为兜底；backlog 又宣布 2026-08-09 后“不得引用 tally 数字”的纪律解除。两处都没有写关键前提：只有 `missingFiles === 0`、无 `INCOMPLETE` 时这些数才可当总量；加载期抛错时 JUnit 会少行，crash 分类器也可能不触发。
- **证据／命令输出**：上述独立 load-time probe 得到 Bun summary `1 pass / 1 fail / 1 error / 2 files`，XML 却为 `tests=1 failures=0` 且完全缺失失败文件。当前代码 `scripts/parallel-test.ts:212-217,242-254` 通过 `compareFileIdentities` 发现 missing，并把 `missingFiles` 送入 tally；`scripts/parallel-test-artifacts.ts:220-239` 明确写“these counts are a floor, not a total”。因此代码合同已经是“JUnit + identity completeness”，不是文档所写的“JUnit 即真相源”。
- **接手方错误动作**：接手方会照稳定约定或 backlog 的“纪律解除”直接摘取 `N tests/N pass/N fail`，即使同一行带 `INCOMPLETE`，甚至在实现新的报告器时只解析 XML、不做文件身份对账；结果仍会把加载失败算成不存在。
- **建议处置**：将权威约定改成“JUnit testcase 行提供已观察计数，discovery↔runtime file identity 决定计数是否完整；`INCOMPLETE` 时数字只是 floor，禁止作规模／增减／全绿证据”。backlog 的解除也必须加同一条件，并明确“同一 commit 连跑三次”不是完整性的替代。修复方建议 `gpt-souls:doc-writer`；同步对账 memory/README 的相同措辞。

### [MAJOR] `docs/memory/methodology-missing-evidence-counted-as-zero.md:25`、`docs/tmp/2026-08-08-mandatory-block-delivery-h2-progress-task9-ready-snapshot.md:203` — “任何部分退化按构造全绿”是被反例推翻的全称断言

- **现象**：两份文档都从健康端 `109.68/218.58` 与完全失效端 `9.51/10.79` 外推“任何部分退化”在旧 10x 门下都会绿。这个结论需要所有部分退化都单调落在阈值之上，但没有对应实验；完全失效端的 physical 本来就在 10 以下，因此靠近该端的部分退化完全可能仍低于 10。
- **证据／命令输出**：先运行保留下来的 `/home/xp/.claude/jobs/a7c2cc1a/tmp/scratch/cascontrol.it.test.ts`，得到健康 `physicalRatio=109.8525 / liveRatio=218.7468`，4 pass；运行 `casmut.it.test.ts` 得完全失效 `9.51348 / 10.79397`，旧 physical `>=10` 断言红。随后复制为 `caspartial47.it.test.ts`，只让前 47/48 个 operation 内容唯一、保留第 48 个 operation 使用共享内容——这是“尚保留一部分复用”的部分退化，不是完全失效；实跑得到 `physicalRatio=9.51575 / liveRatio=10.79469`，旧 physical 断言仍红。一个反例足以推翻“任何部分退化全绿”。
- **接手方错误动作**：接手方会把“端点测量”误当成覆盖整个退化空间的证明，在其他判据上照搬“两个端点夹住所有中间态”的方法；这会制造新的机制故事与错误阈值论证。当前 30/50 阈值仍比旧值强，但不能用该全称句证明其覆盖所有部分退化。
- **建议处置**：把结论收窄为已证事实：“完全失效时 live 仍过 10，physical 仅以约 0.49 失败；旧阈值对严重退化的余量过薄，且 live 对该目标失效无鉴别力。”若要主张部分退化覆盖，必须参数化复用比例并实测曲线或证明单调边界。同步修正测试内同款注释。文档修订交 `gpt-souls:doc-writer`；判据覆盖曲线如需建立，可交 `gpt-souls:perf-engineer`。

### [MAJOR] `docs/todo/deferred-backlog.md:1286-1291` — 把一次 9.51s 观测写成当前稳定真值与“系统性偏长”，当前复跑已不支持中心前提

- **现象**：条目标题和正文把 `5.818s vs 9.51s`、差额 3.7s 写成当前状态，并由此断言 LPT “实为 9.5s”且 shard “系统性偏长”；但没有运行日期、commit、命令、样本次数。原评审报告其实已把残差标为“可能是运行方差”“未核实归因”，条目却把单次读数提升成稳定当前状态。
- **证据／命令输出**：`rg -n 'store-performance\.it\.test\.ts' scripts/test-timings.json` 得缓存 `5.818051`；我在 HEAD `a8b846ce` 运行 `bun test tests/history/v3/store-performance.it.test.ts --reporter=junit --reporter-outfile=...`，退出 0、`4 pass / 0 fail`，XML 四个 testcase 的时间为 `0.049415 + 1.011342 + 5.130231 + 0.535257 = 6.726245s`，不是 9.51s；整文件 runner wall 为 7.27s。当前差额按同一“逐用例之和”口径约 0.91s，而非 3.7s。`git log ... -- scripts/test-timings.json` 表明缓存锚定 `05fd7c3d`，但 backlog 没写这个 commit。
- **接手方错误动作**：接手方会直接启动“为什么稳定少估 3.7s”的调查、拒绝刷新 timing cache，或把 CAS 超时归咎于一条并不存在的稳定 9.5s 文件负载；实际先要回答的是运行方差、采集版本和样本分布，当前并无“系统性 9.5s”的证据。
- **建议处置**：把条目改成带基线的历史观测：“`05fd7c3d` 缓存 5.818s；评审某次 HEAD/命令测得 9.51s；当前复跑 6.726s，差异具有运行方差，是否需要刷新或改采集机制未定。”触发条件应是“多次同环境测量显示缓存显著偏离分布”，不是沿用单样本。若要断言性能缺陷，交 `gpt-souls:perf-engineer` 建立多次分布基线；文档修订交 `gpt-souls:doc-writer`。

### [MAJOR] `docs/tmp/2026-08-08-mandatory-block-delivery-h2-progress-task9-ready-snapshot.md:181-208` — checkpoint 的 HEAD 锚仍是 `b9b5895b`，正文却已写入该锚之后的裁决与修复

- **现象**：小节标题仍称“HEAD `b9b5895b`”，但后续正文说 `0144edcb`、`27113ce4` 已修并称两份评审闭合；这两个 commit 都是 `b9b5895b` 的后代。在标题所给快照 checkout 下，这些“已修”事实不存在。
- **证据／命令输出**：`git diff f7932527..HEAD -- <progress-file>` 显示后续 `aae1ec08` 把“待裁决”替换成闭合 verdict，却未更新标题锚；`git log --oneline f7932527..HEAD -- <progress-file>` 只有 `aae1ec08`。`git log --first-parent --oneline ca5f4cf7^..53ae4903` 显示被裁决批次共 10 个提交，包含 `0144edcb`、`27113ce4`，而 `b9b5895b` 仅是其中较早一笔。两份报告则在 `8ba5a109` 才落库。
- **接手方错误动作**：接手方按标题 checkout `b9b5895b` 或以它为复验基线，会期待 `INCOMPLETE` 修复、30/50 阈值与最终裁决已经存在；实际会得到旧实现，并可能把复验差异误判成回归。反过来，按当前正文继续执行又没有一个明确的闭合基线。
- **建议处置**：保留原 checkpoint 快照时，应把后续内容单独标成“状态更新，核验于 `<闭合 SHA>`”，并说明原锚只覆盖 181-196 的历史证据；或把标题更新为闭合 commit，并在正文另存原始 `b9b5895b` 证据点。不要让一个 heading 同时冒充两个时间点。修复方建议 `gpt-souls:doc-writer`。

### [MAJOR] `docs/tmp/2026-08-08-mandatory-block-delivery-h2-progress-task9-ready-snapshot.md:1-39` — 文件仍自称 `in-progress` 且列出已完成的剩余项，活跃写入权没有闭合

- **现象**：frontmatter 仍为 `status: in-progress`；“剩余项”仍要求跑完整门禁、做两视角评审、Task 9 闭合后转移写入权。但同一文件第 138 行已写“最终 verdict：可合并，BLOCKER 0 / MAJOR 0”，第 198 行又写两份合并态评审均闭合；权威进度账 `.superpowers/sdd/progress.md:27` 明确 Task 9 实现候选已完成、正交评审收口，Task 10 才是 blocked 项。
- **证据／命令输出**：`rg -n 'status:|## 剩余项|最终verdict|两份评审均已闭合' <progress-file>` 同时命中 `status: in-progress`、35-39 的旧剩余项、138 的最终可合并 verdict、198 的闭合裁决。`git show --stat --oneline 2df07a1a` 的提交信息就是 `docs: close Task 9 review with final gate evidence`，并修改本文件及 `.superpowers/sdd/progress.md`；后者当前第 27 行写 Task 9 已完成评审收口。
- **接手方错误动作**：三个月后的接手方会重复跑已完成评审、误以为 Task 9 仍未完成，或继续把旧 progress 文件当活跃写入点，与 `.superpowers/sdd/progress.md` 形成双状态源；也可能因“Task 10 不推进”误判为仍等待 Task 9，而真实 blocker 是 Tasks 7/8/9 的整体 activation gate。
- **建议处置**：按 progress 协议将该文件状态改成已完成／已由权威 ledger 接管，清理或改写“剩余项”为历史已完成结果，并明确新的活状态源是 `.superpowers/sdd/progress.md`；不要继续把历史运行日志当当前工作队列。修复方建议 `gpt-souls:doc-writer`。

### [MINOR] `exp/junit-tally-false-green/README.md:41-52` — 配方声称可复算“任意一批产物”，却把 shard 数硬编码为 16

- **现象**：当前 runner 用 `Math.min(files.length, os.cpus().length)` 动态决定 buckets，而配方固定读取 `shard-01.xml` 到 `shard-16.xml`。在少于 16 CPU 的机器上会读不存在文件；若未来 shard 数超过 16，又会静默漏算后续 XML。
- **证据／命令输出**：`scripts/parallel-test.ts:131-153` 显示 shard 数来自 `os.cpus().length`；README 配方为 `for (let i = 1; i <= 16; i++)`。本机当前恰为 16，所以实跑成功并输出 5360；这只证明正样本，不证明“任意一批”。
- **接手方错误动作**：接手方在 8-core CI 上照抄会得到 ENOENT，在 32-core 产物上可能只复算前 16 份并把截断结果当全量。
- **建议处置**：从目录枚举并自然排序 `shard-*.xml`，断言至少一份且编号连续；不要由机器 CPU 数反推已有 artifact。修复方建议 `gpt-souls:doc-writer`。


## 已核实但未形成发现的范围

- **backlog 三条旧 tally 条目**：确认标题没有把“历史七个数字的根因未定位”和“3-run 稳定性守卫未建立”藏掉；`docs/todo/deferred-backlog.md:1188-1197,1255-1265` 明写这两项仍开放。因此没有把“已解决／机制已消除”本身另报缺陷。真正问题是该条在 1258 无条件解除 tally 引用纪律，已并入上面的 JUnit completeness MAJOR。
- **新增 `initHistory()` 条目**：逐行打开并核实 `src/lib/history/state.ts:100-143`、`src/lib/history/worker/admission.ts:182-207`、`src/lib/history/v3/terminal-bus.ts:35-74`、`src/lib/history/recent-terminal.ts:27-38`、`tests/history/v3/migrations-wiring.it.test.ts:117-128`；`git show 57208559:src/lib/history/state.ts` 确认缺口在被合并 master 上已存在，`git diff 57208559:... HEAD:...` 确认合并只新增 summary-backfill stop/drain/start。引用行和归属成立；条目给出触发条件、已有 primitives、顺序约束与确定性测试形状，可直接启动独立设计／实施批次。
- **memory 索引钩子与交叉引用**：`docs/memory/MEMORY.md:30` 含触发症状“门禁在真失败之上报 0 fail”、三种防漏动作和阈值标定提示，不是裸目录项。三个 `[[wiki-link]]` 目标文件均存在。除已经单列的“任何部分退化”全称过强和 evidence provenance 外，未发现额外断链。
- **数字与 SHA**：`git rev-list --count 6d431481..2df07a1a` 为 108，`..57208559` 为 404；两父相对 merge-base 的 changed-file 集交集为 149；`git show --cc ... | rg '^@@@' | wc -l` 为 53。`e24de3a1` 前后 discovery baseline 实算 714→727。`e24de3a1`、`0144edcb`、`27113ce4`、`57208559` 均可解析为 commit。`30/50` 阈值在当前测试代码中存在；保留的 control/mutation harness 实跑得到健康 `109.8525/218.7468`、完全失效 `9.51348/10.79397`。精确历史 `3337/7529/16.29342` 的证据等级问题已单列。
- **定向测试**：`bun test tests/infra/parallel-test-artifacts.unit.test.ts` 得 `18 pass / 0 fail`；`bun test tests/history/v3/store-performance.it.test.ts --reporter=junit ...` 得 `4 pass / 0 fail`。未跑 `test:backend`，遵守任务约束；用 `test:fast` 只为生成 README 配方所需当前 artifact，得 `5360 pass / 0 fail`。

## 结构怪味扫描

- `docs/todo/deferred-backlog.md:1127-1265` — **怪味类型：同一 tally 问题存在三份部分重叠条目，状态分别为“已解决／机制已消除／载体已换”，且新纪律分散复述。** 处置：本轮不要求合并历史记录；记录为 backlog 文档结构债，理由是三条分别保留不同历史样本与未闭合根因，贸然合并会丢 provenance。应指定 1255 条为当前结论入口，前两条显式 `superseded-by`，稳定约定只落 `docs/coding-conventions.md`，避免以后再次出现 1258 与约定文档不同步。
- `docs/tmp/2026-08-08-mandatory-block-delivery-h2-progress-task9-ready-snapshot.md:1-208` — **怪味类型：运行日志与当前状态混写，导致同文件同时有 `in-progress`、旧剩余项、最终 verdict 与后续合并态裁决。** 处置：本轮修；这是两条 MAJOR 的共同结构根因，不另增严重度。
- 其余扫描范围：memory 正文与索引、coding conventions 新增段、exp README。判据为重复实现／职责错位／同一事实多载体且强弱不一；除上述和已列事实发现外无额外结构怪味。

## 主观建议

### [建议] `docs/memory/methodology-missing-evidence-counted-as-zero.md:25` — 阈值标定教训与“缺失证据计零”主轴耦合过松

- **改进点**：同一记忆最后附 CAS 阈值标定，索引钩子也被迫同时承担两个触发面。两者同属 verification，但一个是 evidence completeness，一个是 oracle calibration。
- **预期影响**：未来按“看到 0/空/none”触发本条的人会读到不相关阈值材料；按“阈值取整”找教训的人则不一定搜到本条，降低召回精度。
- **推荐做法**：把 CAS 实例下沉到 `methodology-new-oracle-discriminating-power-is-experimental` 或独立 calibration 条目，本条只留交叉链接与一句摘要；索引钩子保持聚合器症状词聚焦。

## 最终计数

- BLOCKER：0。
- MAJOR：7。
- MINOR：1。
- NIT：0。
- 主观建议：1。
