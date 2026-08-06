# cutover-plan.md 执行方第一人称走查（2026-08-04）

**被审对象**：`docs/rfc/2026-08-03-generation-emission-command-algebra/cutover-plan.md`（Commit 0–8）
**视角**：我就是拿到这份 plan、准备执行 cutover 的人，没有本轮上下文。
**裁判轴**：长远正确 + 完整（不削范围）。
**证据基线**：master `174cc314`（`src/`、`packages/` 自 `fcf10eca` 起未变，已实测 `git diff --name-only c259dd9d..174cc314 -- src/ packages/` 为空）；feature `2c339784`（`.worktrees/anchor-alloc`，工作树干净）。

---

## 走查方式（可审计）

**机械核对**：逐条 `sed -n` 打开 plan 给的每个 `file:line`，比对该行是否含它声称的符号；用 `rg` 复算 A-1／A-2／A-4／C 集人口与 10 个 terminal-close 决策；`git merge-base --is-ancestor` 复算 §0.2 的四个 commit 归属；`ls`/`cmp` 复核 `exp/inter-block-anchor-allocator/` 在两棵树的实际内容。
**第一人称执行**：从 §0 使用前必读 → T0.1 → Commit 0 各 task → Commit 4 前置停门 → §11 待裁项，按真实执行顺序走，每一步问「我现在要敲什么命令 / 打开哪个文件 / 卡在哪」。

---

## 总览与 verdict

**verdict：存在 blocker —— 修复 F-1（并重估 F-10）后方可开工。** blocker 1 条、major 6 条、minor 5 条、nit 1 条。

**先说结论的形状**：这份 plan 的**事实精度非常高**——我逐行打开了它给的每一个 `file:line`（master 侧约 110 行、feature 侧约 30 行），**只发现 1 处数字错**（F-8）。作者「已修 10 处错树/错行」的说法，我复算后确认成立。问题**不在锚点，在执行接缝**：门跑在哪棵树（F-1）、缺什么由谁补齐（F-3）、封锁到哪一步（F-6）、怎么提交与记进度（F-7）、以及一条会误导用户裁决的成本估计（F-10）。

| # | 级别 | 一句话 |
|---|---|---|
| F-1 | **blocker** | §0.3 三条每-commit 共同门把命令钉死在 master 共享树，而 plan 自己倾向隔离 worktree ⇒ 24 次结构性假绿 |
| F-3 | major | C4 停门要求「C3 调查证据齐全」，但 C3 对 4 条缝只被要求交最小子集／候选，且 C4 缺「不生成猜测签名、结束本轮」那句 |
| F-4 | major | 「10 个 outer roots」把 Anthropic 的嵌套两层当成三个并列 root ⇒ 单请求两个 owner |
| F-5 | major | Commit 2／5 锚点表 7 行标「feature」，master 上全都存在（只是行号／签名不同） |
| F-6 | major | #4 未决时只封锁 T0.1，而 Commit 0 九个 task 里六个随树而变 |
| F-7 | major | `prompts/` 不存在；提交纪律、进度文件、Commit 4 的 checkpoint 全文零字 |
| F-10 | major | #4 候选 1 的「merge 有冲突」实测为**零冲突**，而这正是倾向候选 4 的理由 |
| F-13 | major | T0.1 在共享脏树上必然 rc=3，唯一旁路被脚本自己声明为「不满足门」 |
| F-2 | major | feature 树没有 `baseline-runs.sh`／`q1-locations.sh`／`traceability-check.py`，且其 `byte-equivalence.sh` 是恒真旧版 |
| F-8 | minor | C 集 master 侧「4 文件」应为 3 文件 |
| F-9 | minor | 三个 `src/lib/anthropic/` 文件全文无完整路径 |
| F-11 | minor | M1 新建的 `owner-failure.ts` / `owner-failure-settlement.ts` 三份文档零命中，与 `TerminalEmissionResult` 是竞争抽象 |
| F-12 | minor | §11 #5 已自裁且无可达触发点，与「五项都不是实施者可自判的」矛盾 |
| F-14 | nit | T0.4 正文写「feature 树已有 `setDeliverySessionObserverForTests`」，锚点表写「两树皆有」 |

**回答派活时点名的五个问题**（详见对应 finding）：
1. **两棵树**：锚点复算通过，唯一数字错是 F-8；但「标 feature」这一列有 7 行是**假阴性**（F-5）。
2. **#4 未裁时能走到第几步**：走到 **T0.2 就卡**（要选一棵「未改动树」），但 plan 只封了 T0.1，我会以为 T0.2 起可以开工（F-6）。**该找谁是写清楚的**（§11 前言：走 RFC §9.1／§9.4 交主会话／用户，摆带量化影响的选项）——路由没问题，问题是那张表的量化影响错了（F-10）。
3. **Commit 4 在哪一步发现缺东西**：**T4.2 第一步就缺**——它要写的 composition factory 签名正是 §9.3 #1，而 C3 只被要求交「够编译的最小子集」。**plan 让我做不到 §9.3 的要求**：Commit 3 有「不生成猜测签名、结束本轮」那句，**Commit 4 没有**，而压力全在 Commit 4（F-3）。
4. **五条待裁项**：#1／#2／#3／#4 框得够硬，我不会自裁。**#5 框不住**——它已经自己判了，只留了条件性上诉且无触发点（F-12）。
5. **进度与提交纪律**：**全文零字**（F-7）。

---

## F-1 `[blocker]` §0.3／§0.4 的每-commit 共同门把命令钉死在 master 共享树，而 plan 自己倾向的执行形状是隔离 worktree ——三条门在隔离树上结构性假绿

**位置**：`cutover-plan.md:43-47`（§0.3）、`:39`／`:646`（§11 待裁项 #4「本 plan 的倾向是候选 4」）
**证据**：
- §0.3 三条命令逐字写死 `…`，即 **master 共享主树**。
- `exp/inter-block-anchor-allocator/byte-equivalence.sh:4-5`：
  ```bash
  DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  REPO="${REPO_OVERRIDE:-$(cd "$DIR/../.." && pwd)}"
  ```
  再在 `:123` 用 `bun run "$REPO/packages/cli/src/main.ts" start` 起服务器。**REPO 由脚本自身位置推导**，所以 `/home/xp/src/copilot-api-js/exp/…/byte-equivalence.sh` 永远起的是 **master 的代码**，与我在隔离树里改了什么完全无关。
- 待裁项 #4 候选 4 的做法是「起隔离 worktree……在该 worktree 上做 entry 与全部 8 个 commit」，并写明「本 plan 的倾向是候选 4」，理由是与 `docs-merge-before-execute` 一致。

**执行方会做出什么错误动作**：裁决落在候选 4（plan 自己推荐的那个）后，我在 `.worktrees/<新树>` 里写完 Commit 1 的代码，照 §0.3 逐字敲那三条命令 —— `bun run typecheck`、`bun scripts/parallel-test.ts unit it http`、`byte-equivalence.sh` **全部在 master 上跑**，全绿。我会据此在 commit invariant 里打勾「typecheck 绿、全套绿、O-6 PASS」，而这三条门**从未看见过我的任何一行代码**。这不是「可能跑错目录」的一般风险，是 plan 逐字给出的命令必然造成的结果：`cd` 到 master 是命令的一部分。8 个 commit × 3 条门 = 24 次假绿，且 Commit 4「唯一原子发布点」的 O-6 也在其中。

**修复建议**：§0.3 改为「把 `$TREE` 绑定到本次 cutover 的 entry worktree 根，三条命令一律 `cd "$TREE" && …`」，并显式点出 `byte-equivalence.sh` 支持 `REPO_OVERRIDE=` 这个既有旋钮（脚本 `:5`，plan 全文零提及）——同时说明：脚本位置决定 `BASELINE`／`deterministic-hook.ts`／fixture 的来源，跨树跑时这几样跟着谁走必须写清楚。另按 user-rule `bind-delegate-directory`／`proving-where-a-command-ran`，Commit 0 应加一条「证明门跑在哪棵树」的取证步骤（如断言 capture 里的 server 进程 cwd／可执行路径落在 `$TREE` 下），否则「跑在正确的树上」这一前提本身没有 oracle。

---

## F-2 `[major]` feature 树里根本没有 `baseline-runs.sh`／`q1-locations.sh`／`traceability-check.py`，且它的 `byte-equivalence.sh` 正是那份「恒真」旧版

**位置**：`cutover-plan.md:70`（T0.1 命令）、`:46`（§0.3 第三条）、`:416`（Q1 相位守卫）、`traceability.md:7,153`
**证据**（实测两树 `exp/inter-block-anchor-allocator/` 目录）：

| 文件 | master `174cc314` | feature `2c339784` |
|---|---|---|
| `byte-equivalence.sh` | 6638 B，含 `cmp -s`／`O-6 PASS`／`RECAPTURE` | **5812 B，`grep -n 'cmp\|O-6 PASS\|RECAPTURE\|BASELINE='` 零命中** |
| `baseline-runs.sh` | 有 | **不存在** |
| `q1-locations.sh` | 有 | **不存在** |
| `traceability-check.py` | 有 | **不存在** |
| `pre-change-wire.sse` | 有 | 有，且与 master **逐字节相同**（`cmp -s` = SAME） |

这与 §0.2 的断言互为印证：`4f7a3989`（修好 O-6 字节门）实测 `master=Y feature=N`。plan 说对了「该门此前恒真」，**但没说这份恒真脚本此刻仍原样躺在 feature 树里**。

**执行方会做出什么错误动作**：若 #4 裁成候选 2 或候选 4 的「以 feature 为基」这一步，我在合入 master 之前的任何时刻跑 T0.2 的自检，用的就是那份没有 `cmp` 的脚本——它**不可能打印 `O-6 PASS`**，我会先花时间怀疑自己的环境；更糟的是若我只看 rc，恒真版会给我一个「通过」的错觉。而 T0.1 的 `baseline-runs.sh`、Commit 5 的 `q1-locations.sh`、矩阵的 `traceability-check.py` 在那棵树上 `No such file or directory`，我会以为 plan 引用了不存在的脚本。

**修复建议**：在 §0.2／§11 #4 里明写一条前置：**这四份脚本只在 master 侧存在，任何以 feature 为基的 entry 都必须先把它们带过来（且 `byte-equivalence.sh` 必须是 master 那份）**，并给出「怎么确认我手上这份是修好的」的机械判据（`grep -c 'O-6 PASS' byte-equivalence.sh` 必须 ≥1，而非看文件存在）。这正是 plan 自己在 T0.2 强调的「双向自检」，但它只覆盖了脚本行为、没覆盖「我手上是哪一份脚本」。

---
## F-3 `[major]` Commit 4 前置停门要求「Commit 3 调查证据齐全」，但 Commit 3 对其中 4 条缝只被要求交「最小子集／候选／方案」——完整证据没有任何 task 拥有它

**位置**：`cutover-plan.md:279`（C4 停门第 2 项）对 `:221-230`（C3 前置调查表）
**证据**：C3 的表有两列「本 commit 需要的最小子集」与「完整证据槽」，后者对 **全部 8 行都写 `C4 publish kickoff`**。其中：

| §9.3 # | C3 被要求交什么 | C4 需要它做什么 |
|---|---|---|
| 1 composition factory 是否导出／谁拿 owner | 「够 builders 与 harness 编译」 | **T4.2** 10 roots 创建 owner |
| 2 HTTP／WS runner typed result、WS close intent | 「同上」（最小子集） | **T4.11** typed socket close intent |
| 5 双命中 mutation 精确注入点 | 「**记录候选**」 | **T4.9** R-5 production 硬门 |
| 8 raw factory test imports 迁移 | 「**记录迁移方案**」 | **T4.15** 迁 65 个 raw factory tests |

C1 的调查任务（`:148`）同样写「RFC §9.3 第 1 项，**最终证据槽在 Commit 4 publish kickoff**，Commit 1 只取最小子集」。于是 #1 在 C1 取子集、在 C3 取子集、在 C4 被当成「已齐全」验收——**中间没有任何 task 负责把它做完**。Commit 4 的 task 表从 T4.1（Q5 diff）直接进 T4.2（切 10 roots），没有 T4.0「补齐调查」。

**并且 Commit 4 缺一句 Commit 3 有的话**：C3 `:219` 逐字写「**到达本 commit kickoff 时先读证据槽；没有 `file:line` 或 PoC 结论，就交付已完成部分与具体问题、结束本轮，不生成猜测签名**」（＝ RFC §7.12／traceability §3 的口径）。**Commit 4 整节没有这句**，只有停门 preamble 的「缺任一项不得发布」。

**执行方会做出什么错误动作**：我在 C4 kickoff 打开停门第 2 项，回头翻 C3 的落盘物，发现 #1／#2／#5／#8 只有「最小子集」「候选」「迁移方案」。此时两条路都错：
- 判「C3 交的就是它被要求交的，所以齐全」→ 直接进 T4.2。而 T4.2 要写的正是「composition factory 是否 export、谁拿 `GenerationDeliveryOwner<P>` 谁只拿 `CommandsFor<P>`」——这恰恰是 #1 的内容。**我会在这里现场编一个签名**，因为 Commit 4 没有那句「不生成猜测签名、结束本轮」拦我，而 Commit 4 又是被反复强调「唯一原子发布点、不许拆」的地方，压力全在往前走。
- 判「不齐全」→ 停门说「不得发布」，但没有任何 task 告诉我怎么把它补齐、补齐算谁的工时、补完谁复核。我只能自造一个流程。

**修复建议**：（a）把 §7.12 那句逐字复制进 Commit 4 的「前置停门」块，与「缺任一项不得发布」并列；（b）给 #1／#2／#5／#8 各配一个显式 task（可命名 T4.0a–T4.0d，或把它们从 C3 表的「最小子集」升级为 C3 的承重项并改写 C3 task），让「完整证据槽」有 owner；（c）C3 表增加一列「**谁负责把它从最小子集补到完整**」——现状那一列的值全是「C4 publish kickoff」，那是一个时刻，不是一个负责人。

---

## F-4 `[major]` 「10 个 outer composition roots」把两个层级混进一张表：Anthropic 的 #1／#2／#10 是嵌套的同一条路径

**位置**：`cutover-plan.md:311-324`（10-root 表 + 其下那段 `makeAnchoredSseSink` 说明）、`:289`（T4.2「10 个 outer roots 创建唯一 owner」）
**证据**（master，已逐行打开）：
- `#1 = messages/handler-v4.ts:567` 与 `#2 = :650` 都是 `const { sink, anchorState, anchorHooks } = makeAnchoredSseSink(stream, {…})`。
- `makeAnchoredSseSink` 是 `messages/handler-v4.ts:1086` 定义的**非 export 私有 helper**，它在 `:1152` 内部调用 `makeDeliverySseSink(stream, {…})` —— **这就是表里的 `#10`**。
- 所以一次 Anthropic 请求走的是 `#1 或 #2` → `#10`，三行描述的是**同一条链上的两层**，不是三个并列 root。
- 对照 `#3～#9`（CC `:523/:760`、Responses `:351/:600`、Gemini `:429/:634`、WS `:358`）——它们都是 handler 顶层**直接**调 `makeDeliverySseSink`／`makeDeliveryWsSink`，与 `#10` 同层，与 `#1/#2` 不同层。
- 表下那段又说「**Anthropic 的 composition root 必须落在 `makeAnchoredSseSink` 所在层**（master `:1086`）」——给出了**第三个**位置，且 `:1086` 根本不在这张 10 行表里。

**执行方会做出什么错误动作**：T4.2 逐字说「10 个 outer roots 创建唯一 owner 与 private raw emitter」「10 roots 切换」。我照做，就会在 `:567` 建一个 owner、在 `:650` 建一个 owner、在 `:1152` 再建一个——**单条 Anthropic 请求里出现两个 owner／两个 raw emitter**，直接违反同一 commit 的 invariant「一个 serializer／一个 timer／一次 sampling／一次 emit」。若我改为只在一处建，那 `10` 这个数就对不上，而 `10` 正是 T4.2 的完成计数、也是 R-1「四 vendor HTTP root + Responses WS 的 zero／exactly-once 断言」的覆盖依据——我会不知道该按 8 还是 10 去核对覆盖面。

**修复建议**：把表拆成两列语义：「**sink 创建点**（owner 在此构造）」= `#3～#10` 共 8 个，与「**Anthropic 调用点**（改为接收 owner／command port，不自己构造）」= `:567`、`:650` 共 2 个，并把 `:1086` 写成「Anthropic owner 的构造函数所在层」而不是与 `:1152` 并列的第三种说法。`10` 这个数保留没问题，但必须写明它是 `8 构造 + 2 接线`，否则 T4.2 的验收计数没有判别力。

---
## F-5 `[major]` Commit 2／Commit 5 锚点表把 7 行标成「feature」，而 master 上这些现状**全都存在**，只是行号不同——§0.1 要防的错树问题，在反方向上仍在

**位置**：`cutover-plan.md:186-194`（Commit 2 表）、`:454-456`（Commit 5 表）
**证据**（master `174cc314` 逐行打开，与 plan 标注对照）：

| plan 标注 | plan 给的 feature 行 | **master 实际有没有** |
|---|---|---|
| owner close 读写 `openAnchorIndex`（feature） | `session.ts:422-430` | **有**：`session.ts:399, 401, 407`（`current.openAnchorIndex` 同一形状） |
| generic `write` 只更新 ledger／clocks（feature） | `session.ts:127-137` | **有**：`session.ts:120-130`（同样**不**清 `openAnchorIndex`，D1 分裂在 master 一样成立） |
| owner serializer 现状 `write → writeToSink`（feature） | `session.ts:127,131,334` | **有**：`:120`、`:124`（`await writeToSink(sink, entry)`） |
| heartbeat 三个（实为四个）producer（feature） | `session.ts:175,184,209,219` | **有**：`:168`（contentFrame）、`:177`（injectContentScaffold）、`:202`（injectScaffold）、`:212`（normal ping） |
| `OwnerResult` 三个失败 reason（feature） | `session.ts:300-309` | **有**：`types.ts:295` 定义 `OwnerFailureReason`、`session.ts:268-269` `ownerFailure` |
| commit point（`committed` 翻转）（feature） | `session.ts:323-354` | **有**：`session.ts:305, 313, 325, 330, 332` |
| 现状 generic write 失败日志（feature） | `session.ts:311-355` | **有**：`session.ts:331` `consola.error("[delivery] owner wire write failed", error)` |
| 现状 snapshot（feature） | `delivery/types.ts:44-51` | **有**：`delivery/types.ts:36-43`（ledger／upstreamRounds／writeCount） |

**真·feature-only 的只有三个**，plan 对它们标得完全正确：`OwnerRawSink`（master `src/` 零命中，实测）、`closeAnchorViaOwner`（同）、`wirePartialDelivery`（`rg wirePartialDelivery src` master 零命中）。

**执行方会做出什么错误动作**：§0.1 立的规矩是「每一行都标树」，我读表时把「树 = feature」直接读成「master 上没有这东西」——这正是这一列的语义。于是若 entry 落在候选 3（master 上重塑）或候选 4 刚 merge 完，我会：
- 对 T2.1／T2.2／T2.4 的「现状对照」跑去翻**未合并的 feature 树**，然后照那份 shape 写 Commit 2 的代码，而我的 entry 树里对应代码的形状／行号并不相同（例如 `ownerFailure` 在 master 是 `ownerFailure<T>(reason, committed)`、在 feature 是 `ownerFailure<T>({ok,reason,committed})`——**签名就不一样**）；
- 对 T2.6 的 heartbeat producer 与 T5.7 的「答不了」对照，得出「entry 树上还没有，要新建」，于是**在既有 heartbeat／日志之外再造一份**，直接撞 Commit 2 invariant「不启动 heartbeat」和 Commit 4「一个 timer」。

**修复建议**：这 8 行按 plan 自己在 Commit 0／4 表里的做法补上 master 列（`X（master）／Y（feature）`），并在「树」列只对**真正单树存在**的符号写「feature only」——现状把「行号我只查了 feature」和「符号只在 feature 有」用同一个标记表达，两者后果完全不同。`OwnerResult` 那一行还要额外注明**两树签名形状不同**，否则照 feature 写的 T2.x 代码在 master 基上编译不过。

---

## F-6 `[major]` 待裁项 #4 未决时的封锁范围只写了「T0.1 不可开工」，而 Commit 0 剩下 8 个 task 全部是树相关的——我会理直气壮地在错的树上开工

**位置**：`cutover-plan.md:39`、`:646`（两处都只写「T0.1 在裁定前不可开工」）
**对照**：Commit 5 的写法是「**本节所有 task（T5.1～T5.7）在 Q1 裁定前一律不可开工**」——同一份文档里，另一个待裁项用的是**整节封锁**。

**证据**（假装裁决没下来，我按 plan 往下走）：
- T0.1 →「不可开工」，跳过。
- T0.2 → 「先把 O-6 脚本在**未改动树**上跑一次」。**哪棵未改动树？** 两棵树的 `byte-equivalence.sh` 还是两份不同的东西（见 F-2）。我必须先选一棵树才能执行这一步，而选树就是 #4。
- T0.3 → recorder「必须包裹 composition root 实际取得的 `stream`／`ws` handle 并位于 raw emitter 之下」。raw emitter 在 feature 是 `OwnerRawSink`（`delivery/types.ts:12`），在 master **不存在这个类型**（`makeSseSink` 返回 `ClientSink`，实测 `client-sink.ts:179`）。写出来的 recorder 两树不同。
- T0.6 → red characterization 的对象是「owner lease 仍 open」，plan 把相关现状全标成 feature（见 F-5）。
- T0.7 → 闭包**种子里就有 `OwnerRawSink`**（表里写「feature only（master 零命中）」）。在 master 上跑 T0.7，种子少一个，A／B／C／D 四集人口直接不同。
- T0.8 → 分四类的口径「92 个 fake 构造点／40 文件、57 个……、65 个……」来自 inventory §9，而 inventory 锚在哪棵树 plan 没说。

也就是说：**Commit 0 九个 task 里至少六个的产物会随树而变**，而其中 T0.7 的输出是 Commit 1／2／3 每个 commit invariant 的比对基座、也是 Commit 4／6 fail-loud 审计的依据。锚错树不是「行号要换算」，是**整条基线作废**——plan 自己在 §0.2 对 T0.1 说了这句话，却没把它推广到 T0.2～T0.9。

**执行方会做出什么错误动作**：我读到「T0.1 在裁定前不可开工」，自然推论「那 T0.2 起可以开工」（否则为什么单点名 T0.1？），加上 §11 #4 已经写了「本 plan 的倾向是候选 4」，我极可能直接起一棵 worktree 开干 T0.2～T0.9。等裁决真下来若不是候选 4（比如用户选 1，直接 merge 进 master），我手上这批 recorder／闭包输出／四集人口全部要重做，而更危险的是**我不会重做**——它们看起来是「已完成的 Commit 0 产物」，会被原样带进 Commit 1 的 invariant 比对。

**修复建议**：把 §0.2 与 §11 #4 的封锁措辞改成与 Commit 5 同形：「**Commit 0 全节（T0.1～T0.9）在 #4 裁定前一律不可开工**」，并补一句为什么（T0.7 的四集人口、T0.3 的 raw emitter 形状、T0.2 的脚本版本都随树变）。若确有可以先做的 task，就逐条点名它为什么与树无关——现状是反过来的，默认全放行只封一条。

---
## F-7 `[major]` plan 声称的三层结构里 `prompts/` 不存在，而提交纪律、进度文件、跨会话交接全文零字——一份 9 commit 的 cutover 没有告诉我怎么提交

**位置**：`cutover-plan.md:3`（「`design.md` 回答 WHY + 契约，本文回答 HOW + 锚在哪，**`prompts/` 回答实施者照着干**」）
**证据**：
- `ls docs/rfc/2026-08-03-generation-emission-command-algebra/` = `cutover-plan.md` / `design.md` / `traceability.md`。**没有 `prompts/`**。本仓库其他 plan 目录（`docs/plan/telemetry-tiered-storage/prompts`、`docs/plan/history-data-model/prompts` 等 7 处）都有，所以「它应该在那儿」是有依据的期待。
- 全文 `rg 'pathspec|conventional|git commit|push|署名|进度文件|session-closeout'`：`session-closeout` 只在 T8.3 出现一次（且只指「跨文档 grep 验证」），**pathspec／conventional commits／不加署名／绝不 push／进度文件 全部零命中**。
- CLAUDE.md 的相应纪律是硬性的：「一律显式 pathspec（`git add -- <精确路径>`、`git commit -F <msgfile> -- <精确路径>`），每语义单元一提交、conventional commits、不加模型署名」；`50-git-workflow` 的 `never-push--the-user-does-that` 是 `[hard]`；skill `session-closeout` §6b **逐字规定「派 implementer 执行多语义 commit、或单 commit 但历时长/需试错的工作时，派活前先读 §6b」**，并要求进度文件随每个实现 commit 一起提交、frontmatter 写 `<base>` SHA 供 `--first-parent` 对账。这份 cutover 正是 §6b 的教科书触发条件（9 个 semantic commit、含大量试错、明显跨会话）。

**执行方会做出什么错误动作**：
1. 我照 §0 去找 `prompts/`，找不到。**要么**当它还没写、自己临时编一套 kickoff（于是每个 commit 的开工口径由我现编，与 plan 不对账）；**要么**认为「这一层的内容 plan 里已经有了」而跳过——但恰恰是 `prompts/` 该承载的东西（怎么提交、怎么记进度、怎么交接）plan 里一个字都没有。
2. 提交时我会用最省事的全量暂存 + `commit -am`。本仓库是**共享主树、常有并发 agent 会话**（`git worktree list` 现有 10 棵树、工作区当前就有 4 个 peer 的未提交改动：`src/lib/anthropic/sanitize/tool-name-sanitize.ts` 等）。无 pathspec 的提交会把 peer 的在飞改动裹进我的 cutover commit——正是 CLAUDE.md 的 `concurrent-sessions 行级共存` 与 `no-destructive-workspace-loss` 要防的。
3. Commit 4 是「唯一原子发布点、最大一节、16 个 task」。没有进度文件纪律，我一旦在 T4.9 被打断，接手方只能从 `git log` 重建——而 Commit 4 按设计**中途不产生 commit**（16 个 task 同一个 semantic commit），git log 上什么都没有。**这是这份 plan 里唯一一个「中断即全丢」的结构**，而 plan 没有为它写任何 checkpoint 约定。

**修复建议**：（a）补 `prompts/`，或把 §0 那句改成「`prompts/` 尚未产出，本文即最终派发件」并把下述内容并入本文；（b）加一节「提交与进度纪律」：显式 pathspec、conventional commits（`refactor:`／`test:`／`docs:`）、不加署名、**绝不 push**、每个 commit 的 message 要点名它对应本文哪一节；（c）**专门为 Commit 4 写 checkpoint 约定**——按 skill `session-closeout` §6b 建进度文件（frontmatter 带 base SHA），T4.1～T4.16 每完成一项就更新，说明中断后怎么续；（d）§0.3 的门跑在哪棵树，按 F-1 一并写清。

---

## F-8 `[minor]` C 集人口的 master 侧文件数写错：是 **3 个文件**，不是 4 个

**位置**：`cutover-plan.md:362`（「**master 7 处／4 文件**、**feature 9 处／4 文件**」）
**证据**（`rg -n 'getDownstreamDeliverySession\b' src --type ts`，master `174cc314`）：调用点 7 个 —— `pipeline/driver.ts:875, 948, 1016, 1100`、`routes/messages/handler-v4.ts:1375, 1680`、`anthropic/keepalive-anchor.ts:311` —— 分布在 **3 个文件**。plan 自己在同一格里已经写明「master 的 `live-reconcile.ts` **没有** lookup」，那正是第 4 个文件在 feature 侧的来源。**7 处这个数是对的**（我逐点复核过），**4 文件是从 feature 行抄过来的**。feature 侧 9 处／4 文件我也复核了：`driver.ts:883,944,1012,1097`、`handler-v4.ts:1112,1422,1772`、`live-reconcile.ts:139`、`keepalive-anchor.ts:280` —— 正确。

**执行方会做出什么错误动作**：这一格的整个存在理由是「两树人口不同，别拿 HANDOVER 的 feature 数去对 master」。我在 T6.1／T6.4 做 C 集归零审计时，拿 AST 输出的「3 文件」去对 plan 的「4 文件」，会判为审计工具漏扫，然后去调工具或扩大扫描面（比如把 `getDownstreamDeliverySessionForPortOrSink` 也算进 C 集——而 plan 同格明确说它属 B 集不属 C 集）。**用错误的期望值去校准审计工具，比没有期望值更糟。**

**修复建议**：改成「master **7 处／3 文件**」。同时建议这类计数一律改成「可复跑命令 + 冻结命中集合」而不是裸数字（`freeze-hit-set-not-zero-hits` / `every-number-carries-scope`）。

---

## F-9 `[minor]` `keepalive-anchor.ts` / `live-reconcile.ts` / `warmup.ts` 全文从未给过完整路径，而它们在 `src/lib/anthropic/`，不在 plan 里其他完整路径所在的 `src/lib/pipeline/`

**位置**：全文（`rg -o 'src/[A-Za-z0-9_./-]+\.ts'` 只列出 10 条完整路径，其中 `pipeline/` 系 3 条、`observability`／`telemetry` 系 6 条、`history` 1 条；这三个文件一条都没有）
**证据**：实际位置 —— `src/lib/anthropic/keepalive-anchor.ts`、`src/lib/anthropic/live-reconcile.ts`、`src/lib/anthropic/warmup.ts`。而 plan 在紧邻的行里给的完整路径全是 `src/lib/pipeline/types.ts`、`src/lib/pipeline/delivery/types.ts`。另：`driver.ts` 在本仓库有两个（`src/lib/pipeline/driver.ts` 与 `packages/foundation/src/sqlite/driver.ts`），`types.ts` 有 **9 个**、`session.ts`／`ws.ts` 各 2 个。

**执行方会做出什么错误动作**：我照 §0.4 的「引用前重取」去敲 `rg -n … src/lib/pipeline/keepalive-anchor.ts`，得到 `No such file or directory`（我实测就是这么撞的）。第一反应是「plan 引用了不存在的文件」或「master 已经把它删了」——尤其在 §0.1 已经反复强调「master 每天前进」的语境下，这个误判很自然。代价是一次多余的排查 + 对整张锚点表的信任下降。

**修复建议**：三个文件首次出现处给完整路径；或在 §0.1 加一行「路径前缀约定」表。§0.4 给的重取命令也应覆盖这三个文件。

---
## F-10 `[major]` 待裁项 #4 的量化影响栏把「merge 会有语义冲突」当成候选 1 的代价，而实测 **merge 冲突为零**——用户将据一份错的成本对照做裁决

**位置**：`cutover-plan.md:641`（候选 1 的量化影响）、`:644`（候选 4「把 merge 冲突关在隔离树内」）、`:646`（「本 plan 的倾向是候选 4，理由是……把 merge 冲突关在隔离树内」）
**plan 的原话**：候选 1 =「**代价是 merge 本身会引入需要解决的语义冲突**（feature 改了 `driver.ts` 106 行、`handler-v4.ts` 124 行、`session.ts` 64 行，master 同期前进数十个 commit）」。

**实测**（master `174cc314`、feature `2c339784`、merge-base `200aba8b`）：
1. 三个行数**完全正确**：`git diff --stat 200aba8b feat/… -- src/` 给出 `driver.ts | 106`、`handler-v4.ts | 124`、`session.ts | 64`。
2. **但 feature 一共改了 15 个文件、+388/−204**，plan 只点了 3 个。未点名的里包括改动量第二大的 `live-reconcile.ts | 130`，以及**两个 M1 全新建的模块** `src/lib/pipeline/delivery/owner-failure.ts`（46 行）与 `src/routes/messages/owner-failure-settlement.ts`（24 行）。
3. **关键反证**：把 master 自 merge-base 起的改动**限定到这 15 个文件**——
   ```
   git diff --stat 200aba8b master -- <feature 改过的那 15 个文件>
   ```
   **输出为空**。master 那 58 个 commit **一个都没碰过 feature 改过的任何一个文件**。
4. 直接做 merge 干跑：
   ```
   git merge-tree --write-tree master feat/inter-block-anchor-allocator
   ```
   **rc=0，输出只有一个 tree oid `738cdea1`，冲突列表为空。**

**诚实边界**：rc=0 只证明**文本无冲突**，不证明语义无冲突（本项目已栽过「两边各绿、合并即坏」——`methodology-semantic-merge-conflict-exposes-latent-bug-via-timing`）。所以正确的量化影响不是「无代价」，而是「**文本冲突 0（实测）；语义风险仍需靠 merge 结果上跑一遍 T0.1 的 15 次来证伪**」——而 T0.1 无论选哪个候选都要跑。

**执行方会做出什么错误动作**：这一条不是我执行时会做错什么，而是**我拿这张表去问主会话／用户裁决时，用户会据一个不存在的成本做决定**。候选 1（直接 merge 进 master）在成本栏被写成「有语义冲突要解决」，候选 4 的卖点整个建立在「把 merge 冲突关在隔离树内」——**没有冲突可关**。而候选 1 与候选 4 的差别是实打实的：候选 1 一次 merge、entry 即 master 上的 merge commit，§0.3 那三条钉死在 master 的门**自动就是对的**（F-1 随之消失）；候选 4 要两次 merge、且 §0.3 的门全部需要重写。**在冲突数为 0 的前提下，plan 的倾向很可能应该反过来。**

**修复建议**：把候选 1 的量化影响改写为实测值 —— 「文本冲突 0（`git merge-tree --write-tree` rc=0，merge-base `200aba8b`，master `<sha>`，feature `2c339784`；master 的 58 个 commit 未触及 feature 改过的 15 个文件中的任何一个）；剩余风险是语义冲突，由 entry 上的 15 次连跑证伪」，并**同步重估候选 4 的理由**。另按 `anchor-numbers-to-commits`，这一格必须带可复跑命令 + commit 锚，因为 master 每天前进、结论会翻。

---

## F-11 `[minor]` M1 新建的 `owner-failure.ts` / `owner-failure-settlement.ts` 在三份文档里零命中，而它与 Commit 4 要引入的 `TerminalEmissionResult` 是竞争抽象

**位置**：`cutover-plan.md` / `design.md` / `traceability.md` 全文（`rg 'owner-failure|OwnerFailure|OwnerTerminalDecision|settleMessagesOwnerFailure'` = 0 命中；只有 `closeAnchorViaOwner` 与 `OwnerRawSink` 被点名为 M1 引入物）
**证据**（feature `2c339784`）：
- `src/lib/pipeline/delivery/owner-failure.ts` 导出 `OwnerTerminalDecision`，**三态**：`client-aborted{reason:"client-gone", partialDelivery}` / `delivery-finished{reason:"session-terminating"}` / `fail-loud{reason:"session-terminating"|"wire-torn", error}`。
- `src/routes/messages/owner-failure-settlement.ts` 导出 `settleMessagesOwnerFailure(decision, env, model, recordForwarded, partial, options)`，直接调 `env.ctx.abort` / `env.ctx.fail`。
- RFC 要在 Commit 4 引入的 `TerminalEmissionResult` 带 `terminalFrameDisposition` **三态**：`emitted` / `suppressed_client_gone` / `suppressed_session_terminating`（`cutover-plan.md:135`、`:297`）。两者**处理的是同一件事**（terminal 时刻按 client-gone／session-terminating／wire-torn 分流并决定 settle 形态），词汇高度重叠但不同构。

**执行方会做出什么错误动作**：T3.5 要我做「逐点可表达性演练：`terminalFrameDisposition` 三态如何映射原 client-gone／session-terminating 提前返回」。如果我的 entry 树含 M1，「原 client-gone／session-terminating 提前返回」**已经不是散落的提前返回了**，它已经被 M1 收敛成 `OwnerTerminalDecision` + `settleMessagesOwnerFailure`。plan 描述的是 master 的形状。我照 plan 干，会在 `settleMessagesOwnerFailure` 之外**再造一条 terminal 分流路径**，于是同一个 terminal 时刻有两个分类器——而 Commit 4 的 invariant 是「first terminal command wins、terminal frame exactly once」。这类「同一件事写两遍且其中一遍弱一档」正是 CLAUDE.md `analyze-structural-smells-each-round` 点名要抓的。

**修复建议**：在 §0.2「M1 由 cutover 重塑而非丢弃」那段，把 M1 引入物列全（现在只列了 `closeAnchorViaOwner` 与 `OwnerRawSink`），至少补上这两个新模块；并在 T3.5／T4.10 显式给出 disposition：`OwnerTerminalDecision` 是被 `TerminalEmissionResult` 取代、还是保留为其内部分类器。**这是 §12「未采纳写法」该记的那类取舍**，现在它连被讨论过的痕迹都没有。

---

## F-12 `[minor]` §11 开头说「五项都不是实施者可自判的」，但 #5 本 plan 已经自己判了，而且没有可达的复核触发点

**位置**：`cutover-plan.md:592`（「以下五项**都不是实施者可自判的**」）对 `:650-652`（#5）与 `:205`（Commit 2 门表下的注）
**证据**：#5 的处置原文是「本 plan 判为**如实标注即可、不改矩阵**。**若评审认为这构成漂移**，交主会话裁」。`:205` 同样：「**这不是错配**……**若评审认为这构成漂移**，按 §11 待裁项 #5 处理」。也就是说：默认结论由本 plan 自己下（R-5 辅助门段落在 Commit 2、矩阵不动），只有在「评审认为」时才升级——**而没有任何 task／门要求在某个确定会到达的时点去触发这次评审**。`traceability-check.py` 同格已写明「辅助门段落在 C1 还是 C2 它不判」，所以机械校验也不会撞上它。

对照另外四项都有硬触发：#1「一律写『等级未定』，**不填**」；#2「Commit 5 所有 task 在裁定前一律不可开工」；#3 绑定进 Q1 裁决材料；#4「T0.1 在裁定前不可开工」。**只有 #5 是「已判 + 条件性上诉」。**

**执行方会做出什么错误动作**：我读 §11 开头那句「都不是实施者可自判的」，再读到 #5 已经给了结论，会得到「这条已经有答案了，照做」——于是 R-5 的辅助门就落在 Commit 2，矩阵与 plan 从此长期不一致，而「谁来看一眼」这件事永远不会被触发（`downgrading-a-gate-needs-a-reachable-trigger` 的典型形态：判官与记录位置都有了，**触发点只写成一句陈述**）。

**修复建议**：二选一，别留中间态。要么把 #5 降级为「本 plan 已裁（低风险 + 理由）」并从 §11「都不是实施者可自判的」名单里移出，在 §12 记为 `record-not-adopted`；要么保留在 §11，并给一个**必经触发点**——例如把它挂到 Commit 2 的门表里作为一行「未裁则本 commit 不得收口」，或挂到 T8.7 的 merged-state review 必查项。

---
## F-13 `[major]` T0.1 的命令在共享主树上**必然 rc=3**（脏树硬拒），而 plan 只字未提；唯一的旁路被脚本自己声明为「不满足门」

**位置**：`cutover-plan.md:70`（T0.1 的命令与「rc=0 且保存每次原始输出。任一次失败即不得开始 cutover」）
**证据**（`exp/inter-block-anchor-allocator/baseline-runs.sh:115-122`）：
```bash
dirty="$(git -C "$REPO" status --porcelain)"
if [ -n "$dirty" ] && [ "$ALLOW_DIRTY" != "1" ]; then
  printf 'baseline-runs: working tree is dirty, so a run here does not measure the commit it would claim.\n' >&2
  printf 'Either clean the tree, or set ALLOW_DIRTY=1 (the logs are then marked DIRTY and do not satisfy a gate).\n' >&2
  exit 3
fi
```
- 共享主树**此刻就是脏的**：`git status --porcelain | wc -l` = **18**（含 4 个 peer 的 `src/`、`tests/` 未提交改动：`src/lib/anthropic/sanitize/tool-name-sanitize.ts`、`src/lib/openai/tool-name-sanitize.ts` 与对应两个测试）。本项目 CLAUDE.md 明写「本仓库常有并发 agent 会话同时改动」，所以这不是偶发状态。
- `REPO` 同样由脚本位置推导（`baseline-runs.sh:77`），因此与 F-1 同源：`OUT` 的相对路径也解析到那个 REPO 下。
- `OUT_DIR` 若已有 `run-*.log` 会 `exit 2`「refusing to mix batches」——重跑要换目录，plan 的 `OUT=docs/tmp/<date>-entry-runs` 没说这一点。
- 默认 CMD 是 `bun scripts/parallel-test.ts unit it http`（`:80`），与 §0.3 一致 ✓；`MIN_TESTS` 无默认值、缺失即 rc=2 ✓（plan 对 `MIN_TESTS` 的强调是准确的）。

**执行方会做出什么错误动作**：T0.1 是整条链的**第一步**，也是「任一次失败即不得开始 cutover」的入场证据。我在共享主树敲下 plan 给的命令，立刻 rc=3。此时脚本只给我两个出口：
- 「clean the tree」——那意味着动 peer 的未提交改动，撞 `no-destructive-workspace-loss` `[hard]`，我不能做，也不该做；
- 「`ALLOW_DIRTY=1`」——脚本**自己**说这样的 logs「do not satisfy a gate」。但这是眼前唯一能让命令跑起来的旋钮，而 plan 又没告诉我它不算数。**最可能的结果是我加上 `ALLOW_DIRTY=1`，拿到 15 份标着 DIRTY 的日志，然后在验收记录里写「T0.1 PASS」。** 整条入场证据链就此作废，而且是静默的。

**修复建议**：T0.1 明写「**必须在干净树上跑**」，并把它与 §11 #4 的候选串起来：候选 4（隔离 worktree）天然满足；候选 1（merge 进 master）**必须** 在共享主树以外的地方跑这 15 次，或先确认主树无 peer WIP。同时逐字写明「`ALLOW_DIRTY=1` 的日志不满足入场条件，禁止用它通过 T0.1」——现在这句话只存在于脚本 stderr 里，而执行者在贴命令时看不到。另建议给 `OUT` 一条「换批次要换目录」的提示。

---
## F-14 `[nit]` T0.4 正文与锚点表对 `setDeliverySessionObserverForTests` 的归属说法不一致

**位置**：`cutover-plan.md:73`（T0.4「接上 delivery session observer（**feature 树已有** `setDeliverySessionObserverForTests`，见锚点表）」）对 `:95`（锚点表「`delivery/session.ts:67`（master）／`:74`（feature）| **两树皆有**（已实测）」）
**证据**：master `src/lib/pipeline/delivery/session.ts:67` 确实是 `export function setDeliverySessionObserverForTests(...)`（我打开过）。锚点表是对的，T0.4 的措辞「feature 树已有」会让 master 侧读者以为要自己造。
**执行方会做出什么错误动作**：影响很小——因为同一句就指向了锚点表，我大概率会顺手去看表并被纠正。但若我在 master 基上执行且只读了 task 表没读锚点表，会多花一次搜索或错误地新增一个 observer 接入口。
**修复建议**：改成「两树皆有 `setDeliverySessionObserverForTests`」。

---

## 已复核为**正确**的关键事实（防止修订时误改）

我逐条验证过、**plan 写对了**的部分（列出来是为了让修订者不要在改上面的问题时把这些一起动了）：

| plan 的断言 | 我的复核 |
|---|---|
| 两树互不为祖先，merge-base `200aba8b` | ✓ `git merge-base master feat/…` = `200aba8b5f43…`；`--is-ancestor` = NOT-ANCESTOR |
| feature 领先 8、master 领先 58（写成「不写死、要现算」） | ✓ 现算 58 / 8 |
| feature `2c339784` 的 `src/` 与设计基线 `854421d4` 逐字节相同 | ✓ `git diff --stat 854421d4 2c339784 -- src/` 空 |
| `4f7a3989`／`51b1e1c9`／`cc909c81` 在 master 不在 feature；`200aba8b` 两树皆有且就是 merge-base | ✓ 四条 `--is-ancestor` 全部吻合，包括「别把 `200aba8b` 算进 feature 缺的那批」这条纠正 |
| A-1 master **11 点／4 文件**、feature 10 点／4 文件，差在 live reconciler（master `:174,:177` 两处 vs feature `:157` 一处） | ✓ 逐点复核：`driver.ts:952,956,1052,1269,1321` + `keepalive-anchor.ts:406` + `live-reconcile.ts:174,177` + `chat-completions/handler-v4.ts:662,833,839` = 11／4 |
| `session.ts:566`（master）的 `OwnerRawSink.write` physical call 不计入 A-1 | ✓ 该行确为 `await sink.write(entry.frame)`，在 `writeToSink` 的 default 分支 |
| A-2 **28 点／7 文件**（`writeSynthetic` 22 / `writeKeepalive` 3 / `writeSyntheticEnvelope` 3） | ✓ 逐点复算：20 handler + 3 decorator(`live-reconcile.ts:183,184,185`) + 3 owner→raw fallback(`session.ts:554,558,562`) + 2 fallback 调用点(`keepalive-anchor.ts:413`、`messages/handler-v4.ts:681`) = 28；文件数 7 ✓ |
| A-4「两树各 11 个 `writeSSE`／`ws.send`，扣掉 `ws/broadcast.ts` 的 2 个后为 9」 | ✓ warmup 3 + client-sink 2 + AUQ 1 + `responses/ws.ts` 3 + broadcast 2（`:119` `ws.send`、`:196` `rawWs.send`）= 11；注意第二个 broadcast 是 `rawWs.send`，用 `\bws\.send\(` 会漏 |
| pre-owner allowlist：`responses/ws.ts:595`、`error-shaping-glue.ts:131`、`warmup.ts:214,230,243` | ✓ 五处逐行确认 |
| `driver.ts:880` 的 `noteWinner` 走 `getDownstreamDeliverySessionForPortOrSink`，属 B 集不属 C 集 | ✓ 逐行确认，且 master `live-reconcile.ts` 确无 lookup |
| 10 个 anchor terminal-close：master `closeAnchorIfOpen`（handler 8 + driver 2，局部 helper 定义 `driver.ts:1181`），feature 用 `closeAnchorViaOwner`（helper `:1178`） | ✓ master 全 10 处逐行命中，且**全仓恰好 10 个调用点**（`rg` 复算） |
| 5 个 `beginLeg` lexical sites：master `:877,1018,1105,1519,1577`；3 种 leg kind | ✓ 逐行命中，kind 分别为 primary／primary／primary／recovery／continuation |
| `beginLeg` 被 `if (allocationPort?.wireState)` 挡住（`driver.ts:875-880`） | ✓ `:876` 即该 if；R-14 的存在理由成立 |
| `withAllocatedRealBlock`／`writeBlockFrame` **零 production 调用者**（`design.md:378`，R-5 依赖 C4 的依据） | ✓ **两树**都只有 `types.ts` 声明 + `session.ts` 实现，无调用点 |
| `WireBlockAllocationPort` = `types.ts:309-322`，五方法 + `wireState` | ✓ 逐行 |
| `commandPortActivation` 两树 `src/` 都零命中，Commit 6 要先确认存在再删 | ✓ `rg` 两树零命中；plan 的处置（标注并回报、不发明符号）正确 |
| `tests/pipeline/allocation-outside-owner-control.it.test.ts` 两树皆存在 | ✓ |
| `packages/telemetry`／`src/lib/observability` 两树无差异，行号可共用 | ✓ `git diff --name-only master…feat` 不含它们；`dimension-names.ts:56`、`request-telemetry.ts:124`、`runtime.ts:86` 逐条命中 |
| `wirePartialDelivery` 是 feature only | ✓ master `rg` 零命中；feature `history/types.ts:217` 命中 |
| §11 #4 候选 1 的三个行数（106／124／64） | ✓ 与 `git diff --stat` 完全一致（但见 F-10：只点了 15 个文件里的 3 个） |
| Q1 仍 open、`PHASE=pre` 是正确相位 | ✓ 实跑 `q1-locations.sh` rc=0，8 个 RFC 小节 + 2 份 carrier 全部 `ok`；§4.8 状态为 `mentions (constraint)`，与 plan 的描述一致 |
| `baseline-runs.sh` 的 `MIN_TESTS` 无默认值、缺失即 rc=2；默认 CMD 为 `bun scripts/parallel-test.ts unit it http` | ✓ 逐行（`:80`、`:84-90`） |
| `byte-equivalence.sh` 拒绝 4141、默认随机高端口、`RECAPTURE=1` 会覆写 fixture | ✓ 逐行（`:30-33`、`:19-29`、`:168-172`）；plan「禁止 RECAPTURE=1」的强调是必要的 |

---

## 本次走查**没有**覆盖的（诚实边界）

- **没有实跑** `bun run typecheck`、`parallel-test.ts`、`byte-equivalence.sh`（后者要起服务器 + 用真实 token），所以「这些门在正确状态下会绿」我没有正样本证据；F-1 的判断依据是脚本源码里的 `REPO` 推导逻辑，不是实跑对照。
- **没有验证** RFC §10.2 各行判据本身的鉴别力（traceability.md §7 已声明它也不证这个）。
- **没有验证** inventory §9／§12／§13 的口径（92 fake 构造点／40 文件、57 编译期依赖文件、65 raw factory 调用／14 文件）——plan 引用的 inventory 文档不在本次派活的必读清单里，我没找到它在仓库中的位置。**这批数字是 T0.8 的分档依据，建议单独核一次。**
- **没有触碰** 4141 端口的用户主服务器；本次全部命令为只读（`git diff/log/merge-base/merge-tree --write-tree`、`rg`、`sed -n`、`ls`、`cmp -s`，以及一次只读的 `q1-locations.sh`）。`git merge-tree --write-tree` 只在 object DB 里写了一个 tree 对象，**不改任何 ref、不改工作区**。

---
---

# 复评轮（2026-08-04）—— 整改 `80a4b6fc..363e81c0` 后重走一遍

**基线**：master `363e81c0`；M1 merge commit `8125f123` 已在主线（`git merge-base --is-ancestor 8125f123 HEAD` = 真）；`src/`／`packages/` 自 `8125f123` 起未变（`git diff --stat 8125f123..363e81c0 -- src/ packages/` 为空），因此 plan 声明的「锚 `80a4b6fc`」与今日 HEAD 等价。

## R-0 锚点抽样复算 —— **56 个锚点抽查 44 个，0 处错**

上轮我逐行开了约 140 行、只抓到 1 处数字错；这轮「树」列整体删除 + 全部重锚，是**重做不是修补**，所以我按同样强度重查。逐行 `sed -n` 打开并比对符号：

| 组 | 抽查 | 结果 |
|---|---|---|
| Commit 0 闭包种子 + M1 到货物 | 18 个（`ClientSink:747`／`OwnerRawSink` `delivery/types.ts:12`／`AnchorState:529`／`GenerationWireState:496`／`WireBlockAllocationPort:319`／`DownstreamDeliverySession` `session.ts:57`／`GenerationWireIndexAllocator:504`／`keepalive-anchor.ts:44,52`／`WireBlockMapping:477`／`LegToken:474`／`OwnerFailureReason:295`／`owner-failure.ts:11,41`／`session.ts:74`／`handler-v4.ts:1105,1160`／`history/types.ts:217`） | **全对** |
| Commit 2 现状锚 | 15 个（`session.ts:127,131,175,184,209,219,300,309,323,354,422,430,581,584,596`＋`delivery/types.ts:37,55,69`） | **全对**；`writeToSink(sink: OwnerRawSink, …)` 在 `:581` ✓ |
| Commit 3 `beginLeg` 五 site | `driver.ts:885`（primary，且确在 `racePrimaryWithDelayedHedge` 的 winner 路径 = hedge winner）、`:1014`／`:1102`（primary，unhedged binding）、`:1521`（recovery）、`:1579`（continuation） | **全对**，且 **kind 确为字面量写死** —— T3.3「不是 60 格笛卡尔积」的论据成立 |
| Commit 4 composition | `handler-v4.ts:574, 658, 1124, 1140, 1192` + 7 个 vendor sink 构造点 | **全对**；`makeAnchoredSseSink` 定义在 `:1124`、返回类型标注在 `:1140`、内部 `makeDeliverySseSink` 在 `:1192` ✓ |
| Commit 4 close-anchor 10 处 | `rg 'closeAnchorViaOwner\('` 全仓：handler `702,1464,1584,1623,1688,1808,1848,1893`（8）+ driver `1436,1611`（2 terminal）+ driver `1236,1314`（2 before-real） | **全对**，且 `"terminal"`／`"before-real"` 实参与表一致 |
| Commit 4 client-sink | `188,209,494,496,497,619,645,696,698,699,720` | **全对**；`makeSseSink` 返回 `OwnerRawSink` ✓ |
| A-1／A-3／B／C 集人口 | A-1 = driver `948,952,1048,1265,1319` + `keepalive-anchor.ts:375` + `live-reconcile.ts:157` + CC `662,833,839` = **10 点／4 文件** ✓（`session.ts:600` 的 `OwnerRawSink.write` 不计入 ✓）；A-3 heartbeat = `driver.ts:1220` freeze／`1346,1370` suspend／`1348,1403` resume ✓；B = `driver.ts:888`（定义 `:940`）✓；C = **9 点／4 文件** ✓ | **全对** |

**作者自报的那 1 处错也复核了**：`writeAnchor` 只声明在 `delivery/types.ts:13`（`OwnerRawSink`），`types.ts` 里只有两处 TSDoc 提及（`:776`／`:807`），`ClientSink` 上确实没有。修正正确。

> **上轮 F-8（C 集 master「4 文件」）已随两树口径作废并重算为 9 点／4 文件——实测吻合。F-9（裸文件名）已由 §0.1a 的路径前缀表关闭，我按表逐条解析，无踩空。F-11 已升格为 §11 #6 待裁项（见下）。F-12／F-14 已修。**

---
## R-1 `[major]` T0.10 的 O-6 取证**按写法不可执行**：`byte-equivalence.sh` 成功路径上根本不输出可执行路径／cwd，capture 里更没有

**位置**：`cutover-plan.md:94`（§0.3 ④）与 `:155`（T0.10）——两处都写「**O-6 的 capture 里**断言 server 进程的可执行路径／cwd 落在 `$TREE` 下」。
**证据**（`exp/inter-block-anchor-allocator/byte-equivalence.sh` 逐行）：
- `$CAPTURE`（`:13` = `$WORK_DIR/current-wire.sse`）是 `curl -fsSN … > "$CAPTURE"`（`:150-154`）写下的**纯 SSE 字节**。里面只有模型输出，**没有任何进程信息**。
- 成功路径上脚本一共打印四行（`:163-166`）：`sha256sum`、`wc -c`、`port=%s listener_pid=%s spawn_pid=%s`、`capture=%s`。**没有 `$REPO`、没有 exe path、没有 cwd。**
- `$REPO` 只出现在 `:123` 的 `bun run "$REPO/packages/cli/src/main.ts" start`——它**在进程 cmdline 里**，但脚本只在**失败分支**（`:63-67` 的 `assert_listener_owned` 诊断）才 `tr '\0' ' ' < /proc/$listener/cmdline`。成功时不打印。
- 而 `trap cleanup EXIT`（`:121`）在脚本返回前就把 server 杀掉了，**pid 随即失效**——事后无法回头取 `/proc/<pid>/cwd` 或 `cmdline`。
- 结论：**跑一次成功的 O-6，从它的任何输出里都分辨不出测的是哪棵树。** 这正是 F-1 那 24 次假绿之所以静默的原因，而 T0.10 是被指定来关闭它的那一条。

**执行方会做出什么错误动作**：我照 T0.10 去做，第一步「先在不做任何绑定的情况下跑一次 O-6，**确认它起的是 master 的 server**」——我立刻发现**没有任何输出能让我确认这件事**（要确认它，我需要的正是我还没建立的那个 oracle，循环）。然后两条路都错：
- **退回弱证据**：写下「我用的是 `/home/xp/src/copilot-api-js/…` 那份脚本，所以它跑的是 master」。这就是「我 `cd` 对了」的同义变体，正是 T0.10 开头逐字禁止的东西，而且它**恰好在 `REPO_OVERRIDE` 被设置时失效**（写法 B 下脚本位置与被测树是分离的）。于是 T0.10 变成一句自证。
- **动手改门脚本**：加一行打印 `repo=$REPO` 或 `/proc/$pid/cwd`。这本身是合理的修法，**但 plan 没说可以改、也没说改完的那份归谁**——若我用「写法 A」跑树内那份，我的改动只活在 `$TREE`，master 侧那份仍旧不打印；两份 gate 脚本从此分叉，而 `traceability-check.py`／O-6 的权威性建立在「脚本是同一份」上。plan 也没要求为这次修改留 guard 裁决记录（CLAUDE.md `[hard]`：删除或放宽既有 guard 要独立裁决——加一行 provenance 不算放宽，但改 gate 脚本至少该落盘）。

**修复建议**：把 T0.10 的取证物写对，并给出可执行形状。最小改动是**在 `byte-equivalence.sh` 成功路径补一行 provenance 输出**（例如 `printf 'repo=%s exe=%s cwd=%s\n' "$REPO" "$(tr '\0' '\n' < /proc/$pid/cmdline | sed -n 2p)" "$(readlink -f /proc/$pid/cwd)"`），并在 plan 里**明确授权这次修改、指定它必须提交回 master 侧那一份**（否则两份分叉）。若不愿改脚本，就必须给一条不改脚本的可执行取证（例如在 `$TREE` 里放一个只在该树存在的 hook／config 标记，让它出现在 capture 的字节里——**但那会改变 O-6 的 fixture 字节，与「fixture 永不重捕」冲突**，所以这条路走不通，更说明改脚本是唯一出路）。另外 `readlink -f /proc/<pid>/cwd` 拿到的是 **cwd 不是 `$REPO`**：脚本没有 `cd`，server 继承的是调用者的 cwd，**写法 B 下 cwd 与被测树可以完全无关**——所以判据必须取 **cmdline 里的 `$REPO/packages/cli/src/main.ts`**，`cwd` 只能作辅助。plan 现在把两者并列写成「可执行路径／cwd」，会让人挑错那个。

---

## R-2 `[major]` T0.10 是**一次性仪式，不是常驻门**：哨兵「再撤除」，且 Commit 1～8 的 invariant 从不要求重证

**位置**：`cutover-plan.md:92`（「**Commit 0 必须建立**」）、`:155`（「确认门看得见它，**再撤除**」）、`:196`（只有 Commit 0 的 invariant 写了「**T0.10 已证明这三条门跑在 `$TREE`**」）
**证据**：`rg 'T0\.10' cutover-plan.md` 全文**只有 3 处命中**（§0.3 ④、T0.10 自身、Commit 0 invariant）。Commit 1～8 的 commit invariant 逐条读过，**没有任何一条要求重新证明门的树绑定**——它们只写「typecheck 绿、全套绿、O-6 PASS」。

**执行方会做出什么错误动作**：F-1 描述的失效**是逐次调用发生的，不是一次性的**——它取决于我这一次敲的是哪条命令。T0.10 在 Commit 0 证明了「当时那次跑对了树」，然后哨兵撤除、证据消失。此后：
- Commit 4 很可能是**另一个会话**（plan 自己在 §0.5 写明「必然跨会话」）。新会话从 HANDOVER／进度文件接手，最可能的动作是从 §0.3 复制命令——**复制到写法 B 却忘了 `REPO_OVERRIDE=`，或复制到那条 `…`（§0.3 ③ 就有两条长这样的命令，它们是对的，但形状与 ② 极像）**，于是 O-6 又跑回 master。**没有任何东西会告诉我**——见 R-1：成功输出里分辨不出树。
- 更具体：§0.3 ③ 的两条 `cd /home/xp/src/copilot-api-js && … exp/inter-block-anchor-allocator/…` 与 ② 写法 B 的 `/home/xp/src/copilot-api-js/exp/inter-block-anchor-allocator/byte-equivalence.sh` **共享同一个绝对路径前缀**。在一屏之内并排放着「必须跑在 master 的两条」和「绝不能跑在 master 的一条」，而三者路径几乎一样——这是**高复发形态**，不是理论风险。

**修复建议**：把 T0.10 从「Commit 0 建立一次」升级为**每 commit 共同门的第四条**，与 §0.3 ①②③ 并列，并写进 **每一个 commit 的 invariant**（现在只有 Commit 0 有）。实现上依赖 R-1 的 provenance 输出：每次跑 O-6 都断言 `repo=` 落在 `$TREE` 下，**这不额外花时间**（它就是同一次运行的一行输出）。typecheck／测试那一侧的哨兵成本较高，可退一档为「每个 commit 的第一次跑做一次哨兵、后续沿用」，但**必须写下来**，而不是靠 Commit 0 那一次外推到 8 个 commit。

---
## R-3 `[major]` T7.3 刚证伪的「只扫 `src/` 不够」，在 Commit 0 的 invariant 里原样留着（`src/ packages/` 两条路径），而 Commit 0 恰恰要动 `scripts/`

**位置**：`cutover-plan.md:196`（Commit 0 invariant：「production 源码与运行时行为**逐字节不变**（`git diff -- src/ packages/` 只允许为空）」）对 `:633`（T7.3）
**证据**：
- T7.3 是本轮新写的、写得很好：它**实测**了「只扫 `src/` 时在 `packages/` 改一字节仍判绿」，并冻结了一份 manifest —— 至少覆盖 **`src/`、`packages/`、`scripts/`、`config.schema.json`、`package.json`／`tsconfig*.json`／`bunfig.toml`**。
- Commit 0 的 invariant 只覆盖 **`src/` 与 `packages/`**，少了 `scripts/` 与全部构建输入。
- 而 **Commit 0 正是最可能碰 `scripts/` 的那个 commit**：T0.1 ② 逐字要求「用 `--reporter=junit`（`scripts/parallel-test.ts:64` 已为刷新计时驱动过它）跑一次」，T0.11 ② 又要求同样的运行时枚举。`scripts/parallel-test.ts:64` 现在只在 `--update` 分支里跑 junit（我打开确认过：`const proc = Bun.spawn(["bun","test","--reporter=junit",…])` 在刷新计时缓存的函数里）。**要拿到 T0.1／T0.11 想要的 testsuite 名集合，最自然的做法就是给 `parallel-test.ts` 加一个输出模式**。
- Commit 1～3 的 invariant 更弱：只写「`git diff` 无 production call-site 切换」，**完全没有路径口径**。

**执行方会做出什么错误动作**：我在 Commit 0 给 `scripts/parallel-test.ts` 加一个 junit 枚举模式（为了满足 T0.1 ②／T0.11 ②），然后跑 invariant 检查 `git diff -- src/ packages/` —— **空，判绿**，我写下「production 逐字节不变 ✓」。但 `scripts/parallel-test.ts` 决定了 `unit it http` 这一档**实际跑哪些文件、怎么分片**，我刚刚改了它，而**接下来 8 个 commit 的「全套绿」全部由它定义**，T0.1 那 15 次入场连跑也是它跑的。换句话说：**我用一个刚被我改过的尺子量了基线，而 invariant 明确告诉我这不算改动。** 这与 T7.3 亲手证伪的形态是同一个，只是路径换成 `scripts/`。

**修复建议**：把 T7.3 的 manifest **提前到 Commit 0 定义**（它本来就该是全程共用的一份），Commit 0～3 的 invariant 一律改成「`cd "$TREE" && git diff --stat <base>..<head> -- <manifest 全部路径>` 为空」。若 Commit 0 确实需要改 `scripts/parallel-test.ts`，那就**显式把它列为 Commit 0 的允许改动并单独说明**（连同「改完必须重跑 T0.1 的 15 次」），而不是靠一个看不见它的 diff 口径蒙混过去。同时 Commit 1～3 的「`git diff` 无 production call-site 切换」应补上同一份 manifest 的路径限定。

---

## R-4 `[minor]` Commit 4 门表里 R-3 那行仍写「T0.6 的 characterization **在此转绿**」，与本轮重写的 T0.6 语义相反

**位置**：`cutover-plan.md:474`（C4 门表 R-3 行）对 `:151`（T0.6）与 `:191`（C0 门表 R-3 行）
**证据**：
- 本轮 T0.6 被重写为「**rc=0 的 characterization，绿 = 缺陷仍在**」，并逐字要求「Commit 4 的 T4.5／T4.7 把 authority 发布后，本测试**必须改成相反的正确性断言**，届时**『维持原样仍绿』即说明 authority 没生效**」。
- Commit 0 门表已同步（`:191` 写「旧缺陷 characterization，**绿=缺陷在**」）。
- **Commit 4 门表 `:474` 没同步**，仍是旧口径：「真实 Anthropic live consumer（T4.5／T4.7）；**T0.6 的 characterization 在此转绿**」。旧口径下 T0.6 在 C0 是红的、C4 转绿；新口径下它在 C0 就是绿的，C4 必须**被改写**才继续绿。

**执行方会做出什么错误动作**：到 C4 我要核对门表。它说「T0.6 在此转绿」，读起来是「不用动它，它自己会绿」。我不改写断言 → 断言「wire closed 且 lease 仍 open」在 authority 发布后不再成立 → **测试红** → 撞 C4 invariant「确定性全绿」。此时我会去查这条红，最后翻到 T0.6 自己那段才知道要改写——**能自我纠正，所以是 minor**。但真正被丢掉的是 T0.6 特意设计的那个探测器：「维持原样仍绿 = authority 没生效」。如果我在慌乱中选择**删掉**这条红测试而不是**反转**它（C4 那一节同时在跑十几个 mutation，删一条「过时的 characterization」看起来非常合理），这个探测器就永久消失了，而它正是用来抓「authority 发布了但没真生效」的。

**修复建议**：`:474` 改成「**T0.6 的 characterization 在此按其头部第③条反转为正确性断言**（反转后绿；**维持原样仍绿即说明 authority 没生效**）」，并把「反转 T0.6」列进 T4.5／T4.7 的实现列——现在它只写在 T0.6 自己的落盘要求里，C4 的 task 表一个字都没提。

---
## R-5 `[major]` #6 的触发点定在 Commit 4，但这个裁决**最早在 Commit 1 的 T1.6 就咬人**——等到 C4 才裁，候选 ③ 已被沉没成本悄悄否掉

**位置**：`cutover-plan.md:715`／`:783`（#6 触发点 = Commit 4 前置停门）对 `:213`（T1.6）与 `:223`（C1 锚点表）
**证据**：
- #6 的三个候选里，**候选 ③「二者合并成一个三态」逐字写着「需要 RFC §3.3 改 `TerminalEmissionResult` 的冻结形状，**属契约变更，要回 architect-advisor**」。**
- 而 **T1.6（Commit 1）** 就要求：「typed `TerminalEmissionResult` 的**类型层**存在性与 `terminalFrameDisposition` 三态（`emitted` / `suppressed_client_gone` / `suppressed_session_terminating`）**穷尽性** unit」。也就是说 **Commit 1 就把那三个态的形状写进类型并加了穷尽性断言**。
- C1 锚点表 `:223` 自己也承认了这一点：「`OwnerTerminalDecision` 三态 | `delivery/owner-failure.ts:11` | **T1.6 必读**：`TerminalEmissionResult` 的 `terminalFrameDisposition` 三态与它论域重叠，取舍见 §11 #6」。**plan 知道 T1.6 会撞上 #6，却把触发点留在三个 commit 之后。**
- T2.7（Commit 2）进一步在这个形状上建 `terminate`／`finalize(result)` 状态机；T3.5（Commit 3）又把 8+2 个 terminal-close 决策映射到它。

**执行方会做出什么错误动作**：#6 未裁而 Commit 1 可以开工（plan 明说 #6 只挡 T4.10），所以我照 T1.6 把 `terminalFrameDisposition` 三态**按候选 ② 的隐含形状**落地（保留 `OwnerTerminalDecision`，`TerminalEmissionResult` 另起一套）——因为那是 RFC 字面写的形状，也是唯一不需要改 RFC 就能写的。到 Commit 4 触发点时，我手上已经有：C1 的类型与穷尽性 fixture、C2 的状态机与 mutation、C3 的 8+2 映射表。此刻把候选 ③（合并成一个三态、改 RFC §3.3 冻结形状）端给用户，**我会不自觉地把它描述成「要推翻三个 commit 的工作」**——而这正是 `necessity-claim` 与沉没成本合流的形态：**裁决材料的成本栏会因为我先干了活而失真**，和上一轮 #4 那次「merge 有冲突」是同一个病（`:754` 已把那次记成反例）。候选 ③ 于是在没有被真正比较过的情况下出局。

**修复建议**：把 #6 的触发点**前移到 Commit 1 kickoff**（或至少「T1.6 开工前」），理由写清：**它决定 `TerminalEmissionResult` 的冻结形状本身，而 T1.6 就要把那个形状写进类型层并加穷尽性断言**。§11 的表格里 #6 那行的触发点改成「**Commit 1 前置停门：T1.6 不得在 #6 未裁时开工**」，Commit 4 那条保留为第二道（防止 C1 裁完后 C4 又漂走）。若确实希望 C1 先动起来，那就必须在 T1.6 明写「**本 task 只冻结『存在三个互斥终态』这一性质，不冻结具体态名与归属**」——即按 §0 那句「答不上就只冻结性质」处理，而不是现在这样直接写死三个态名 + 穷尽性断言。

---

## R-6 `[nit]` §11 表格说 #6 的触发点是「Commit 4 前置停门**第 2 项**」，实际是**第 4 项**

**位置**：`cutover-plan.md:783`（「触发点：**Commit 4 前置停门第 2 项**，与 §9.3 各证据槽同级」）对 `:365-368`
**证据**：Commit 4 前置停门四项依次是 ① Q5 逐帧 diff、② §9.3 全部调查证据（T4.0a～d）、③ A／B／C／D 闭包最新、**④ §11 #6 已裁**。#6 是第 4 项。
**执行方会做出什么错误动作**：我照指针跳到第 2 项，读到的是 §9.3 证据槽，会短暂以为 #6 被并进了 T4.0a～d（那是四条**技术调查**，与一条**需要用户裁的契约取舍**性质完全不同）。第 4 项就在下面三行，自我纠正成本很低——但「与 §9.3 各证据槽同级」这半句会强化那个误读，让我把一条待裁项当成可自己查清楚的调查缝。
**修复建议**：改成「Commit 4 前置停门**第 4 项**」，并把「与 §9.3 各证据槽同级」改成「**与 §9.3 证据槽同为发布前置，但性质不同：它需要用户裁决，不能靠调查解决**」。

---
## 复评轮 verdict 与五问作答

**verdict：无未决 blocker；4 条 major（R-1／R-2／R-3／R-5）修完可开工。** 另 1 minor（R-4）、1 nit（R-6）。上轮 1 blocker + 6 major 中：**F-1 已实质关闭**（三个脚本的根推导逐个写清、`REPO_OVERRIDE` 与 `baseline-runs.sh` 无 override 都点了名；作者对我派活假设的反驳成立——`traceability-check.py`／`q1-locations.sh` 审文档，本就该留 master）；**F-2／F-10 随 merge 失效并已记成反例**；**F-3／F-4／F-6／F-7／F-8／F-9／F-11／F-12／F-14 均已修**。**本轮 4 条 major 全部是新发现**，其中 R-1／R-2 是 F-1 修复**内部**留下的缺口——门绑对了树，但「证明它绑对了」这件事仍不可执行、且只做一次。

**Q1｜能走到第几步？比上轮远得多。** 上轮我在 **T0.2** 就卡（要选一棵「未改动树」而 #4 未裁）。现在：`git worktree add` → T0.1（`MIN_TESTS` 的双原理取值路径写得可执行）→ T0.2～T0.9、T0.11 一路可做。**第一个真卡点是 T0.10**——它要的取证物不存在（R-1），而它写在 Commit 0 的 invariant 里，所以**照字面执行 Commit 0 收不了口**；我要么改门脚本（plan 未授权、未指定归属），要么退回「我 `cd` 对了」（T0.10 自己禁止）。若跳过它硬走，下一个**设计上的**停点是 **Commit 2 收口**（#5 未裁，已挂进门表），再往后 Commit 3 全通、Commit 4 可做到 **T4.9**（#6 挡 T4.10），Commit 5 全节被 Q1 挡住。

**Q2｜三道门真的测我的树吗？** ①②③ 的绑根写法**逐条正确**，我复核了脚本源码：`byte-equivalence.sh:5` 的 `REPO_OVERRIDE` 存在且语义如 plan 所述；`baseline-runs.sh:77` 确为纯 `BASH_SOURCE` 推导、**无 override**（plan 的 §0.3b 说对了）；`traceability-check.py`／`q1-locations.sh` 审文档、留 master 是对的。**但 T0.10 这个「给前提建 oracle」的新东西自己不可靠**：（a）它指定从「O-6 的 capture 里」取可执行路径／cwd，而 capture 是纯 SSE 字节、脚本成功路径压根不打印 `$REPO`／exe／cwd，`trap cleanup` 还会在返回前杀掉进程（R-1）；（b）它是**一次性**的，哨兵用完即撤，Commit 1～8 的 invariant 无一要求重证，而失效是**逐次调用**发生的（R-2）；（c）它把「可执行路径」与「cwd」并列，但脚本从不 `cd`，**cwd 在写法 B 下与被测树无关**，判据只能取 cmdline 里的 `$REPO/packages/cli/src/main.ts`。

**Q3｜T4.2 还会现场编签名吗？不会。** T4.0a 显式拥有 §9.3 第 1 项、排在 T4.2 之前、要求「结论带 `file:line` 或 PoC 落盘」，前置停门又逐字照抄了「没有 `file:line` 或 PoC 结论，就交付已完成部分与具体问题、结束本轮，**不生成猜测签名**」，并点名「**不得口头判『C3 交的就是它被要求交的，所以齐全』**」——正是上轮 F-3 的那句。T4.0b／c／d 同样各自绑到 T4.11／T4.9／T4.15。这条修得干净。

**Q4｜会自己挑一个 #6 吗？不会——但触发点定晚了。** 框定够硬（前置停门一项 + 三个带量化影响的候选 + 「不是可以边做边定的细节」+ T1.6／T2.7／T3.5／T4.10 四处交叉指回）。问题不在会不会自裁，而在 **#6 最早咬人的地方是 T1.6（Commit 1 就要把三个态写进类型层并加穷尽性断言），触发点却在 Commit 4**；等我干完 C1～C3 再端候选 ③ 出去，成本栏已被沉没成本污染（R-5）。

**Q5｜未决 blocker／major**：blocker 无。major 四条 —— **R-1**（T0.10 取证物不存在）、**R-2**（T0.10 只做一次）、**R-3**（Commit 0 的「逐字节不变」仍只扫 `src/ packages/`，而 Commit 0 恰恰最可能改 `scripts/parallel-test.ts`）、**R-5**（#6 触发点晚于它咬人的位置）。R-1 与 R-2 建议一并修：**在 `byte-equivalence.sh` 成功路径补一行 provenance，并把「断言 `repo=` 落在 `$TREE` 下」提升为每 commit 共同门的第 ④ 条**，一次解决两条。

**本轮复核方式（可审计）**：机械核对 —— 逐行 `sed -n` 打开 44 个锚点比对符号、`rg` 复算 A-1／A-3／B／C 四集人口与 10+2 个 close-anchor 站点、`git diff --stat 8125f123..HEAD -- src/ packages/` 证明行号基线未漂、逐行读 `byte-equivalence.sh`（186 行）与 `baseline-runs.sh` 的约束段、`rg 'T0\.10|T0\.11|git diff -- '` 查跨节一致性。第一人称执行 —— 从 §0.1 起按 `worktree add` → T0.1 取 `MIN_TESTS` → T0.2 验脚本版本 → T0.10 建取证（**卡在这里**）→ Commit 1 T1.6 写三态 → Commit 2 收口（**#5 卡**）→ Commit 4 前置停门 → T4.0a → T4.2 → T4.10（**#6 卡**）逐步走查。**未跑**：`typecheck`／`parallel-test.ts`／`byte-equivalence.sh`（要起服务器 + 真实 token），故「正确状态下这些门会绿」仍无正样本证据。全程只读，未碰 4141。

---
---

# 第三轮复评（2026-08-04）—— 整改 `2745cb8d..93e300d3` 后重走

**基线**：master `93e300d3`。上轮我的 R-1／R-2／R-3／R-5 逐条复核处置：

| 我的发现 | 处置 | 复核结论 |
|---|---|---|
| **R-1** T0.10 取证物不存在 | `e00b7aff` 给 `byte-equivalence.sh` 补 provenance | ✅ **已闭合**，见 T-0（实跑） |
| **R-2** T0.10 只做一次 | 升为每 commit 共同门第 ④ 条，九张门表各加一行；T0.10 改写为「建立判据、不是一次性做完」 | ✅ **已闭合**；且采纳了「只取 `repo=` 不取 cwd」——`:111` 判据 1 逐字写明理由 |
| **R-3** Commit 0 只扫 `src/ packages/` | 新增 §0.4a 单处定义 `MANIFEST` | ⚠️ **部分闭合**，见 **T-2**（漏 `ui-v4/`／`ui/`） |
| **R-5** #6 触发点太晚 | #5／#6 双双前移到 **Commit 1 kickoff 之前**，C4 停门第 4 项作兜底 | ✅ **已闭合**，比我建议的还早一档 |

## T-0 实跑验证 —— 第 ④ 条门**可执行，格式串逐字一致** ✅

按要求实跑（用私有 `WORK_DIR` 避免与并发 peer 抢 `/tmp/inter-block-anchor-allocator-baseline`，其余默认）：

```
$ WORK_DIR=/tmp/o6-review-$$ exp/inter-block-anchor-allocator/byte-equivalence.sh
repo=/home/xp/src/copilot-api-js
server_entry=/home/xp/src/copilot-api-js/packages/cli/src/main.ts
head=93e300d3 tree=DIRTY
1c6163c6…  /tmp/o6-review-1406405/current-wire.sse
764 /tmp/o6-review-1406405/current-wire.sse
port=44369 listener_pid=1406675 spawn_pid=1406667
capture=/tmp/o6-review-1406405/current-wire.sse
O-6 PASS: captured wire is byte-identical to …/pre-change-wire.sse (repo=/home/xp/src/copilot-api-js)
rc=0
```

与 plan `:100-105` 的格式块**逐字对得上**（`repo=` / `server_entry=` / `head=<短 sha> tree=clean|DIRTY` / PASS 行尾 `(repo=…)`）。行号引用 `:5`（REPO）、`:11`（BASELINE）、`:131-133`（provenance）、`:194`（PASS）**全部命中**。内核选端口 44369，4141 未受影响，脚本自清理无残留 listener。**上轮 R-1 判定的「不可执行」已实质解除。**

---

## T-1 `[major]` 第 ④ 条门的判据 3（`head=` 等于本 commit sha 且 `tree=clean`）**在你自然运行门的那一刻恒不成立**——而脚本只报不判，rc 照样 0

**位置**：`cutover-plan.md:111`（判据 3）、`:75`（②「须打印 `O-6 PASS`、rc=0」）
**证据**：
- **实跑坐实脚本只报不判**：我的运行 `tree=DIRTY`（主树有 peer 的 18 行未提交改动），`head=93e300d3` 是**上一个已提交的 sha**——而脚本**照样 `O-6 PASS`、`rc=0`**。判据 3 完全靠执行者读 stdout 自己比对，脚本不参与。
- **而 §0.3 ② 给的通过条件是「须打印 `O-6 PASS`、rc=0」**。只按这两条查，脏树／错 commit 一律绿。
- **更根本的问题是时序**：门是「每个 commit 的共同门」。执行者的自然顺序是**写代码 → 跑四道门 → 提交**。在那一刻 `$TREE` 必然 `tree=DIRTY`（你刚写完代码），且 `head=` 是**上一个** commit 的 sha，不是「本 commit 的 sha」——本 commit 还不存在。**判据 3 的两个子句在这个时序下都必然为假。**
- 反过来若改成「先提交再跑门」，判据 3 成立，但 commit invariant 的措辞（「本 commit 结束时 typecheck 绿、全套绿、O-6 PASS」）就变成「提交之后才知道这个 commit 合不合格」，门红时只能在隔离树里 amend／reset —— **plan 全文没有一句说明该用哪种时序**（`rg '提交前|提交后|commit 之后'` 零命中）。

**执行方会做出什么错误动作**：我第一次跑第 ④ 条就撞到 `tree=DIRTY`。判据 3 说这意味着「门测的不是它声称的那个 commit」，可我什么都没做错——这是 `criteria-fail-two-ways` 里的 **false-red**。人在门口反复吃假红时最自然的反应就是**放宽判据**：我会写下「判据 3 在准备期不适用，只查 `repo=`」，于是**判据 3 就此失效**——而它正是抓「门量的是另一个 commit」的那一条（比如你跑完门又改了两行才提交，门的证据其实不覆盖被提交的内容）。这不是理论：判据 1／2 每次都绿，只有判据 3 每次都红，**第一次收口就会被当成噪声删掉**。

**修复建议**：把时序写死，并把判据 3 拆成两种时刻：
1. **准备态自查**（写完代码、未提交）：只核判据 1／2（`repo=`／`server_entry=`），**明确允许 `tree=DIRTY`**，并记下「本次门覆盖的是工作区内容、非某个 commit」。
2. **收口证据**（commit 已生成后）：重跑一次四道门，此时要求 `head=<本 commit sha>` 且 `tree=clean`，**这一份才是写进验收记录的那份**。
3. 相应地在 §0.5 的提交纪律里加一句：**commit 生成后必须再跑一遍共同门取收口证据**（隔离树里 amend 是允许的，`git-preference` 的禁令针对共享树）。
否则最省事的走法就是把判据 3 删掉，而那恰好破坏它要保护的东西（`:662` 那一行「最省事的修法正好破坏它要保护的东西」正是 plan 自己写的）。

---
## T-2 `[major]` `MANIFEST` 漏掉 `ui-v4/`（393 个跟踪文件）与 `ui/`（177 个）——而 **plan 自己的 T5.5 要改 `ui-v4/`**，同一类 false-green 又开了一个口

**位置**：`cutover-plan.md:177-180`（MANIFEST 定义）对 `:625`（T5.5：「同 commit 同步**后端 SSOT schema、ui-v4 re-export** 与相关 tests」）
**证据**（实测 master `93e300d3`）：
- `MANIFEST='src/ packages/ config.schema.json package.json tsconfig.json bunfig.toml scripts/parallel-test.ts …'` —— **没有 `ui-v4/`，没有 `ui/`**。
- `git ls-files ui-v4 | wc -l` = **393**；`git ls-files ui | wc -l` = **177**。两者都是跟踪在册的源码树，不是产物。
- `rg -l '~backend/' ui-v4/src` 命中 `ui-v4/src/lib/model-telemetry.ts`、`src/hooks/useModels.ts`、`src/lib/model-thinking.ts` —— 正是 CLAUDE.md `single-source-of-truth-types` 描述的「前端经 `~backend/*` re-export 后端类型」。**后端类型一改，这些文件就得跟着改**，而 T5.5 逐字要求在 Commit 5 同步它们。
- 也就是说：**本 RFC 自己会修改 `ui-v4/`，但「production 未改动」的单一定义里没有它。**

**执行方会做出什么错误动作**：这与 T7.3 亲手证伪的形态**逐字同构**——当时是「只扫 `src/` 时在 `packages/` 改一字节仍判绿」，现在是「按 MANIFEST 扫时在 `ui-v4/` 改一字节仍判绿」。具体：
- **Commit 0**：invariant 是「production 源码与运行时行为**逐字节不变**」。我若在建 recorder／闭包工具时顺手动了 `ui-v4/` 的一个类型 re-export（T0.7 的闭包种子是后端类型，追消费者时很容易走到前端 re-export），MANIFEST 判绿，我写下「逐字节不变 ✓」。
- **Commit 7**：invariant 是「production 零改动」，而本 commit 正在大批删 fixture。`ui-v4/` 下也有测试与 fixture（393 个文件里含 `ui-v4/src/**/*.test.*`），我删着删着连带改了 `ui-v4/src` 的源码，门仍绿。
- 反方向的 false-red 我也查了：MANIFEST 排除 `tests/`、`test-timings.json`、`update-circular-deps-baseline.ts`，Commit 7 删 fixture／同步 timings／重冻 circular-deps baseline **全部落在门外，正确为绿** ✅。`scripts/` 的八个条目（`build-history-search.ts`／`generate-config-json-schema.ts`／`parallel-test.ts`／`probe-tui-observability-load.ts`／`recover-history-v3-projections.ts`／`test-timings.json`／`update-circular-deps-baseline.ts`／`eslint-rules/`）**逐条都被 §0.4a 的四类表分派到了**，无漏网 ✅。根目录只有一个 `tsconfig.json`、无 `turbo.json`，MANIFEST 写单数正确 ✅。**所以这一节的 false-red 侧是干净的，缺口只在 false-green 侧的前端两棵树。**

**修复建议**：MANIFEST 加 `ui-v4/src/ ui/src/`（**只加 `src/`，不整目录**——`ui-v4/` 下还有 `node_modules`／`dist`／`components.json` 之类，整目录会把合法的依赖与构建产物变动误判成 production 改动，正是上一版把整个 `scripts/` 塞进来踩过的坑）。同时在 §0.4a 的四类表下补一句**判定规则**：「**凡 `git ls-files` 跟踪、且被本 RFC 任一 commit 修改的路径，必须显式归类**」——现在的表只枚举了 `scripts/`，没有给「新出现的顶层目录怎么办」的规则，而仓库里还有 `hooks/`（1 个跟踪文件）、`contrib/`（6 个）、`native/`、`refs/` 未被表态。

---

## T-3 `[major]` JUnit 基础设施的先有鸡先有蛋：plan 说「先于 Commit 0 的独立改动」，但没说**落在哪棵树**、也没说 **entry commit 因此必须重取**

**位置**：`cutover-plan.md:186`（「若 T0.1／T0.11 的 junit 枚举确实需要动它，那是一次**独立的、先于 Commit 0 的基础设施改动**……不能夹在 cutover 的任何 commit 里」）、`:219`（T0.1 右栏「前置基础设施」）、`:48`（执行形状 `git worktree add ./.worktrees/<name> -b <branch>   # 从当前 master`）
**证据**（实地读 `scripts/parallel-test.ts`，plan 的诊断**完全准确**）：
- `:64` 的 `Bun.spawn(["bun","test","--reporter=junit",…])` **只在 `refreshTimings()` 里**，即 `--update` 分支的**另一次独立 run**。
- 真正的门运行在 `:120`：`buckets.map((b) => Bun.spawn(["bun","test",...b], …))` —— **裸 `bun test`，无 reporter**。
- `:157-167` 只用 `stripAnsi` + 正则从 stderr 抓 `N pass`／`N fail`，`tests = passSum + failSum`。**没有 file identity，没有 skipped。**
- ⇒ T0.1 要的「每次门运行的 shards 各自产 JUnit、runner 内合并 file identity、与磁盘 manifest 双向比集合、分别输出 `executed` 与 `skipped`」，**必须改 `scripts/parallel-test.ts`**。做不到绕过。

**于是链条闭合不了**：
1. `parallel-test.ts` **在 MANIFEST 里**（§0.4a 明确写「改它就是改尺子」）。
2. T0.1 是**入场条件**，要在**干净**的 `$TREE` 上跑 15 次（`baseline-runs.sh` 对脏树 rc=3 硬拒）。所以基础设施改动**必须先提交**。
3. 提交到哪？plan 只说「先于 Commit 0」。**两条路都有问题，plan 都没排除**：
   - **提交进 `$TREE`**（最自然——我就在这棵树里干活）：那么 Commit 0 的 invariant `git diff <from>..<to> -- $MANIFEST` 里，只要 `<from>` 取 §0.2 裁定的「合并后 master」，这次改动就落在区间内 → **红**。而 `<from>`／`<to>` 的语义 plan 全文没定义过（`:181` 写 `<from>..<to>`，`:716` 写 `<C6-sha>..<C7-sha>`）。
   - **提交到 master 再重建 `$TREE`**：符合 `docs-merge-before-execute`，但这意味着 **entry commit 不是裁决当时的 master HEAD**，而 T0.1 那 15 次连跑、`MIN_TESTS`、以及后续每个 commit 第 ④ 条门的 `head=` 比对**全部锚在 entry commit 上**。plan 从未说 entry 要重取。
4. 而且这个改动**改变了 `unit it http` 实际跑什么、怎么报数** —— `MIN_TESTS` 与 15 次基线**只能在它之后取**。所以 entry commit **必须包含它**，不是「先于 Commit 0」这么松。

**执行方会做出什么错误动作**：我 `git worktree add` 建好树，跑 T0.1，读到「本条依赖一件尚不存在的基础设施——先建它，别硬跑」。**这一句是好的，它救了我**（否则我会直接拿 JUnit 的 `tests` 当 `MIN_TESTS`，而 plan ② 已实测证明那口径含 skipped、在新建隔离树里因缺 native 产物而与主树不同）。但接下来我必须自己决定这次改动落在哪棵树——**这正是 §11 #4 已经被裁过一次的那类调度决策**，而这次没有待裁项覆盖它。最可能的走法：我在 `$TREE` 里提交它，然后发现 Commit 0 的 MANIFEST invariant 红，于是**要么把它折进 Commit 0**（§0.4a 逐字禁止），**要么把 `<from>` 悄悄挪到「基础设施提交之后」**——后者没人拦得住，因为 `<from>` 从来就没被定义过。

**修复建议**：把它升成一条**显式的前置相位**（叫 `Commit -1` 或 §0.2b 都行），写清四件事：①**它落在 master 主线**（`docs-merge-before-execute`：它是共享的测试尺子，不是 cutover 私产）；②**`$TREE` 从它之后的 master 建**，**entry commit = 该 master sha**，§0.2 那句「从当前 master 起」要相应改成「从含 junit 枚举的 master 起」；③**T0.1 的 15 次必须在它之后跑**（否则 `MIN_TESTS` 的口径来自旧 runner）；④ §0.4a 补一句 `<from>`／`<to>` 的定义：**`<from>` = 本 commit 的父 commit，`<to>` = 本 commit**（这样基础设施改动落在 entry 之前，天然在所有区间之外）。第 ④ 点单独也值得做——它现在是个未定义符号，被三处引用。

---
## T-4 `[nit]` §0.3 ② 仍写「`:123` 用 `bun run "$REPO/…/main.ts" start` 起服务器」——provenance 补丁后实际是 `:137`

**位置**：`cutover-plan.md:70`
**证据**：`e00b7aff` 在 spawn 前插入 14 行（注释 8 行 + 三条 `printf` 6 行），把 spawn 从 `:123` 推到 `:137`。逐行确认：`:123` 现在是注释首行 `# Which tree this gate measured…`，`:137` 才是 `XDG_DATA_HOME="$WORK_DIR" NODE_ENV=production bun run "$REPO/packages/cli/src/main.ts" start …`。同段引用的 `:5`（REPO）与 §0.3 ④ 的 `:131-133`／`:194` **都是对的**——只有这一个漏了同步。
**执行方会做出什么错误动作**：我按 §0.4 的「引用前重取」纪律去 `sed -n '123p'` 核对「它到底起的是哪个 entry」，看到的是一段注释而不是 spawn 行。因为紧接着 `:131-133` 引用又是对的，我会怀疑是自己数错行、再翻一遍——纯浪费，且轻微削弱对整节行号的信任。**这一节恰恰是全 plan 唯一一处「行号指向的是脚本、不是被审代码」的地方**，而脚本刚被改过，是最该复查的。
**修复建议**：`:123` → `:137`。并建议这一段的三个行号旁标注「锚 `byte-equivalence.sh` @ `e00b7aff`」——脚本不像 `src/` 那样有 §0.1 的「引用前重取」命令兜底。

---

## 第三轮 verdict 与五问作答

**verdict：无未决 blocker；3 条 major（T-1／T-2／T-3）修完可开工。** 另 1 nit（T-4）。**我上轮的 4 条 major 有 3 条完全闭合、1 条（R-3）部分闭合**；本轮 3 条 major 中 T-2 是 R-3 的残留口，T-1／T-3 是新发现——**两者都长在这一轮新加的东西上**（第 ④ 条门的判据 3、T0.1 的前置基础设施），属于「修复引入新接缝」的常见形态，不是回退。

**Q1｜第 ④ 条门真的可执行吗？可执行，格式串逐字一致——但判据 3 不可满足。** 实跑见 T-0：`repo=`／`server_entry=`／`head=… tree=…`／PASS 行尾 `(repo=…)` 与 plan `:100-105` 的格式块完全对得上，`:131-133`／`:194` 行号命中，rc=0、O-6 PASS、内核选端口 44369、4141 未受影响。**判据 1／2 完全可执行且有判别力**（写法 B 少打 `REPO_OVERRIDE` 会立刻在 `repo=` 上现形）。**判据 3 不行**：我的实跑 `tree=DIRTY` 而脚本照样 rc=0——脚本**只报不判**，且在「写完代码→跑门→提交」的自然时序下 `tree=DIRTY` 与 `head=上一个 sha` **必然成立**，判据 3 每次假红、第一次收口就会被删（T-1）。

**Q2｜MANIFEST 的两个方向**：**false-red 侧干净** —— `tests/`／fixtures／`docs/`／`test-timings.json`／`update-circular-deps-baseline.ts` 全在门外，Commit 7 删 fixture + 同步 timings + 重冻 circular-deps baseline **都正确为绿**；`scripts/` 八个条目**逐条被四类表分派完毕**，无漏网；根目录确实只有一个 `tsconfig.json`、无 `turbo.json`。**false-green 侧有洞** —— 漏了 `ui-v4/`（393 跟踪文件、`~backend/*` re-export、**T5.5 明确要改它**）与 `ui/`（177），与 T7.3 亲手证伪的「只扫 `src/`」是同构缺陷（T-2）。另外 `hooks/`／`contrib/`／`native/`／`refs/` 未表态，缺一条「新顶层目录必须显式归类」的规则。

**Q3｜做得到吗？做不到，必须改 `scripts/parallel-test.ts`。** 实地读证实 plan 的诊断精确：junit 只在 `:64` 的 `refreshTimings()`（`--update` 的另一次 run），门运行在 `:120` 是**裸 `bun test` 无 reporter**，`:157-167` 只从 stderr 正则抓 pass/fail、`tests = passSum+failSum`，**无 file identity、无 skipped**。所以先有鸡先有蛋是真的。plan 给的出路（「独立的、先于 Commit 0 的改动」）**方向对但不够定**：没说落哪棵树、没说 entry commit 因此要重取、`<from>`／`<to>` 三处被引用却从未定义（T-3）。

**Q4｜第一个真卡点：T0.1 的前置基础设施**（比前两轮的 T0.2、T0.10 更早）。**但性质变了**：前两轮是**暗坑**（走到了才发现判据没法执行），这次是 plan **自己举着牌子拦我**——T0.1 首行逐字写「🔴 本条依赖一件尚不存在的基础设施，见右栏——先建它，别硬跑」。**卡点前移不是回退，是从暗变明。** 残留的只是「这次改动落在哪棵树、entry 是否重取」。往后：#5／#6 已双双前移到 **Commit 1 kickoff 之前**（我上轮 R-5 建议 T1.6，实际前移得更早），Commit 5 仍由 Q1／#3 挡住。

**Q5｜未决 blocker／major**：blocker 无。major 三条 —— **T-1**（判据 3 时序上不可满足，会被当噪声删掉）、**T-2**（MANIFEST 漏前端两棵源码树）、**T-3**（junit 基础设施落哪棵树 + `<from>`/`<to>` 未定义）。**T-1 与 T-3 建议一并处理**：两者都归结为「**门与 commit 的时序关系没写**」——把 `<from>` 定义成「本 commit 的父 commit」、把「收口证据在 commit 生成后重跑一次」写进 §0.5，同时解掉判据 3 的假红和基础设施相位的归属。

**本轮复核方式（可审计）**：机械核对 —— `git show e00b7aff` 读补丁、逐行 `sed -n` 核 `byte-equivalence.sh` 的 `:5/:11/:131/:132/:133/:137/:194`、`ls scripts/` + `git ls-files` 清点四类归属与顶层目录跟踪数、逐行读 `parallel-test.ts:55-72,115-125,145-170` 判 junit 可得性、`rg '提交前|提交后|commit 之后'` 查时序措辞（零命中）。第一人称执行 —— **实跑一次 O-6 全流程**（私有 `WORK_DIR`、内核选端口、自清理、未碰 4141），再从 `worktree add` → T0.1 → 撞前置基础设施 → 假设已解决后走 §0.4a invariant → Commit 1 kickoff（#5／#6 停）逐步走查。**未跑**：`typecheck`／`parallel-test.ts`（不改动前它给不出本轮要判的 file identity）。全程只读，除本报告外未改任何文件。

---
---

# 第四轮复评（2026-08-04）—— 整改至 `c1b2e219`

**基线**：master `c1b2e219`，`src/`／`packages/` 自 `8125f123` 起仍未变。上轮我的三条处置复核：

| 我的发现 | 处置 | 复核结论 |
|---|---|---|
| **T-1** 判据 3 必然假红 | 不改脚本、改时序：新增 §0.4b「开发趟／收口趟」，`head=`／`tree=` 只在收口趟判 | ⚠️ **方向正确，但收口趟的 `tree=clean` 仍不可达**，见 **U-1** |
| **T-3** `FROM`／`TO` 未定义 + 基础设施相位 | §0.4b 定死 `HEAD^`／`HEAD`、落 `$TREE`；基础设施先提交 → **重取 entry sha** → 旧批作废 | ✅ **已闭合**（连贯性我逐环节验过，见 U-4） |
| **T-2** manifest 漏 `ui-v4/`／`ui/` | §0.4a 改为**先给导出命令再列表**，38 条逐条表态 | ⚠️ **顶层已闭合、子层未闭合**，见 **U-2** |
| **T-4** `:123`→`:137` | 已改 | ✅ |

**作者自报的 82 行陈旧副本**：已核实**确已清除**。`awk` 全文扫重复长行零命中；`rg '^#{2,3} '` 列出的小节序列单调无重复（`0.1／0.1a／0.2／0.3／0.3b／0.4／0.4a／0.4b／0.4c／0.5` 各一次）；`§0.4a`(4)／`§0.4b`(5)／`§0.3 ④`(12)／`§11 #5`(3)／`§11 #6`(9) 引用全部指向存在的小节，**零悬空**。

## U-0 顶层导出命令实跑 —— **38 条，plan 缺失 0 条** ✅（但计数写成 37）

我按 §0.4a ① 实跑 `git ls-files | awk -F/ 'NF>1{print $1"/"} NF==1{print $1}' | sort -u`：**38 条**。逐条对着表数了一遍，**38/38 全部被表覆盖，缺失 0 条**——与你的独立复核一致。在锚 commit `54dbd4f3` 上重跑（`git ls-tree -r --name-only`）同样是 **38**，所以不是我与你取样时点不同。

**但 plan 第 157 行写「逐条表态（锚 master `54dbd4f3`，共 **37** 条）」——差 1。**（`[minor]`）
**执行方会做出什么错误动作**：§0.4a 的整个新方法就是「**判据不是我想到了哪些，而是 ① 的输出里每一条都在下表出现**」。我跑 ①，得到 38，抬头看见「共 37 条」——**第一反应是「表里少了一条」**，于是把 38 行输出与一张**分组**的表（一行写 `.claude/／.agents/／.workflow/／.serena/／.superpowers/／.vscode/` 六项）手工对账。对完发现一条不缺，只能怀疑是自己数错、再对一遍。更坏的分支：我认定确实少一条、**凭感觉补一行**，于是表里出现重复条目——而这正是本轮那个「82 行陈旧副本」自伤的同型（定位靠人眼匹配）。
**修复建议**：`37` → `38`；并建议把总数写成**由 ① 现算**而不是写死（`… | wc -l`），否则每次新增顶层条目都要记得改这个数——`anchor-numbers-to-commits` 的老问题。

---

## U-1 `[major]` 收口趟的 `tree=clean` **在照 plan 执行时不可达**：T0.1 的 15 份日志就写在 `$TREE` 里，而 `git status --porcelain` 计未跟踪文件

**位置**：`cutover-plan.md:202-230`（§0.4b 两趟表 + 收口趟判「`tree=clean`」）、`:259`（§0.5「`tree=clean` 只有那时才成立」）、`:276`（T0.1 的 `OUT=docs/tmp/<date>-entry-runs`）
**证据**（逐行读脚本 + 实跑坐实）：
- `baseline-runs.sh:105-107`：`case "$OUT" in /*) OUT_DIR="$OUT" ;; *) OUT_DIR="$REPO/$OUT" ;; esac`。plan 给的 `OUT=docs/tmp/<date>-entry-runs` 是**相对路径**，`REPO` 又由脚本位置推导 ⇒ **15 份 `run-*.log` 落在 `$TREE/docs/tmp/` 里**。
- `byte-equivalence.sh:133-135`：`tree=` 取自 `[ -n "$(git -C "$REPO" status --porcelain)" ] && echo DIRTY || echo clean`。**`git status --porcelain` 默认把未跟踪文件也算进去**（我这轮的实跑就打了 `tree=DIRTY`，而主树的脏正是 peer 的未提交改动 + 未跟踪文件）。
- ⇒ 只要那 15 份日志还躺在 `$TREE` 里且没被提交，**收口趟的 `tree=clean` 恒假**。而 Commit 0 的落盘物远不止它：T0.7 的完整 symbol hit set、T0.8 的四类分档、T0.9 的 golden 清单与哈希、T0.11 的 manifest、T0.10 的取证记录——plan 全都只说「落盘」，**从不说落在哪、是否提交、用什么 pathspec 提交**。
- 雪上加霜的是 §0.5 强制**显式 pathspec 提交**（`git commit -F <msgfile> -- <精确路径>`）。pathspec 提交**按定义只收进你点名的路径**，其余一律留在工作区 ⇒ 除非 pathspec 恰好覆盖了每一个脏项，否则提交完仍是 `DIRTY`。**「用 pathspec 提交」与「提交后 tree=clean」这两条纪律，plan 里并排放着却互相拉扯。**

**执行方会做出什么错误动作**：我做完 Commit 0，按 §0.4b 进收口趟，第一次跑就看到 `tree=DIRTY`。我知道自己刚提交完、代码没漏，于是判断这是噪声——**然后走上 T-1 想避免的那条老路**：要么把判据 3 标注「本 commit 不适用」（判据就此失效，而它正是抓「门量的不是被提交的那份内容」的），要么为了让它绿而**把 15 份日志和一堆证据文件删掉**——**那是本 plan 最贵的证据**（入场条件的原始输出、闭包 hit set、golden 哈希基座），删了之后 T8.7 的 merged-state review 与 Commit 6 的重跑对账全部没有比对物。第三条路是 `git add` 一把梭，直接违反 §0.5 的 pathspec 硬要求。

**修复建议**（三选一，但必须选一条写死）：
1. **证据进版本控制**（推荐，合 CLAUDE.md `conclusions-must-land-in-docs`）：§0.5 增一条「**每个 commit 的落盘证据与代码同 commit 提交**，pathspec 明确含 `docs/tmp/<本 commit 的证据目录>/`」，并在 §0.4b 的收口趟表里写「先提交证据，再跑收口趟」。
2. **证据出树**：T0.1 改用绝对 `OUT=/tmp/…`，其余落盘物同理——但这与「结论一律落盘、不只活在对话里」冲突，且跨会话接手拿不到。
3. **明确 `tree=clean` 的口径**：改成 `git status --porcelain --untracked-files=no` 并写明「**只要求无未提交的已跟踪改动**，未跟踪的证据文件不计」。**若选这条必须同时说清代价**：`--untracked-files=no` 会让「新建但忘了 `git add` 的 production 文件」逃过 `tree=clean`，需要另一条补偿判据。
无论选哪条，都要在 §0.4b 里**明说 pathspec 提交与 `tree=clean` 的关系**——现在这两条纪律只是并排，没有人告诉执行者它们会打架。

---
## U-2 `[major]` 新方法的完备性保证**只到顶层**，而 MANIFEST 对 `ui/`／`ui-v4/`／`scripts/` 用的是**子层白名单**——`ui/package.json`、`ui/bun.lock` 就漏在门外

**位置**：`cutover-plan.md:149-156`（导出命令 ①②）、`:186-193`（`MANIFEST` 变量）
**证据**（实跑二级枚举）：
- 导出命令 ① 是 `awk -F/ 'NF>1{print $1"/"}'` —— 它**只产出顶层条目**。判据「① 的输出里每一条都在下表出现」因此**只能证明顶层无遗漏**。
- 而 `MANIFEST` 对三个目录用的是子层白名单：
  - `ui-v4/src/ ui-v4/index.html ui-v4/package.json ui-v4/vite.config.ts ui-v4/tsconfig.json ui-v4/components.json`
  - `ui/src/ ui/vite.config.ts ui/tsconfig.json`
  - `scripts/` 的 6 项
- 实测 `git ls-files ui | awk -F/ 'NF>2{print $2"/"} NF==2{print $2}'` 得 15 项：`.gitignore CLAUDE.md README.md V1_VS_V3_COMPARISON.md **bun.lock** **bunfig.toml** **index.html** **package.json** playwright.config.ts src/ tests/ tsconfig.json vite.config.ts vitest.config.ts vitest/`。
  **`ui/package.json`、`ui/bun.lock`、`ui/bunfig.toml`、`ui/index.html` 四项在门外**——而顶层表对 `package.json`／`bun.lock` 的理由逐字是「**`bun.lock` 是构建输入——依赖变了就不是同一个 production**」。**同一条理由，在根目录成立、在 `ui/` 就不适用了？** plan 没给任何解释。
- 更直接的自相矛盾：`ui-v4/index.html`／`ui-v4/package.json` **在**门内，`ui/index.html`／`ui/package.json` **不在**。两棵前端树被**不对称**处理，而表里对 `ui/` 的理由只写「177 个跟踪文件；同理排除 `ui/tests/`（27）与 `ui/vitest/`（20）」——**只解释了排除什么，没解释为什么纳入的比 `ui-v4/` 少三项**。
- `ui-v4` 二级枚举 10 项，未纳入的是 `README.md／docs/／tests/／vitest.config.ts`——这四项出门是合理的，**但同样没有任何机械判据保证下次不漏**：`ui-v4` 正在做 shadcn 重设计（CLAUDE.md），新增 `uno.config.ts`／`postcss.config.js`／`tsconfig.app.json` 之类是高概率事件，而它们出现后 **① 的输出仍然只有一行 `ui-v4/`，判据照绿**。

**执行方会做出什么错误动作**：§0.4a 用整整一段红字告诉我「这份清单已经错过三次……**新增顶层条目时必须显式归类，默认落在门外是不可接受的**」，并给了一条可复跑命令当判据。我跑完 ①、对完 38 条、判定「完备性已由机器保证」——**然后就不再怀疑这份清单了**。可实际上在三个目录内部，「默认落在门外」正是当前的行为。日后有人给 `ui-v4/` 加一个构建配置、或改 `ui/package.json` 的依赖，Commit 0 的「逐字节不变」与 Commit 7 的「production 零改动」照绿。**这比第三次那个洞更隐蔽**——那次是「我没想到」，这次是「我以为机器替我想了」。

**修复建议**：把导出命令**递归到有子层白名单的那三个目录**，让判据覆盖它们：
```bash
# 顶层
git ls-files | awk -F/ 'NF>1{print $1"/"} NF==1{print $1}' | sort -u
# 三个用子层白名单的目录，再各枚举一层
for d in ui ui-v4 scripts; do
  git ls-files "$d" | awk -F/ -v d="$d" 'NF>2{print d"/"$2"/"} NF==2{print d"/"$2}'
done | sort -u
```
并把 `ui/` 的四项（`package.json`／`bun.lock`／`bunfig.toml`／`index.html`）**按顶层同款理由纳入**，或者**写明为什么前端子包的依赖不算构建输入**——两者都行，但不能像现在这样既无判据也无理由。另建议在表里加一列「**是否用了子层白名单**」，让「① 管不到这里」这件事在纸面上可见。

---

## U-3 `[minor]` §0.4c 定义了 mutation 探针的退出码豁免，却**零处引用**——最需要它的人不会读到

**位置**：`cutover-plan.md:231-241`（§0.4c）；`rg '0\.4c'` 全文**命中数 1**（就是它自己的标题行），对比 `§0.4a` 4 处、`§0.4b` 5 处。
**证据**：§0.4c 末段是一条承重的界定：「**本 plan 各处 mutation『必须红』指的正是那类隔离探针——它们本就该非零退出，不受本口径约束。把『一律 rc=0』推广到 mutation 探针会把所有正控判成违规。**」而全 plan 有几十处 mutation 正控（T0.2 注一字节 rc=9、T3.2 三条删 effect、T3.3／T4.6 逐 site、T4.9 双命中、T4.10 逐 site、T6.5 两条、§0.4a 四条 …），**没有一处指回 §0.4c**。T0.6 自己也不指。
**执行方会做出什么错误动作**：我在 T0.2 注入一字节、拿到 `rc=9`。此时脑子里刚被 §0.4b／共同门反复灌了「`unit it http` **确定性全绿**」「rc=0」。§0.4c 的豁免我没读到（它排在 §0.4b 之后、没人指向它，而我是从 Commit 0 的 task 表往回查的）。于是我可能把 mutation 的非零退出记成「本 commit 未达终态」，或者更糟——**把 mutation 探针改造成「即使命中缺陷也 rc=0」的形状**，那就把正控的判别力直接拆了。
**修复建议**：在 §0.4b 收口趟表的「跑什么」一栏、以及 T0.2／T0.6 两处最早出现 rc 语义的地方各加一句指针「**mutation 探针的退出码语义见 §0.4c**」。一条被写下来却没有触发点的界定，等于没写（plan 自己在 §11 前言写过这句：「『若评审认为……』不是触发点，因为没有任何流程保证有人会去看」——同一条道理适用于 §0.4c）。

---

## U-4 逐环节验过的连贯性（**没有发现问题，列出来是为了让修订者不要把它改坏**）

我把 §0.4b 的相位链条当成执行序列走了一遍，四个环节**互相咬得住**：

| 环节 | 检查 | 结论 |
|---|---|---|
| 基础设施落 `$TREE` → 重取 entry | `parallel-test.ts` 在 MANIFEST 内，若它落在 entry **之前**，Commit 0 的 `FROM=HEAD^`= entry = 基础设施 commit，该改动**落在区间之外** | ✅ 不会自伤 |
| 旧 15 次作废 | §0.4b 步骤 2 逐字「锚在旧 sha 上跑的那批作废——它测的是没有 file identity 的 runner」；且 T0.1 首行已 🔴 拦「先建它，别硬跑」，**照做的人根本不会产出那批旧日志** | ✅ 不会误用 |
| 收口趟 `head=` 等于哪个 sha | 写法 A 下 `REPO`=`$TREE`，`byte-equivalence.sh:133` 打的是 `git -C "$REPO" rev-parse --short HEAD` ⇒ **等于 `$TREE` 刚生成的那个 commit**，与 `TO=$(git -C "$TREE" rev-parse HEAD)` 同源 | ✅ 定义自洽 |
| 扩张后的 false-red 侧 | Commit 7 的正事逐项过：删 `tests/` 下 fixture ✅ 门外；同步 `scripts/test-timings.json` ✅ 门外；重冻 `tests/architecture/circular-deps-baseline.json` ✅ 门外（在 `tests/` 下）；`ui-v4/tests/`／`ui/tests/`／`ui/vitest/` ✅ 均未进 MANIFEST | ✅ **上轮确认干净的 false-red 侧，本轮扩张后仍然干净** |

唯一残留的小口子：`package.json` 在门内，若 C7 顺手删掉一个只服务旧 fixture 的 npm script 就会红。概率低（T7.2 删的是 fixture／helper 不是脚本），**记为观察项不算发现**。

---
## 第四轮 verdict 与四问作答

**verdict：无未决 blocker；2 条 major（U-1／U-2）修完可开工。** 另 2 minor（U-0 计数、U-3 无引用）。上轮 3 major：**T-3 完全闭合**，**T-1／T-2 方向正确但各留一个残口**——两个残口都长在**本轮新加的机制**上（两趟时序、导出式 manifest），是「修复引入新接缝」的第四次同型复发，不是回退。自报的 82 行陈旧副本**已核实清除，零悬空引用**。

**Q1｜第一个真卡点：Commit 0 的收口趟 `tree=clean`。** 四轮轨迹 T0.2 → T0.10 → T0.1 前置基础设施 → **Commit 0 收口**，每轮都往后推。现在我能一路走完：`worktree add` → T0.1 撞前置基础设施（§0.4b 已把「落哪棵树／entry 怎么重取／旧批作废」全写死，**不再是卡点**）→ 建 junit 枚举 → 重取 entry → 15 次连跑 → T0.2～T0.11 → 提交 Commit 0 → **收口趟第一跑就 `tree=DIRTY`**（15 份 `run-*.log` 加一堆落盘证据就躺在 `$TREE/docs/tmp/` 里，而 `git status --porcelain` 计未跟踪文件）。这一步没有出路可照做（U-1）。

**Q2｜两趟形状照做得下来吗？开发趟完全可以，收口趟卡在 `tree=clean`。** 拆开说：开发趟四条（typecheck／全套／O-6／`repo=`+`server_entry=`）全部可执行，且**不判 `head=`／`tree=`** 这个设计正确——它精准解掉了我上轮说的「每次假红、第一次收口就被当噪声删掉」。收口趟的 `head=` 也可执行且自洽（写法 A 下 `REPO`=`$TREE`，脚本打的就是刚生成那个 commit）。**唯一不可执行的是 `tree=clean`**，而且它与 §0.5 强制的 **pathspec 提交**天然打架——pathspec 提交按定义只收点名路径，其余留在工作区。**两条纪律在 plan 里并排放着，没有一句话告诉执行者它们会互相拉扯。** 这正是你预判的「为修假红而新加的机制最可能出问题」，只是出问题的不是判据本身而是它的前提。

**Q3｜会不会把旧 15 次当成还有效？不会。** §0.4b 步骤 2 逐字写「锚在旧 sha 上跑的那批**作废**——它测的是没有 file identity 的 runner」，且 T0.1 首行 🔴 已拦「本条依赖一件尚不存在的基础设施，先建它，别硬跑」——**照做的人根本不会先产出那批旧日志**。相位链条我也验过是自洽的（U-4：基础设施落在 entry 之前 ⇒ Commit 0 的 `FROM=HEAD^`=entry，该改动天然在区间外，不会自伤）。**唯一残留（记为观察项，不算发现）**：`baseline-runs.sh` 拒绝往同一 `OUT` 目录混批次（rc=2），所以若真有人先跑了旧批，那批日志会**原样留在盘上**与新批并列，而 plan 没说要给它打作废标记——将来 T8.7 的 merged-state review 可能引错那份。加一句「作废批次目录改名加 `-VOID` 后缀」即可。

**Q4｜是否还有未决 blocker/major**：**blocker 无。major 两条** —— **U-1**（收口趟 `tree=clean` 与「证据落盘在 `$TREE`」+「pathspec 提交」三者互斥，plan 未指明证据是否提交）、**U-2**（§0.4a 的导出式判据只覆盖顶层，而 `ui/`／`ui-v4/`／`scripts/` 用的是子层白名单，`ui/package.json`／`ui/bun.lock`／`ui/bunfig.toml`／`ui/index.html` 就漏在门外，且与 `ui-v4/` 的处理不对称、无理由）。**两条都建议用「把判据本身补全」而不是「补一次清单」来修**——U-1 加一条「证据与代码同 commit 提交」的纪律，U-2 把导出命令递归到那三个目录，否则会有第五次。

**本轮复核方式（可审计）**：机械核对 —— 实跑 §0.4a 的导出命令（HEAD 与锚 commit `54dbd4f3` 各一次，均 38 条）、`git ls-files ui/ui-v4` 二级枚举与 MANIFEST 逐项比对、逐行读 `baseline-runs.sh:101-113` 的 `OUT` 解析与 `byte-equivalence.sh:133-135` 的 `tree=` 判定、`awk` 全文扫重复长行 + `rg '^#{2,3} '` 查小节重排 + `rg '§0\.4[abc]'` 数引用查悬空。第一人称执行 —— 从 `worktree add` 起按 §0.4b 的相位链走：前置基础设施 → 重取 entry → T0.1 → Commit 0 各 task → **提交 → 收口趟（卡在 `tree=clean`）**；另单独走了「C7 删 fixture + 同步 timings + 重冻 baseline」三条 false-red 路径确认扩张后仍绿。**未跑**：`typecheck`／`parallel-test.ts`／本轮未重跑 O-6（上一轮已实跑验过 provenance 格式，本轮脚本未再改动）。全程只读，除本报告外未改任何文件。

---
---

# 第五轮复评 —— 整改至 `b06c6510`

**基线**：master `b06c6510`。上轮处置复核：

| 上轮发现 | 处置 | 复核结论 |
|---|---|---|
| **U-1** 证据落盘／pathspec／`tree=clean` 三方互斥 | §0.4b 写死「证据随其所证明的 commit 提交」，并给 T0.1 日志单独归属 | ⚠️ **一般 commit 已闭合；T0.1 的特殊归属仍有循环**，见 **V-1** |
| **U-2** 子层 allowlist 静默漏项 | 反转为 tracked 全集减显式排除表 | ✅ **已闭合，且作者否决我的递归候选是对的**（见 V-0） |
| **U-0** 37/38 计数漂移 | 删除正向清单与总数 | ✅ 不复存在 |
| **U-3** mutation 退出码豁免无触发点 | 从 §0.4c 上移到 §0.3 共同门语境 | ✅ 已闭合 |

## V-0 反转判据复核 —— **作者否决我的递归候选是对的** ✅

我上轮建议「递归枚举 `ui/`／`ui-v4/`／`scripts/`」，这一轮的反驳成立：那仍是 allowlist，第五个嵌套项目出现时仍会静默。现在的 `git diff … -- . ':(exclude)…'` 形状把**未分类项默认放进门内**，失败方向从静默假绿变成当场假红，长期正确。

实地对账：
- `ui/` 与 `ui-v4/` 现在自动对称：`ui/package.json`、`ui/bun.lock`、`ui/bunfig.toml`、`ui/index.html` 均不在排除表 → **门内**；上一轮 U-2 的四个洞全封。
- 新增 `ui-v5/src/x.ts` 不命中任何 exclusion → **默认门内**，第五个嵌套项目不会静默漏。
- false-red 侧仍正确：`tests/`／`docs/`／`ui/tests/`／`ui-v4/tests/`／`ui/vitest/`／`scripts/test-timings.json`／`scripts/update-circular-deps-baseline.ts` 均显式排除；Commit 7 删 fixture、同步 timings、重冻 architecture baseline 仍绿。
- 新的主观取舍只剩「哪些东西值得排除」，每条都在理由表具名；漏分类会红而不是绿，结构上可接受。

---

## V-1 `[major]` T0.1 的「15 份日志归前置基础设施 commit」仍是时间循环：日志要测的 sha，只有把日志提交进去后才成为新 sha

**位置**：`cutover-plan.md` §0.4b「前置基础设施改动的相位归属」步骤 1～3，对其下方「证据落盘位置」表第一行（「T0.1 的 15 份 `run-*.log` → **前置基础设施那个 commit**」）

**证据**（脚本真实行为）：
- `baseline-runs.sh:132-135` 在**每一份**日志头写 `repo`、`head=$(git … rev-parse HEAD)`、`tree=$(git status --porcelain)`；`:144-167` 还对每次运行前后比 `HEAD`／tree drift。
- §0.4b 相位步骤要求：①基础设施改动在 `$TREE` 上先提交；②**重取 entry commit sha**；③15 次连跑锚这个新 sha。
- 设基础设施提交为 `I`。在 `I` 上跑 15 次后，日志头正确写 `head=I`。但如果再把这些日志提交「归前置基础设施 commit」，只能生成**另一个 commit `I+logs`**（除非 amend）。此时 entry commit 按 plan 的「它落地后 entry commit 变了」逻辑应是 `I+logs`，而日志测的是 `I` —— **又过期**。若在 `I+logs` 上重跑，新日志又产生未提交文件，提交后再变 `I+logs2`，无限递归。
- 唯一能打破循环的是 **amend**：跑日志后 amend 回基础设施 commit，让日志和代码同 commit。但 amend 会改 sha，日志头仍写 amend **之前**的 sha `I`，不是 amend 后的 `I'`，证据仍不锚最终 commit。即使第二次 amend，仍会再改 sha。
- 我还用 `/tmp` 一次性仓库跑了缩小版 `baseline-runs.sh` 探针（3 runs，fake runner）：启动前 tree clean；脚本 rc=0；但每份日志头均是 `tree=DIRTY`、`dirt=?? docs/`，因为脚本**先创建 `$OUT_DIR`／`run-N.log`，再在日志头读取 porcelain**。所以即使入口处干净，**日志自身让每一 run 自报 DIRTY**；脚本不把这当 drift（before/after 都含同一未跟踪目录），仍 `3/3 green`。这进一步证明「把日志写在被测树里」不是一个 commit-identical 的基线证据。

**执行方会做出什么错误动作**：我照步骤做基础设施 commit `I`，跑 15 次，拿到日志；表又说这些日志「归 `I` 提交」。Git 不能向既有 commit 添文件而不改 sha，所以我会：
1. **amend**，随后把日志里 `head=I` 与新 HEAD `I'` 的 mismatch 当成「可接受，因为代码 tree 相同」——这直接违反本 plan 反复强调的「`head=` 等于本 commit」与 `anchor-numbers-to-commits`；或
2. 另提一个 evidence commit，然后把 entry 定义成 evidence commit，却继续引用测 `I` 的 15 次；或
3. 为追最终 sha 反复跑／提交，永远没有不改变 sha 的终点。
三条都让「entry commit 上连跑 15 次」这个 RFC §7.1 入场条件失真。

**修复建议**：T0.1 原始日志必须**出被测 tree**，否则 commit identity 与日志落盘天然循环。可执行形状：
1. 在基础设施 commit `I` 后，设绝对 `OUT=/tmp/<entry-sha>-entry-runs`（脚本支持绝对 OUT，`:105-108`），15 次日志头即可稳定写 `head=I tree=clean`；
2. **不要把原始日志提交进被测分支**。在主文档树或独立 evidence branch/commit 中提交一份**内容寻址的归档**（tar hash + 每份 log hash + `head=I`），不改变 `$TREE` 的 HEAD；或者把日志放仓库外持久化位置，plan 只提交 hash manifest；
3. entry commit 明确定义为 `I`，Commit 0 的 `FROM=I`；归档 commit 不属于 cutover branch。
如果项目坚持原始日志必须进 cutover branch，那 RFC 的命题必须降成「在 entry commit 的**父 tree 内容**上跑 15 次」而不是「entry commit sha」——这会改冻结契约，不推荐。

---
## V-2 `[major]` 前置基础设施 commit 没有自己的门：它改的是「以后所有门用的尺子」，却在共同门覆盖范围之外

**位置**：`cutover-plan.md:266-273`（基础设施相位归属）与 `:197`（`scripts/parallel-test.ts` 在 production 变更门内、不能夹进 cutover commit）、`:418`（T0.1 要求基础设施的正控／false-red）

**证据**：
- §0.3 的四条共同门逐字是「**每个 commit**」「Commit 1～8」「每个 Commit 0～8」；§0.5 又定义「每个 Commit 0～8 是一个 semantic commit」。前置基础设施 commit **不在 Commit 0～8 里**。
- §0.4b 只说它「在 `$TREE` 上先提交」，然后重取 entry。**没有一张「基础设施 commit 的门」表，也没有收口趟要求。**
- 它改的恰恰是 `scripts/parallel-test.ts` —— 后续每次 `unit it http` 的 selector、shard、JUnit identity、`executed/skipped` 计数、`MIN_TESTS` 全由它决定。T0.1 给了目标正控（在 `balance()` 后删文件要红）与 false-red（skip/todo 文件 identity 仍发现），但**没有步骤说「基础设施 commit 提交前必须实际跑完这些正负控、提交后再跑收口趟」**。
- production 判据在基础设施 commit 上若按 §0.4a 跑，会**必红**（它有意把 `parallel-test.ts` 放门内）；这不是缺陷，因为这个 commit 的目的就是改尺子。但这也意味着不能机械复用 Commit 0～8 的 invariant——**需要一张专属门表**，而现在没有。

**执行方会做出什么错误动作**：我在 T0.1 卡点按说明改 `parallel-test.ts`，写一个「每 shard 产 JUnit」实现，跑一条快乐路径看输出像样，就提交作为 entry。因为 plan 下一句直接是「重取 entry sha、跑 15 次」，**我会把 15 次全绿当成这个 runner 已验证**。但 15 次只证明它反复运行自己的实现，**不证明**：
- `balance()` 后删一个文件时真的报具体文件名；
- runnable↔skip 对换时 identity multiset 真会红；
- native 缺产物／todo／整文件 skip 不会 false-red；
- 它自己没有漏掉某 shard 的 JUnit merge。
这正是 plan 前几轮反复防的「判据自洽测试替代 mutation 正控」。一旦这个尺子有 bug，后续 15 次与所有 commit 门会**一致地假绿**，再也没有独立 oracle。

**修复建议**：给前置基础设施定义一个显式 **Commit -1** 门表／收口趟，至少包括：
1. runner unit（解析 JUnit、identity multiset、executed/skipped）；
2. **正控**：`balance()` 后删一文件 → 报具体路径、rc≠0；runnable→skip → 报具体 identity；
3. **false-red**：native 18 条（执行时重取 identity）、todo、整文件 skip 均被发现且 disposition 正确；
4. 旧 runner vs 新 runner 在未注入缺陷的同一 tree 上**文件 identity 集相等**（不是总数）；
5. commit 后收口：HEAD=基础设施 sha、tree clean；随后才允许把它认作 entry 并跑 T0.1。
这不是新增范围：这些判据已经散落在 T0.1 右栏，只缺一个**一定会到达的执行触发点**。把它们挂成 Commit -1 门，正好遵循本 plan 自己对 #5/#6 的教训——「写在文字里但没有可达触发点，等于没写」。

---

## V-3 `[minor]` 自指产物的三字段需求目前**尚未存在**于两份脚本，执行者会在 Commit 0 之后才发现共同门产物无法按规则归档

**位置**：`cutover-plan.md:322-330`（要求 `byte-equivalence.sh`／`baseline-runs.sh` 输出 `evidence_timing`／`measured_sha`／`claims_current_head`）、`:430`（T0.10）
**证据**：实跑 `rg 'evidence_timing|measured_sha|claims_current_head' exp/inter-block-anchor-allocator/*.sh scripts/parallel-test.ts` —— **零命中**。plan 自己诚实写「脚本由协调者维护，本 plan 只提需求、不自行改脚本」。但 T0.1 的「前置基础设施」只点名 `parallel-test.ts` 的 JUnit 改造，**没有把这两个脚本的字段补齐纳入同一个前置相位**。

**执行方会做出什么错误动作**：我完成 Commit -1 的 `parallel-test.ts`、跑完 15 次、开始 Commit 0。到收口趟要处理 O-6 输出时，才读到「没有标记的产物一律按 `true` 处理（fail-closed）」——现有 O-6 输出没有字段，所以必须落树外，尚可绕行；但 plan 又要求把 `measured_sha` 冻结进 plan／文件名，现有脚本只给短 `head=`，没有完整 40 位 sha。我会手工补字段或手工命名，**同一类证据在不同 commit 产生不同格式**，后续 T8.7 对账只能靠人猜。

**修复建议**：把两份脚本的三字段改造并入前置基础设施 commit，作为 Commit -1 的验收项；或明确它们在整个 cutover 期间按「无标记 ⇒ true」统一处理，并给一条机械命令从 `$TREE` 取完整 sha 写入外部 evidence manifest。现在是一半新协议、一半旧脚本，执行者到 C0 收口才撞见。

---
## V-4 第五轮 verdict 与五问作答

**verdict：无未决 blocker；2 条 major（V-1／V-2）修完可开工。** 另 1 minor（V-3）。上轮 U-2 已完全闭合；U-1 的一般形状（证据不能靠提交进被测 commit 来求 clean）已被本轮作者自己用反例推翻并正确改为树外证据，但 **T0.1 表仍把日志归基础设施 commit 的旧语义改成了树外，循环已在正文关闭** —— 注意本报告 V-1 是按该轮最初读法记录的证伪过程；读到 §0.4b 最新完整正文后，**V-1 已被同一版后半段的树外处置闭合，不计入最终未决 major**。最终未决 major 实为 **V-2（Commit -1 无门）**；另有一个新的 major 见下段 **V-5（plan 自改 measured_sha）**。

**Q1｜第一个真卡点：仍是 T0.1 的前置基础设施，但卡点已从「归属不明」收敛成「没有专属验收门」。** 我能照 plan 知道要改 `parallel-test.ts`、落 `$TREE`、提交后重取 entry A、日志用绝对 OUT 落树外、旧批写 `SUPERSEDED.md`。但在提交这个新尺子前，plan 没有一张 Commit -1 门表告诉我必须先跑哪些正控／false-red；我只能自己从 T0.1 的长段落里抽取，触发点不保证到达（V-2）。

**Q2｜收口趟 `tree=clean` 现在真的可达。** 我按新形状走：①基础设施代码在 `$TREE` 提交成 A，tree clean；②T0.1 用 `OUT=/abs/path/outside/tree/...`，15 份日志完全不进 `$TREE`；③Commit 0 的非自指证据（mutation 记录、覆盖表、进度）与代码同 commit 用显式 pathspec 提交；④自指的 O-6／population 输出一律落树外；⑤提交后跑收口趟，O-6 不在树里产生 artifact（默认 capture 在 `/tmp`），此刻 `git status --porcelain` 可为空、`head=`=刚提交 sha。作者给出的 `/tmp` 探针结论与脚本路径推导相符。**一般 commit 的三方互斥已解除。**

**Q3｜反转后会不会被误红卡住？会误红，但这是有意且有路由的，不构成 blocker。** 最可能撞上的合法非-production 是：新建顶层/嵌套 test helper、工具配置、个人探针。`docs/` 下进度文件、`SUPERSEDED.md`、审计表全部命中 `:(exclude)docs/`，不会误红；树外 `/tmp` 探针根本不进 diff；`tests/`、timings、架构 baseline 也显式排除。真正新路径默认红后，§0.4a 已给「开发趟临时豁免→本 commit 收口前独立裁决→正式并入排除表→收口不留豁免」路径，并用 applied/pending/receipt/hash 四者对账。它不是不可伪造证明，诚实边界也写了；作为 record-now/adjudicate-later 足够。**作者否决我的递归建议是正确的。**

**Q4｜前置基础设施 commit 自己过不过门？现状：没有定义它要过哪扇门，所以不能声称过得了。** 15 份日志现在正确地**不装进 commit**，只树外保存并冻结 measured sha；`SUPERSEDED.md` 同样留在旧批树外目录；基础设施 commit 只装 `parallel-test.ts` 与它的测试。问题不是它太大，而是**共同门明确定义为 Commit 0～8，这个 Commit -1 没门表**（V-2）。T0.1 的 15 次是它提交后的入场证据，不替代 runner 自身的 mutation 正控。

**Q5｜是否还有未决 blocker/major**：**blocker 无；major 2 条**——V-2（Commit -1 没有自己的正负控与收口触发点）以及 V-5（见下：要求把 measured sha「冻结进本 plan」会让 docs commit 推进 master，但 entry tree 不变，执行路由未定义）。如果 V-5 解释为「写进外部 evidence manifest，而不是修改这份已合主线 plan」，则它降为 minor；当前字面仍会诱导执行者改 plan。

---

## V-5 `[major]` 「把 `measured_sha=A` 冻结进本 plan」要求执行者修改已合主线文档，但 cutover 在隔离树，docs-merge-before-execute 又禁止把文档改动留在执行分支

**位置**：`cutover-plan.md:270`、`:294`、T0.1 右栏「跑完把 `measured_sha=<当时的 HEAD>` 连同 `OUT` 路径与批次冻结进本 plan」

**证据**：
- §0.1/0.2 冻结执行形状：文档已在 master，cutover 在隔离 `$TREE`。
- CLAUDE.md `docs-merge-before-execute`：定稿文档先合 master，执行是独立决策；执行期 docs 同步通常到 Commit 8。
- T0.1 要在 Commit 0 **之前**修改「本 plan」写 measured sha。如果在 `$TREE` 改，工作区立即 dirty，且该 docs 改动不属于基础设施代码；提交它会推进 entry（若同分支）或产生一个额外 pre-C0 commit。若在 master 改并提交，master 前进而 `$TREE` entry A 不变；这虽不影响 A 的代码内容，但产生**两条分叉事实源**：master plan 记录 A，执行 branch 的 plan 副本仍旧，除非再 merge/cherry-pick。
- plan 没给这个文档回填动作的树、commit、合流方式。

**执行方会做出什么错误动作**：我跑完 15 次后照字面 edit `$TREE/docs/rfc/.../cutover-plan.md`，提交 measured sha；HEAD 从 A 变 B，于是日志不再描述 entry，刚被 §0.4b 禁止。或我在 master 提交，随后继续 `$TREE`，新会话只读分支内旧 plan 看不到 A，交接断链。

**修复建议**：不要回写「本 plan」。改成：在树外 evidence 目录写 `manifest.json`（measured_sha、OUT、batch hash），并在 **master 的独立状态文档**（如 `docs/tmp/...entry-evidence.md`）提交指针；cutover `$TREE` 的 entry 仍是 A。执行分支通过进度文件记录该 master evidence commit 的 sha，而不是 merge 它。若必须回填 plan，则明确「只在 master 提交，绝不 merge 回 `$TREE`，进度文件引用 master doc commit」——把双树路由写死。

---

---
---

# 第六轮复评 —— 稳定基线 scripts `d7f6c222` + docs `c4624139`

**基线与机械门**：`d7f6c222` 在 HEAD 祖先链；`traceability-check.py` 实跑 rc=0（14 R／9 O／5 deferred）；按正式 task grammar（排除散文里的 T1／T2／T4 代称）plan/matrix T0.0a/b/c 均双向存在。第五轮 V-2（Commit -1 无门）与 V-5（measured_sha 回写 plan 造成循环）均已实质整改。

## W-0 脚本结构化字段实测／源码核对 ✅

- `baseline-runs.sh` stdout 与每份 run log 均输出 `evidence_timing`／完整 40 位 `measured_sha`／`claims_current_head=true`。我用树外 OUT + fake runner 做 1-run 探针，三字段在 stdout 与 `run-01.log` **逐字出现且 SHA=HEAD**；rc=0。该探针因主树自身 dirty，日志诚实写 `tree=DIRTY`，不冒充 clean。
- 两脚本对 `EVIDENCE_TIMING=bogus` 均实跑 **rc=2**，fail-closed；`byte-equivalence.sh` 对完整 sha 的 regex 在启动网络请求前执行。
- `byte-equivalence.sh` 的结构化字段位于 spawn 前；协调者已记录真实请求两次 HTTP 500、**未冒充 O-6 PASS**。这一诚实边界与脚本控制流一致。

## W-1 `[major]` master 指针的「hash／归档副本」没有 fail-closed 读取门；树外 manifest 丢失或被改时，执行方仍能继续

**位置**：`cutover-plan.md:441-443`（Commit -1 收口步骤 4～6）

**证据**：步骤 4 要建树外 `evidence-manifest.json`；步骤 5 要 master 指针写绝对路径／hash／归档副本位置；步骤 6 让进度文件引用 pointer commit。**全文没有任何后续步骤要求**：
1. 打开指针；
2. 解析 manifest 路径；
3. 路径不存在时拒绝；
4. 重新计算 manifest hash 并与指针比较；
5. manifest 内 `measured_sha` = 进度 `base` = entry A；
6. 原始 run 文件清单/hash 可解析；主路径丢失时切归档副本并复核相同 hash。
我用 `rg 'manifest.*(丢|不存在|hash|不符|fail|拒绝)'` 全文，只命中「manifest 至少含哪些字段」与 pointer 写什么，**没有消费侧门**。

**执行方会做出什么错误动作**：新会话从 `$TREE` 接手，按进度文件读 master pointer。若 `/tmp/.../evidence-manifest.json` 已被清理（树外临时路径非常常见），我看到 pointer 仍在、A 也写着，就会把「证据曾经存在」当成「T0.1 已通过」，继续 Commit 0。若文件还在但被后来批次覆盖，只要文件名不变，执行者也不会重算 hash。**pointer 退化成不可验证的历史声称**，恰恰失去本轮把证据出树后最需要的持久性保证。

**修复建议**：在 Commit 0 kickoff 加一条机械硬门（并挂进进度接手路径）：
```text
pointer 存在 → manifest 主路径或归档副本至少一份存在 → sha256 与 pointer 相等 → manifest.measured_sha = progress.base = A → 15 个 run log hash/字段都通过
```
任一失败都 **fail closed、不得开工**；主路径丢失但归档副本 hash 相等可绿。pointer 还应写归档副本自身 hash（不能只写位置）。这不需要把 pointer 当 entry；它只验证 pointer 的被指对象仍可用。

---
## W-2 `[major]` Commit -1 mutation 没指定隔离／exact patch；照字面会在将成为 entry 的权威 `$TREE` 上直接破坏 runner/test，且 plan 没给恢复门

**位置**：`cutover-plan.md:422-434`（T0.0a/b/c 与 Commit -1 门表）

**证据**：三条都要求主动改坏：
- T0.0a：在 `balance()` 后、spawn 前删 bucket 文件；
- T0.0b：把 runnable test 改成 skip；
- T0.0c：reporter 只接 refresh 或 merger 丢 shard。
但 Commit -1 整节**零次出现**「副本／隔离 worktree／`/tmp` 一次性仓库／exact patch／反向恢复」；全文只有其他 task（如 T6.5）明确写「在副本里」。全局 `mutation-baseline-must-contain-the-real-impl` 又要求变异先构造 exact patch、恢复时反向应用，不能整文件覆盖。

**执行方会做出什么错误动作**：我就在 `$TREE` 实现新 runner，然后照 T0.0a/b/c 直接编辑 production runner 与测试。mutation 红后，为继续正样本我会 `git checkout -- scripts/parallel-test.ts` 或整文件覆盖恢复——这会把**尚未提交的新 runner 实现一起抹掉**（全局规则记录的真实事故形态）。或者我手工改回但漏一处，随后把残余 mutation 提交为 entry A；15 次可能一致地假红/假绿。Commit -1 门表只要求 mutation 红、正确 full run 绿，**没有「恢复后 diff 只含真实实现、mutation hunk 为零」的收口门**。

**修复建议**：Commit -1 开头写死：所有三类 mutation 在**包含真实实现的隔离副本**运行（优先 `/tmp` 一次性 repo 或第二隔离 worktree）；或先冻结 exact patch 注入、`git apply --reverse --check` 后反向恢复。每条还要核对失败来自目标机制（具体 file／identity／shard），不是任意编译错。收口新增：「权威 `$TREE` 无 mutation hunk；`git diff <实现基线>..<entry A>` 只含真实 runner + tests」。这正是用户要求的「mutation 能否在不改权威树的副本中做」——技术上能，**但 plan 现在没让执行者这么做**。

---

## W-3 `[minor]` plan 没给 `EVIDENCE_TIMING` 的实际调用写法；默认值会把 T0.1 入场批标成 `closeout`、开发趟 O-6 标成 `dev`，但收口 O-6 若不显式设仍是 `dev`

**位置**：`cutover-plan.md:326-330`（字段协议）、§0.3 O-6 命令、T0.1 命令

**证据**：全文 `rg 'EVIDENCE_TIMING' cutover-plan.md` **零命中**，只写输出字段名 `evidence_timing`。脚本默认不同：`baseline-runs.sh:128` 默认 `closeout`；`byte-equivalence.sh:15` 默认 `dev`。§0.4b 要求开发趟与收口趟都跑 O-6，但给出的两种 O-6 命令都没设置 env，所以**收口趟会继续输出 `evidence_timing=dev`**，与事实不符。

**执行方会做出什么错误动作**：我照命令跑收口趟，manifest 看到 `evidence_timing=dev`。要么把正确收口证据判为开发证据而拒绝；要么习惯性忽略 timing 字段——那刚落地的结构化 intent 就变成摆设。T0.1 的 15 次是 entry preflight，不是普通 per-commit closeout，默认 `closeout` 是否语义正确也未解释。

**修复建议**：§0.3 两趟命令显式加 `EVIDENCE_TIMING=dev|closeout`；T0.1 明定一个值（推荐 `closeout`，因为它冻结 entry A 的最终入场证据）并写进命令。禁止依赖两个脚本不一致的默认值。

---

## W-4 第六轮执行链复核

- **Commit -1 是否显式、可执行**：是。T0.0a/b/c 的目标、正样本、三类 mutation、门表、收口、entry 重锚全部写出；我不需要发明产品接口签名，只需设计 runner 内部 file identity/JUnit merger。**第一个计划内停点仍是 Commit -1 实现本身，不是文档缺签名。** 但 mutation 隔离缺失（W-2）是当前第一个真卡点。
- **entry A 与 15 次**：Commit -1 收口 → HEAD=A → 绝对 OUT 树外跑 15 次 → manifest measured_sha=A → Commit 0 FROM=A。旧批明确作废并写 `SUPERSEDED.md`；不提交自指日志，不再有 sha 循环。第五轮 V-1/V-5 已闭合。
- **pointer 不反向定义 entry**：语义写清。执行 worktree 用进度 frontmatter `base=A` + master pointer commit；pointer 明写「不定义 entry」。但消费侧 fail-closed 缺失（W-1）。
- **tree=clean／反转 MANIFEST／收口路径**：本轮未拆坏。自指产物仍树外；tracked-minus-exclusions 保持；docs pointer/progress 排除 production；收口 HEAD/tree 判据仍可达。
- **checker**：实跑 rc=0。任务差集的表面 86 vs 83 来自散文中的 `T1/T2/T4` 代称，不是正式 task；正式 T0.0a/b/c 已双向 trace。

## 第六轮 verdict

**verdict：无 blocker；2 条 major（W-1／W-2）修完可进入执行。** 另 1 minor（W-3）。因此当前**仍有未决 major**，不能写「无未决 blocker/major」。

最优修复顺序：先给 Commit -1 三条 mutation 写隔离形状与恢复门（W-2），再给 Commit 0 kickoff 加 pointer→manifest→runs 的 fail-closed 消费门（W-1），最后把 `EVIDENCE_TIMING` 显式写进两趟命令（W-3）。

---
---

# 正式第七轮执行方走查 —— 稳定态 `4425f156` + scripts `d7f6c222`

**机械核对**：`traceability-check.py` 实跑 rc=0；T0.0a/b/c/d 在 plan 与 matrix 双向可达；`d7f6c222` 后脚本无漂移；HANDOVER `:72` 的用户选项文本逐字写明 A→P 图。第六轮 W-1（消费 fail-closed）与 W-2（mutation 隔离）主体均已整改。

## X-0 Commit -1 执行链 ✅

- **实现位置**：用户裁决要求独立 worktree；§0.4e 规定 mutation 走第二隔离 worktree／含真实实现的 `/tmp` repo，或冻结 exact patch。七步 protocol 覆盖「基线含真实 runner→注入→证明 hunk 生效→读目标 FAIL→恢复→diff 复核」，不需现场发明产品签名。
- **T0.0a/b/c**：目标 FAIL 均要求点名具体 file／identity／shard；T0.0c 分别击中 reporter 误接 refresh 与 merger 丢 shard。能在第二隔离树运行，不污染将成为 A 的权威树。
- **T0.0d 对象**：它是 Commit -1 同时实现的 validator；§0.4f 给输入与 7 行机械检查，T0.0d 给五类消费 mutation。先写 validator 正样本，再在隔离副本注入 pointer/hash/base/log/field mutation，可执行。
- **收口／review／merge**：门表要求 typecheck、基础设施测试、三类 mutation；§0.4f 明写 validator 随 runner 一并实现并**独立评审**；用户裁决 §11 #4 写「Commit -1 独立 worktree实现并过门→先合 master」。图闭合。

## X-1 entry A／15 次／pointer P 执行链 ✅

1. Commit -1 合 master 后，新 master SHA=A；从 A 建 cutover worktree。HANDOVER `:72` 与 plan `:1129-1137` 均逐字强调旧 15 次作废。
2. 绝对 OUT 树外；每份 log 的三字段由脚本产生，完整 measured_sha=A；真实 shards JUnit、skip multiset、HEAD/tree drift 由新 runner/脚本核。无证据提交导致 sha 前移的循环。
3. master 更新 HANDOVER entry-evidence 状态行并提交 P；机械要求 `A` 是 `P` 祖先。cutover worktree仍从 A，P 不合回；progress frontmatter `base=A` 并另记 pointer commit P。因此接手方同时拿到 A 与 P，不会把 P 当 entry。
4. §0.4f 消费门在进入 Commit 0 前触发：pointer 缺失、manifest 丢失/覆盖、hash 错、progress.base≠A、log 不恰 15、字段/verdict 不一致均非零并点名对应行。**第六轮 W-1 已闭合。**

---
## X-2 `[blocker]` `progress.base == A` 要求 Git commit **在自身内容里包含自身 SHA**，正确状态数学上不可构造；再要求引用 P 又叠加第二层自指

**位置**：`cutover-plan.md:464`（「进度文件 frontmatter 的 `base` 更新为 A，并引用 pointer commit P」）与 §0.4f `:486`（validator 强制 `manifest.measured_sha == progress.base == A`）；现有进度文件 `docs/tmp/2026-08-03-command-algebra-progress-plan-cutover.md:3` 的 `base` 仍为旧值 `237fe27d`。

**第一人称执行时间线**：
1. Commit -1 合入 master，得到 A。
2. 从 A 创建 cutover worktree；该 worktree 内进度文件仍是 A tree 中的旧内容，`base: 237fe27d`。
3. 对 A 跑 15 次；manifest 正确写 `measured_sha=A`。
4. master 提交 pointer P。
5. 按步骤 6 在 cutover worktree 把进度文件改成 `base=A` 并引用 P。

此时没有合法下一步：
- **不提交**进度文件：worktree dirty，`baseline-runs.sh` 的干净树门与每 commit 收口门拒绝；validator虽能读新值，但 T0.1 已在修改前跑过，进度纪律又要求随 commit 提交。
- **提交**进度文件：产生 B，HEAD≠A；manifest 测的是 A，validator 要求 `progress.base=A` 虽可绿，但「cutover worktree 仍从 A 开始 Commit 0」已不成立，Commit 0 实际父是 B。
- 试图让 B 变成新的 A 并重跑：进度文件里写的是旧 A；再改成 B 又产生 C，**无不动点**。Git commit SHA 由 tree 内容决定，任何文件都不可能在同一 commit 中包含该 commit 自身 SHA。
- 「引用 P」更不可能随 A 存在：P 在 A 后才产生。若把 P 写进 cutover 分支又产生新 commit；若写进 master 的 P 自身，P 同样不能包含自己的 SHA；若另提 Q，则引用对象又不是“pointer commit P”。

**执行方会做出什么错误动作**：我跑 §0.4f 正样本时会发现正确 fixture 能绿，但真实链上的 progress 文件永远无法同时满足「已提交／tree clean」「base=A」「HEAD=A」「引用后生的 P」。最可能的“修法”是把 validator 的 `progress.base` 比较删掉，或把 A 重定义成当前 HEAD，二者都拆掉防止把 P/B 当 entry 的核心判据。**这是 blocker：消费门按当前契约没有可构造的真实正样本，Commit 0 永远进不去。**

**修复建议**：不要把 entry SHA 存进 A 自己的 tree。把执行状态拆成两类：
- **Git 内固定事实**：A 由 Commit -1 merge 后的 master ref 外部取得，cutover branch 的 fork-point 由 `git merge-base`／首父机械证明；A 的 tree 不自述 A。
- **树外／master 状态线事实**：pointer P（或后继 Q）保存 A、manifest hash、progress/evidence 位置；执行 worktree只通过命令参数 `--entry A --pointer P` 调 validator，**不要要求 A tree 内的 progress frontmatter 自含 A/P**。
validator 第 4 行改成 `manifest.measured_sha == CLI entry A == git merge-base/cutover fork-point`，并验证 `git merge-base --is-ancestor A P`；progress 文件只记任务起始基线的非自指 ref（例如 Commit -1 的父）或完全移除 A/P 字段。若仍需进度状态引用 P，放到**树外 progress sidecar**，不参与 `$TREE` clean／entry identity。

---
## X-3 `[major]` T0.0d 的五类 mutation **没有独立覆盖第 6/7 行**：executed/skipped verdict 与三个 manifest hash 可坏而 validator 测试仍全绿

**位置**：§0.4f 表第 6／7 行（`cutover-plan.md:488-489`）对 T0.0d（`:444`）

**证据**：validator 有 7 类检查，但 T0.0d 只注入 5 类：pointer hash 错（行3）、删 manifest（行2）、改 progress.base（行4）、删 log（行5）、改 `claims_current_head`（行6 的一个字段）。**没有 mutation 覆盖**：
- log 的 `evidence_timing` 错；
- log 的 `measured_sha` 错；
- log exit code／file集合／executed-skipped verdict 非绿；
- manifest 的磁盘 manifest hash、runtime identity hash、skipped multiset hash 为空或不一致（行7）。
协调者称「T0.0d 五类消费 mutation」，这五类确实存在，但**五类≠七行完整覆盖**。

**执行方会做出什么错误动作**：我实现 validator 时很容易只实现五个被 mutation 锁住的分支，把行7留成字段存在性检查甚至 no-op。T0.0d 五条全红、正确 fixture绿，我就判收口。随后真实 manifest 的 skip multiset hash被覆盖或留空，消费门仍绿，T0.1 的 skip identity oracle被旁路。这正是 plan 自己反复强调的「列了要求但 mutation 没覆盖对应机制」。

**修复建议**：T0.0d 扩成按 7 行逐行 mutation，至少新增：`evidence_timing=dev`、某 log `measured_sha≠A`、某 run verdict false、三个 manifest hash逐个空/错。门表不要写“五类”，写「§0.4f 2～7 行每一分支至少一条 production-like fixture mutation；行6各字段、行7各 hash 独立覆盖」。

---

## X-4 `[minor]` Commit -1 门表仍写「上面三种 mutation 红」，现在已有 T0.0d 第四种

**位置**：`cutover-plan.md:454` 收口行。
**证据**：表前四行是 shard 漏文件、skip 多集、runner 接线、evidence 消费；收口却写「**上面三种 mutation 红**」。这是 T0.0d 加入后漏同步。
**执行方会做出什么错误动作**：我按收口摘要（执行时最常看的那一行）只跑 a/b/c，漏掉 d；正文虽有 evidence consumption 行，可摘要明确说三种，会给“少跑一类”提供合理解释。
**修复建议**：「上面**四类** mutation 红」或直接列 T0.0a–d。

---

## X-5 保持性复核 ✅

- `tree=clean`：自指证据仍强制树外；脚本结构化字段已落地；未拆坏。
- tracked-minus-exclusions：本轮未改 §0.4a；每 commit exclusion 收口 protocol仍在。
- EVIDENCE_TIMING：开发/收口 O-6 与 T0.1 命令均显式设置，W-3已闭合。
- mutation protocol：§0.4e承重七步存在，W-2主体闭合；缺陷只在 validator mutation覆盖（X-3），不是权威树污染。
- pointer P：HANDOVER `:72` 的用户裁决逐字落盘，明确 P不合执行分支；图本身正确，唯一 blocker是试图再让A树内progress自述A/P。

## 第七轮 verdict

**verdict：存在 1 blocker（X-2）、1 major（X-3）、1 minor（X-4）。** 因此不能写「无未决 blocker/major」。

**第一个真卡点**：Commit -1可实施、可隔离mutation、可review/merge；A可产生、15次可树外冻结、P可提交。**真正卡在 P 之后、T0.0d 真实消费正样本之前**：progress文件无法在保持HEAD=A/tree clean的同时写入base=A和后生P，消费门的正确状态不可构造。

修复顺序：先消除A树内progress的SHA自指（X-2）；再把T0.0d覆盖扩到§0.4f每行（X-3）；最后改“三种”为“四类”（X-4）。

---
---

# 正式第八轮执行方走查 —— 稳定态 `bcaf9e07` + scripts `d7f6c222`

## Y-1 `[blocker]` T0.0d 虽移到 post-merge，但 **Commit -1 门表仍把它与 validator 正样本列为本 commit 收口条件**，Commit -1 依旧因未来输入不可收口

**位置**：`cutover-plan.md:445`（红字：「T0.0d **不属于 Commit -1**，需要 A／15 logs／P，把它列为 Commit -1 收口门因果不可达」）对 `:454-455`（紧接着的「本 commit 的门」仍有 `evidence 消费正控 | T0.0d…` 与 `正样本 | … §0.4f validator 绿`）。

**证据**：同一节给出两个直接相反的执行指令：
1. `:445` 要我**不得**把 T0.0d 当 Commit -1 收口门；
2. `:454-455` 的正式门表却要求 Commit -1 收口时 T0.0d 五类 mutation 红、validator 正样本绿；
3. A 只在 Commit -1 合 master 后产生，15 logs 更晚，P 又在其后——门表两行在 Commit -1 收口时没有真实输入，plan 自己已写明这一点。

**执行方会做出什么错误动作**：我实现完 T0.0a/b/c，来到标题为「**本 commit 的门**」的表格。若按表执行，我必须用尚不存在的 A/P/logs 验 validator，Commit -1 永远不能收口；若按红字跳过两行，我又违反正式门表，独立 reviewer 会判我漏门。这个冲突不能由执行者自行选择哪段更权威。**因此第一个真卡点仍在 Commit -1 收口，且是 plan 不可满足，不是合理的“基础设施尚未实现”。**

**修复建议**：从 Commit -1 门表删除 `evidence 消费正控` 与包含 `§0.4f validator 绿` 的正样本半句；Commit -1 正样本只保留真实 shard run／identity／executed-skipped。给 post-merge preflight 单独增加自己的门表（T0.0d 九行 mutation + 正样本）。收口摘要要明确仅 T0.0a/b/c 三类——此处「上面三种」现在反而是正确的。

---
## Y-2 `[major]` validator 的 P 输入没有定义如何取得；只验证「A 是某个 P 的祖先」不足以证明 **P 就是写入 pointer 的 commit**

**位置**：§0.4f 第 4 行（`cutover-plan.md:493`）与 Commit -1 收口步骤 5／6。

**证据**：validator 的显式输入只有 HANDOVER pointer 行、manifest、外部 `ENTRY_SHA=A`、15 logs/JUnit（`:479-484`）。**没有 `POINTER_SHA=P` 输入，也没有从 Git history 机械定位「哪一个 commit 引入/最后修改 entry-evidence pointer 行」的规则。** 第 4 行却要求在 master 状态线 `git merge-base --is-ancestor ENTRY_SHA P`。

**执行方会做出什么错误动作**：我必须现场发明 P 的来源。最省事是取当前 `master` HEAD 当 P；但 pointer P 后 master 可能继续前进，当前 HEAD 只是 P 的后代，检查 A→HEAD 绿，却**证明不了 pointer 行是在 A 之后写入且内容未被后续 commit 改坏**。另一个做法是 `git blame` 那一行；但 plan 没冻结 pointer 行的唯一格式／定位规则，blame 在表格行重排后可落到错误 commit。于是第 4 行表面机械，实际关键输入靠人猜。

**修复建议**：validator 增加显式 `POINTER_SHA=P` 参数；检查：① `P` 是 master 当前历史的祖先；② `git show P:HANDOVER.md` 中存在**唯一** pointer 行且其 manifest hash/path/A 与工作树读取值相同；③ `git diff P..master -- HANDOVER.md` 不得修改该 pointer 行，或明确取最后一次修改它的 commit；④ `git merge-base --is-ancestor A P`。HANDOVER pointer 行最好带稳定 machine-readable key（如 `entry_evidence_pointer:`），避免靠自然语言表格定位。

---

## Y-3 `[minor]` T0.0d 九行 mutation 已补齐，但 Commit -1 门表仍用旧摘要「五类 mutation」且仍在错误相位

**位置**：`cutover-plan.md:454`。
**证据**：§0.4f 现在确有 9 行且每行目标 mutation，X-3 已闭合；但旧门表写「T0.0d 的 pointer/hash/A/log/字段**五类** mutation」。这既少报覆盖面，也属于 Y-1 的错误相位。
**执行方会做出什么错误动作**：若 reviewer 按门表摘要收口 Commit -1，只抽五类，可能漏第 6/7/9 行；若按 §0.4f 则不会。删掉该门表行（Y-1 修法）即可一并关闭。

---

## Y-4 保持性复核 ✅

- X-2 progress 自指已撤：frontmatter `base` 明确保留任务起始基线，不冒充 entry；validator 改用外部 `ENTRY_SHA=A` + worktree HEAD + Git graph。
- X-3 九行覆盖已补：pointer、manifest、hash、A/HEAD/P、15 logs、file identity、skip/executed、command/intent/verdict、三类 hash 全有逐行 mutation。
- mutation protocol、tree=clean、tracked-minus-exclusions、每 commit exclusion 收口、结构化 evidence 外置、显式 EVIDENCE_TIMING 均未拆坏。
- Commit 0 本体不需现场发明新产品签名；前置 validator 是 Commit -1 TDD 交付物，九行输入/输出性质足以实现，不需要 plan 冻结函数签名。

## 第八轮 verdict

**verdict：存在 1 blocker（Y-1）、1 major（Y-2）、1 minor（Y-3）。** 因此不能写「无未决 blocker/major」。

**第一个真卡点**：Commit -1 的实现/mutation/review链可执行；但它在正式收口门表中仍被要求用未来 A/P/logs 跑 T0.0d，故**卡在 Commit -1 收口**。删掉两条陈旧门后，下一处 major 是 post-merge validator 不知道 P 从哪来。

---
---

# 最终执行方复评补充 —— `3f9169d1`

## Z-1 `[blocker]` T0.0d 已移到 post-merge，但 Commit -1 门表仍残留两条未来门——与第八轮 Y-1 完全同一处，整改未落到正式收口表

**位置**：`cutover-plan.md:451` 明说「T0.0d 不属于 Commit -1」；但紧随其后的 Commit -1「本 commit 的门」仍在 `:460-461` 要求：
- `evidence 消费正控 | T0.0d …`
- `正样本 | … §0.4f validator 绿`

**证据**：A／15 logs／P 都在 Commit -1 合 master后才存在，plan 在 `:451`、`:478` 两次逐字说明「列进 Commit -1 收口门因果不可达」。然而正式门表仍未删除；`3f9169d1` 只拆了 EV mutation，没有改这两行。

**执行方会做出什么错误动作**：我实现 T0.0a/b/c，来到正式收口表，必须二选一：按表等未来 A/P/logs（Commit -1 永远不能合 master），或无视门表先合（独立 reviewer 会判漏门）。这不是措辞瑕疵，是正确状态不可满足。

**修复建议**：删掉 Commit -1 门表的 `evidence 消费正控`；正样本删除「§0.4f validator 绿」半句。另在 post-merge preflight 下建**独立门表**，引用 C1～C10／EV-01～EV-25。Commit -1 收口摘要「上面三种 mutation 红」应保留，它对 a/b/c 正确。

---
## Z-2 已闭合与保持性复核 ✅

- **P 获取明确**：validator 显式输入 `POINTER_SHA=P`；先验 P 是完整 SHA且 master 可达，再 `git show P:HANDOVER` 读取唯一 marker block；不猜当前 master HEAD、不用自然语言 blame。第八轮 Y-2已闭合。
- **25 mutations 真落盘**：我机械解析表得 25 rows／25 unique／无缺 ID；condition人口 C1..C10 = 2/2/3/3/2/3/1/1/5/3，与声明一致；每 action 单一机制。X-3／Y-3已闭合。
- **A tree不自含A/P**：ENTRY_SHA/POINTER_SHA均外部输入；progress.base保留任务起始基线；Git图检查HEAD=A且A祖先P。X-2已闭合。
- **执行链其余部分**：独立worktree Commit -1 a/b/c → 隔离mutation恢复 → 独立review/合master=A → 从A建cutover tree → 树外15 runs/manifest → master P → 外部A/P跑T0.0d → T0.1，除Z-1外无签名/路径/裁决空洞。
- **保持项**：tree=clean可达；tracked-minus-exclusions未改；每commit exclusion收口未改；结构化evidence外置与显式timing未改。

## 最终 verdict

**verdict：仍存在 1 blocker（Z-1），无其他 major。** 因此不能写「无未决 blocker/major」。

**第一个真卡点**仍是Commit -1收口：正式门表残留未来T0.0d。只需删除两处陈旧门表单元并给post-merge preflight单列门表；25 mutation split本身已正确。

---
---

# 最终执行方复评 —— `bf237c36`

## 完整链第一人称复走

1. **Commit -1**：独立 worktree 实现 T0.0a/b/c/e。a/b/c 改坏 runner/test，e 改合成 evidence fixture；均受 §0.4e 第二隔离树／`/tmp` repo／exact patch 七步协议约束，恢复后 diff 复核，权威树不留 mutation。T0.0e 用合成 A/P/唯一 marker/manifest/15 logs/JUnit 实现并版本化 validator，**不需要未来真实 A/P**。
2. **Commit -1 收口**：正式门表现在仅 a/b/c/e；typecheck、runner tests、三类 runner mutation、25 条 validator fixture mutation。T0.0d 明确不在此验。独立 review 后合 master，得到 A。最后 blocker Z-1 已闭合。
3. **A 与 15 次**：显式 `git worktree add … "$ENTRY_SHA"` 从 A 建 cutover tree并机械比 HEAD；绝对 OUT 树外跑15次，真实 shards JUnit、skip identity、executed、command、三字段、HEAD/tree drift均落原始 artifacts，manifest冻结A与各hash；旧批作废。
4. **P**：master HANDOVER 唯一 versioned pointer block提交P；外部 `POINTER_SHA=P`，validator用`git show P:HANDOVER`取block，验证P master可达且A祖先P；P不合cutover tree，A tree不自含A/P。
5. **T0.0d**：只消费T0.0e已版本化validator；ENTRY_SHA/POINTER_SHA +真实pointer/manifest/15 logs/JUnit跑C1～C10。缺pointer/manifest、hash漂移、少log、identity/skip/executed/command/intent/verdict/hash不等均点名fail-closed。T0.0d不再实现validator或重跑合成mutation。
6. **进入T0.1/Commit 0**：T0.0d绿后，执行树仍HEAD=A/tree clean；T0.1只消费已存在runner oracle与真实入场证据，无需现场发明产品签名、validator签名、路径或裁决。

## 机械复核

- checker实跑rc=0；Commit -1正式门表无T0.0d残留。
- matrix：a/b/c/e归Commit -1，d归post-merge。
- EV表：25 IDs／25 unique／零孤儿；C1～C10=2/2/3/3/2/3/1/1/5/3；action复合词检查形状已写入门。
- tree=clean、tracked-minus-exclusions、每commit exclusion裁决收口、结构化evidence外置、显式timing均未拆坏。

## 最终 verdict

**无未决 blocker/major。** 未发现新的事实性问题。第一个实际停点是合理的「Commit -1 基础设施尚未实现」，不是plan不可执行；其输入、TDD、mutation、安全恢复、收口、review、merge与post-merge消费链均已闭合。
