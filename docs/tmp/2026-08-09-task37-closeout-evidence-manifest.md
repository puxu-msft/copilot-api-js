# Task 37 收尾：临时证据清单与非文件候选（2026-08-09）

本文件是收尾的**证据处置记录**，不是结论载体——结论各有归属，见下表的「替代证据」列。

## 基线事实（冻结于写作时）

| 项 | 值 |
| --- | --- |
| 本会话交付合并入 master 的提交 | `fe8977c0`（`git merge-base --is-ancestor fe8977c0 master` 通过） |
| 写作时 master | 已由并发会话推进至 `6d212286`（此后 11 个 peer 提交，属正常前进，不触发已验收证据复验） |
| 交付时门禁 | `16 shards · 7726 tests · 7726 pass · 0 fail · 11 skipped`，exit 0，零 crashed shard（测于 `fe8977c0`，树与 master 快进后逐字节相同） |
| job 临时根 | `/home/xp/.claude/jobs/a7c2cc1a/tmp` |
| 冻结成员清单 | `docs/tmp/2026-08-09-task37-closeout-tmp-inventory.md`（排序路径全表，头部带枚举时刻与方法） |
| 成员数 | **427**，两法一致：`os.walk`（含指向目录的符号链接）与 `find "$R" \( -type f -o -type l \)` 同为 427 |

⚠️ **本清单的第一版写的是 424，那个数是错的，值得记下来它怎么错的。** 三处：
1. **它是写作时快照，而同一个 job 随后还在往那个目录写**——我自己写的 commit-message 文件就把它撑到了 425。**裸总数不能宣称「全覆盖」**，必须锚到一份冻结的成员集合；本文件现在锚到上表那份排序清单，分类表逐类对账到 427。
2. **分类表混了两个 selector**：扩展名计数取自 `-maxdepth 1`（顶层），类计数取自全树，于是各行之和既不等于顶层数也不等于全树数。
3. **第一次冻结用 `os.walk` 只遍历 `filenames`，漏掉 2 个指向目录的符号链接**（`os.walk` 把它们归进 `dirnames`），得 425 而 `find` 得 427。**这正是「两种方法交叉验证」该抓的东西**——第一次跑就 DISAGREE，改对方法后才 AGREE。

⚠️ 另一条枚举陷阱：交叉核对必须用 `fd -H -I`。**不带 `-I` 的 `fd` 会遵守 `.gitignore` 而少报**，而本仓多数 job 产物落在被忽略路径下——少报的恰恰是没人复核过的那些。

**job 目录在 job 存活期间保持可写，此后新增是预期内的**，由下表的类规则覆盖，不由这个数覆盖。

## 文件处置（按类，逐类对账到冻结集合的 427 行）

| 类 | 数量 | 长期价值 | 替代证据 / 接收方 | 处置 |
| --- | --- | --- | --- | --- |
| 命令输出 / 门禁日志（`.txt` `.log`） | 237 | 无。被引用的数字均已逐条抄进提交信息与评审报告 | 提交信息 `3a6439ea`／`b8ab9dbb`／`9325ea4d`／`fefb0951`／`e19351e4`／`a72a8e83` 的 Gate 段；`docs/tmp/2026-08-09-task37-seam-review-dispositions.md` | 保留至 job 过期（不主动删） |
| JUnit / 结构化产物（`.xml` `.json`） | 62 | 无。skip 多重集核对结论已落盘 | 本文件 N2／N3 行 + `tests/infra/entry-test-discovery-baseline.json` | 同上 |
| 临时 TS 探针（`.ts`） | 53 | **部分有**：本轮两个分类探针已提交进仓库 | `exp/task37-anthropic-error-boundary/{probe-classify,probe-roundtrip}.ts` + README | 已持久化，副本保留至过期 |
| 一次性编辑 / 整改脚本（`.py`） | 52 | 无。每个都是对某仓库文件做一次文本编辑，结果已提交 | 对应 commit 即结果 | 同上 |
| 变异 / 临时 patch | 10 | 无。每个变异的「符号 → 判据 → 失败形态」均已记录 | dispositions 的变异正控表 + `fefb0951`／`a72a8e83` 提交信息 | 同上 |
| 探针 / 分析脚本（`.py`） | 7 | **部分有**，见下「唯一产出方」节 | 见该节 | 同上 |
| 报告草稿（`.md`） | 2 | 无。已蒸馏进正式报告 | `docs/tmp/2026-08-09-task37-seam-review-*.md` | 同上 |
| 其他 | 2 | 无 | —— | 同上 |
| 符号链接（2 条，均指向 `node_modules`） | 2 | 无。其一指向 `.claude/worktrees/placeholder/node_modules`（本 job 早期 Task 9 阶段的树，仍存在） | —— | 同上；**不删**，删链接对目标无影响但无收益 |

**合计 427，与冻结清单成员数相等**（`recompute-classes.py` 机械对账，OK）。

**不执行删除。这是一个选择，不再是失败关闭。**

过程要记清楚，因为理由变过两次：第一版写「边际成本为零、边际风险为负」，那是**价值判断**、被评审判为不可接受，已撤；第二版改成「双向对账非空 → 按 skill 失败关闭」，那是**可核验的门**，当时成立；**而现在该门已通过**——独立评审在第六轮发出 `review_temp_manifest` 的 positive receipt（事件源与范围、独立枚举、双向 diff 为空，三项齐备），删除因此**已被释放**。

即便如此仍不删，理由是 `closing-a-development-session` 明确允许「harness 自行回收 job 目录」这一处置，前提是**每个对象均有 disposition**——上表逐类覆盖冻结集合的 427 行，该前提成立。删除是不可逆动作，而保留它不损失任何东西。

冻结集合之后新增的对象由上表的类规则给出「保留至过期」的动作；**若将来改为主动删除，类规则不够——必须重新逐路径冻结、分类并复评。**

## 「唯一产出方」审查（skill 明确点名的高危类）

逐个检查是否存在「结论只在此、仓库无载体」的文件：

| 文件 | 它产出了什么 | 载体 | 判定 |
| --- | --- | --- | --- |
| `attrib-duplicate-error.py` | 归属判定：重复终态由 adapter `case "error"` 引入 | `fefb0951` 提交信息的 before／after 帧序列表 | 已有载体 |
| `halfblock-probe.py` | 归属判定：半块泄漏由 D5 分支引入 | `9325ea4d` 提交信息 + `docs/todo/deferred-backlog.md` 的 A／B 实测行 | 已有载体 |
| `show-types.py` | 观测客户端实收帧类型序列的手法 | 手法已内化进 `tests/pipeline/i9-h2-buffered-probe.http.test.ts` 的 `event: error` 计数断言 | 已有载体 |
| `register-skip.py`／`register-suite-skip.py`／`sort-skips.py`／`check-skips.py` | **基线维护的两条操作事实** | ⚠️ **原先无载体**——已于本次收尾补进 backlog，见 N2／N3 | 已修复 |
| `m1`–`m5`／`hb.patch` | 五次变异的精确 diff | 变异正控表已记「符号 → 判据 → 失败形态」，达到可重建粒度 | 已有载体 |

## 非文件候选（Stage `discover_nonfile_candidates`）

文件清单结构上看不见的知识。**每行标 provisional，处置与文件行同权。**

**事件源与范围（第一版没写，是 RR4 判 MAJOR 的直接原因）**：本 job 的 transcript 实际位于 `/home/xp/.claude/projects/-home-xp-src-copilot-api-js--claude-worktrees-task37-closeout/a7c2cc1a-1103-4c54-8ae1-e2837bda4112.jsonl`。⚠️ **transcript 路径随会话所在 worktree 变化**——第一版我给评审的是 worktree 前缀之前的旧路径，那个文件不存在，评审自己定位到了真路径。

**枚举范围收窄为 JSONL 第 12000–15108 行（Task 37 阶段），这是一次有理由的缩窄，不是放弃。**

理由，以及它是怎么被发现该缩的：我先按「覆盖整个 session」做，独立评审连做三轮反向对账，漏项数是 **6 → 5 → 17+**，且第三轮明写「剩余**至少**包括」——**发散而非收敛**。这不是努力不够，是范围错了。skill 自己写着候选须「drawn only from enumerable events of this session — not filtered from 'everything I know', **which degenerates into a full audit**」；在一个横跨两阶段、15108 行的 job 上按每一次订正／校准／变异／探针的粒度枚举，它**已经退化成全量审计**——第三轮列出的 17 组里包含大量 Task 9 阶段的 fixture 假设、阈值重标定与逐个正控。

**关键事实：Task 9 阶段在本 job 内已经单独收过尾。** 它的产物是 `docs/tmp/2026-08-08-task9-review-{spec,acceptance}.md`、`docs/tmp/2026-08-08-mandatory-block-delivery-h2-progress-task9-*.md`、当时增补的 `docs/todo/deferred-backlog.md` 条目与 `docs/memory/` 记忆。评审第三轮列出的多项**已经有载体**——例如它写的「`initHistory()` terminal-settlement 归因被证伪 → 真实 disposition 是 master 既有缺陷并进 backlog」，那条 backlog 早已存在。**它们缺的是本表里的行，不是仓库里的载体**，而本 stage 的目的是「后继者会不会因为证据不可见而重做」，不是「本表是否穷尽」。

**因此**：本表的冻结范围是 **Task 37 阶段（JSONL 12000–15108）**。Task 9 阶段的候选归属它自己那次收尾，本表不追溯重建；若发现该批产物确有遗漏，应作为一条独立的补录任务，而不是塞进本表。**这个缩窄本身是可反驳的**——评审在 RR4 里给过「缩窄并解释」与「按全 session 补行」两个选项，我先选了后者、失败后改选前者，理由如上。

⚠️ **不再声称「覆盖整个 session」**：写作期间该 transcript 已增长到 15419 行，收尾本身仍在产生事件，「整个 session」是写下即过期的断言。

| # | 类 | 内容 | 来源事件 | 如何复现 | 载体 |
| --- | --- | --- | --- | --- | --- |
| N1 | 3 修正的解析／作用域错误 | **在变异之后用 `git diff` 导出恢复 patch，对未跟踪文件得到空 patch，恢复因此没有发生**。它**失败关闭、不是静默失效**：`git apply --reverse --check` 对空输入报 `No valid patches in input` 并退出 128，`&&` 链就此停住、`RESTORED` 未打印——但变异仍在树上，须手工撤销 | 对 `src/lib/anthropic/wire-frame-type.ts`（当时新建、未 `git add`）做正控 | 新建文件 → 编辑 → `git diff -- <file>` 得空 → `git apply --reverse --check` 该空 patch | skill `positive-control-your-tests` 步骤 1（本次补） |
| N2 | 3／6 | **discovery 基线 `allowed_skipped` 必须按 `skipSortKey`（NUL 连接的 identity 字段）逐字节全序**；追加到末尾会以 `allowed_skipped are not unique bytewise sorted` 失败，而**报错的测试名是「tracks the current backend discovery population」**（一条 files 断言），真正的 throw 来自 `parseDiscoveryBaseline`，极易误判 | 注册 gated skip 时踩中 | 往 `allowed_skipped` 末尾追加一条后跑该守卫 | backlog（本次补） |
| N3 | 3／6 | **一个被 `describe.skip` 的套件产出两条 skip identity**：具名那条 + `name:"(unnamed)"` 的套件级那条。只登记具名的会留下潜伏的多重集不匹配 | 用真实运行的 `skipped-multiset.json` 核对时发现 | 跑 `parallel-test` 后读 artifacts 的 `skipped-multiset.json` | backlog（本次补） |
| N4 | 6 运行时探针 | `errorShapingEnabled` 经 `setStateForTests` 在**全应用 HTTP 测试里确实生效**（关闭态可观测到 raw error 帧原样透传） | 参数化 `i9-h2-buffered-probe` 时实测（JSONL 附近） | 见该测试的 `describe.each([true, false])` | **无需补载体**——见下 |
| N5 | 1 已否决路线 | 在 `mergeCandidateResponseOpts` 里 OR-组合 `commitBoundaries`（修法①）——会让 handler 层 JSON classifier 复活，违反 Task 3 冻结契约「adapter.classify 是唯一 wire classifier」 | 修 D2 时的两个候选 | —— | dispositions 已记 |
| N6 | 1 已否决路线 | `test.failing` 取代 `describe.skip`——自解除更优，但 JUnit／基线口径未验证、本仓无先例 | 第三轮评审建议 | —— | backlog 已记 |
| N7 | 2 已证伪的因果 | 「`discardOpen` 保证半块不会送达客户端」——错。`discard-open-unit` outcome 在 `src/` 零消费者，它只清 grammar 自己的累积 | `b8ab9dbb` 提交信息写下该断言，第三轮评审证伪 | `grep -rn 'discard-open-unit' src/` | `grammar.ts` 注释 + dispositions |
| **N8** | 1 已否决路线 + 2 已证伪 | **D5 整条路线被撤回**：让 `acceptTerminal` 对 `failed` 终态发出终态而非协议错误，重试确实停了，**但引入半块泄漏 + 双终态**。这是「路线」级候选，N7 只记了它其中一条错误因果，替代不了它 | JSONL 13720–14077 | backlog 那条 A／B（分支开：1 次上游调用 + `content_block_delta("mid-block")` 上线；撤回态：4 次调用、该 delta 0 次） | `docs/todo/deferred-backlog.md`「已被实测否掉的直接修法」 |
| **N9** | 3 无失败信号的判据错误 | **把控制点参数化到一个结构上无鉴别力的形状**（「已提交块 + error」——块已提交后重试闸门本就关闭，`upstreamCalls` 恒为 1），结果是**两格绿而非一格更强的判据**。我在同一轮里刚写下这个形状判别不了任何 error 分类机制，随后又把新控制点放了进去。**可执行判据**：给一条判据加参数之前，先问「这个形状在**任一**参数取值下能不能被目标变异打红」；答不出就先做变异对照，别先加参数 | JSONL 13668／14741 | 移除 adapter 的 event 行回落 → 该测试两格仍绿；移到「无前置内容」形状后才红 | 本表（自足）+ **建议**加入 skill `catching-false-green-tests`，已向用户提出、待裁决 |
| **N10** | 6 运行时探针 | **真实入口探针实测客户端收到 `["message_start","error","error"]`**（两个终态），这是 D6 的直接证据、也是把判据从 `toContain` 改成数条数的理由 | JSONL 14441 | 见 `tests/pipeline/i9-h2-buffered-probe.http.test.ts` 的 `event: error` 计数断言 | `fefb0951` 提交信息 + 该测试 |
| **N18** | 2 已证伪 + 1 已否决路线 | **D1「Task 4 提前落地」是归属误判**（由未卷入的裁决者裁定撤销）；**且同一评审给的 D2 修法方向是反的**——它建议删掉 handler 的外层谓词，那会把语义偏差固化 | JSONL 12663（Task 37） | 归属：查 Task 4 四项交付物是否存在 + 被引基础设施的引入日期 vs 计划日期。修法方向：比较被删谓词与替代投影的**边界集合**是否相等 | `docs/tmp/2026-08-09-task37-d1-arbitration.md` + dispositions |
| **N19** | 3 修正的作用域错误 | **我唤醒视角 A 时把自己对 D1 的结论告诉了它，污染其独立性**——它随后判 I8 时不能算独立第三票。我在给裁决者的材料里主动披露了这一点 | JSONL 13194 | 复审派活消息：凡在 prompt 里写入自己的结论，该 agent 对该命题的判定即不独立；判据是「它的结论能不能追溯到我的输入」 | 本表（自足）+ `docs/tmp/2026-08-09-task37-d1-arbitration.md` 的污染披露段 |
| **N20** | 2 已证伪的因果 | **代码注释声称「tracked in docs/todo/deferred-backlog.md」而该条目根本不存在**——假的追踪指针比不写更坏，它会终止后续追查。由独立评审 `rg` 无命中发现 | JSONL 13826 | 写下任何「已记录在 X」的指针后，立刻 `rg` 该 X 验证命中；空命中即假指针 | `docs/todo/deferred-backlog.md`（条目已补建）+ `grammar.ts` 注释 |
| **N21** | 5 已执行的变异正控 | **accumulator-feed 正控**：移除共享原语 `anthropicWireFrameType` 的 event 行回落 → 两条 H2 探针在**条数与原因两个维度**同时变红（`overloaded_error` 被 `upstream stream truncated` 取代） | JSONL 14623／14633 | 见 `fefb0951` 提交信息的 mutation control 段 | `fefb0951` 提交信息 |
| **N22** | 6 运行时／外部能力探针 | **Rust／native 工具链可用性探针**：`cargo --version` 得 1.97.1，据此判定可在隔离树内自建 history-search native 产物、从而完成「陈旧产物 vs 新构建」的正样本对照 | JSONL 12346 | `cargo --version`；产物构建走 `bun run build:history-search` | `docs/todo/deferred-backlog.md` 的陈旧 native 产物条目 |
| **N23** | 3 修正的作用域错误 + 6 探针 | **陈旧 native 产物伪装成代码回归**：主检出的 `.node` 建于 2026-08-06、Rust 源码此后 5 个提交，14 条用例以断言失败变红、形状酷似代码缺陷。正样本对照（同 commit、同两文件、新构建产物 → 28 pass）才定性。**并连带订正了我早先的覆盖面声称**——我报的 `7613 pass / 43 skipped` 是在无 native 产物的树里测的，那 43 条 skip 里 34 条正是这批 native 测试，它们从未跑过 | JSONL 12325／12397／12501 | `ls -la native/history-search/*.node` 比对 `git log -5 -- native/history-search/`；重建后重跑同两文件 | `docs/todo/deferred-backlog.md` 陈旧产物条目 + 会话内公开订正 |
| **N24** | 3 修正的作用域错误 | **评审 agent 实际跑在错误的 worktree 里并在其中注入了变异**——我派它去 `.worktrees/task37-seam-review`，它落在我的活跃工作树。这是 `proving-where-a-command-ran` 描述的形态：prompt 里写目录没有绑定力，subagent 落在派发方 cwd | JSONL 12711 | 读评审报告头部它自报的工作树路径，与派发时指定的比对；或要求它首条命令 `pwd -P` | 本表（自足）+ user-level skill `proving-where-a-command-ran` 已有该机制 |
| **N25** | 6 探针 + 5 变异正控 | **首次真实 HTTP 端到端复现**（`upstreamCalls` 期望 1、实测 4）与随后的 **adapter `case "error"` 变异正控**（删除该分支 → 探针按目标变红） | JSONL 12861／13537 | `bun test tests/pipeline/i9-h2-buffered-probe.http.test.ts`；变异见 dispositions 的正控表 | `3a6439ea` 提交信息 + dispositions |
| **N26** | 3 修正的作用域错误 | **被审对象在评审进行中被我撤回**——我在专审 grammar 改动的评审跑到一半时把那处改动 revert 了，它的结论会落在一个已不存在的状态上。我随即通知它改变范围、转为审「撤回本身」 | JSONL 13796 | 判据：派审后若要改动被审对象，必须先通知评审；否则它的证据基线失效 | 本表（自足） |
| **N27** | 3 修正的作用域错误 | **全站点枚举漏五处**：我按拼写 grep 出 7 处并宣称完整，评审找出 5 处（三个 reverse accumulator 入口 + 两个 translator）。教训已收窄为「grep 枚举的是共享同一**拼写**的位置，不是共享同一**错误**的位置」 | JSONL 14458 | 按业务维度（腿／格式／端点／翻译方向）逐个点名，而非数符号引用 | `docs/memory/feedback-fix-all-comparison-sites.md`（本次补的第二实例） |
| **N28** | 3 修正的作用域错误 | **环境条件性 skip 让门在「正确环境」里反而变红**：entry-evidence 的 skip 多重集要求逐条精确相等，而基线里 34 条是 `native-unavailable`——构建了产物（`test:ci` 就会）反而 mismatch。同一文件对 `RUN_PERF_TESTS` 有结构性中和、对 native 却没有 | JSONL 12420／12426／12451 | 在有产物的环境跑 `capture-entry-evidence.ts`，观察 `skipped identity multiset mismatch` | `docs/todo/deferred-backlog.md` 该条目 |
| **N29** | 6 探针 | **adapter 自产帧的协议自洽探针**：把 Anthropic adapter 自己 `renderError()` 产出的帧喂回它自己的 `classify()`，得到 `unexpected-frame`——它认不出自己写出的错误帧 | JSONL 12644／12663 | `bun run exp/task37-anthropic-error-boundary/probe-roundtrip.ts` | `exp/task37-anthropic-error-boundary/`（已提交） |
| **N30** | 3 修正的作用域错误 | **管道过滤伪造失败**：`cmd \| grep …` 让整条命令的退出码变成过滤器的，`grep` 无命中即 exit 1，我两次差点把它读成测试失败 | JSONL 12849／12906 | 判据：要判成败就别过滤；嫌长先落盘再筛 | 本表（自足）+ 既有记忆 `methodology-output-filter-fakes-a-failure` |
| **N31** | 3 修正的作用域错误 | **`echo` 覆盖失败码**：`cmd > f 2>&1; echo "exit=$?"` 里 `echo` 自身成功，于是**整条 bash 调用的退出码是 0**，后台任务通知显示「completed exit 0」而实际 `cmd` 是 1。真值在 `f` 里 | JSONL 13001 | 把真实退出码写进输出文件或用独立变量，别让最后一条命令决定整体码 | 本表（自足） |
| **N32** | 6 探针 + 3 修正 | **wall-clock flaky 的分型探针**：`summary-query-performance` 在全量档红、单跑绿、重跑绿 → 判为已登记的争用型 flaky 而非我的改动。**分型先于归因**是这里的判据 | JSONL 14373／14380／14401 | 单跑该文件 + 重跑全量；两者都绿才可判 flaky | `docs/todo/deferred-backlog.md` 的 wall-clock flaky 条目 |
| **N33** | 3 修正的作用域错误 | **Git diff 范围问错**：`git diff --name-only HEAD..master` 列的是两边**所有**差异文件（含我自己新建的），我一度读成「master 改了这些」。正解是先取 `merge-base` 再分别 diff | JSONL 14766 | `git merge-base HEAD master` 后分别 `diff --name-only <base>..master` 与 `<base>..HEAD`，取交集 | 本表（自足） |

**载体说明**：N8–N10、N18–N22 以**本文件自身**为仓库 carrier（已提交），不另建文档；评审确认该处置可接受。**原 N11–N17（Task 9 阶段的判据空跑、根因证伪、正控不可达、正则→冻结命中集、锚点标反、越权缩小冻结验收）已随范围缩窄移出本表**，归属该阶段自己那次收尾的产物。

## 待补载体（本次收尾产生的动作项）

- **N1** → 归属 user-level skill `positive-control-your-tests`（它拥有「Restoring the mutation without destroying real work」一节）。**已写入该节步骤 1**，作为「patch 来源」这条正令的失败形态。首版措辞含两处缺陷、经独立评审指出后已改：① 写过「for a tracked file it happens to work」——那等于给「事后从 diff 导出」这条捷径发一张 tracked 文件通行证，与步骤 1 的白名单正令竞争，已收敛为无例外表述；② 写过一句 peer edit 会被「静默扩进」的全称因果，本次事故并未实测该路径，已改为条件化命题。**该改动已于第六轮定稿**：独立评审判 INFO／闭合，BLOCKER 0、MAJOR 0。

## 查过但判定**不需要**改载体的（记下来，免得下次重查）

- **N4**：初判为「限定既有记忆的适用面」，**复核后撤回**。记忆 `reference-config-yaml-overwrites-setstatefortests-per-request` 的判据本来就不是「一律空操作」，而是「取决于生效 config 里有没有显式写那个键」。
    **真正的独立依据是代码路径**：`tests/pipeline/i9-h2-buffered-probe.http.test.ts` 用默认 `createFullTestApp()`、且请求 payload 没有 `system`，按 canonical skill `test-isolation` 的调用点表，这条 harness／route 在目标消费之前不会触发 `applyConfigToState()`，所以 `setStateForTests({ errorShapingEnabled })` 存活。
    ⚠️ **仓库根 `config.yaml` 无命中只是辅助证据，不能单独裁决**——`test-isolation` 明确警告仓库根那一份不代表 bundled + user 合成后的生效 config。第一版把它当主要理由写了，是方法上的错；照那样泛化会在别的 suite 漏掉 sandbox user config 与 synthetic bundled config。结论仍是**印证实例、不是订正，不改那条记忆**。

