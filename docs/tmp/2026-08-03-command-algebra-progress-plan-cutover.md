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

## 第十六轮整改（validator mutation split：只做本件事）

- **完成报告纠偏**：上一轮回报「十行单机制/单 mutation」与磁盘不符——条件表虽 10 行，mutation 列仍是「删除／复制」「任一字段」「分别篡改」等复合机制，**没有 `EV-*` ID**。本轮只改此处，不重报 topology。
- **新形状**：condition 表最后一列只列 `EV-01`…`EV-25`；独立 mutation 表每 ID 只改一个输入、写唯一 FAIL。对账实跑原样输出：`C1=2 C2=2 C3=3 C4=3 C5=2 C6=3 C7=1 C8=1 C9=5 C10=3`；`25 IDs each map to exactly one condition`；duplicate/orphan=`none`；action compound-token hits=`0`；无缺条件。
- **可信度修复动作**：这次不再只报 checker green；已贴出独立对账输出、checker rc=0、task 差集空。若本轮 `Edit`/commit 失败，应如实报告失败，不将未落盘内容称完成。

## 第十五轮整改（执行方第八轮：Y-1/Y-2/Y-3）

- **Y-1 因果迁移完成**：T0.0d 在 Commit -1 正式门表中的所有 evidence/正样本要求已删除；它只属于 P 后、C0 前的 post-merge preflight，矩阵标题同步。**不是「task 放哪方便」，是未来输入不能验过去 commit。**
- **Y-2 P 输入**：`POINTER_SHA=P` 成为 validator 显式外部输入，用 `git show "$POINTER_SHA":HANDOVER` 读取唯一 versioned pointer block，验 master 可达、A=执行树 HEAD、A 是 P 祖先。**P 不是 current master 猜测，不是 blame 推断，也不是 entry。**
- **Y-3 独立重算**：validator 由 9 条复合条件拆 10 行，每行一机制/一 mutation：P、唯一 block、block 字段、Git 图、manifest hash、15 logs、JUnit identity、skipped multiset/executed、log 字段/verdict、artifact hashes。**一次错误 manifest 与 artifact 一起错不再自证。**
- **额外内容检查**：本轮工具曾在收口表注入 工具调用残留；checker 不会抓 prose 污染。唯一行重写后，增加 residue scan；最终 task 差集空、checker/diff/residue 全绿。

## 第十四轮整改（判据侧第九轮 + 执行侧第八轮）

- **Y-1 因果相位**：T0.0d 已从 Commit -1 正式门表**彻底删除**，迁入独立 **post-merge entry-evidence preflight**（P 后、C0 前）。全 plan/矩阵 grep disposition：它只在 preflight 与其「不属于 -1」说明里出现；Commit -1 只收口 a/b/c。**用未来 A/15/P 验过去 -1 是因果不可达，不是排版问题。**
- **Y-2 `POINTER_SHA=P`**：validator 现在显式输入 `ENTRY_SHA=A`／`POINTER_SHA=P`（完整 SHA），用 `git show "$POINTER_SHA":HANDOVER` 读**唯一机器定位 pointer block**，再验 `ENTRY_SHA` 是 P 祖先、执行树 HEAD=A、当前 master 包含 P。**不猜 P=当前 master HEAD，不靠未规定 blame 格式。**
- **Y-3 十行 validator mutation**：原九行复合机制拆为十行；每行一个条件/一个 mutation 类型（P 可达、唯一 block、字段、Git 图、manifest hash、15 logs、JUnit identity、skip multiset、log 字段、artifact hashes）。原始 artifact 独立重算保持，不信 manifest 自洽。
- **minor timing**：O-6 dev/closeout 与 baseline closeout 均显式 `EVIDENCE_TIMING`。执行方确认其余树 clean/MANIFEST/exclusion/intent 未拆坏。
- **工具残留事故**：本轮编辑工具曾在 Commit -1 收口表行末注入 工具调用残留；checker 不会抓这类人类文档污染。用唯一前缀单行重写后，额外跑 `tool-residue` 扫描（0 命中）+ checker 复验。**教训：结构 checker 绿不等于 prose 无污染，产物还要过内容特异扫描。**

## 第十三轮整改（判据侧最终 1 blocker/1 major + 执行侧最终 1 blocker/1 major/1 minor）

- **T0.0d 因果倒序已修**：它从 Commit -1 的收口门移到明确命名的 **post-merge entry-evidence preflight**（P 后、Commit 0 前）。已裁图顺序是 -1 收口→合 master 得 A→A 的执行树→15 次/manifest→P→**T0.0d**→T0.1/C0。**不能用未来 A/15/P 去验过去 Commit -1**。矩阵标题与 plan gate 表同步，T0.0d task ID 不变、差集为空。
- **X-2 Git 自指已修**：`progress.base=A` 是不可能的（写 A tree 内 progress→B，A 不再 HEAD；P 还在 A 后）。entry A 改为 validator **外部参数** `ENTRY_SHA=A`；Git 图机械证明执行树 HEAD=A 且 A 是 P 祖先。progress.base 回归它本来的「任务起始基线/plan 工作起点」，不冒充 entry truth；P 只走 master 状态线。
- **X-3 原始 artifact 重算**：T0.0d 不再只验 manifest 内部自洽。9 行 validator 表逐条从原始 JUnit/log/disk manifest/runtime identity/skipped multiset 重算：每 run identity、每 run skipped multiset+executed、canonical command+三字段+verdict、三类 hash，再比 manifest。每行都有目标 mutation；正样本必须 15 次逐次一致。
- **Commit -1 mutation protocol 未被相位搬迁冲淡**：a/b/c 仍在 Commit -1 自身门；d 是 P 后消费门，**不为了改摘要数字把 d 混回 -1**。

## 第十二轮整改（用户裁 Commit -1 拓扑 + 执行方第 6 轮 2 major）

- **用户裁已落两处**：plan §11 #4 与 HANDOVER「用户已裁决」表，来源严格保留 AskUserQuestion 选项文本 **「Commit -1 先合 master（推荐）」**。图不是口号，写成可检验 sequence：-1 独立 tree 过门 → 合 master → A → A 的 cutover tree → 外置 15 次 → master P，且 `A` 是 `P` 祖先、P 不合回执行分支。
- **Commit -1 mutation protocol**：T0.0a/b/c 不在将成为 entry 的 `$TREE` 上变异；A 路径是含真实实现的第二隔离 worktree／`/tmp` repo，B 路径是 exact patch + `git apply --reverse --check` + 恢复后 diff。**先证 hunk 真变，再读 FAIL 来自目标机制**，只看 rc 不算。
- **evidence 消费侧 fail-closed 门补为 T0.0d**：validator 逐条验证 master HANDOVER pointer、树外 manifest existence/hash、`manifest.measured_sha == progress.base == A`、恰 15 logs hash/字段/绿 verdict、集合 hash；manifest 被清理即 blocker。并拆成四个可解析 task ID 行，checker 差集为空。
- **显式 timing**：O-6 开发／收口命令均设 `EVIDENCE_TIMING=dev|closeout`，baseline 15 次显式 `closeout`，不依赖默认值。

## 第十一轮整改（用户裁 Commit -1 拓扑 + 执行方第 6 轮 2 major）

- **用户裁决已落 §11 + HANDOVER**：来源严格写 AskUserQuestion 选项文本 **「Commit -1 先合 master（推荐）」**，不编自由文本。图固定：Commit -1 独立 worktree 过自身门 → 先合 master → 合入后 master SHA=A 建 cutover worktree → 树外 OUT 对 A 跑 15 次 → master 提交 pointer P（`A` 是 `P` 祖先）→ cutover 仍从 A 开始 C0、**P 不合回执行分支**。旧 15 次作废。
- **Commit -1 不再是 T0.1 右栏的一句话**：显式 `T0.0a/b/c`、独立 TDD／门表／收口。三类 mutation 都必须走 §0.4e 共同 protocol：**包含真实实现的第二隔离树／`/tmp` repo，或 exact patch + reverse check**；先证 hunk 真变、再读目标 FAIL；禁止从不含实现的基线恢复、禁止共享树整文件覆盖。它们使用 parseable task ID，矩阵拆成三行，checker plan/matrix task 差集为空。
- **evidence 消费门**：树外 manifest 的结构、pointer 的固定路径与语义已经写清；尚需执行期实际生成后按 plan 的 fail-closed validator 消费（pointer/manifest hash/A=progress.base/15 logs 三字段与 hashes）。**缺树外 manifest 不是 warning，是 blocker**。
- **timing 默认已排除**：所有 plan 运行命令显式 `EVIDENCE_TIMING=dev|closeout`；不依赖 baseline closeout／O-6 dev 的不同默认。

## 第十轮整改（协调者前置脚本已落 + 执行方第 5 轮 2 major）

- **`d7f6c222` 已实装结构化 intent**：plan 不再写「字段需求」，改为实际格式 `evidence_timing=dev|closeout`／`measured_sha=<40 位小写 SHA>`／`claims_current_head=true`。baseline 两模式 stdout + 每 run log 字段 SHA=HEAD 已验证；O-6 真请求两次 HTTP 500，故只声称**字段路径正确**，不借成完整 PASS。
- **Commit -1 前置基础设施变成一等相位**：`T0.0a/b/c`、独立 TDD、独立门表；它不是 cutover commit，**一收口 entry sha=A 就变，旧 15 次全部作废**。该 phase 的本体是 runner 自身 mutation，不是 15 次自洽运行：`balance()` 后删文件必须点名红、真实 shard JUnit identity 必须逐次对账、skip multiset 与 reporter/merge mutation 各有正控。
- **证据拓扑最终定形**：树外 evidence manifest 冻结 A；固定 master 指针 `docs/tmp/<date>-entry-evidence-pointer.md` 只定位 manifest/hash，**不写「当前 HEAD=A」**；进度文件引用 pointer commit。归档只是副本，不重定义 entry。
- **任务 ID**：Commit -1 使用 `T0.0a/b/c`（而非 `T-1.*`），避免绕过 checker grammar；plan/matrix task 集合差集实测为空。

## 第九轮整改（协调者前置脚本已落 + 执行方第 5 轮 2 major）

- **结构化 intent 已从「plan 需求」变成 `d7f6c222` 的真实前置能力**：`byte-equivalence.sh`／`baseline-runs.sh` 现输出精确三行 `evidence_timing=dev|closeout`／`measured_sha=<40 位小写 SHA>`／`claims_current_head=true`；无效 timing 与非完整 SHA fail-closed。baseline 两模式 stdout + 每 run log 都经协调者验证字段 SHA=HEAD。**O-6 真请求连续两次 HTTP 500**，所以计划只声称**结构化字段路径正确**，不盗借成「完整 O-6 PASS」。4141 未受影响。
- **Commit -1 不再是 T0.1 右栏里一句「先建它」**：前置基础设施现在有 `T0.0a/b/c`、独立 TDD、门表、收口和 entry 重锚规则。它不是 cutover commit；它收口后 entry sha=A 变化、旧 15 次全部作废。**`T0.0*` 刻意用可解析 grammar**（而非 `T-1.*`），矩阵 §6 已映射，双向 checker 实测 plan/matrix task 差集均为空。
- **`measured_sha=A` 的落点**：树外 evidence manifest 是权威；master 状态文档只放 `A`、manifest 路径/hash、归档副本位置的**指针**，不写「当前 HEAD=A」、不反向定义 entry；进度文件引用这个状态指针所在 master commit。这里上轮「写进 plan」的表述已全扫改掉——写 `$TREE` plan 会造 B、循环重现。
- **自指类从前置需求切换到已实现**：plan 使用实际字段格式，缺标记 fail-closed；不改脚本。真 O-6 请求 500 的诚实边界明记。

## 第八轮整改（判据证伪第七轮：2 blocker + 元判断）

- **blocker-1：sha grep 是推断，且两向都漏** —— 假阴：`HEAD`、不同长度 prefix、大写 sha；假阳：合法历史说明恰好引用当前短 sha。**再补一种 regex 仍是推断型判据换形态**，不采纳。按项目已有记忆 `methodology-relocate-invariant-when-guard-cannot-keep-up` 换轴：**让产生方声明 intent，门读声明**。对协调者维护的 `byte-equivalence.sh`／`baseline-runs.sh`，plan 只提结构化字段需求（不改脚本）：`evidence_timing`／`measured_sha`／`claims_current_head`；缺标记 fail-closed。**关键独立性已写清**：脚本产生，产生方不是被门约束的执行者。手写审计表的同字段只是自述，不冒充机械输入。
- **blocker-2：`[ -s "$PEND" ]` 仍是推断** —— 改文件名、直接追加 pathspec、清空／删除文件都可绕。**同一解药，但此处没有独立产生方**：wrapper 是唯一应用 exclusion 的入口，收口对账 pending + applied ledger + 裁决回执 + `canonical_command_hash`。hash 是承重件：无豁免 canonical command 的 hash 固定，手动追加 `:(exclude)` 必改 hash。**诚实边界已写**：wrapper/ledger 仍由执行者跑，能提高绕过成本、不构成不可伪造证明；独立性只在 reviewer/user 回执。不是继续加 regex。
- **元判断（先取数据）**：收敛，不是无限加固。数据：首两轮是 RFC/plan 实体矛盾与不可达；后几轮 blocker 逐步收缩到**上一轮新加 meta-gate 的自作者问题**（证据落点→自指→grep/pending）。原 cutover contract 已闭合，剩下的是「能否机械证明执行者确实照做」这个不同问题。plan §0.4d 把机械/纪律边界显式列出：**剩余项应记为已知边界，交执行期的人守**；无独立 intent/外部 oracle 时，禁止继续加推断 gate。若后续评审只剩这些已登记边界，**可放行执行，不为还能再造一个推断门无限阻塞**。

## 第七轮整改（判据证伪第六轮：2 blocker）

**两条 blocker 各命中我上一轮的一处，且都是「刻画对了但只落到一个实例」。**

- **blocker-1：自指产物是一类，我只处理了一个成员** —— 上轮我写「唯独 T0.1 的 entry 日志不行，它是唯一一份内容指涉自己所在 commit 之 sha 的证据」。**「唯一」是错的**：`byte-equivalence.sh:133` **每次都打 `head=<当前 HEAD>`**，所以**每个 commit 收口趟的 O-6 输出都同类**；含 `TO=<sha>` 的 population／invariant 报告、可能含 HEAD 的 T0.10 材料亦然。**与 manifest 那次同型——补第 N 个实例堵不住一族。**
  **处置按类**：通用规则「凡内容含本 commit sha 的产物一律落 `$TREE` 外并冻结 `measured_sha`；树内只放不自指的产物」+ **机械判据**（`grep -qE "\b($SHA|$SHORT)\b"`）——**「这份算不算自指」不能由被门约束的一方当场判断**，那又是自评。判据两向实测：O-6 输出被判出，纯命令／计数的审计表判为可提交。
  **协调者点名的循环风险已显式验证**（收口趟跑门→门产出→产出自指，看着像个环）：**产物落树外 ⇒ 跑门不改变树状态**，探针确认收口后 porcelain 仍空、`tree=clean` 成立、输出 `head=` 仍等于 HEAD。**环在「产物出树」这一步就断了**，两条修复不互相拆台。
- **blocker-2：临时 exclusion 粒度写成相位，等于长期旁路** —— 我上轮写「相位收口时批量交裁」，**允许跨多个 commit 累积**，那些 commit 的门**实际没受完整约束**就通过了。**补票补在相位末，漏的正是「门本该咬住的那一刻」。** 收紧到 **commit 粒度**：临时豁免只在开发趟有效、本 commit 收口前必须完成独立裁决、**收口趟不接受任何残留豁免**。
  **机械拒绝**（不是写一句「须已裁决」）：豁免必须以具名文件 `docs/tmp/<date>-pending-exclusions-<slug>.txt` 承载，收口第一步 `[ -s "$PEND" ]` 即 `exit 1` **并列出具体条目**；production 判据在收口趟**以无豁免形态原样重跑**。**正控实跑**：留一条 → rc=1 且报出该条；空文件／文件不存在 → rc=0。

**本轮的可迁移教训**（与上轮那条并列）：**把缺陷刻画成一个类之后，必须回头枚举这个类的全部成员**——刻画正确却只应用到触发它的那个实例，是我连续两轮的同一个失误（manifest 的嵌套二级、自指产物的 O-6 输出）。

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
