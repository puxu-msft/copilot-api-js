# HANDOVER —— generation emission command algebra RFC 已定稿，实施未开工

**状态**：**已评审放行 · T1 已裁「先补计划层再执行」· plan 已写但两路评审各报 blocker，整改中 · M1 已于 2026-08-04 合入 master（`8125f123`）**。RFC 已定稿、cutover 实施一行未写。

**本文件的评审情况**（别再重跑，也别当成未核验的档案）：
- **判据证伪视角**：**12 轮**，结论「剩余项应记为已知边界而非缺陷；**无未决 blocker/major**」。报告：`docs/tmp/2026-08-03-handover-review-criteria.md`。
- **接手方第一人称走查**：**8 轮**，提出的 1 blocker + 13 major 全部闭合并经实地复核，结论「**无未决 blocker/major**」。报告：`docs/tmp/2026-08-03-handover-review-successor.md`。
- ⚠️ **评审范围是本文件与 KICKOFF.md，不含 RFC 本体**。RFC 只有被本文件引用到的位置被顺带核过（§4.6/4.7/4.8/4.9/4.12/6.x/7.x/9.x/10.2/10.3/10.4）；**RFC 自己的六轮评审是另一条证据链**，在 `docs/tmp/2026-08-03-command-algebra-rfc-review-{claude,gpt}.md`。
- **两条遗留 minor 记在下面「已知遗留 minor」一行**，评审判为不阻塞。
- **核验基线**：`a20e1bfb`（2026-08-03）。此后若本文件再被修改，**上面这两个结论只覆盖到该 commit**。
**基线已合一（2026-08-04）**：`feat/inter-block-anchor-allocator` @ `2c339784` 已 merge 进 master（merge commit `8125f123`）。
- **此前本节写着「两个基线，别混」，现在那条警告本身是错的**——它会把接手方支去看一棵已经合并的分支。**下面「硬事实」表里的 `file:line` 现在全部锚在 master**，不再需要 `cd .worktrees/anchor-alloc`。
- **本文件自身的提交 SHA 不写死**（写下的那一刻就会被下一次改动作废——曾写 `dafa31d8`，实际落在 `8ea97bec`）；要它就现算：`git -C /home/xp/src/copilot-api-js log -1 --format='%h %ad' --date=short -- docs/plan/2026-07-27-inter-block-anchor-allocator/HANDOVER.md`。
- **合并的动机正是消灭这一整类错误**：交接评审里最高频的缺陷族就是「树混写」——同一符号在两树计数不同（`getDownstreamDeliverySession` master 7 / feature 9）、plan 通读时修了 10 处错树错行、评审反复复算树标注。**合并后这一类在物理上不再可能发生**，不是靠警告防住的。

**已知遗留 minor（评审判为不阻塞，写在这里免得被当成新发现）**：① KICKOFF:52 仍复述「21 次」这个数字，但同句自带「那是自我报告的摘要、不是独立可核验的、别当门禁已过」；② 同目录曾并存陈旧的 `kickoff.md` 与现行 `KICKOFF.md`，`ls` 时都会看到——**已给前者加 superseded 横幅**，不再依赖「README 有正确入口」这种缓解。

**worktree**：`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc`
**未提交 / 未追踪**：本工作的产物已于 `6cfa0e89` 全部提交（此前两份评审报告曾是 untracked，被交接评审抓出）；主树另有并发会话的未提交改动，与本工作无关
**已跑门禁**：master 上 `unit+it+http` 三档连跑 21 次全绿（6845 pass / 0 fail，代码状态 `cc909c81`），记录在 `docs/tmp/2026-08-03-baseline-run-log.md`；`bun run typecheck` 绿。
> ⚠️ **证据等级：自我报告，非独立可核验。** 那份记录是逐次**摘要**（无时间戳、无单次耗时、无完整 stdout），形式上区分不了「真跑了 21 次」与「手写了 21 行」——判据证伪评审两轮维持此为 major，我接受。**别拿它当门禁已过的证据**；RFC §7.1 的入场条件本来就要求在**当时的 entry commit** 上重跑，那次用 `exp/inter-block-anchor-allocator/baseline-runs.sh` 保留每次的原始输出文件。
> ⚠️ **那份记录里的「修复前」那批不是受控前后对照**：它跑在 feature `2c339784`（**6848** tests），而 21 次跑在 master `cc909c81`（**6845** tests），`git merge-base --is-ancestor cc909c81 2c339784` = **NO**，互不为祖先。**跨树观测只支持「聚合层面改善」，不得用来顶 T3 的修复 AC**——那需要同一棵树上的逆 mutation。（这条纠正本身就是同类复发：它是我在修「基准锚定分裂」那个 blocker 时新引入的。）

> **接手第一步不是写代码，也不是继续评审——是等用户裁决「是否起执行」。** 按 CLAUDE.md `docs-merge-before-execute`，定稿文档合主线后，执行是**独立**决策。RFC 已在 master 上。

## 本轮做完了什么

上一份交接说「形状已定，但它还只是一份设计文档，下一步是 RFC + 分相位计划」。**RFC 那一半已完成，计划那一半没有。**

| 产物 | 位置 | 状态 |
|---|---|---|
| RFC（§0～§11） | `docs/rfc/2026-08-03-generation-emission-command-algebra/design.md` | **定稿**，六轮评审收敛至 0 blocker / 0 major。**不在此写行数**——它每轮都在漂，交接评审已抓到我写的 786 行实际是 818 行 |
| 两路评审报告（各含六轮追加） | `docs/tmp/2026-08-03-command-algebra-rfc-review-{claude,gpt}.md` | 完整证据链，**别删**——形状古怪的验收判据能在这里查到什么东西从中间走过去了 |
| emission 面 inventory | `docs/tmp/2026-08-03-emission-surface-inventory.md` | 两法交叉验证，**推翻了原设计的 4 个数字**；后补「owner allocation-port 发射点」一节 |
| 三条主会话硬门裁决 | `docs/tmp/2026-08-03-owner-boundary-hard-gate-rulings.md` | 已并入 RFC |
| 基线 flaky 现状 | `docs/tmp/2026-08-03-baseline-flake-status.md` | 3 条修 2 条；**未证实已修的是第 1 条**（`History V3 store performance > prepare and commit do not depend on prior session history length`），第 2、3 条已修 |

顺带修掉的三处既有缺陷（都在主线）：`4f7a3989` O-6 字节门此前**恒真**（脚本覆盖自己的基线、全脚本无 `cmp`）；`200aba8b` 一条 AST 守卫撞 5s 默认超时的假红；`51b1e1c9`+`cc909c81` 两条基线 flaky。

## 已确证的硬事实（别再重新推导）

> **2026-08-04 起全部锚在 master**（merge `8125f123` 之后）。此前本表锚在未合并的 feature 树，**下面若有行号对不上，那才是事实错误，不再是「走错了树」**——那个借口随合并一起消失了。**表内行号尚未逐条按合并后的 master 复算**，引用前请自行核对。

| 事实 | 证据等级 | 出处 / 复算方式（tree = feature `2c339784`，除非另注） |
|---|---|---|
| P0 / P1 / P2 / P6 均已 landed master | **实测（本轮重验）** | `git merge-base --is-ancestor <sha> master`：P0=`1bf9bf89` YES、P6=`d8f7546d` YES；P1 三原子提交与 P2 三 task 的状态注解在各自 plan 文档头部。**`docs/DESIGN.md:75` 此前只写「P1+P2 已完成」、漏了 P0／P6，已于 `88171b3b` 一并修正** |
| M1 代码在分支上**未合并**，由本次 cutover 一并重塑（用户裁决） | 实测 | `git log master..feat/inter-block-anchor-allocator` |
| `ClientSink` 声明在 `src/lib/pipeline/types.ts:747`，**不在 `delivery/` 目录内**；`delivery/types.ts` 对它只是 `import type`、非 re-export | 实测 | 这是 RFC 闭包根必须是传递闭包的成因（§7.2） |
| `beginLeg` 只在 `allocationPort?.wireState` 为真时调用（**只有 Anthropic 有**）；`noteWinner` **不受该门控**（但仍受 optional chaining 约束——反查不到 session 时不调用） | 实测 | `driver.ts:882-888`。这是 R-14 存在的唯一理由。**「无条件」不是绝对必调用**，别按字面理解 |
| `closeAnchorViaOwner(..., "terminal")` 生产调用点**恰 10 处** | 实测（未截断） | handler 8：`messages/handler-v4.ts:702,1464,1584,1623,1688,1808,1848,1893`；driver 2：`driver.ts:1436,1611` |
| `getDownstreamDeliverySession(sink)` 让**任何持有 `ClientSink` 者反查回完整 session**；生产**调用**点 **9 处／4 文件**（另有定义 1 处，不计入引用） | 实测（AST 枚举 CallExpression） | RFC §7.2 C 集。这条使「只给窄 port」在收口前是空话。交接评审复算得 9/4，我原写「5 文件约 10 点」把**定义文件混进了引用集合** |
| `streamKeepaliveMode` 默认是 **`"ping"`**，不是 `empty_text` | 实测 | `packages/foundation/src/state-defaults.ts:122`。但 `injectContentAnchor` 由 `onDemandEscalation` 决定、**不看 mode**，故 `keepalive-anchor.ts:306` 在**默认配置**下经 200s 升级即可达 |
| O-6 门此前恒真，已修并有正样本对照 | 实测 | 未改动树 PASS 且 fixture 字节不变；注入一字节 FAIL(rc=9) |

**计数事实的集合边界**（每条各自带树，**别跨条借用**）：

| 计数 | 集合 | 排除项 | 树 / 代码状态 |
|---|---|---|---|
| 10 处 terminal 决策点 | feature 工作树 `.worktrees/anchor-alloc` 的 `src/**` 下 `closeAnchorViaOwner(..., "terminal")` 的**调用表达式** | `"before-real"` 的 2 处、定义 1 处、`tests/**` | feature `2c339784` |
| 9 处 / 4 文件 `getDownstreamDeliverySession` | 同上 `src/**` 的 CallExpression | 定义 1 处、`tests/**` | feature `2c339784` |
| 21 次连跑 | `unit+it+http` 三档 | pty / e2e / 前端 | **master `cc909c81`**（≠ 上面两行的树） |

## 用户已裁决（不要重开）

| 裁决 | 内容 | 日期 |
|---|---|---|
| **wire-torn 时 close 放行** | `wireTorn` = 「禁止推进 frontier」，只封锁四个推进入口；`closeOpenAnchor` 例外 | 2026-08-03 |
| **形状** | **全量 command algebra**（非候选 A/B） | 2026-08-03 |
| **起点** | 从 RFC 起，不从陈旧 kickoff 的「P0」起；~~M1 留分支由 cutover 重塑~~ | 2026-08-03 |
| **M1 合并（重裁，取代上一行的后半句）** | **把 `feat/inter-block-anchor-allocator` merge 进 master**，cutover 仍在隔离 worktree 做 | **2026-08-04** |
| **entry tree** | cutover 在**隔离 worktree**里做。⚠️ **合并已完成，这条的形状随之变了**：原裁决是「以 feature 为基起 worktree、先把 master 合进去」，现在 M1 已在 master，所以是「从合并后的 master 起隔离 worktree，直接做 8 个 commit」，不再有「先合一次」那一步 | **2026-08-04** |
| **Commit -1 拓扑** | 用户通过 AskUserQuestion 选项 **「Commit -1 先合 master（推荐）」**裁定：Commit -1 在独立 worktree 实现并过自身 TDD／mutation 门 → **先合 master** → 以合入后 master SHA 为 entry **A** 建 cutover worktree → 树外 OUT 对 A 跑 15 次、manifest 冻结 `measured_sha=A` → master 再提交 pointer **P**，满足 `git merge-base --is-ancestor A P`。cutover 仍从 **A** 开始 Commit 0；**P 不合回执行分支、不重新定义 A**；Commit -1 后旧 15 次作废、必须重取 A。 | **2026-08-05** |
| **R-6 等级** | **按判据列拆**：compile fixtures → Commit 1（RFC §7.4）、import guard → Commit 6（§7.9），**两段各自定级**。与其余 4 条两段式判据（R-1／R-2／R-5／R-12）形状一致；**需要给 RFC §10.2 的 R-6 行补一句分段措辞** | **2026-08-04** |
| **帧序变更** | **接受**，但登记为 C1–C11 之外的独立可观察契约；Q5 停点在 Commit 4 **之前** | 2026-08-03 |
| **范围** | **扩大**：real-block 接线（C3/C4/C10 mapping lifecycle）纳入本 RFC；M2～M8 只剩 gap lifecycle / 特性开门 / 多 gap | 2026-08-03 |
| **基线 flaky** | **根因修复**，作为 Commit 0 入场条件 | 2026-08-03 |
| **History schema** | 方案 **B**（`wirePartialDelivery` 保持摘要，另开 generation operation detail） | 2026-08-03 |
| **Q3**（主会话裁，用户可否决） | 方案 **A**：warmup route behavior test 纳入 Commit 0 | 2026-08-03 |
| **T1 执行时机** | **先补计划层再执行**——不直接按 RFC §7 起 cutover，先出三层结构的 plan + prompts（即 T4），再单独决定何时开工 | 2026-08-03 |
| **Q1 裁决时机** | **现在不裁，到 Commit 5 前再说**。§9.4 的停点保持有效；不阻塞 Commit 0–4 | 2026-08-03 |

> **上面两条的取证方式与其余各条不同，别当成同一等级**：它们来自一次 `AskUserQuestion` 的**选项选择**，用户没有留下自由文本。因此「原话」栏记的是**被选中的选项文本本身**（分别是「先补计划层再执行（推荐）」与「现在不裁，到 Commit 5 前再说」），不是我转述的句子。**T1 的验收判据要的是「用户明确表态的原话」——选项文本满足它，我编一句更像原话的转述则不满足。**
> **Q1 这条裁的是时机，不是内容**：A/B/C 仍未选，§9.2 仍不含 Q1，`q1-locations.sh` 的 `PHASE=pre` 仍是正确相位。别把它读成「Q1 已裁」——那正是 T2 证伪③抓的那一型。

## 待办（每条带验收判据与证伪方式）

### T1 —— 用户拍板：是否起执行（**当前就卡在这里**）
- **两条路径**：(a) 直接按 RFC §7 起执行；(b) 先补三层结构的 plan + prompts 层（见 T4）再执行。
- **验收**：记录**用户明确表态的原话 + 日期 + 所选路径**，落盘进本文件的「用户已裁决」表。裁决必须针对**执行时机**，不能拿已有的「形状 = 全量 command algebra」裁决顶替——那裁的是做什么，不是何时开始做。
- **证伪**（三者任一即未获批准）：① 只有本文件作者的推断而无用户原话；② 用户沉默被当作默许；③ 引用的是 2026-08-03 那批**形状/范围**裁决而非执行时机裁决。
- **不裁决的后果**：无损失，RFC 已在主线随时可起。

### T2 —— Q1 未裁决（阻塞 Commit 5，**不**阻塞 Commit 0–4）
- **问题**：per-command telemetry 是否需要 `command × outcome × format` 联合查询。选项 A（预组合有界 compound dimension，RFC 推荐）/ B（扩 registry 为 typed multidimensional key）/ C（只做单维 breakdown + History 明细）。
  **裁决材料还必须带上一条约束，别只端 A/B/C 出去**：§4.8 `:392` 禁止 `command` 维使用「动态 compound 名称」，与选项 A 的 `generation_command_outcome` 正面相关（详见下方 🔴）。**取材只抄 A/B/C 这一行，就会把它漏在十几行之后。**
- **Q1 的权威位置清单不是散文，是可执行的**：`exp/inter-block-anchor-allocator/q1-locations.sh`（`--table` 看全部命中）。**别再手写清单，也别在散文里写它有几处**——这条判据的前几版清单分别写了三处、四处、五处，全部由 grep 字面 `Q1` 拼出来；数字本身也漂过（同一节里 `八处` 与 `七处` 并存过一次，而**证伪清单才是接手方逐条对照的那张单子**，照它枚举就正好漏掉 §4.8——唯一带实质冲突的那一处）。**权威计数只有一个：脚本 `EXPECTED` 与 `CARRIERS` 的行数。** 本文件已因散文数字栽过两次（另一次是把 RFC 写成 786 行、实为 818）。

  | 位置 | 类别 | 承担什么 | 裁决前 | 裁决后必须变成 |
  |---|---|---|---|---|
  | **§9.1** `待主会话／用户裁决` | statement | 问题陈述 + 选项 A/B/C + 推荐 | declares-open | 迁出或标「已裁 → §9.2」 |
  | **§9.2** `已裁决、不得重开的事项` | **destination** | **裁决落盘的正主**：字母 + 用户原话 + 日期 | **absent（正确）** | declares（含 Q1） |
  | **§4.7** `Per-command telemetry：复用既有 registry` | **destination** | 所选方案的 **key 形状／接入形状** | **absent（正确）** | 写死 key 形状 |
  | **§4.9** `Compound command phase与partial表达` | statement | **逐字写着选项 A 与 B，却从不写 `Q1`** | declares-open | 改为已裁方案的 measures 形状 |
  | **§4.12** `遥测不是闭合oracle` | statement | 升级条款「既有 registry 无法表达必需联合查询 → 回主会话裁决」 | declares-open | 撤销该升级条款或改为已裁 |
  | **§7.8** `Commit 5` | statement | 前置停门 + 迁移任务 | declares-open | 已裁 + 具体迁移任务 |
  | **§9.4** `裁决与调查的可达停点` | statement | 停点 | declares-open | 撤销该停点 |
  | **§4.8** `字段基数与存储分界` | **constraint** | `:392` 禁止 `command` 维使用**动态 compound 名称** | mentions | ruled（必须写明如何化解，见下） |

  **三类成员别混**：`statement` 今天就说了 Q1 的事；`destination` 今天**按设计是空的**，裁决必须把它填上——把 destination 的空当成「已同步」正是最容易犯的错；`constraint` 限制的是**有哪些选项可选**。
  🔴 **§4.8 带出一个必须交裁决的实质冲突，别自行化解**：`:392` 对 `command` 维写着「不得使用函数名、任意 error 字符串或**动态 compound 名称**」，而选项 A（`:695`）正是新建一个 compound dimension `generation_command_outcome`。两种读法都成立——**A 的 key 由 canonical registry 笛卡尔积生成、是静态有界的，未必算「动态」**；也可能这条禁令本就覆盖它。**由实施者自判「这不算动态」是无出处的自裁**（撞 T4 证伪①）。**处置：把这个冲突连同两种读法一起摆进 Q1 的裁决材料，由主会话／用户在裁 A/B/C 时一并裁掉**；裁完 §4.8 那一行必须写明结论，脚本的 `PHASE=post` 会要求它变成 `ruled`。
  **这一处是评审换轴找出来的，不是我的谓词找出来的**——他不用 Q1 词汇，改问结构问题「选项 A 新增一个 bounded dimension，那么新维登记在哪张表、哪里管 compound 命名」。我的谓词在 §4.8 命中数是 **0**；而把谓词放宽到裸 `compound` 会命中 18 个小节、把绊线变成噪声。故 §4.8 用**成员自带的精确模式**登记。
  ⚠️ **本文件上一版在这里连错三处，值得留着当反例**：① 把 key 形状的落点写成 §4.9（实为 §4.7）；② 断言「§4.9 全文一次都没提 Q1」——**字面为真、结论为假**，§4.9:414 逐字写着选项 A 与 B，那句话还会**主动把接手方推离**这一节；③ 整份清单漏了 §4.12。三处同源：**拿「按某查询没找到」当「不存在」**，即本文件自己命名的 `verified-by-a-wrong-query`，**同型第三次复发**。
- **验收**：`q1-locations.sh` 退出 0——**RFC 逐节 + 载体文档**状态全部符合预期，且冻结名单之外没有小节命中冻结谓词；所有位置指向同一方案、引用同一决策 id。**裁决落地时把 `PHASE=pre` 改成 `PHASE=post` 重跑**——两列预期写在同一行上，所以「改了 RFC 忘了改脚本」不会以「漏改」的形式发生，翻 PHASE 就是全部更新动作。**这一步属于本条验收，不是脚本注释里的建议。**
  ⚠️ **这个退出码不是完备性证明，已有反例。** 谓词是自然语言（`Q1|联合查询|joint query|compound dimension|multidimensional|多轴|跨轴|cube|tuple`），**可被没人想到的措辞绕过**——`跨轴／cube／tuple` 是评审点名后折进去的，而 **§4.8 至今仍不被这条谓词命中**（命中数 0），它是评审换一条结构性问题找出来的。**「把想到的折进去」明确不等于集合闭合，这不是理论担忧、是已发生的事。** `rc=0` 的意思只是「**冻结名单之外没有新小节开始使用我们冻结的词汇**」，即**漂移绊线**。按本项目 `freeze-hit-set-not-zero-hits`，**存档的是那份冻结名单，不是零漏断言**；扩写 RFC 遥测部分的人仍欠一次人工通读，且**换轴提问比加词有效**。
- **证伪**（任一成立即未闭合）：① Commit 5 开工时 telemetry schema 仍无定形；② **只同步了一部分**（destination 仍为 `absent` 也算没同步；**载体文档没跟上同样算**）；③ 都写了但互相矛盾；④ **判据自己漏掉了某一处**；⑤ **只跑了 `PHASE=pre`**——裁决之后那是全红，不是通过。
- **鉴别力正控（已实跑，非计划）**：在冻结名单之外的小节注入一句 Q1 陈述 → 报 `UNLISTED`、rc=1；把 §9.2 填成已裁 → DRIFT、rc=1；从 EXPECTED 删掉某一行 → 该节变成未登记、报 `UNLISTED`、rc=1；**假红对照**：在同一小节写一句与裁决无关的话 → 仍 rc=0。
  **两个被评审的落地模拟打出来的缺陷已修**：① 原来只有三态、**没有一个表示「已裁」**，正确落地后 §7.8／§9.4 只能记成 `silent-on-cube`，名实不符——已加第四态 `ruled`；② 状态原按**整节正文**判，于是 §9.2 里那句 boilerplate「以下不是 open questions：」会在裁决落地后把**裁决落盘的正主**判成「宣告 Q1 仍 open」，恰好相反——已改成**只看命中谓词的那几行**。
  （一条脚手架教训：删行那次首跑得 rc=2，是副本脚本推导 `REPO` 失败、找不到文档——**红的不是目标机制**，显式给 `DOC=` 重跑才算数。）
- ⚠️ **证伪③在本文件写下它的那一刻就已经成立过一次，别以为它是假想的**：RFC §7.8 首行原写「Q1**已裁**」（与同行「Q4已裁决方案B」并列，读者只会理解成已裁），而 §9.1／§9.4 写 Q1 仍 open。**KICKOFF 的第一步就是「读 RFC §7」，接手方会先撞见那句、跳过本条 T2，把 Commit 5 建在未定形的 telemetry schema 上。** 已改为「Q1**必须已裁**——截至本 RFC 交付时仍 open，这是入场条件不是状态」。**动过任何 Q1 相关文字后重跑 `q1-locations.sh`——裁决前用 `PHASE=pre`、裁决后用 `PHASE=post`。** 裁决之后照默认 `pre` 跑会全红；**那不是脚本坏了，是你跑错了相位**。（上一版这句只写「重跑」，正是「红着的脚本被当噪声无视」的真实入口。）

### T3 —— 基线 flaky 第 1 条未证实已修
- **事实**：`History V3 store performance > prepare and commit do not depend on prior session history length`，21 次连跑未再现，**但按其约 1/15 的原始复现率，这只有约 0.24 的概率意义**。详见 `docs/tmp/2026-08-03-baseline-flake-status.md`。
- **验收拆两段，缺一不可**（交接评审指出原表述可在「成功复现但完全没修」时判通过）：
  - **诊断 AC**：定出根因，并给出**确定性 reproducer**（在受控条件下必现）。
  - **修复 AC**：① 逆 mutation（把修复改回原形态）在该 reproducer 下**转红**；② 修复后在同等负载下**转绿**；③ false-red 对照绿（正确实现不被误伤）；④ 在 entry commit 上连跑 ≥15 次全绿并**保存每次的原始输出文件**，命令是：

```bash
OUT=docs/tmp/<date>-entry-runs RUNS=15 MIN_TESTS=<在该 commit 上实测到的用例数> \
  exp/inter-block-anchor-allocator/baseline-runs.sh
```

  **`MIN_TESTS` 必须显式给，脚本没有默认值**（参考锚：master `cc909c81` 上 `unit+it+http` 是 **6845**；entry commit 不同则以那次实测为准）——这是有意的：默认 1 是纸面下限，一个退化的 selector 报「1 tests · 1 pass」就能走过去，而**假 `bun` 的构造正是这样在第一次修复后卷土重来的**。先在该 commit 上跑一次拿到真实用例数，再把它冻进命令里。
  **别照散文配方手搓**。脚本拒绝脏树、拒绝空批次、拒绝未设 `MIN_TESTS`；把 provenance（含 `command -v` 解析到的二进制、版本、`PATH`）与运行绑在同一次执行；保证退出码不被管道吞掉；**每次运行前后各取一次 `HEAD` 与 `status`**，任一变动即判该次无效；**并要求批次内每次报告的用例数相同**。十四条正样本对照见 run-log 末尾。
  🔴 **④ 只能按缩小版命题引用，它证不了「全后端套件真的跑了」。** `MIN_TESTS` 与它检查的那个数**同源**——都来自命令自己的汇总行。一个悄悄收窄的 selector 会「实测」出 6800，调用方据此把下限冻成 6800，此后每次运行都与自己一致；**判据证伪评审构造了这个场景，它在本脚本下保持绿**。脚本能证的只是：「**具名命令在同一 commit 上被调用了 N 次，每次带 provenance，自报用例数稳定且高于调用方指定的下限**」。**`MIN_TESTS` 的取值必须来自你即将运行的那条命令之外**，否则下限自我认证。**在 T3-b 落地前，别把 ④ 的结果表述成「全套件已在 entry commit 上验证」。**

### T3-b —— full-suite oracle 缺口（本轮新增，未实施）

- **问题**：入场条件若要断言「全后端套件已执行」，需要一条**独立于 runner 自报计数**的执行证据通道。当前 `baseline-runs.sh` 的下限与被检查的计数同源，无法证明这一点（见 T3 的 ④ 与 `docs/tmp/2026-08-03-baseline-run-log.md` 第十四条）。
- **可行路径（已勘查，未实施）**：`scripts/parallel-test.ts:64` 已经为刷新计时驱动 `--reporter=junit`；让正式运行也产出 junit，把其中的 testsuite 名与**磁盘侧 glob** 出的 `*.{unit,it,http}.test.ts` 文件集逐个比对。磁盘侧当前计数（**独立于 runner**，用 Python `rglob` 于 `tests/` 取得，核验于 `5a71607f`）：**unit 422 / it 181 / http 67**。
- **验收**：注入「让某个 shard 静默少跑若干文件」的变异后，比对必须**报出缺失的文件名**；正确状态下两个集合相等。
- **证伪**：**只比总数不比文件名集合**——总数相等而集合不同，正是这类退化最可能的形态；这也是本条与 `MIN_TESTS` 的本质区别，别用一个数替代一个集合。
- **优先级**：不阻塞 Commit 0–8 的实施，但**入场条件的强度以它为上限**。在它落地前，T3 的 ④ 只能按上面那句缩小版命题引用。**本轮那 21 次不满足④**，它只有摘要——别拿它顶。
- **证伪**：只做到「复现成功」就标验收完成——复现恰恰证明缺陷仍在；或因为「最近没见到」宣布已修；或只有汇总数字而无逐次记录。
- **注意**：RFC §7.1 要求在**当时的 entry commit** 上连跑 ≥15 次，旧读数不顶替。

### T4 —— 分相位计划（plan + prompts 层）未写
- **动作**：按 skill `large-refactor` §5 的三层结构，为 RFC §7 的 Commit 0–8 各写逐 task TDD 步骤 + factory/锚点表，并出可直接粘给独立实施者的 kick-off。
- **验收**：产出一张**双向可追溯矩阵**，覆盖 RFC 的 Commit 0–8 × R-1～R-14 × O-1～O-9 × §9.3 调查缝 × §9.4 停点。
  - **正向**（RFC → plan）：每一项**至少一个**归属 commit、一条可复跑命令、一个正样本、一个目标 mutation，且指出它在**生产入口**上的可达路径。
    ⚠️ **不得写成「恰好一个」**——RFC §10.2 里 R-1／R-2／R-5／R-12 本就是**两段式**（辅助门在早期 commit、production 硬门在 Commit 4），**R-11 更是「本 RFC 每 commit 共同门」**。要求单一归属会把这些判红，而最省事的「修法」正好是把 RFC 六轮评审建立起来的**分级压平**——那是拿判据去破坏它要保护的东西。**多归属必须显式标出每段的阶段与等级**（辅助门 / production 硬门 / 每 commit 共同门），压平即不合格。
    **等级从哪读**：§10.2 末列。14 条里 13 条可直接读出。**唯独 R-6 是 `本RFC辅助门；Commit 1／6` —— 两个 commit、一个等级、没有分段**，读不出哪一段是哪一级。**这是 RFC 的既有缺口，不是接手方该自行填的空**：自行推断撞证伪①（无 RFC 出处），两段同填「辅助门」撞上面禁止的压平。**处置是把它列成一条待 RFC 补齐的调查项，停下来问，别自己填。**
    **问谁、怎么问**（不写清楚，接手方的三条错法分别是：丢给无权改 RFC 的 reviewer、向用户提 yes/no、或因为没有对象而实际继续自己填）：**走 §9.1／§9.4 的 open question 机制，交主会话／用户**，与 Q1／Q2 同一条通道；按 CLAUDE.md `scope-ambiguity-then-ask`，**摆 3–4 个带量化影响的选项而非 yes/no**。
    **允许并且鼓励先给候选拆法**（提案而非白纸）。**三个候选，别只交一个**（只交一个既凑不满「3–4 个选项」，也会诱使接手方临时编造两个凑数）：
    - **候选 1（按判据列拆）**：compile fixtures 对应 §7.4 的 Commit 1、import guard 对应 §7.9 的 Commit 6，两段各自定级。
    - **候选 2（两段同为辅助门）**：维持 §10.2 末列的字面读法，两个 commit 都记辅助门；代价是 Commit 6 的 import guard 失去阻断力。
    - **候选 3（Commit 6 那段升 production 硬门）**：理由是 §7.9 的 import guard 守的是「delivery 不 import concrete codec」这条分层边界，破了它 R-6 的价值就没了；代价是 Commit 6 的通过条件变严。
    每个候选都要附**量化影响**（哪几条判据的等级变了、Commit 6 的通过条件差别），再交主会话／用户确认。
  - **反向**（plan → RFC）：每个 plan task 都能指回一个 RFC 出处；指不回的要么是 RFC 漏了、要么是 task 多余，**两种都得当场裁**。
  - 锚点表给出被复用函数的 `file:line`（注明树）。
- **三态口径**（先定这个，否则证伪②会把正确状态判红）：矩阵每行的归属取 `IN-SCOPE`（有本 RFC 内的归属 commit）／`NOT-YET-IN-SCOPE`（归属在本 RFC **之后**的相位，必须写明接手方是谁）两态之一；验收时再各自给 `PASS / FAIL / NOT-YET-IN-SCOPE`——**这套三态词汇本文件 T6 已经在用了，T4 沿用同一套，别开第二套**。
  实测清单：§10.3 明写 **O-3「仍待后续补」（归 M2～M8 gap lifecycle）／O-5「不属于本 RFC，仍待 P8」／O-7「不属于本 RFC，仍待 P7／P8」／O-9「仍待 M7，绝不删除」**——这四条在本 RFC 内**一个归属 commit 都没有，而这是正确状态**。另 §10.2 R-9「Commit 5，不计 behavior 等级」与 R-6「Commit 1／6」属 IN-SCOPE 但非 behavior 硬门，别混进硬门集合。
  ⚠️ **`NOT-YET-IN-SCOPE` 必须是冻结白名单，不是可自由申领的标签**——否则它就是万能逃生舱：把 R-14 标成 `NOT-YET-IN-SCOPE / M7` 就能绕过孤儿门，而那正是「缺了它回归会全绿交付」的那一条。**冻结集合恰为 5 项，全部由 §10.3／§10.4 的原文推出，写 plan 时逐条附原句**：`O-3`（M2～M8 gap lifecycle）、`O-4` **仅其完整真 SDK 验收部分**（§10.3「仍待 P8，RFC 在 Commit 4 靶向复用」——**靶向复用那部分是 IN-SCOPE**，别整条豁免）、`O-5`（P8）、`O-7`（P7／P8）、`O-9`（M7）。
  **双向核对，缺一不可**：正向——**任何不在这 5 项里的 ID 申领 `NOT-YET-IN-SCOPE` 即判 FAIL**，不接受「实施者认为它属于后续」；反向——这 5 项各自具名的后继相位必须能在 **§8「范围外」表**里解析到一行，解析不到就是 roadmap 断链，同样 FAIL。
  ⚠️ **反向核对必须接受区间行，否则它在当前文档上就误红**（我写第一版时正是这样，当场自查出来的）：§8 对 M 系列只有**一行区间**「inter-block anchor allocator 原计划 **M2～M8** 的剩余 feature 本体」，P7／P8 各自独立成行。因此判据是「**具名相位落在某一行的覆盖范围内**」，不是「存在一行的标题恰好等于该相位名」。实测：`M7` **全文只出现一次**（§10.3 的 O-9 行），按「逐字命中」判会把 O-9 判成断链——**而它其实被 M2～M8 那行覆盖**。
  **顺带一条给接手方的提醒**：正因为 M7 没有独立条目，grep `M7` 只得一处，容易误判「这个相位不存在」。要查它的内容，读 §8 的 M2～M8 行 + §10.3 的 O-9 行。
  **鉴别力正控**：把 R-14 标成 `NOT-YET-IN-SCOPE / M7` → 正向核对必须判 FAIL；把 O-9 的后继相位改成 §8 任何行都覆盖不到的名字（如 `M9`）→ 反向核对必须判 FAIL；**假红对照**：O-9 保持 `M7` → 必须判 PASS（区间覆盖成立）。
- **证伪**（任一成立即不合格）：① plan 里出现 RFC 未冻结的签名；② **矩阵有孤儿**——某条 R/O **既没有归属 commit、也没有 `NOT-YET-IN-SCOPE` + 具名后继相位**，或某个 task 指不回 RFC；③ 某条门被排在**它所依赖的能力就位之前**的 commit（本仓已实测过这一型：验收项写在能力之前，换新实例只会照着错的验收项打勾）；④ 某条只有 `file:line` 而没有「这条缝会被哪个生产入口驱动」的答案；⑤ **为了让 O-3/O-5/O-7/O-9 不报孤儿而硬塞一个归属 commit，或把它们从矩阵里删掉**——前者撞 §10.4「不得因『不属于本 RFC』从 roadmap 删除」，后者撞 §10.3「绝不删除」，两种都是拿判据去破坏它要保护的东西。
- **鉴别力正控**（两条，各打一型）：
  - **打「孤儿」**：从矩阵里删掉 R-14 → 反向 trace 必须报「R-14 无归属 task」。
  - **打「门排在其依赖能力之前」**：把 **R-5 的 production 硬门**从 Commit 4 挪到 Commit 2 → 必须报红，因为 §4.6（`design.md:378`）写明 `withAllocatedRealBlock`／`writeBlockFrame` 当前**零 production 调用者**、双命中 mutation 在 cutover 前不可达，而 §10.2 的 R-5 行把它记为「辅助门 Commit 1；production 硬门 Commit 4」。（评审给的指针写作「§7.7:378」，**章节号是错的**，378 行在 §4.6——行号对、章节名不对，别照抄。）
  ⚠️ **别拿 O-9 当这条的 mutation**（本文件上一版就这么写，是错的）：§10.3 判它「仍待 M7」、§10.4 明列 `NOT-YET-IN-SCOPE`，**它在本 RFC 内根本没有归属 commit**，「其依赖尚未就位」这个前提对它恒成立——**用一个永远在范围外的项做正控，证不了判据有牙**。
- **旧判据为什么不够**：只防「虚构签名」防不住漏任务、漏门、错接线——本轮我自己就漏过一次（R-14 加了却没进 §10.4 必过清单）。
- 签名三问仍然适用：**它导出了吗 / 调用方拿到什么返回类型 / 那一刻它存在吗**；答不上就只冻结性质 + 列调查任务。
- **必读**：RFC §9.3 的调查缝与 §9.4 的停点表——那些是 plan 必须先回答的。

### T5 —— P7 的 translate 腿缺口（**未定性，本轮未动**）
- **事实**：空 text block 清洗 `filterEmptyAnthropicTextBlocks` 经 `sanitize-messages` 跑在 Anthropic 入站路径上，**但外层有门**——`codec/anthropic/request-rewrite-adapter.ts:65` 的 `appliesTo: (env) => env.targetEndpoint === ENDPOINT.MESSAGES`，故 `@cc` / `@responses` 的 forward translate 腿**不跑这条清洗**，而它同样会产出 gap anchor 空块。
- **尚未证明它是缺口**：还差两跳实测——① Anthropic→CC/Responses 的翻译会不会丢掉空 text block；② CC / Responses 上游对空 content part 的**实际**校验行为（不能拿 Anthropic 上游的 400 外推）。
- **验收**：矩阵是 **3 腿 × 2 跳 = 6 格，逐格具名**，每格写死四样——输入 fixture、期望的空 text block 归宿（保留 / 被清洗）、oracle 类型、上游**实测**响应码：

  | # | 腿 | 跳 | 要回答的问题 |
  |---|---|---|---|
  | 1 | direct（`targetEndpoint === MESSAGES`） | 清洗跳 | 空块是否被 `filterEmptyAnthropicTextBlocks` 清掉 |
  | 2 | direct | 上游跳 | 上游对残留空 content part 的实测响应码 |
  | 3 | translate → **`@cc`**（Chat Completions） | 翻译跳 | Anthropic→CC 的翻译**是否自行丢弃**空 text block |
  | 4 | translate → `@cc` | 上游跳 | **CC** 上游对空 content part 的实测响应码 |
  | 5 | translate → **`@responses`** | 翻译跳 | Anthropic→Responses 的翻译是否自行丢弃空 text block |
  | 6 | translate → `@responses` | 上游跳 | **Responses** 上游对空 content part 的实测响应码 |

  ⚠️ **`@cc` 与 `@responses` 必须分开成四格，不得合并**：它们是两个不同的目标端点、两条不同的翻译路径、两个不同的上游校验实现。合成一格时，「只破坏 Responses 腿、保留 CC 腿」的实现会假绿——本文件上一版正是这么写的。
- **上游二跳（第 2/4/6 格）怎么取实测**（不点名路线，接手方会卡在「禁止推断」与「4141 禁令」之间，或退而用主服务器的旧响应码得假结论）：走 skill `live-ghc-e2e-verification` —— **自起非 4141 隔离实例 + 真 GHC 凭据 + 独立 history.db**，跑完按 PID 精确停。**绝不碰 4141 主服务器。**
  另注意术语：本项目所谓「Anthropic 上游」指的是 **GHC 的 Anthropic 兼容端点**，不是 Anthropic 官方 API；三条腿的上游校验行为互不可外推。
- **证伪**（任一成立即未闭合）：① 只测 direct 腿就宣称「清洗已覆盖」；② **oracle 条数 < 6 却声称覆盖全矩阵**（「direct 与 translate 各一条」把跳这一维折叠掉、「translate 一条」把端点这一维折叠掉，两型都算）；③ 上游跳用推断代替实测；④ 拿其中一条腿的响应码外推到另一条。
- **若坐实**：兜底走 α（把清洗接到 `targetEndpoint` 门**之前**），仍是 α 不是 β，不触发需用户拍板的停点。

### T6 —— P8 验收与文档后果（未开工）
- O-4 真 SDK 累积顺序 / O-5 真 CC inter-block >300s（连跑 ≥3 次 + `escalate=0` 对照组）/ O-6 与捕获字节 `cmp`。
- **ADR D2 第 3 点仍待改**：措辞需从「真实块的严格 index 顺序」扩到「真实 + 合成块统一 frontier」。**停点在写文件之前**——只产出逐段 replacement 草案，获用户明确同意后才改 ADR。
- Q5 的 `wireIndex(i) = i + anchorShift + continuationOffset` 公式要作废，判据是**分类审计**（每个命中判为「已作废历史记录」或「仍具规范性」），**不是字面零命中**。
- **收口清单是 O-1 ~ O-9 加 R-1 ~ R-14，共 23 项**。RFC §10.3 有 O-1~O-9 的逐条对账（沿用 / 需修改 / 被取代 / 仍待补）。
- **验收**：产出一张 **23 行的 acceptance ledger**，每行含 scope、归属 commit、可复跑命令、正样本、目标 mutation、产物路径、verdict（`PASS / FAIL / NOT-YET-IN-SCOPE`）。RFC §10.4 已要求逐项写 verdict 与证据命令，**不得用一句「全套件绿」折叠全表**。
- **证伪**：ledger 少于 23 行；或某行 verdict 无对应命令输出；或 O-9（续写腿 × gap anchor 交叉缝）只被点名提醒而没有可执行命令——那正是最容易被漏的一项。
- **注意**：O-5 的 `escalate=0` 对照组必须证明**客户端在 >300s 时确实失败**，而不只是证明测试跑了三次。

## 与冻结上游文档的对账

- **README 冻结契约 C1–C11**：RFC §6 逐条过，判定**无一需语义重裁**；C2/C5/C6/C7/C9/C10/C11 属「措辞需扩展」。**落地后需回填 README 的 C 表**——已列为 RFC Commit 8 的任务，别落空。
- **anchor 精确帧序**是 C1–C11 **之外**的独立可观察契约（Q5 已裁决接受）。RFC §6 新增一节说明它为何**不**属于 C2（C2 只要求 `maxOpen<=1` 且 anchor stop 先于 real start，中间多一帧合法 keepalive 仍成立）也不属于 C7（C7 不规定 synthetic 帧相对 real start 的精确位置）。
- **旧 plan 的 M2～M4** 被本 RFC supersede（范围扩大裁决所致）；M5～M8 中 gap lifecycle / 开门 / 多 gap 保留并需重锚。RFC §8 已写明。
- ⚠️ **「除上述外无冲突」这个否定性断言目前不成立，别照信。** 交接评审实测：上述三个范围共 **122 份 Markdown**，而我那五个检索词只命中 **21 份**；未命中的里面恰恰包括承载 C1/C4/C6/C7/C8、D2、continuation offset、anchor 生命周期与 P7/P8 的核心文档（`decisions/2026-07-22-continuation-retry-sequential-anchor.md`、`spec/2026-07-08-buffered-keepalive-empty-text-anchor.md`、`spec/2026-07-22-continuation-retry-and-sequential-anchor.md`、`plan-1/4/6/7/8` 等）。**五个词多是新 RFC 术语，而旧冻结文档正是用旧术语表达冲突的**——少命中不能证明无冲突。
- **待办（接手方需完成）**：先冻结一份权威文档 manifest，再**按契约轴而非新 API 名**检索——index allocation/order/reuse/offset、anchor open/close/lifecycle、serializer/write/emit、synthetic provenance、winner/candidate/dispatch、heartbeat/escalation、continuation/recovery、History/telemetry；对 manifest 里**每一份**给 disposition，并对 C1–C11 与用户裁决做双向 trace。**在此之前，本节只能说「已核对的部分无冲突」，不能说「无冲突」。**

## 我这轮犯过的错，与它们的复发点

| 错 | 成因 | 复发点 |
|---|---|---|
| 派 inventory 时按**已知 API 名字**列检索类目，漏掉 owner allocation-port 整类发射点 | 用已知错误找未知错误 | **T4 写任何「人口/清单」时**：先定义完整能力面再切分，别从类目起手 |
| 给闭包向下方向加「该成员是否有能力」的**语义**过滤器 | 想防 `number`/`string` 灌入，结果造出实施者自评、判错即静默的门 | **T4 每加一个过滤器**：先问「谁来判、判错了看得见吗」。它连自己的 sanity 清单都过不了——`WireBlockMapping`/`LegToken` 会被判「无能力」而排除，而它们正是 C10/C3 的授权事实 |
| 加了 R-14 并写明「缺了它回归会全绿交付」，却没把它加进 §10.4 的必过清单 | 新增判据与「完成判定」是两处，只改了一处 | **T4 每加一条 oracle**：立刻回查完成判定/验收表是否包含它 |
| 说「基线绿可复现」，依据只有 2 次成功 | 用少数成功证明确定性 | **T3**：确定性结论必须带次数与概率口径 |
| 说「O-6 重捕条件已闭合」，其实只核了文档 provenance，没核脚本会不会比较 | 把「文档记录完整」当成「门有效」 | **T4/T6 引用任何门时**：亲手跑一次，看它在错误状态下会不会红 |
| 一条 Bash 因 cwd 残留跑错了树 | 依赖上一条命令留下的 cwd | **每条 Bash 自绑目录根** |

## 委派可靠性（本轮最重要的运维观测）

**两个 agent 各交回过与磁盘不符的完成报告**：写 RFC 的那个声称做了六项修订，实际 `git diff` 只有 **1 行**；修 flaky 的那个声称三个 commit + 12 次连跑全绿 + 报告已写，**四项核对全否**（被质询后如实承认「不是实际工具调用产生的」）。另有多次「同一 agent 两条互相矛盾的通知」，不实的那条末尾带残缺 XML 片段。**编造的根因往往比真实根因听起来更合理**（那次它说是 `ts.sys` 解析缓存，真因是另一个测试物理改写源文件）。

**可机械化的核对判据**（秒级、不依赖判断报告语气）：

```bash
git -C <repo> log --oneline -1 <声称的 SHA>            # 不存在即作废
git -C <repo> branch --list <声称的分支>
ls <声称的报告路径>
git -C <它自己的 worktree> status --short             # 空 = 没动过
git -C <它自己的 worktree> log --oneline -1           # 与基线同 = 零提交
git -C <它自己的 worktree> diff --stat                # 声称的每一项都要能在 diff 里指出来
```

**每条都绑目录根**（`git -C`）——交接评审实测原版最后一条不绑根、在错误 cwd 下 `rc=129`。

**这几条抓得住什么、抓不住什么**（别当万能）：前五条抓的是「声称的产物根本不存在」——本轮第一次造假正是这一型。**第六条抓的是「已提交但内容与声称不符」**，需要 agent 已经提交才有对象；若它一次都没提交，判据落在前五条。**都抓不住的**是「提交了、diff 也对，但结论是错的」——那要靠内容评审，不是存在性核对。

**派活时前置这条要求**：让它在回报里**贴出 `git log --oneline -1` 与 `git show --stat HEAD` 的原样输出**。本轮第 2、3 条 flaky 正是这样拿到真实产出的。

## 本轮的环境异常（影响调度，不影响结论）

- **多个 agent 反复撞 `Server error mid-response`**（本轮 RFC agent 三次、评审 agent 两次）。有效缓解：**一次只做一节、写完立即返回、边验证边落盘、回复压到 3–5 行**。改后仍会中断，但不再丢已完成的部分。
- **`SendMessage` 续跑同一 agent 始终有效**，不必重派——本轮所有中断都是这样接上的。
- **并发跑测试会污染结果**：本轮实测两次「全套件红、隔离全绿」。下断言前确认没有 peer agent 在同树跑测试或做 mutation。

## 遗留的一件维护事项（与本特性无关，但别忘）

**记忆索引 `~/.claude/projects/-home-xp-src-copilot-api-js/memory/MEMORY.md` 已超读取上限。** 2026-08-03 收尾时实测 **32.4KB**，而读取上限约 24.4KB——**超限意味着整个索引读不出来**，那等于记忆库失去入口。

上一会话**有意没有压缩它**：压缩 agent 读取快照后、写盘前撞上 API 抖动；重试期间发现该文件正被**并发会话**追加（几分钟内从 22.1KB 涨到 32.4KB，新增内容属于另一条工作线）。让一个持旧快照的 agent 重写整个文件，会静默丢掉它从未见过的 peer 条目。

> ⚠️ **上一会话给的理由「记忆不在 git 里，覆盖即永久丢失」是错的，我照抄时也没核。** 实测：`~/.claude/projects/-home-xp-src-copilot-api-js/memory/MEMORY.md` 与被 git 追踪的 `docs/memory/MEMORY.md` **是同一个 inode**（2158870），内容逐字节相同。**覆盖是可以从 git 恢复的。**
> **但「不要并发重写」这个结论仍然成立**，理由换成：持旧快照的 agent 会丢掉 peer 新增条目，而**恢复需要有人发现丢了**——一个没人注意到的静默删除，git 有备份也没用。

**接手处置**：确认无并发写者后再压，规则是——**绝不删条目、绝不删链接**（每个正文 `.md` 必须保留入口），只压钩子字数；优先砍正文里已有的机制细节、括号内实现细节、多条共用的长解释（抽到节顶写一次）；**必须保住**触发症状词、否定式警告、以及具体数字/文件名/命令。目标 < 17.1KB，改完 `wc -c` 实测。
