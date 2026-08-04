---
slug: plan-cutover
base: 237fe27d
branch: master
worktree: /home/xp/src/copilot-api-js
plan: docs/rfc/2026-08-03-generation-emission-command-algebra/cutover-plan.md
agent_id: planner（`AI_AGENT=claude-code_2-1-220_agent`；本 agent 表面读不到独立 agent id，只有会话级 `CLAUDE_CODE_SESSION_ID`）
session_id: 046d7295-e5ce-470b-a284-c721c6ce1cb8
---

# 进度 —— cutover-plan.md 撰写

> 由主会话在**派活前**建立（skill `session-closeout` §6b）。任务预计多轮、需读大量 RFC 与源码、有试错空间，落在「必须建」的一侧。
> **只记 git 记不下来的三样**：剩余项（带验收判据）、在途意图、已作废的路子。「我干了什么」git log 已经有了，别复述。
> **随每个实现 commit 一起提交**，别攒在工作区——被打断时未提交的在途意图会全丢。

> ⚠️ **本文件自己违反过上面这条**：四个 plan commit（`a0c5ae5d`／`1e2957e7`／`da4d4a21`／`2fc705f6`）与矩阵回填 commit（`3512301d`）**都没有带上它**，是被打断后由协调者点名才补的。V12 的观测值就是这个：`--first-parent` 对账会报出 5 条「缺进度更新」，且**集中在前段而非末尾**——这是「一次性补写」的形态。

## 剩余项

- [x] Commit 0～8 的逐 task TDD 步骤（每 task 一个 `T<commit>.<n>` id）—— **78 个 task**（整改轮新增 T0.10／T0.11／T4.0a–d）
- [x] factory／锚点表 —— **整改轮已全部重锚合并后 master `80a4b6fc`，「树」列删除**
- [x] 回填矩阵 `traceability.md`，消掉全部 `_TBD_`
- [x] `traceability-check.py` rc=0 —— **整改轮复跑仍 rc=0**。⚠️ 它已被修成双向（`6ce493e5`），**会咬悬空引用**：本轮新增 T0.10／T0.11／T4.0a–d 时它当场报 `cited by no matrix row`，补进矩阵 §6 后才转绿。**这不是形式，是它第一次真的抓到东西。**
- [x] **整改轮（2026-08-04）**：两路评审的 5 blocker + 7 major 已修，见下「本轮修了什么」
- [x] **执行方复评整改（2026-08-04）**：无 blocker、4 major。R-1 由协调者在脚本层修（`e00b7aff`），R-2／R-3／R-5 + minor R-4 + nit R-6 已修。**锚点抽查 44/56 零错**，`writeAnchor` 那处自报修正被独立确认。
- [x] **判据证伪复评（5 blocker / 5 major / 1 minor）已整改** —— 见下「判据证伪复评整改」。两条不归我：checker 的 suffix-ID 盲区（`aee088d7`）与 `design.md:5,46` 陈旧基线（`4a35e745`）由协调者修。
- [x] **`design.md:597,750` 的 `red characterization` 已由协调者改（`93e300d3`）** —— plan §0.4c 的停门随之撤除。**过期停门会拦住已完成的工作**，改 RFC 的人要顺手扫引用它的 plan。
- [ ] **复评**：本轮改动需再过一轮。
- [ ] **未决裁决**：plan §11 状态表——#2／#3（Q1 与 §4.8）／#5（R-5 归属）／#6（`OwnerTerminalDecision`）。**#6 的触发点本轮从 Commit 4 提前到 T1.6**。

## 第六轮整改（判据证伪第五轮：major 清零，1 blocker + 1 minor）

- **blocker：U-1 的处置是循环的（我上一轮采纳的候选）** —— 日志在 sha **A** 生成 → 提交进去得 **B** ⇒ **日志不再描述最终 entry**；另开 evidence commit 同样前移 entry，**递归无不动点**。`/tmp` 实测 `A=2856653`／`B=49cb4c8`，而日志正文仍写 `measured 2856653`。
  **它当初为什么通过**：我只验了**机械**半边（提交后 porcelain 为空、`tree=clean` 可达——这半边是对的），没验**语义**半边（**日志说的还是不是原来那件事**）。协调者说他提问时也只问了机械那一半，**两个人查了同一半**。
  🔴 **可迁移判据（本轮最大收获）**：验证任何「把 X 放进 Y」的方案，除了「放得进去吗」，必须问「**放进去之后 X 说的还是不是原来那件事**」。
  **新处置在采纳前两半都验了**：① `OUT` 用 `$TREE` 外绝对路径（`:105-107` 的 `/*)` 分支实测直接取值不拼 `$REPO`）→ 树内不产未跟踪文件、`tree=clean` **且 HEAD 仍等于日志所测 sha**；② `measured_sha=A` 冻结进 plan；③ 事后归档到 `docs/tmp/` 仍允许，**实测归档后 A 仍是 HEAD 祖先、日志正文不变**——只是副本，不重新定义 entry。
  **另核实**：证据出树后，「收口趟 `tree=clean`」与 pathspec 提交**不再打架**；并清掉了上一轮我写进 §0.4b／相位归属里依赖「证据随 commit 提交」的措辞（**共 3 处**：处置表、相位归属第 2-4 步、T0.1 的命令行本身仍写着相对 `OUT`）。**各 commit 自己的门输出仍可随该 commit 提交**——只有 entry 日志不行，它是唯一「内容指涉自己所在 commit 之 sha」的证据。
- **minor：新增 exclusion 需独立裁决** —— 反转的前提是排除表会增长，要防的是**增长过程无人复核**：同一方既判「这是合法非-production」又执行加表、无外部 oracle，正是 `downgrade-self-adjudicated-gates` 的形状，**误红处理会退化成随手 bypass**，每 bypass 一次门就少看住一块。改为「当场记录 + 门调用处具名临时豁免 → 相位收口批量交裁 → 通过的才并入 §0.4a」，**排除表只由裁决结果修改**。

## 第五轮整改（两路第四轮：blocker 清零，2+2 major／minor）

**两路独立收敛到同一条：production 判据不完整（第四次复发）。**

- **判据反转（两路共同的 major）** —— 前四次分别是：只扫 `src/` → 整个 `scripts/` 一刀切 → 漏 `ui-v4/`＋根级输入 → 漏 `ui/` 二级条目。**第四次的成因与前三次不同**：第三次之后我加了导出命令，但 `awk -F/ 'NF>1'` **只枚举顶层**，而 `ui/`／`ui-v4/`／`scripts/` 是嵌套项目，**二级我又回到凭想到的列**。评审的措辞值得记：**「第三次是我没想到，第四次是我以为机器替我想了。」**
  **否决了「把导出命令递归下去」**（评审候选 a）：它仍是 allowlist，**第五个嵌套项目出现时同样静默**——修的是实例不是机制。**改为反转：tracked 全集 减 显式排除表。** 依据是失败方向不对称：allowlist 漏项 → **静默假绿**；exclusion 漏项 → **误红一次、当场可见**。反转后 `ui/` 与 `ui-v4/` **自动对称**，我不必再想全。
  **四条对照已实跑**（`/tmp` 一次性仓库）：`ui/package.json`／`ui/bun.lock` 红、`ui/tests`+`tests`+`docs`+`timings` 绿、**新增嵌套项目 `ui-v5/` 默认落在门内→红**。**最后这条就是「第五次不会静默复发」的答案**。
- **U-1 收口趟 `tree=clean` 不可达（执行方 major）** —— 三条要求数学上互斥：`OUT` 相对路径 ⇒ 15 份日志落 `$TREE` 内、`git status --porcelain` **计未跟踪**（`/tmp` 实测 `?? out/`）、收口趟要 `clean`。**执行者最可能的动作正是删判据或删证据。** 处置：**证据随它所证明的 commit 一起提交**（实测走得通，porcelain 为空）；T0.1 那 15 份归**前置基础设施 commit**（它确定 entry sha）。`docs/` 在排除表里，**两条判据互不干扰是有意的**。另补：`baseline-runs.sh` 拒绝混批次但**旧批留盘无作废标记**，要求当场写 `SUPERSEDED.md`。
- **major-2 retained-test-only 岔路** —— 三重判据能抓「只登记名字」，但 (i)「仍存在且仅 test 可达」这条岔路**可以给 T6.2／T6.4 明令删除的 legacy export 当避难所**，C6 归零就成了纸面。已限定：删除清单上的 identity **只能走 replacement 路径**，并补正控。
- **两条 minor**：skipped identity key 定义为 `file+classname+name+ordinal` 的 **multiset**（参数化与模板名会在前三项上碰撞）；mutation 退出码豁免**移到 §0.3**（原先只写在 §0.4c、零处引用，**最该读到它的人读不到**）。
- **「共 37 条 vs 实测 38」**：该表随反转已删除，问题自然消解——**反转的附带收益是不再需要维护一个会与现实漂移的计数**。

**协调者自报了两条复核缺陷（判据太弱），值得记**：①「出现在文档任意位置」②「出现在 §0.4a 区间」——后者会命中代码块而非表格行，**38 条里 20 条没有独立表格行，而该检查区分不了「被分组行覆盖」与「没覆盖」**。这与我上轮那次「38 条全缺失」是同一类：**覆盖率检查本身要能区分它想区分的两种状态**，否则它的绿和红都不携带信息。

## 第四轮整改（执行方 3 major + 判据证伪 1 blocker／3 major／1 minor）

**两路重叠的那条：manifest 不完整。** 这个错**第三次换范围复发**（只扫 `src/` → 整个 `scripts/` 一刀切 → 漏前端与根级输入），所以这次**换方法而不是再列一遍**：§0.4a 先给导出命令（`git ls-files | awk` 枚举全部 tracked 顶层条目），判据是「命令输出里每条都在表中出现」，我**跑脚本核对 38/38 零遗漏**。补进门的：`ui-v4/`（393 文件、`~backend/*` re-export、T5.5 要改）、`ui/`（177）、`bun.lock`（依赖是构建输入）、`tsdown.config.ts`、`hooks/`（运行时加载的 hook，不是文档样例）、`native/`、`contrib/`。false-red 侧经复核保持干净，另按路径排除 `ui-v4/tests/`。

- **「或有具名 replacement」是逃生舱（blocker）** —— 上轮我为解 T0.11 假红而加的，**解了假红开了假绿**：没要求证明它被用、语义等价、production 零可达。改成三条各带正控的可执行判据 (a)(b)(c)，补第 ④ 条 mutation 专打「只登记名字」。
- **第 ④ 条门判据 3 必然假红（执行方 T-1）** —— 脚本对 `head=`／`tree=` **只报不判**，而「写完→跑门→提交」的自然时序下 `tree=DIRTY` 恒成立。**每次假红的门，第一次收口就会被当噪声删掉**——删的正是「门量的是另一个 commit」这道检查。**不改脚本**（跑门本就在提交前，让它对 DIRTY 判红会堵死正常流程），改**时序定义**：§0.4b 分「开发趟／收口趟」，只在收口趟判。
- **`FROM`／`TO` 从未定义（执行方 T-3）** —— 三处引用零定义。§0.4b 一并定死：`FROM=HEAD^`、`TO=HEAD`、落 `$TREE`，并解决基础设施改动的相位归属（**它落地后 entry commit 变了，15 次连跑必须重锚新 sha**）。
- **skipped 口径仍有洞（major）** —— 只比数量时，「一条 runnable 改 skip + 一条 skip 改回」总数不变而 floor 被降低。改为**逐次核对 skipped identity set**；native 那批（写作时 18 条）单列具名审核，**数字标注为执行时重取**。
- **rc=0 口径收窄** —— 论域限于进入 C0 默认 suite 的测试；**隔离 mutation probe 本就该非零退出**，推广会把全部正控判成违规。
- **过期停门（minor）** —— RFC 已改（`93e300d3`）而 plan 还挂着「未改则 C0 不得开工」。**过期的停门会拦住已经完成的工作**，与漏掉的停门同样有害。

**过程中自己犯的一个错**：用 `t.index(...)` 定位小节做替换，**匹配到先前插入留下的第一处**，结果留下一份 §0.4a/0.4b/0.5a 的陈旧副本（82 行）。**是覆盖率检查报「38 条全部缺失」把它暴露的**——结果太离谱，于是先怀疑查询本身而不是文档，才找到重复块（`verified-by-a-wrong-query` 的正向一次）。已顺带把 §0.4a/b/c 重排成阅读顺序，机械复核零悬空引用。


## 判据证伪复评整改（第三轮）修了什么

- **T0.11／T6.5 恒存判据（blocker）** —— 新加的门自己没过检验，**与上轮 T0.10 同型**。seam 直接 import `OwnerRawSink`（`:20`）与 `createDownstreamDeliverySession`（`:31`），而 T6.2／T6.4 的正事就是删它们 → **正确迁移会被自己的门判红**。改成「identity + 迁移关系槽位」，C4（T4.15）填 replacement，C6 判「仍存在且仅 test 可达 **或** 有具名 replacement」，并补第二条 false-red 对照（按计划退役必须绿）。
- **#5／#6 触发点仍过晚（两个 blocker，同型）** —— **可达 ≠ 在分叉前可达**。#5 候选②要改的正是 C1 的内容，而触发点挂在 Commit 2 门表——到那时 C1 已提交并通过 invariant，只剩「改写已落盘的 C1／重排历史／接受缺门」三条都没授权的路。两者都前移到 **Commit 1 kickoff**，Commit 2 那行降为「复核已被贯彻」。
- **#6 框错了（blocker 的实质部分）** —— 上一版说两者「处理同一件事」，**实测不成立**：`ownerFailureOutcome`（`driver.ts:933`）把**任意** owner command 失败都送进 `classifyOwnerFailure`，调用点 `:886,1018,1106,1525,1583` 全是 `beginLeg`、`:1060` 是 `close-anchor-before-real`。**它答「request 怎么 settle」，`TerminalEmissionResult` 答「terminal frame 发了没」——正交轴，不是同一判别函数的两个名字。** 据旧框法，候选①会**静默丢掉非-terminal 的 caller action**、候选③覆盖不了两个轴。已补**候选④**（保留正交职责 + 只桥接 terminate-failure 那一格 + exhaustive mapping／顺序测试防双 settle），并标明**先由 architect-advisor 出重框提案**（职责边界属架构合同）。
- **T0.6 三份 SSOT 相反（blocker）** —— plan／矩阵已改绿口径，**冻结 RFC `:597,750` 仍写 red**。新增 §0.4b 写死「谁在哪个 commit 改」，并挂进 C0 门表：**未改则 C0 不得开工**。**语义澄清**：`red characterization` 的 red 指「被观察到的产品缺陷仍在」，**不修饰测试退出码**——上一版按字面读成后者，才产生终态互斥。
- **T0.1 的 JUnit 来自另一次运行（blocker）** —— `refreshTimings()`（`:61-70`）是 `--update` 时**另起**的一次 run，真正的门运行在 `:120` 用**裸 `bun test`**、无 reporter。**磁盘 vs 一次 refresh JUnit 只证明 `discover()` 当时完整**，证不了 `balance()` 之后／spawn／那 15 次没漏文件——**而 plan 自己的正控恰恰打在这一层**。已改为「每次门运行的 shards 各自产 JUnit + 每次双向比集合」，正控移到 `balance()` 之后。
- **`MIN_TESTS` 口径（major）** —— 两边**现在是相反的**：Bun JUnit `tests` **含** skipped/todo，`parallel-test.ts:148-167` 的 `tests` = `passSum+failSum`（**不含**）。冻结为 **`executed = tests - skipped`**；这也顺带吸收了「主树有 native 产物而隔离树没有、那 18 条会 skip」的差——原始总数两处不同，`executed` 才稳定。
- **T5.1 双腿（major）** —— 只承诺不保证：History 若从 bounded accumulator 读，`cap+1` 之后已经没了。冻结两条独立腿 + **第二条 mutation**（History 复用 truncated buffer 必须红）——只有第一条时「两条腿其实是一条」会全绿交付。
- **T7.3 `scripts/` 一刀切（major，我上轮的直接后果）** —— 该目录四类混住，只有两类是 production；`test-timings.json` 自称 perf hint、`update-circular-deps-baseline.ts` 只写 tests baseline，而 **C7 的正事就是删 fixture、随后同步 timings 是合法测试审计**。改为逐文件枚举 + 「新增文件必须显式归类」+ production 类脚本的正控。
- **T2.4（minor，上轮遗留）** —— 自死锁典型表现是 promise 永不 settle 而非同步 throw，「确认它当场炸」不可判。改为 barrier + 短确定性 deadline + queue-state probe。

**变异复跑（读 FAIL 消息，不只看 rc）**：`T4.0d→T4.0z` 报 `matrix cites plan task T4.0z, which p.md does not define` **且** `T4.0d is cited by no matrix row`；注入 `R-99` 报 `invented acceptance id`；未变异副本与真实文档均 rc=0。**协调者的 checker 修复对 suffix ID 与 extra ID 两个方向都咬得住。**

## 本轮（复评整改）修了什么

- **R-2 门跑在哪棵树** —— 原来只是 T0.10 一次性仪式（哨兵还要「再撤除」、`rg` 全文 3 处、C1–C8 无一要求重证），**而失效是逐次调用发生的**。升为**每 commit 共同门第 ④ 条**，九张门表各加一行。能这么写是因为 `e00b7aff` 让脚本真的打 `repo=`／`server_entry=`／`head=`／`tree=`。<br>**判据只能取 `repo=` 行，不能取进程 cwd**——脚本从不 `cd`，写法 B 下 cwd 与被测树无关。这条是评审的附带观察，我原本会写成「cwd 或可执行路径」，那在写法 B 上给错答案。
- **R-3 用刚改过的尺子量基线** —— T7.3 刚实测证伪「只扫 `src/` 不够」，Commit 0 的 invariant 却还是 `src/ packages/`，**缺 `scripts/`**；而 T0.1②／T0.11② 的 junit 枚举最自然的实现就是改 `scripts/parallel-test.ts`。**处置不是在两处各写一份路径清单**（两份必漂）——新增 §0.4a 定义一次 MANIFEST，Commit 0 invariant 与 T7.3 都引用它。另写明：若 junit 真需要动 `scripts/`，那是**先于 Commit 0 的独立基础设施改动**，不能夹进 cutover 任何 commit。
- **R-5 #6 触发点太晚** —— T1.6 就把三态写进类型层加穷尽性断言，**形状那时已定死**，T2.7／T3.5／T4.10 全建在上面。触发点前移到 T1.6，Commit 4 停门第 4 项降为兜底。**理由不只是「早点裁更好」**：拖到 C4 才裁，候选①要连带推翻三个 commit 的类型层工作，**成本栏会被沉没成本污染**——与上一轮 #4「merge 有冲突」（实测零冲突）是同一种病。
- **R-4（minor，但差点丢掉一个探测器）** —— C4 门表的 R-3 行还写着「T0.6 在此转绿」，那是**重写前**的口径；新口径下 T0.6 在 C0 就是绿的、C4 必须**反转**它才继续绿。照旧口径干 → 测试红 → **在十几个 mutation 同时在跑的 C4，删掉一条「过时的 characterization」看起来非常合理**，而它正是「authority 发布了但没生效」的探测器。已改 C4 门表 + 把反转动作写进 T4.5 的实现列。

## 在途意图

- **对派活指令的一处反驳被采纳**：协调者上一轮要求「三个脚本各自怎么绑根要逐个写清」，我据此判定 `traceability-check.py`／`q1-locations.sh` **本来就该留在 master**（它们审的是文档，文档在主线上），而非跟着 `$TREE` 走。复评确认这个判断成立。**教训是：把「逐个写清」执行成「逐个绑到 $TREE」才是新错**——绑根的正确答案取决于每个脚本审的是什么，不是统一动作。
- **F-7 仍只做一半**：`prompts/` 本轮仍不写（第三层另派），纪律已并入 §0.5，文首写实「`prompts/` 尚未存在、本文即最终派发件」。

## 已作废的路子

- **想用 `fd` 找 golden 文件** —— 本机没装，用 `rg -l`。
- **想按已知 API 名去数 emission 面** —— 漏过 owner allocation-port 整类。改为引用 T0.7 闭包输出。
- **想把 `commandPortActivation` 当既有符号给 `file:line`** —— 实测 `src/` 零命中。
- **想用 `withAllocatedRealBlock`／`writeBlockFrame` 现有签名当终态签名** —— §3.4 要 opaque handle，现有签名是迁移起点。
- **想在锚点表保留「树」列** —— merge 后只会误导（该列此前把「行号只查了一棵树」与「符号只在一棵树有」用同一标记表达）。
- **想给 T0.6 加 `skip`／`todo` 让共同门变绿** —— 会让 R-3 的 C0 段假绿。
- **想在 §11 #5 只写「若评审认为构成漂移则上诉」** —— 无触发点等于永不发生。
- **想把 T0.10 的取证写成「从 O-6 capture 取 server 的 cwd／可执行路径」** —— **物理不可执行**：capture 是纯 SSE 字节，`trap cleanup` 在返回前就杀了进程。已改为读脚本新打的 provenance 行。
- **想在 T7.3 与 Commit 0 invariant 各写一份 production 路径清单** —— 两份必漂（本目录已因「同一事实两处并存」栽过）。改为 §0.4a 定义一次。
- **想把 R-2 的门写成「断言进程 cwd 落在 `$TREE` 下」** —— 脚本从不 `cd`，写法 B 下 cwd 与被测树无关，会给出错误答案。只能取 `repo=`。

## 本轮（整改）修了什么 —— 只记判断，改动本身看 git log

**前提变更**：M1 已 merge（`8125f123`），**「两棵树」整体消失**。因此评审的 F-2 失效、F-5 需重做而非按原意修、F-6 大部分失效、F-10 已闭合。**#1（R-6 等级）与 #4（entry 树）已裁**。

**五个 blocker 的处置判断**：

1. **F-1 门绑根** —— 不是「加一句 `cd $TREE`」就完。**三个脚本的根推导方式各不相同**，必须逐个写：`byte-equivalence.sh` 与 `baseline-runs.sh` 按**脚本自身位置**推导 `REPO`（`cd` 完全不管用），前者有 `REPO_OVERRIDE` 旋钮而后者**没有**；`traceability-check.py`／`q1-locations.sh` 同样按位置推导，但它们审的是**文档**，文档在 master 主线上，所以它们**本来就该留在 master 侧**——把它们也指向 `$TREE` 才是错的。另加 T0.10：**「我 cd 对了」不是证据**，门跑在哪棵树这个前提本身需要 oracle。
2. **T0.6 红绿互斥** —— 关键判断是**不能用 `skip`／`todo` 绕开**。跳过的测试永远不会告诉你缺陷是否还在，那让 R-3 的 C0 段可被假绿。改成 rc=0 的 characterization：**绿 = 缺陷仍在**，并要求文件头落盘「何时必须反转」。
3. **T3.3 笛卡尔积** —— 实测五个 site 的 kind 是**字面量写死的**（`driver.ts:885/1014/1102` primary、`:1521` recovery、`:1579` continuation）。改成关系覆盖表 + **逐 site mutation**（一条聚合断言证不了五个都接上了）。
4. **T0.1 自我认证** —— 取值路径必须**不同原理**：磁盘 glob 与 junit suite 集合**逐文件**比较（不是比总数——总数相等而集合不同正是这类退化的形态）。另加 F-13：脏树 rc=3、`ALLOW_DIRTY=1` 被脚本自己声明不满足门。
5. **#5 实质自裁** —— 撤回「这不是错配」的断言。**并给了必经触发点**（Commit 2 门表），因为 `traceability-check.py` 对「辅助门落 C1 还是 C2」结构性不判——没有机械绊线时，「若评审认为……」等于永不触发。

**新提 #6**（本轮唯一新增待裁）：`OwnerTerminalDecision`（M1 带进来的，三份文档零命中）与 Commit 4 的 `TerminalEmissionResult` 是**竞争抽象**。T3.5 让实施者映射「原散落的提前返回」，但合并后它们**已经被 `classifyOwnerFailure` 收敛了**——照旧描述干会造出第二个 terminal 分类器。

## 在途意图（上一轮，保留）

- **F-7 只做一半是有意的**：本轮**没有**写 `prompts/`（第三层另派），但把它该承载的提交纪律 + 进度文件要求并进了 plan §0.5，并在文首把「`prompts/` 尚未存在、本文即最终派发件」写实。**Commit 4 的 checkpoint 约定单独强调**——16 个 task 同属一个 semantic commit、中途不产生 commit，是全 plan 唯一「中断即全丢」的结构。
- **两处评审建议未采纳，理由记在这里**：①「把 R/O/task 收敛成结构化 manifest 再生成 Markdown」——方向正确但属工具重构，超出本轮整改范围，且会与正在用的 `traceability-check.py` 撞车；②「plan 只引用 machine-readable acceptance row、不复制判据」——本轮已把 T4.10 漏掉的逐 handler mutation 补回，但**彻底去重复需要先有那个 manifest**，同①。两条都该记进 backlog 而非本轮硬塞。
