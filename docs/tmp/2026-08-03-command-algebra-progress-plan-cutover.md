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
- [ ] **判据证伪那一路的复评未回** —— 可能还有一批。
- [ ] **未决裁决**：plan §11 状态表——#2／#3（Q1 与 §4.8）／#5（R-5 归属）／#6（`OwnerTerminalDecision`）。**#6 的触发点本轮从 Commit 4 提前到 T1.6**。

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
