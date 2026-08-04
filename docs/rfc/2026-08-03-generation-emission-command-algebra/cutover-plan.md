# Cutover 实施计划 —— generation emission command algebra

> **这是三层结构的第二层**（skill `large-refactor` §5）：`design.md` 回答 WHY + 契约，本文回答 HOW + 锚在哪。
>
> ⚠️ **第三层 `prompts/` 尚未产出**（`ls docs/rfc/2026-08-03-generation-emission-command-algebra/` 只有三个 `.md`）。**在它出现之前，本文即最终派发件**——所以 §0.5 的提交与进度纪律写在这里，而不是留给 prompts。若日后补了 `prompts/`，那节应迁过去，本文只留指针。
>
> **本文不冻结任何 RFC 未冻结的签名。** RFC §3 的接口是**草案**（`design.md:146` 逐字写明「本文不伪造这些尚未存在的源码签名」）。凡本文出现形似签名的文字，一律标注「RFC 草案名」或「性质冻结，签名待调查」。写下任何形状前过三问——**它导出了吗 / 调用方拿到什么返回类型 / 那一刻它存在吗**——答不上就只冻结性质 + 列一条调查 task。
>
> **判据细节不在这里。** 「怎么测 / mutation 正控 / false-red 对照」的单一事实源是 `design.md` §10.2 的对应行；归属与可达性的单一事实源是 `traceability.md`。本文每个 commit 的「门」一节**只写 id + 可复跑命令**，两处并存的表必然漂移。

## 0. 使用前必读

### 0.1 只有一棵树了（2026-08-04 起）

**M1 已 merge 进 master**（merge commit `8125f123`），`feat/inter-block-anchor-allocator` 的内容全在主线。**本文此前的「两棵树」口径整体作废**——锚点表不再有「树」列，**所有 `file:line` 一律锚合并后的 master**，本轮已逐条复算。

M1 带进主线的东西（**别以为 master 上还没有**）：`closeAnchorViaOwner`（`src/routes/messages/handler-v4.ts:1105` 定义）、`OwnerRawSink`（`src/lib/pipeline/delivery/types.ts:12`）、`wirePartialDelivery`（`src/lib/history/types.ts:217`）、以及两个**新模块** `src/lib/pipeline/delivery/owner-failure.ts`（导出 `OwnerFailure`／`OwnerTerminalDecision`／`OwnerFailureContext`／`classifyOwnerFailure`）与 `src/routes/messages/owner-failure-settlement.ts`（导出 `settleMessagesOwnerFailure`）。

> 🔴 **`OwnerTerminalDecision` 与本 RFC 要在 Commit 4 引入的 `TerminalEmissionResult` 是竞争抽象**，两者都在 terminal 时刻按 `client-gone`／`session-terminating`／`wire-torn` 分流。**这不是实施者可自裁的合并取舍**，见 §11 待裁项 #6。

**行号会随 master 前进而漂。** 本文所有行号取于 **master `80a4b6fc`**（`src/` 与 `packages/` 自 merge `8125f123` 起未变，实测 `git diff --stat 8125f123..80a4b6fc -- src/ packages/` 为空）。**引用前重取**：

```bash
cd /home/xp/src/copilot-api-js && rg -n '^export interface ClientSink' src/lib/pipeline/types.ts
```

### 0.1a 路径前缀约定（避免踩空）

本仓库有 **9 个 `types.ts`**、2 个 `driver.ts`（`src/lib/pipeline/driver.ts` 与 `packages/foundation/src/sqlite/driver.ts`）、2 个 `session.ts`、2 个 `ws.ts`。本文简写只在下表内成立：

| 简写 | 完整路径 |
|---|---|
| `types.ts` | `src/lib/pipeline/types.ts` |
| `driver.ts` | `src/lib/pipeline/driver.ts` |
| `client-sink.ts` | `src/lib/pipeline/client-sink.ts` |
| `delivery/{types,session,owner-failure}.ts` | `src/lib/pipeline/delivery/…` |
| `keepalive-anchor.ts`／`live-reconcile.ts`／`warmup.ts` | **`src/lib/anthropic/…`**（**不在 `pipeline/` 下**） |
| `messages/handler-v4.ts`／`error-shaping-glue.ts`／`owner-failure-settlement.ts` | `src/routes/messages/…` |
| `{chat-completions,responses,gemini}/handler-v4.ts`、`responses/ws.ts` | `src/routes/…` |

### 0.2 Entry：隔离 worktree，从合并后的 master 起（**已裁决 2026-08-04**）

**用户已裁**：cutover 在**隔离 worktree** 里做，**从合并后的 master 起**，不再有「先合一次」那一步。原待裁项 #4 关闭。

因此**执行形状固定为**：

```bash
cd /home/xp/src/copilot-api-js && git worktree add ./.worktrees/<name> -b <branch>   # 从当前 master
```

后续所有命令绑到该树根，记作 `$TREE`。**这不是可选风格**——共享主树常有并发 agent 的未提交改动（本文写作时 `git status --porcelain` 有 18 行、含 4 个 peer 的 `src/`／`tests/` 改动），而 T0.1 的脚本对脏树是**硬拒**（见 §0.3b）。

### 0.3 每个 commit 的共同门 —— **三个脚本各自怎么绑根，逐个写清**

> 🔴 **这一节是本 plan 最容易造成结构性假绿的地方。** 三条门若跑在 master 而你的代码在 `$TREE`，8 commit × 3 门 = **24 次假绿**，且 Commit 4 那个唯一原子发布点的 O-6 也在其中。**三个脚本的根推导方式各不相同，别假设一致。**

```bash
TREE=/home/xp/src/copilot-api-js/.worktrees/<name>     # 本次 cutover 的 entry worktree
```

**① typecheck 与测试 —— 用 `cd "$TREE"`，它们读 cwd**

```bash
cd "$TREE" && bun run typecheck
cd "$TREE" && FORCE_COLOR=0 bun scripts/parallel-test.ts unit it http
```

**② `byte-equivalence.sh`（= R-11／O-6）—— 它的 `REPO` 由脚本自身位置推导，`cd` 不管用**

`byte-equivalence.sh:5` 是 `REPO="${REPO_OVERRIDE:-$(cd "$DIR/../.." && pwd)}"`，`:123` 用 `bun run "$REPO/packages/cli/src/main.ts" start` 起服务器。**即使 `cd "$TREE"`，跑 `/home/xp/src/copilot-api-js/exp/…/byte-equivalence.sh` 起的仍是 master 的代码。** 两条正确写法：

```bash
# 写法 A（推荐）：用树内那份脚本——REPO 自然推导到 $TREE
cd "$TREE" && exp/inter-block-anchor-allocator/byte-equivalence.sh
# 写法 B：用任意位置的脚本 + 显式覆盖
REPO_OVERRIDE="$TREE" /home/xp/src/copilot-api-js/exp/inter-block-anchor-allocator/byte-equivalence.sh
```

⚠️ **写法 B 有一个必须知道的分裂**：`BASELINE`（`:11` `$DIR/pre-change-wire.sse`）与 `deterministic-hook.ts` 跟着**脚本位置**走，而被测代码跟着 `REPO` 走。**这正是想要的**（fixture 是权威基线，不该随被测树变），但你必须知道它是这样，否则会误以为「树里的 fixture 没生效」。**须打印 `O-6 PASS`、rc=0、fixture blob 不变；禁止 `RECAPTURE=1`。**

**③ `traceability-check.py` 与 `q1-locations.sh` —— 根同样由脚本位置推导，但它们审的是文档**

两者都是 `parents[2]`／`$DIR/../..`。**文档在 master 主线上**（CLAUDE.md `docs-merge-before-execute`），所以这两个**本来就该在 master 侧跑**，不要覆盖到 `$TREE`：

```bash
cd /home/xp/src/copilot-api-js && python3 exp/inter-block-anchor-allocator/traceability-check.py
cd /home/xp/src/copilot-api-js && PHASE=pre exp/inter-block-anchor-allocator/q1-locations.sh
```

（`traceability-check.py` 支持 `MATRIX=`／`DESIGN=`／`PLAN=` 覆盖，只用于把 mutation 正控跑在副本上；`q1-locations.sh` 支持 `DOC=`。**不要**用它们把门指向 `$TREE` 里的文档副本。）

**④ 证明门确实跑在 `$TREE`（Commit 0 必须建立，见 T0.10）**

「我 `cd` 对了」不是证据（user-rule `proving-where-a-command-ran`）。O-6 的 capture 里应能取到 server 进程的可执行路径／cwd，断言它落在 `$TREE` 下；typecheck／测试则可在 `$TREE` 里植入一个**只在该树存在**的哨兵（如一条会失败的临时断言）确认门看得见它，再撤除。

第 ② 条即 **R-11／O-6**，每个 commit 都跑；**本文各节的「门」表只写 id，不重复这四段。** 另外每个 commit 结束还须满足 §7.1 的两条状态断言：本 commit 已激活的 witness 正样本绿、production mutation 红、false-red 对照绿。

### 0.3b `baseline-runs.sh` 的三个硬约束（T0.1 会撞上）

| 约束 | 脚本位置 | 后果 |
|---|---|---|
| **`REPO` 由脚本位置推导**，无 `REPO_OVERRIDE` 旋钮 | `:77` | 必须跑 **`$TREE` 里那份**脚本，否则测的是 master |
| **脏树硬拒 rc=3** | `:115-122` | 共享主树几乎总是脏的；隔离 worktree 天然干净。**`ALLOW_DIRTY=1` 的日志被脚本自己声明「do not satisfy a gate」——禁止用它通过 T0.1** |
| **`OUT_DIR` 已有 `run-*.log` 即 rc=2** | `:106-113` | 重跑要换目录，别往同一个目录里混批次 |

`MIN_TESTS` 无默认值、缺失即 rc=2（`:84-90`），默认 CMD 是 `bun scripts/parallel-test.ts unit it http`（`:80`）。

### 0.4 准备 commit（1～3）的越界判据

RFC §7.4 的两条，**缺一不可**，每个准备 commit 结束时都要跑：

1. `git diff` 中无 production call-site 切换。
2. **存在性分派的解析结果不变**——属性存在性快照逐 commit 比对，快照由 checker 产出而非人工列举，口径覆盖闭包内全部类型、它们的实现对象、以及构造它们的 options 字面量。**理由是实测出来的**：`delivery/session.ts:584-596` 那类 `sink.writeAnchor ?? sink.write` 的分派，只要方法是否存在变了就会改行为，而 call-site 一行不动。

第 2 条的快照工具本身是 **T0.7** 的产物。

### 0.5 提交与进度纪律（`prompts/` 尚未存在，本节代其承载）

**提交**（CLAUDE.md + user-rule `21-git-workflow`）：

- **一律显式 pathspec**：`git add -- <精确路径>`、`git commit -F <msgfile> -- <精确路径>`。**绝不 `git add -A`／`.`／`commit -am`**——`$TREE` 虽是隔离树，但每次 merge 回主线时同样纪律适用，且养成 pathspec 习惯是本项目的硬要求。
- **conventional commits**（`refactor:`／`test:`／`feat:`／`docs:`／`fix:`），**不加模型署名**（无 `Co-authored-by`）。
- **每条 message 点名它对应本文哪一节**（如 `refactor: publish generation authority (cutover-plan Commit 4)`），否则 merged-state review 无法把 commit 与 plan 对账。
- **绝不 `git push`** —— user-rule `never-push--the-user-does-that` 是 `[hard]`。发布是用户的事。
- 每个 Commit 0～8 是**一个 semantic commit**；准备期的中途状态可以先 WIP 提交再整理，但**Commit 4 不许拆**（§7.7）。

**进度文件**（skill `session-closeout` §6b，本 cutover 是它的教科书触发条件——9 个 semantic commit、大量试错、必然跨会话）：

- 路径 `docs/tmp/<date>-command-algebra-progress-<slug>.md`，`<slug>` 由派活方指定、kebab-ASCII，**一 agent 一文件**。
- frontmatter 必含 **`base`（任务起始 SHA）**、分支、worktree 路径、对应 plan 文档，以及拿到后回填的 agent／session id。**缺 `base` 就做不了 `--first-parent` 对账。**
- **只记 git 记不下的三样**：剩余项（带验收判据）／在途意图／已作废的路子。别复述 git log。
- **随每个实现 commit 一起提交。**

> 🔴 **Commit 4 是本 plan 唯一「中断即全丢」的结构**：16 个 task 同属一个 semantic commit，中途按设计**不产生 commit**，所以 git log 上什么都没有。**因此 Commit 4 的进度文件必须逐 task 更新并单独提交**（进度文件在 `docs/tmp/`，与 `src/` 改动分开 pathspec，不破坏「Commit 4 不拆」）。每完成 T4.x 就写一行：做完了什么、下一个 task 需要的前置在哪、已经否掉了哪条路。

---

## Commit 0 — Legacy 基线、旧缺陷 characterization 与 oracle 分型

**目标**（RFC §7.3）：不改 production；冻结 O-1／O-2／O-6 与现有 goldens、搭建 handle-level physical recorder 并自检、把测试面分四类、并把「旧生成 delivery 的完整能力面」按 §7.2 的双向闭包冻结成 A／B／C／D 四集。

### 逐 task

| id | 先写什么失败测试 → 预期怎么红 | 实现什么 → 预期怎么绿 |
|---|---|---|
| **T0.1** | **入场条件，不是测试。** 🔴 **`MIN_TESTS` 不能从待测命令自己取**——那正是脚本 `:23-25` 逐字点名的假绿形态（selector 悄悄缩窄，「实测」出 6800，下限也冻成 6800，此后每次都与自己一致）。**取值路径必须与被测命令不同原理**：<br>① 从**磁盘**枚举 `tests/**/*.{unit,it,http}.test.ts` 得文件集（不经 runner）；② 用 `--reporter=junit`（`scripts/parallel-test.ts:64` 已为刷新计时驱动过它）跑一次，取 **testsuite 名／文件集**；③ **两个集合逐文件比较**——不是比总数，**总数相等而集合不同正是这类退化最可能的形态**；④ 相等后，把该次运行的用例数冻成 `MIN_TESTS`。 | `cd "$TREE" && OUT=docs/tmp/<date>-entry-runs RUNS=15 MIN_TESTS=<③ 通过后取得的数> exp/inter-block-anchor-allocator/baseline-runs.sh`，rc=0 且保存每次原始输出。<br>⚠️ **必须在 `$TREE`（干净的隔离 worktree）里跑**，用**树内那份**脚本（`REPO` 由脚本位置推导、无 override，见 §0.3b）。**`ALLOW_DIRTY=1` 禁止用于通过本条**——脚本自己声明那批日志「do not satisfy a gate」。重跑换 `OUT` 目录。<br>⚠️ **①～③ 就是 HANDOVER T3-b 的 full-suite oracle。** 它落地前，本条只能按缩小版命题引用：「具名命令在同一 commit 上被调用了 15 次，每次带 provenance，自报用例数稳定且高于下限」——**不得表述成「全后端套件已验证」**。<br>**mutation 正控**：让某个 shard 静默少跑若干文件，③ 必须**报出缺失的文件名**（只比总数的版本抓不到）。 |
| **T0.2** | 先把 O-6 脚本在**未改动的 `$TREE`** 上跑一次，确认打印 `O-6 PASS`、rc=0、fixture blob 未变；再注入一字节，确认 rc=9。**这是 false-red／false-green 双向自检，不是形式**——该门此前恒真（脚本覆盖自己的基线、全脚本无 `cmp`），`4f7a3989` 才修好。 | 把这两条写进每 commit 检查清单，绑根方式照 §0.3 ②。**禁止 `RECAPTURE=1`**。<br>**先确认手上是修好的那份**：`grep -c 'O-6 PASS' exp/inter-block-anchor-allocator/byte-equivalence.sh` ≥1（**看文件存在不够**）。 |
| **T0.3** | 写 handle-level physical recorder，**先让它在「什么都没包住」的状态下断言零 direct send**——此时断言平凡为真，是**假绿**。 | recorder 必须包裹 composition root 实际取得的 `stream`／`ws` handle 并**位于 raw emitter 之下**；再加一条 test-only direct-send seam，断言 recorder **确实看得见**绕过 owner 的发送。看不见就说明探测层装错了深度（RFC §10.1「探测深度必须与被测对象对齐」）。**注入 owner 的 test raw adapter 不用于本判定**。 |
| **T0.4** | 对 warmup fake／drop 写真实 route behavior test：断言完整字节、upstream 零调用、delivery observer **零 session**、一次响应。**先在缺失 observer 的状态下跑**，确认「零 session」这条断言此刻还够不到 delivery 层。 | 接上 delivery session observer（`delivery/session.ts:74` 的 `setDeliverySessionObserverForTests`，**已存在，不用自己造**），四条断言转绿；mutation「提前创建 owner」或「双写」必须红。这是 **Q3 已裁方案 A**，是 §5 唯一没有现成 behavior witness 的出口，也是 composition-root 互斥性的 gatekeeper。 |
| **T0.5** | 对 AUQ fallback SSE 与四格式 non-streaming JSON 各写一条 route observer 基线：断言该 operation 零 delivery owner、完整响应只写一次。**先构造「提前创建 owner」的 mutation 确认它会红**。 | 基线转绿。注意 AUQ 的正确状态是 **upstream／ctx 可能已存在但 client wire 未 commit**——不得把「有 upstream」误判成「有 owner」。 |
| **T0.6** | 🔴 **本条的形状被重写过，别照「提交一个红测试」执行**——那与共同门「`unit it http` 确定性全绿」**终态互斥**（RFC §7.1 同样要求每 commit 全绿）。<br>**正确形状：写一条进程退出码为 0 的 characterization test**，它**断言旧缺陷被稳定观察到**：让一个与 active anchor index 同字节的 stop 走普通 generic `write`，然后断言「wire 已 closed **且** owner lease 仍 open」这一分裂**确实发生**。**测试绿 = 缺陷在**。<br>**先把断言写反**（断言 lease 已被清除）跑一遍确认它红——否则这条 characterization 可能根本没触达那条分裂。 | 转绿（`rc=0`），并在测试文件头**落盘三样**：①它守的是什么（R-3 的旧缺陷现状）；②**它为什么现在是绿的**（绿 = 缺陷仍在，不是「已修」）；③**何时必须反转**——Commit 4 的 T4.5／T4.7 把 authority 发布后，本测试**必须**改成相反的正确性断言，届时「维持原样仍绿」即说明 authority 没生效。<br>⚠️ **不得用 `skip`／`todo` 把它排除出默认发现集**——那样 R-3 的 C0 辅助门可被假绿（跳过的测试永远不会告诉你缺陷是否还在）。 |
| **T0.7** | 实现 §7.2 的**双向不动点闭包**并先跑一次：种子 = §7.2 列出的 6 个 capability 类型（**按 declaration identity 取，不按文件路径也不按名字文本**）；向上（消费者）+ 向下（成员，含**声明**的参数与返回类型）交替迭代。**先构造一个反例确认判据有牙**：`createGenerationWireIndexAllocator()` 零参数、返回类型不是种子——只做向上方向时它与调用点 `messages/handler-v4.ts:1160` 都进不了闭包，**必须**由向下方向捞进来。 | 输出完整 symbol hit set（不是数字），再切成互不相交的 A／B／C／D 四集。四条结构停止点写死（原始／内置类型、`node:`、`node_modules`、别名解析后判断），`any`／`unknown` **不是停止点**、落入 unclassified 并具名 disposition。C／D 相交时按 §7.2 tie-break：**construction／resolution 语义优先归 C，有疑义入 C**。任何 export／production reference 既未进 A／B／C、也未被具名判为合法 pre-owner／test-only，**Commit 0 与 Commit 4 均 fail loud**。 |
| **T0.8** | 把测试面分四类（owner-backed array adapter／raw transport 字节与 observation unit／owner→adapter seam／**test-only adversarial 旧边界正控**）。**先验证第四类真的还能在旧边界造出 wire／state 分裂**——造不出来说明它已经被「合法化」掉了，那正是 R-10 要防的。 | 四类分档落盘。<br>⚠️ **口径数字（92 fake 构造点／40 文件、57 编译期 sink API 依赖文件、65 raw factory 调用／14 文件）来自 `docs/tmp/2026-08-03-emission-surface-inventory.md` §9，锚在 `854421d4`（= 合并前的 feature `src/`，与今日 master 的 `src/` 逐字节相同，但 `tests/` 已随 merge 变化）。本 task 必须在 `$TREE` 上重算这三个数并记差异**，别照抄。<br>**不得机械把所有 fake 改成合法 owner 路径后丢掉 positive control**。 |
| **T0.9** | 冻结现有 anchor／terminal goldens 的文件清单与当前哈希；对每份写明它锁的是什么。**先挑一份注入帧重排，确认它会红**——不会红的 golden 是摆设。 | 清单落盘，作为 Commit 4 「Q5 逐帧预测 diff」的比对基座与 Commit 7 审计对象。 |
| **T0.10** | **证明门跑在 `$TREE`**（§0.3 ④，user-rule `proving-where-a-command-ran`）。**「我 `cd` 对了」不是证据**：先在**不做任何绑定**的情况下跑一次 O-6，确认它起的是 master 的 server——这就是 F-1 那 24 次假绿的实物。 | 建立取证步骤：O-6 的 capture 里断言 server 进程的可执行路径／cwd 落在 `$TREE` 下；typecheck／测试则在 `$TREE` 里植入**只在该树存在**的哨兵（一条会失败的临时断言），确认门看得见它，再撤除。**这一条建立的是「门跑在正确的树上」这个前提本身的 oracle**——没有它，后面 8 个 commit 的所有绿都没有归属。 |
| **T0.11** | **test-oracle manifest**（T6.5 的 coverage gate 依赖它，见 §Commit 6）。**先确认默认 runner 对「删掉一条测试」是绿的**——那正是 T6.5 的 mutation 需要被咬住的形态。 | 冻结三样并落盘：①四类分档里 **adversarial 旧边界正控**的测试**文件路径**；②这些文件**运行时枚举**出的 test name 集合（**用 `--reporter=junit` 取，不用 `rg` 扫 `test("...")`**——后者对参数化与模板名结构性失明）；③该 seam 依赖的 production symbol identity。<br>锚点：`tests/pipeline/allocation-outside-owner-control.it.test.ts`（已存在）。 |

### factory／锚点表

> 全部锚 **master `80a4b6fc`**（merge 后），路径简写见 §0.1a。

| 符号 | `file:line` | 在本 commit 的用途 |
|---|---|---|
| `ClientSink` | `types.ts:747` | 闭包种子 |
| `OwnerRawSink` | `delivery/types.ts:12` | 闭包种子（M1 引入） |
| `AnchorState` | `types.ts:529` | 闭包种子 |
| `GenerationWireState` | `types.ts:496` | 闭包种子 |
| `WireBlockAllocationPort` | `types.ts:319-332` | 闭包种子；五方法 + `wireState` |
| `DownstreamDeliverySession` | `delivery/session.ts:57-67` | 闭包种子；public 面 9 项 |
| `GenerationWireIndexAllocator` | `types.ts:504` | **T0.7 的向下方向反例**：它只是 `GenerationWireState` 的一个属性 |
| `createGenerationWireIndexAllocator()` | `keepalive-anchor.ts:52` | 同上，零参数工厂，只做向上会漏；调用点 `messages/handler-v4.ts:1160` |
| `createGenerationWireState(allocator)` | `keepalive-anchor.ts:44` | 对照组：**因返回种子**而会进闭包 |
| `WireBlockMapping` / `LegToken` | `types.ts:477` / `:474` | §7.2 明确点名：它们是 C10／C3 的授权事实本身，**不得被「无能力」过滤器排除** |
| `OwnerFailureReason` | `types.ts:295` | `client-gone`／`session-terminating`／`wire-torn`；`OwnerTerminalDecision` 的输入 |
| `classifyOwnerFailure` / `OwnerTerminalDecision` | `delivery/owner-failure.ts:41` / `:11` | **M1 新模块**，与 Commit 4 的 `TerminalEmissionResult` 竞争，见 §11 #6 |
| `settleMessagesOwnerFailure` | `messages/owner-failure-settlement.ts:4` | 同上；直接调 `env.ctx.abort`／`env.ctx.fail` |
| `setDeliverySessionObserverForTests` | `delivery/session.ts:74` | **T0.4／T0.5 的 observer 接入点** |
| warmup 三个 direct write | `warmup.ts:214,230,243` | T0.4 被测对象 |
| AUQ direct write | `error-shaping-glue.ts:131` | T0.5 被测对象 |
| raw SSE physical `stream.writeSSE` | `client-sink.ts:209` | T0.3 recorder 必须**位于它之下** |
| raw WS physical `ws.send` | `client-sink.ts:645` | 同上 |
| adversarial 旧边界正控 | `tests/pipeline/allocation-outside-owner-control.it.test.ts` | T0.8 第四类／T0.11 manifest |
| 8 个 sink 构造点 + 2 个 Anthropic 接线点 | 见 §Commit 4 锚点表 | T0.3 recorder 包裹点 |

### 本 commit 的门

| id | 段与等级 | 可复跑命令 |
|---|---|---|
| R-13 | C0 `production 硬门`（Q3 已裁 A） | 见 T0.4／T0.5 落盘的测试路径 |
| R-1 | C0 `辅助门`（recorder 自检） | 见 T0.3 |
| R-3 | C0 `辅助门`（旧缺陷 characterization，**绿=缺陷在**） | 见 T0.6 |
| R-11 / O-6 | 每 commit 共同门 | §0.3 ② |

### commit invariant

production 源码与运行时行为**逐字节不变**（`git diff -- src/ packages/` 只允许为空）；A／B／C／D 四集全部原样存活；新 core 不存在；**T0.6 的 characterization 绿**（绿 = 旧边界的 wire／lease 分裂仍在，其头部三样已落盘）；typecheck 绿、`unit it http` 确定性全绿、O-6 PASS；**T0.10 已证明这三条门跑在 `$TREE`**。

---

## Commit 1 — Capability types 与 profile registry 准备

**目标**（RFC §7.4）：增加 discriminated profiles、command input／result types、`openMessageEnvelope`、`runEmissionBatch`、typed terminal result、validated envelope type 与 compatibility registry；选定「先 narrow profile 再 factory」或经 PoC 证明的 owner top-level discriminant。**不创建 production owner、不改 outer roots／driver／handler 参数、不注册 timer／sampling。**

### 逐 task

| id | 先写什么失败测试 → 预期怎么红 | 实现什么 → 预期怎么绿 |
|---|---|---|
| **T1.1** | compile fixture **正样本**：四类 non-Anthropic concrete profile 调 `emitGeneric`／`emitKeepalive`／`terminate`，Anthropic concrete profile 调 common 与每个 indexed command。**先在类型不存在时跑 `tsc`，确认红。** | 按 RFC §3.2 加 `AnthropicDeliveryProfile` 等五个 profile 与 `FormatDeliveryProfile` union，`indexedBlockLifecycle` 是 **compile-time discriminant，不是 runtime feature flag**，所有 profile 必须显式给值。`tsc` 转绿。 |
| **T1.2** | compile fixture **负样本**：在 Responses HTTP／Responses WS／Chat Completions／Azure／Gemini owner 上分别引用 `openAnchor`／`openRealBlock`／`writeRealBlockFrame`，由 `@ts-expect-error` 锁定 property 不存在。**先确认移除注解时 `tsc` 必须失败**——否则这条 fixture 什么都没测。 | 按 §3.4 的 `CommandsFor<P>` 条件类型收窄，负样本转绿。 |
| **T1.3** | **判别正控**：故意把 factory 返回值退化成共同大接口，负样本必须因「unused `@ts-expect-error`」或显式 compile-failure harness **转红**。再写 union profile 正负样本：未收窄的 `FormatDeliveryProfile` 不能取得 indexed port；先 `profile.indexedBlockLifecycle === "anthropic"` 收窄再调 generic factory，所得 owner 的 indexed command 必须 compile-green，`none` 分支仍 compile-red。 | 保留 §3.5 的**反例锁定**：factory 先接 union profile、再检查嵌套 `owner.profile.indexedBlockLifecycle` 的样例**必须保留为 compile-red characterization**（该路径已被 TypeScript 5.9.3 PoC 证否）。**不得用 `as AnthropicGenerationCommandPort` 作正确样本。** |
| **T1.4** | classifier 三态 unit：①structured payload parse failure 在 external write 前拒绝；②已登记为 owner-governed／terminal／indexed-block 的 effect 误走 generic → `CommandEffectMismatchError`；③payload 可解析但 effect 未登记 → **按 richest-data-flow 默认允许发送**，`actualEffect=unknown`，原始 type／frame detail 进 trace／History。**第三态先写成「拒绝」跑一遍确认它会红**——默认拒绝是最容易写错的方向。 | 三态转绿。**未知 effect 不是已知 generic 的证明，也不是默认拒绝理由。** |
| **T1.5** | command input／result types、`ValidatedDeliveryEnvelope`、`command × profile` compatibility registry 的 unit：断言 envelope 至少保留 §2.2 冻结的性质集合（原始 frame、`command`＋per-operation 唯一 `commandId`、format profile、expected／actual effect、owner-minted provenance、target kind、authorization 引用的 wire index／leg kind／owner state version、candidate／dispatch identity、observation time、C9 committed、compound phase）。 | 转绿。**这些是最小性质集合，不预先规定扁平字段／嵌套对象／opaque token**——具体形状由 T3.1 沿真实 caller 调查后定。 |
| **T1.6** | `openMessageEnvelope`／`runEmissionBatch`／typed `TerminalEmissionResult` 的**类型层**存在性与 `terminalFrameDisposition` 三态（`emitted` / `suppressed_client_gone` / `suppressed_session_terminating`）穷尽性 unit。 | 转绿。**`finalize(result)` 只能消费本 owner 签发的 opaque result**——类型层先把「无 result 时只允许 client-aborted／零 terminal-frame 分支」表达出来。 |
| **T1.7** | 属性存在性快照工具（§0.4 第 2 条）在 Commit 0→1 之间跑一次。**先手工加一个 optional 方法确认它会红。** | 快照相等，rc=0。 |

### factory／锚点表

| 符号 | `file:line` | **树** | 用途 |
|---|---|---|---|
| `ClientFormat`（四值 union） | `src/lib/pipeline/envelope.ts:21` | 两树同行 | profile discriminant 的 `format` 取值来源 |
| `FormatCodec` | `src/lib/pipeline/types.ts:949`（master）／`:948`（feature） | 两树 | RFC §2.6 的既有格式抽象；本次沿用「格式方提供知识、driver／delivery 消费窄口」的依赖方向 |
| `DeliveryTerminalCommand` | `delivery/types.ts:60`（master）／`:69`（feature） | 两树 | 迁移**输入**；其 `frames?: ReadonlyArray<DeliveryFrame>` 允许 caller 提交已铸 provenance，**不能原样成为终态公共签名** |
| `ClientBlockLedger` | `delivery/types.ts:28`（master）／`:37`（feature） | 两树 | observation 层既有形状，T1.5 的对照 |
| `WireBlockAllocationPort` 五方法 | `types.ts:309-322`（master）／`:319-332`（feature） | 两树 | **被替换的双面能力**，不是可继续扩展的终态 |

> **调查任务（本 commit 内必须回答，答不上就只冻结性质）**：`makeDeliverySseSink`／`makeDeliveryWsSink` 当前都是 exported function 且返回静态 `ClientSink`；新 composition factory **是否需要 export**、哪些调用方拿 `GenerationDeliveryOwner<P>`、哪些只拿 `CommandsFor<P>`——RFC §9.3 第 1 项，**最终证据槽在 Commit 4 publish kickoff**，Commit 1 只取最小子集。

### 本 commit 的门

| id | 段与等级 | 可复跑命令 |
|---|---|---|
| R-6 | C1 段，**等级未定见 §11 待裁项 #1** | `bun run typecheck` + compile fixture harness（T1.1～T1.3） |
| R-2 | C1 `辅助门`（classifier 三态 unit） | T1.4 落盘的测试路径 |
| R-11 / O-6 | 每 commit 共同门 | 同 §0.3 |

### commit invariant

旧 API population 与 Commit 0 **机械相等**（A／B／C／D 四集逐 symbol 相等）；**存在性分派解析结果不变**（T1.7 快照相等）；`git diff` 无 production call-site 切换；所有新代码只被 compile fixture 与 direct unit test 引用；typecheck 绿、全套绿、O-6 PASS。若 `git diff` 出现 production call-site 切换，**本 commit 越界，重排而非放宽**。

---

## Commit 2 — Owner state、serializer 与 coordination primitives 准备

**目标**（RFC §7.5）：实现 private authorization registry、`OpenAnchorLease`、cardinality assertion、non-enqueue internal command primitives、owner serializer、`runEmissionBatch`、`terminate`／`finalize(result)` 状态机和 raw emitter 接口，**但不把它们接入 production roots**。

### 逐 task

| id | 先写什么失败测试 → 预期怎么红 | 实现什么 → 预期怎么绿 |
|---|---|---|
| **T2.1** | owner private authorization registry 与 `OpenAnchorLease` 的 unit：断言 record identity 与授权字段**不可变**（除 `lastPulseAtMonotonic` 随成功 pulse 更新外），lifecycle 只由 owner commands 创建／读取／清除。**先写一条「caller 传回 lease token 即可关闭」的测试确认它被拒绝**——lease 默认**不**暴露成 caller 必须传回的 public token。 | 按 §4.1 的性质草案实现（`generationIdentity` / `wireIndex` / `leaseId` / `anchorKind` / `openedAtMonotonic` / `lastPulseAtMonotonic`）。caller 只能说「关闭当前 open anchor」，owner 在 serialized command 内读 private current lease。**单靠 TypeScript brand 不算数**——`as`／同构 interface 即可绕过，必须有 runtime identity 校验。 |
| **T2.2** | **authorization／observation 双层分离**的 unit，四条 mutation（§4.3）：①把 `pulseOpenBlock` 改成从 post-wire ledger 选 target，构造「ledger 仍有该 block 历史记录、但真实 block stop 已成功、mapping 已释放」的状态 → 正确实现必须拒绝／返回 `none`；②注入一个被 observation 看见但从未进 mapping／lease registry 的 block frame → 所有 indexed commands 仍须 fail loud 或返回无 target；③阶段 A 失败 → wire 零 attempt、reservation rollback、lease 与 mapping 不变；④首次 physical send 后失败 → attempt／partial diagnostic 保留、已 commit index 不复用。**每条 mutation 先跑，确认它真的红。** | 双层分离转绿。**类型上分成不同 private fields 只算 presence ratchet**，本条要的是行为 witness。 |
| **T2.3** | cardinality assertion 的**辅助**正控（§4.4）：用 **test-only 预损坏 state** 造「同一 wire index 同时命中 anchor lease 与 real mapping」以及「两个 real mappings 同 index」，断言抛具名 `AuthorizationCardinalityError`（RFC 草案名）、零 wire 副作用、reservation rollback、lease／mapping／frontier 保持阶段 A 进入前状态。 | 检查放在**每个**可能创建、查找、pulse、close 或释放 indexed authorization 的 command 阶段 A：lifecycle preflight 之后、第一次 external write 之前。输入必须来自 **owner private registries 的完整 population**，不得只查当前 leg 或先 anchor 后 mapping 短路。compound close→real-start 要对「关闭前 active 集合」与「按预验证顺序应用后的拟议集合」**都**验证。<br>⚠️ **本 task 只是辅助门。** production 双命中 mutation 在 cutover 前**不可达**（`withAllocatedRealBlock`／`writeBlockFrame` 当前零 production 调用者，`design.md:378`），硬门在 T4.9。**test-only 预损坏 registry 不能替代 Commit 4 production witness，也不得把测试直接 `Map.set` 后抛错冒充最终 behavior oracle。** |
| **T2.4** | owner serializer 与 non-enqueue internal command primitives 的 unit：断言所有 commands 共用**一个** serializer，且 internal primitive 不重复入队（否则 compound command 会自死锁或产生第二个排序点）。**先写一条「在已持锁时再入队」的测试确认它当场炸**——不许改用可重入锁把自锁掩盖过去。 | 转绿。 |
| **T2.5** | `runEmissionBatch` 的 unit：断言在**一个** serializer callback 内完成「suspend heartbeat → 全量 build／validate → 顺序执行一批 commands → fresh interval 重臂」；若 batch 含 terminal 则**不得**重臂。**先写一条「caller 直接拿到 timer 控制方法」的测试确认它拿不到。** | 转绿。它替代 caller 直接 `freezeHeartbeat`／`suspendHeartbeat`／`resumeHeartbeat`。 |
| **T2.6** | heartbeat **unpark 活性对照**（RFC §10.1 硬性要求）：在**不 park** 的对照中推进 N×interval，断言恰有 N 个 keepalive。**这条必须先于任何 parked 否定断言**——没有它，「parked 后没有插帧」可能只是 timer 根本没触发的假绿。 | 活性对照转绿；再写 parked unit tests 断言 suspend 阻止插帧、terminal 后不复活、`freeze→close` 与「恢复 raw timer」「双 timer」mutation 必须红。 |
| **T2.7** | `terminate`／`finalize(result)` 状态机 unit：断言 first terminal command wins、terminal frame exactly once、`finalize` 只 seal／callback once **且不是第二个 emission 入口**。**先写一条「finalize 发帧」的 mutation 确认它红**；再写一条「无 result 调 finalize」确认只有 client-aborted／零 terminal-frame 的显式分支被允许。 | 转绿。**`terminate` 不调用 ctx settle、不运行 delivery-finalized callback**——顺序 `anchor balance／terminal attempt／sampling → recordForwarded → ctx.fail／complete → finalize` 由 route 保持。 |
| **T2.8** | raw emitter 接口的 unit：断言它**只**消费 owner-validated envelope，不接收公开 `ClientFrame` 作为 generation 发送入口；且它不决定业务 intent、block authority 或 provenance。 | 转绿。**本 commit 不调用它**（production 不构造新 owner）。 |
| **T2.9** | 属性存在性快照（§0.4 第 2 条）在 Commit 1→2 之间跑。 | 快照相等，rc=0。 |

### factory／锚点表

| 符号 | `file:line` | **树** | 用途 |
|---|---|---|---|
| `openAnchorIndex`（裸 number） | `types.ts:486-493`（master）／`:496-502`（feature） | 两树 | **被 `OpenAnchorLease` 取代的现状**：裸 index 回答不了「属于哪个 generation／哪一次 anchor／是否仍 current」 |
| owner close 读写 `openAnchorIndex` | `delivery/session.ts:422-430`（feature） | feature | T2.1 的现状对照：读 index，physical write 成功后清成 `undefined` |
| generic `write` 只更新 ledger／clocks | `delivery/session.ts:127-137`（feature） | feature | **D1 的分裂证据**：它**不**清 `openAnchorIndex` |
| `ClientBlockLedger`（observation） | `delivery/types.ts:28`（master）／`:37`（feature） | 两树 | T2.2 双层分离的 observation 侧既有形状 |
| owner serializer 现状（`write` → `writeToSink`） | `delivery/session.ts:127,131,334`（feature） | feature | T2.4 的迁移起点 |
| heartbeat 三个 producer | `delivery/session.ts:175`（content frame）、`:184`（`injectContentScaffold`）、`:209`（`injectScaffold`）、`:219`（normal ping） | feature | T2.6 被测对象；inventory §13 已单列这四个 **owner-internal producer** |
| `DeliveryHeartbeat` | `delivery/types.ts:46`（master）／`:55`（feature） | 两树 | 含 `injectScaffold`；§7.2 点名它是闭包 sanity 成员 |
| `OwnerResult` 三个失败 reason | `delivery/session.ts:300-309`（feature） | feature | `client-gone` / `session-terminating` / `wire-torn` 生命周期失败通道。**`AuthorizationCardinalityError` 与 `CommandEffectMismatchError` 不走这条通道，直接 throw** |
| commit point（`committed` 翻转） | `delivery/session.ts:323-354`（feature） | feature | C9 现状；T2.2 ③④ 的注入点 |

> **调查任务（RFC §9.3 第 6 项，证据槽在 Commit 5 之前，但 T2.x 需要最小子集）**：per-command rich records 的 request-scoped owner 是 `PipelineInfo` 新字段、独立 History detail 还是 ctx snapshot；settle 冻结点在哪。**答不上就只冻结「owner 先保留 rich command observations、sink 在末端投影、成功与失败走同一 normalizer」这三条性质**，不写字段表。

### 本 commit 的门

| id | 段与等级 | 可复跑命令 |
|---|---|---|
| R-5 | C1 段 `辅助门`（**test-only 预损坏 state**）在 T2.3 落地 | T2.3 落盘的测试路径 |
| R-11 / O-6 | 每 commit 共同门 | 同 §0.3 |

> R-5 的 C1 辅助门段在**本 commit**（Commit 2）实现，因为 cardinality assertion 属于 owner state primitives。矩阵把它记在 C1，**这不是错配**：矩阵的「归属 commit」指该门**最早生效**的边界，而 Commit 1 与 Commit 2 之间旧 API population 机械相等、行为等价，门在哪一个准备 commit 落地不改变可达性。**若评审认为这构成漂移，按 §11 待裁项 #5 处理，别自行改矩阵。**

### commit invariant

production **不构造新 owner**；**不维护 shadow lease／mapping／ledger、不启动 heartbeat、不调用 raw emitter**（RFC §7.1：authority 发布前新 core 不得 shadow-send／shadow-sample／维护 shadow authorization 或启动 timer）；旧 API population 与 Commit 0 精确相等；新 core 只由 test adapter 直接驱动；typecheck 绿、全套绿、O-6 PASS。

---

## Commit 3 — Producer builders、LegHandle 数据流与 publish harness 准备

**目标**（RFC §7.6）：增加各 profile 的 pure classifiers／builders、producer-to-command 转换 helpers、candidate binding 中的 opaque LegHandle 承载、10-root cutover harness 与 test-only handle recorder；**所有 helpers 尚未被 production roots 调用**。

### 前置调查（RFC §7.6「前置调查」＋§9.3）

**到达本 commit kickoff 时先读证据槽；没有 `file:line` 或 PoC 结论，就交付已完成部分与具体问题、结束本轮，不生成猜测签名。**

| # | 缝 | 本 commit 需要的最小子集 | 完整证据槽 |
|---|---|---|---|
| 1 | composition factory 是否导出、谁拿 owner 谁只拿 command port | 够 builders 与 harness 编译 | C4 publish kickoff |
| 2 | HTTP／WS runner 的 typed operation result；WS close intent 产生时是否已具备 keep-open／code／reason | 同上 | C4 publish kickoff |
| 3 | 每个 indexed command 调用时 producer 实际持有的 format-native data／handle／builder 是否已 export | **本 commit 承重**（T3.1／T3.3） | C4 publish kickoff |
| 4 | Responses output-item boundary 的精确 effect taxonomy | **本 commit 承重**（T3.2） | C4 publish kickoff |
| 5 | production authorization 双命中 mutation 的精确注入点 | 记录候选 | C4 publish kickoff |
| 7 | C4 authority publish 的逐点可表达性（五类 handler、8 个 handler anchor terminal-close、2 个 driver） | **本 commit 承重**（T3.5） | C4 publish kickoff |
| 8 | raw factory test imports 迁 test-only entrypoint，65 个 raw factory tests 仍覆盖 transport bytes | 记录迁移方案 | C4 publish kickoff |
| + | already-rendered builder / LegHandle / heartbeat 逐点映射 | **本 commit 承重**（T3.3／T3.5） | C4 publish kickoff |

### 逐 task

| id | 先写什么失败测试 → 预期怎么红 | 实现什么 → 预期怎么绿 |
|---|---|---|
| **T3.1** | 各 profile 的 pure builders 与 classifiers，用**真实 vendor bytes** 做 unit／SDK 校准。**先用一份合成 fixture 跑通、再换成真实上游字节确认它仍绿**——合成 fixture 与 builder 共享同一份错误假设时会一起绿（RFC §11.1）。 | builders 转绿。**转发腿的 producer 谓词与 classifier 若共享谓词，两侧会共因判绿**——因此本 task 的绿**不计** behavior 闭合，兜底由 O-2 状态机／wire golden／真 SDK 承担（见 T4.13）。 |
| **T3.2** | Responses output-item boundary 的 effect taxonomy：从 **HTTP／WS renderer、terminal fixtures 与真实 client oracle** 推导完整 expected-effect 集合。**先按 RFC §3.6 那句话臆造一个 event 枚举跑一遍，确认它对不上真实 renderer**——RFC 明确禁止照那一句话猜。 | taxonomy 落盘 + unit 转绿。RFC 只冻结「由 Responses profile 明确分类，不创建 Anthropic allocator」。 |
| **T3.3** | opaque LegHandle 在 candidate binding 中的承载：按 **5 个 production `beginLeg` lexical sites × 3 种 leg kind（primary／continuation／recovery）× 4 种 source scenario（sole primary／hedge winner／continuation／recovery）** 逐格写数据流断言。**先写一格「hedge winner 是第四种 leg kind」的错误映射确认它红**——RFC §9.3 第 3 项明确：**hedge winner 属于 primary kind，不是第四种 leg kind**。 | 3 kinds × 4 scenarios × 5 sites 的映射矩阵落盘、unit 转绿。**owner 能从 state 推导的字段不得重复让 caller 提交。** |
| **T3.4** | producer-to-command 转换 helpers 的 unit。**先写一条「helper 接收或返回闭包内任何符号」的检查确认它红**——准备期新增声明**不得**把闭包内任何符号放进签名（RFC §7.2 表，注意是「闭包内任何符号」而非只有种子类型）。 | 转绿。 |
| **T3.5** | 逐点可表达性演练（§9.3 第 7 项）：五类 handler、**8 个 handler anchor terminal-close 决策 + 2 个 driver 决策**如何产出 `TerminalEmissionResult` 并保持顺序；`terminalFrameDisposition` 三态如何映射原 client-gone／session-terminating 提前返回；driver 所有 `freezeHeartbeat`／`suspendHeartbeat`／`resumeHeartbeat`／`close` 如何映射到 `runEmissionBatch` 或 terminal。**任何无法表达的点都使 Commit 4 停门**（§7.13），**不得反向调用 legacy writer**。 | 逐点映射表落盘。**还须逐 tick 比较旧／新重臂时点并输入 Q5 diff**（T4.1）。 |
| **T3.6** | 10-root cutover harness 与 test-only handle recorder：在**isolated test composition** 中完整演练一遍 publish。**先确认 harness 跑完后 production route goldens、O-6 与全套保持原样**——演练泄漏到 production 就是越界。 | harness 转绿，production 侧零变化。 |
| **T3.7** | 属性存在性快照（§0.4 第 2 条）在 Commit 2→3 之间跑。 | 快照相等，rc=0。 |

### factory／锚点表

| 符号 | `file:line` | **树** | 用途 |
|---|---|---|---|
| 5 个 `beginLeg` production lexical sites | `driver.ts:877, 1018, 1105, 1519, 1577` | **master** | T3.3 的五个格位。**feature 树对应 `:885, 1014, 1102, 1521, 1579`——两树都别混用** |
| `beginLeg` 被 `wireState` 门挡住 | `driver.ts:875-880`（master）／`:883-888`（feature） | 两树 | **R-14 存在的唯一理由**：`beginLeg` 包在 `if (allocationPort?.wireState)` 里而 `wireState` 只有 Anthropic 有；`noteWinner` 不受该门控（但仍受 optional chaining 约束——反查不到 session 时不调用，**「无条件」不是绝对必调用**） |
| anchor frame builders | `keepalive-anchor.ts:155`（start）、`:164`（delta）、`:173`（stop）、`:186`（synthetic message_start）、`:207`（remap）、`:232`（`resolveRemappedFrame`） | **两树同行**（已实测） | T3.1 的**纯函数核心，复用不重写**（skill `large-refactor` §5「保算法核、丢渲染壳」）。终态它们**只能由 owner command 在读取 current lease 后调用** |
| `reconcileLiveFrame` | `live-reconcile.ts:107`（master）／`:90`（feature） | 两树 | T3.1：decorator 要**退化为纯 decision／transform** 的目标形状 |
| `makeReconcilingSink(inner: ClientSink, …): ClientSink` | `live-reconcile.ts:164`（master）／`:138`（feature） | 两树 | **D 集头号成员**（§7.2 逐字点名）。T3.4 的对照 |
| 两个 injector 工厂 | `keepalive-anchor.ts:297`（anchor）、`:382`（envelope），master；feature `:266` / `:351` | 两树 | D 集成员；其 options 含 `getSink: () => ClientSink \| undefined` |
| `stopFrame` 三个 production 调用点 | 见 Commit 4 锚点表 | — | T3.5 的 terminal-close 映射对象 |

### 本 commit 的门

| id | 段与等级 | 可复跑命令 |
|---|---|---|
| R-11 / O-6 | 每 commit 共同门 | 同 §0.3 |

**本 commit 无新增 R-* 段。** builders 的 SDK 校准与 harness 演练都在 isolated test composition 中，不构成 production witness——RFC §7.6 明确「production route goldens、O-6 与全套保持原样」。

### commit invariant

**不替换任何 live call site**；**不读取准备态 handle 影响 routing**；不发 frame、不采样、不启动 timer；旧 API population 与 Commit 0 精确相等；存在性分派解析结果不变；typecheck 绿、全套绿、O-6 PASS。

---

## Commit 4 — 原子发布全部 generation authority 与 producer commands

**目标**（RFC §7.7）：raw authority 从旧 sink 发布给 `GenerationDeliveryOwner` 的那一个 semantic commit，**同时**切换全部 generation producers。本 commit 结束后 production 旧 generation write API 调用 population 必须为零；**不存在按 payload 猜 intent 的临时 adapter，也不存在新 command 回落旧 raw writer**。

> 🔴 **这是唯一可观察切换点，也是唯一的不可满足停门（§7.13）。** 若 PoC 证明全部 producer 无法在同一 semantic commit 切到可授权 commands，或 typed terminal result／heartbeat coordination 不能覆盖真实顺序：**允许继续增加无行为准备 commit，但不得发布部分 authority、不得引入 `legacy_adapted`／payload-guessing facade、不得让 new command 回落旧 writer。**

### 前置停门（缺任一项不得发布）

1. **Q5 逐帧预测 diff 已复核**（§9.2 Q5、§6.3）：产出旧 golden → 预测新序列的逐帧 diff，逐项标明保留／删除／移动及理由，与 Q5 批准范围核对。**若 heartbeat 重臂时点无法证明逐 tick 中性，其预测 diff 必须纳入 Q5 批准范围。** 缺 diff 或实测超出预测即停止，**不得借已接受的 Q5 吞并额外 wire 漂移**。
2. **所有 Commit 3 调查证据齐全**（§9.3 第 1／2／3／4／5／7／8 项 + already-rendered builder／LegHandle／heartbeat 逐点映射），每项有 `file:line` 或 PoC 结论。
3. **§7.2 的 A／B／C／D 四集闭包输出仍是最新**（T0.7 产物在 Commit 1～3 期间机械相等）。

### 逐 task

> **顺序说明**：T4.1～T4.3 是停门与骨架，T4.4～T4.12 是 §7.7「完整切换清单」的 12 项，T4.13～T4.16 是验收。**它们在同一个 semantic commit 内完成**，task 划分是施工顺序，不是发布粒度。

| id | 先写什么失败测试 → 预期怎么红 | 实现什么 → 预期怎么绿 |
|---|---|---|
| **T4.1** | **Q5 停门**（非测试）。产出逐帧 diff 预测，含 heartbeat 重臂时点的逐 tick 比较（输入来自 T3.5）。**先拿 T0.9 冻结的 goldens 做基座**。 | diff 落盘并复核。缺材料**不得进入后续 task**。 |
| **T4.2** | 10 个 outer roots 创建唯一 owner 与 private raw emitter。**先断言「recorder 包裹的是 composition root 实际取得的 `stream`／`ws` handle」**——用 T0.3 的 direct-send seam 复验它仍看得见绕过 owner 的发送。**注入 owner 的 test raw adapter 不用于本判定。** | 10 roots 切换；**删除 raw 第二 serializer 与 raw heartbeat**。转绿。 |
| **T4.3** | 断言 runner／driver／terminal helper／decorator 参数里**没有** raw handle、closure 返回值与可恢复 registry 里也没有；且**不存在能从已传出的 sink／wrapper／observer 反查完整 session、allocation port 或 raw authority 的 lookup**。**先用 test-only adversarial runner 试着 resolve 回 session，确认它做不到**——窄 port 若可被 lookup 还原，只是形式收窄。 | 转绿。**源码／类型扫描只作 presence ratchet**。 |
| **T4.4** | 所有 ordinary／winner／live common producers 切 `emitGeneric`；generic pings 切 `emitKeepalive`；可解析未知 event 按 unknown passthrough。**先写 adversarial `emitGeneric(block-stop)`，断言它在 external write 前以 `CommandEffectMismatchError` 失败。** | 转绿。mutation 恢复 generic passthrough 后，**wire／owner-state 双 oracle 转红**。 |
| **T4.5** | 默认 on-demand／`empty_text` 切 `openAnchor`，`enveloped_ping` 切 `openMessageEnvelope`，anchor pulse／close 切 indexed commands。**先写「`enveloped_ping` 误走 `openAnchor`」的 mutation**，断言它因多 block／index shift／extra stop 转红——以 `tests/anthropic/enveloped-ping.it.test.ts` 为正样本基座。 | 转绿。`openMessageEnvelope` **不分配 block index、不创建 lease**；`openAnchor` 的 `prelude.kind` 至少区分 `captured` 与 `fabricated`，**owner 铸 provenance，caller 不自报 marker**。 |
| **T4.6** | 5 个 `beginLeg` lexical sites 按 3 kinds × 4 scenarios 接好 LegHandle；primary、hedge winner、continuation、recovery 的 real start／delta／stop 全部切 `openRealBlock`／`writeRealBlockFrame`。**先删掉 caller offset 算术再跑 O-1**，确认没有第二条 legacy arithmetic 旁路（C4 双偏移作废）。 | 转绿。**删除任一 open／write 接线或恢复 caller offset 算术，必须由 O-1／O-2／cross-leg oracle 转红。** |
| **T4.7** | close→real-start 用 **compound command**。**先在不 park 的对照中推进 N×interval 断言恰有 N 个 keepalive**（活性对照，缺它则下一条是假绿）；再把 tick 停在旧两 operation 之间，断言新 production live HTTP 只见相邻 `stop@leaseIndex → real-start@next` 且 `maxOpen<=1`。 | 转绿。**mutation 拆回两个 enqueue 必须产生插帧并红**；`wireTorn` 时按已裁决语义只 close、不 reserve／不写 real start，返回 typed `ClosedThenWireTorn`——调用方**不得**把它误解为「零副作用失败」。 |
| **T4.8** | 所有 `freezeHeartbeat`／`suspendHeartbeat`／`resumeHeartbeat`／`close` 切 `runEmissionBatch` 或 terminal；owner 成为唯一 timer。**先写「双 timer」与「恢复 raw timer」两条 mutation 确认它们红。** | 转绿。**caller 拿不到 timer 控制方法。** |
| **T4.9** | **production 双命中 mutation**（R-5 硬门）：改 production reservation／registration 路径，使新 real mapping 的 `wireIndex` 错误地等于当前 active anchor lease 的 index，或第二个 real mapping 复用第一个的 index；然后从**真实 Anthropic HTTP production path** 驱动「先打开 anchor 再开始 real block」或「同腿／跨腿保留两个 active real blocks」。 | 预期 `AuthorizationCardinalityError` 在阶段 A 抛出、**external attempt 为 0**、anchor lease／已有 mapping 不变、reservation rollback、frontier 不额外 commit。<br>⚠️ **若采用单一拒重复 key registry**，mutation 改为破坏 insert-conflict 守卫。**若完成 mapping 接线后仍不可达**，必须点名是「registry 从结构上消除了该状态」还是「witness 未触达」——前者改用 registry insert-conflict production mutation，**后者停下修 oracle**（§9.3 第 5 项）。 |
| **T4.10** | 20 个 handler synthetic terminal、3 个 `[DONE]`、normal terminal、Responses WS post-owner errors 切 `terminate → recordForwarded → ctx settle → finalize(result)`；**10 个 anchor terminal-close 决策被 `terminate` 吸收**。**先写「`terminate` 跳过 active anchor balancing」的 mutation**，断言 O-2 出现终局悬挂 block。 | 转绿。result 表达 `emitted \| suppressed_client_gone \| suppressed_session_terminating`；socket composition **最后**执行 close intent。**不再在 caller 先 close。** |
| **T4.11** | Responses WS direct transport 按 authority 分域：post-owner error／truncation 不再 direct send，改走 `terminate` ＋ typed socket close intent；control-with-inflight 先协调 active owner。**先在 keep-open socket 上启动 parked generation 并打开 anchor，再发坏 JSON、超长、并发 create，并推进 idle clock**——断言无 orphan anchor、active operation 先被协调、**无 5 分钟 idle timer 误杀**。 | 转绿。**真正 pre-owner admission／AUQ／warmup writers 保持独立且 observer 证零 owner，不纳入归零集。** |
| **T4.12** | 收口 **C 集**：删除 production `getDownstreamDeliverySession(sink)` 及等价 lookup 引用。**先写「恢复 sink lookup」的 authority-leak mutation**，确认 production bypass witness 咬得住。<br>收口 **D 集**：闭包命中的每个声明改为只接／只返回 command port 与窄 observer，或退化为纯 transform。**判据不是「签名里不再出现 `ClientSink` 这个名字」**——那会被局部同构 interface 再 cast 绕过（本项目已实测过），而是**运行期没有任何生产路径能从这些声明拿到 emission 能力**。 | 转绿。`createDownstreamDeliverySession` 只留 composition-root 私有 construction allowlist。 |
| **T4.13** | 迁移旧 session observation／provenance consumers：`noteWinner` 改用 `selectWinner(source)` 或等价窄 observation command。**先写 FF-2 描述的退化实现**——让 `selectWinner` 只更新 snapshot／telemetry 而不参与 provenance 铸造——断言 CC／Azure／Responses HTTP／Responses WS／Gemini **五种 profile 的 forwarded provenance 全部转为 `legacy`** 并使 R-14 转红。 | 转绿：五种 profile 各从真实 route 跑一次**有 winner 的 generation**，断言 forwarded 记录携带**真实** candidate／dispatch identity 且与该请求实际胜出的 candidate 一致；同一断言在 **hedge winner 场景重跑一次**。<br>false-red 对照：Anthropic profile 经 `beginLeg` 得到 provenance 仍绿；**无 winner 的路径（pre-owner 拒绝、warmup）不要求 candidate provenance，不得被本条误伤**。<br>`noteUpstreamRoundStarted`／`noteUpstreamRoundEnded`／`writeScaffold` 当前零 production consumers，**不继续暴露给 driver**。新 observer 不得返回 session／command port／raw handle，也不得产生 wire effect。 |
| **T4.14** | **转发腿的独立 oracle**（RFC §2.7／§11.1 的诚实边界）：producer 常以与 classifier 同族的 frame 谓词选择 command，**共享谓词漏形态时两侧会共因判绿**。因此除 wrong-command mutations 外，**直接破坏 producer 与 classifier 共用的 frame 谓词**，使其漏一种合法 block shape。 | **O-2 状态机／wire golden／真 SDK oracle 必须转红**——这三者**不复用**该谓词。这条不能由 builders 的自洽测试替代。 |
| **T4.15** | 同步迁移 raw／heartbeat 11 文件、common／indexed／terminal／finalize／WS、winner observation 与 session-resolution tests。**任何 guard 删除或放宽必须有独立裁决记录**（CLAUDE.md：删除或放宽既有 guard，合并前必须交独立 reviewer 或用户裁决，不得自判放行）。 | 转绿。 |
| **T4.16** | **先跑独立 O-1／O-2／真 SDK**，再在本 commit 同步更新 Q5 批准范围内的 anchor／heartbeat goldens 并复跑。**注入 duplicate index、orphan delta、悬挂 block，必须先由 O-1／O-2 红**——不能只靠新 golden 自洽。 | goldens 更新并复跑绿。**O-6 fixture 永不重捕。** 实测 diff 超出 T4.1 预测即**停下回用户重裁**。 |

### factory／锚点表

> **本表的 master 行号取于 master `c259dd9d`（`src/` 自 `fcf10eca` 起未变），feature 行号取于 `2c339784`；两侧均已逐条实测。** master 每天前进，**引用前重取**。

#### 10 个 outer composition roots（T4.2）

| # | `file:line`（**master**） | `file:line`（feature `2c339784`） | 说明 |
|---|---|---|---|
| 1 | `routes/messages/handler-v4.ts:567` | `:574` | delayed-commit Anthropic anchored composition |
| 2 | `routes/messages/handler-v4.ts:650` | `:658` | immediate Anthropic anchored composition |
| 3 | `routes/chat-completions/handler-v4.ts:523` | `:523` | direct CC SSE delivery |
| 4 | `routes/chat-completions/handler-v4.ts:760` | `:760` | reverse CC SSE delivery |
| 5 | `routes/responses/handler-v4.ts:351` | `:351` | direct Responses SSE delivery |
| 6 | `routes/responses/handler-v4.ts:600` | `:600` | reverse Responses SSE delivery |
| 7 | `routes/gemini/handler-v4.ts:429` | `:429` | direct Gemini SSE delivery |
| 8 | `routes/gemini/handler-v4.ts:634` | `:634` | reverse Gemini SSE delivery |
| 9 | `routes/responses/ws.ts:358` | `:358` | Responses WS delivery |
| 10 | `routes/messages/handler-v4.ts:1152` | `:1192` | `makeAnchoredSseSink` 内创建 delivery sink（outer-layer helper） |

**Anthropic 的 composition root 必须落在 `makeAnchoredSseSink` 所在层**（master `handler-v4.ts:1086`／feature `:1124`），**不能只下沉到 `makeDeliverySseSink`**——只有这一层同时拥有 allocator／wire state／anchor state／injector、History callbacks 和 raw `stream`。它返回 `{ sink; anchorState; anchorHooks }`（master `:1101` 的返回类型标注）。

内部 factory chaining 另 4 点：**master** `client-sink.ts:487`（`makeSseSink`）、`:488`（`createDownstreamDeliverySession`）、`:687`（`makeWsSink`）、`:688`（`createDownstreamDeliverySession`）；**feature** `:496,497,698,699`。

#### raw factory 与 physical adapter（T4.2／T4.3）

| 符号 | master | feature | 处置 |
|---|---|---|---|
| `makeSseSink(stream): OwnerRawSink` | `client-sink.ts:179`（返回类型在 master 是 `ClientSink`，**feature 才是 `OwnerRawSink`**） | `:188` | 私有化：**不 export、不挂 returned object** |
| raw SSE physical `stream.writeSSE` | `client-sink.ts:200` | `:209` | recorder 必须**位于它之下** |
| `makeWsSink(ws)` | `client-sink.ts:608` | `:619` | 同上 |
| raw WS physical `ws.send` | `client-sink.ts:634` | `:645` | 同上 |
| `makeDeliverySseSink` | `client-sink.ts:485` | `:494` | 被 composition root 反转取代 |
| `makeDeliveryWsSink` | `client-sink.ts:685` | `:696` | 同上 |
| `makeArraySink` | `client-sink.ts:709` | `:720` | **test 面**：Commit 0 分四类时归 owner-backed array adapter |

#### 10 个 anchor terminal-close 决策（T4.10）

⚠️ **两棵树用的是不同的原语，名字与行号都不同——这是本表最容易混写的一格。**

| 树 | 原语 | handler 8 处 | driver 2 处 |
|---|---|---|---|
| **master** | `closeAnchorIfOpen(sink, anchorHooks, anchorState)`（定义 `keepalive-anchor.ts:259`） | `messages/handler-v4.ts:693, 1416, 1526, 1553, 1607, 1716, 1754, 1798` | `driver.ts:1438, 1609`（局部 helper 定义在 `:1181`） |
| **feature `2c339784`** | `closeAnchorViaOwner(..., "terminal")` | `messages/handler-v4.ts:702, 1464, 1584, 1623, 1688, 1808, 1848, 1893` | `driver.ts:1436, 1611`（helper 定义在 `:1178`） |

feature 树另有 `"before-real"` 模式 2 处，**不计入这 10 个 terminal 决策**（HANDOVER 计数事实的集合边界）。

#### 旧 emission API 的归零对象（T4.4／T4.10／T4.12）

| 集合 | 人口（口径见 inventory） | master 锚点抽样 |
|---|---|---|
| A-1 `ClientSink.write` | ⚠️ **两树人口不同，RFC 的「10 点／4 文件」锚在 feature**：**master 11 点／4 文件**、**feature 10 点／4 文件**。差在 live reconciler——master 是两处循环写（`:174,:177`），feature 合成一处（`:157`）。两树都另有 1 处 `OwnerRawSink.write` physical call（master `session.ts:566`／feature `:600`），**按 inventory 口径不计入本类** | **master**：`driver.ts:952, 956, 1052, 1269, 1321`；`keepalive-anchor.ts:406`；`live-reconcile.ts:174, 177`；`chat-completions/handler-v4.ts:662, 833, 839`<br>**feature**：`driver.ts:948, 952, 1048, 1265, 1319`；`keepalive-anchor.ts:375`；`live-reconcile.ts:157`；`chat-completions/handler-v4.ts:662, 833, 839` |
| A-1 子集：`[DONE]` **3 点** | 是 A-1 的**子集**，不重复计数 | `chat-completions/handler-v4.ts:662, 833, 839`。目标是 `terminate` 而非 `emitGeneric` |
| A-2 named synthetic APIs | **28 点／7 文件**（`writeSynthetic` 22 / `writeKeepalive` 3 / `writeSyntheticEnvelope` 3）。**两树 AST 实测同为 28／7**，这一类不因树而异 | 20 个直接 handler 点 + decorator 转发 3 点（master `live-reconcile.ts:183,184,185`／feature `:160,161,162`）+ owner→raw fallback 3 点（master `session.ts:554,558,562`／feature `:588,592,596`）+ 2 个 fallback 调用点 |
| A-3 allocation／anchor commands、caller heartbeat controls、旧 terminal／finalize | 见 T4.8／T4.10；`terminate`+`finalize` 共 **53 点／6 文件**（**两树 AST 实测相同**：session 2、messages 15、CC 11、Responses HTTP 11、WS 4、Gemini 10） | `driver.ts:1222`（freeze）、`:1348,1372`（suspend）、`:1350,1405`（resume）——均为 master 行号；51 个 handler `finalize` |
| A-4 client-facing direct transport 的 **post-owner** 成员 | 9 个 generation direct transport 词法点中的 2 个（**两树实测各 11 个 `writeSSE`／`ws.send` 调用，扣掉 `ws/broadcast.ts` 的 2 个管理 broadcast 后为 9**） | `responses/ws.ts:165`（error／truncation，混合 helper）、`:667`（control-with-inflight）——两树同行 |
| **pre-owner allowlist（不得归零）** | | `responses/ws.ts:595`（connection-cap admission）、`messages/error-shaping-glue.ts:131`（AUQ）、`warmup.ts:214,230,243` |
| B 集 | 旧 session public 面 9 项；production consumer 当前 **`noteWinner` 1 点** | `driver.ts:880`（master）／`:888`（feature） |
| C 集 | `getDownstreamDeliverySession` production **调用点**（定义 1 处不计入）。⚠️ **两树人口不同**：**master 7 处／4 文件**、**feature 9 处／4 文件**——HANDOVER 记的「9 处／4 文件」锚在 **feature** 树，别拿它对 master 计数 | **master 定义** `delivery/session.ts:83`；调用 `driver.ts:875, 948, 1016, 1100`、`messages/handler-v4.ts:1375, 1680`、`keepalive-anchor.ts:311`（**`driver.ts:880` 是 `noteWinner`，走 `getDownstreamDeliverySessionForPortOrSink`，属 B 集不属 C 集**；master 的 `live-reconcile.ts` **没有** lookup）<br>**feature** 定义 `:90`；调用 `driver.ts:883, 944, 1012, 1097`、`messages/handler-v4.ts:1112, 1422, 1772`、`live-reconcile.ts:139`、`keepalive-anchor.ts:280`<br>**逐点以 T0.7 的 AST 输出为准，别照抄本表** |
| D 集 | **不能靠列举穷尽，以 T0.7 闭包输出为准** | sanity 成员：`makeReconcilingSink`（master `live-reconcile.ts:164`）、两个 injector 工厂（master `keepalive-anchor.ts:297, 382`）、各 raw factory 返回类型、driver／handler 中带 capability 类型的 helper |

### 本 commit 的门

| id | 段与等级 | 可复跑命令 |
|---|---|---|
| R-1 | C4 `production 硬门` | 四 vendor HTTP root + Responses WS 的 zero／exactly-once 断言（T4.2／T4.3） |
| R-2 | C4 `production 硬门` | 每 profile 从真实 route 发 generic／keepalive／terminal（T4.4）＋ T4.14 |
| R-3 | C4 `production 硬门` | 真实 Anthropic live consumer（T4.5／T4.7）；T0.6 的 characterization 在此转绿 |
| R-4 | C4 `production 硬门` | FakeClock + 真实 route（T4.7） |
| R-5 | C4 `production 硬门` | production registration mutation（T4.9） |
| R-7 | C4 `production 硬门` | 各 vendor direct／reverse、H2、H3、truncation（T4.10） |
| R-8 | C4 `production 硬门` | Responses WS control-with-inflight（T4.11） |
| R-12 | C4 `production 硬门`（更新 golden） | T4.1 停门 → T4.16；O-1／O-2／真 SDK 先跑再同步 golden |
| R-14 | C4 `production 硬门` | 五 profile 各一次有 winner 的 generation ＋ hedge winner 重跑（T4.13） |
| O-1 | C4（5 sites／3 kinds／4 scenarios） | T4.6 |
| O-2 | C4（R-3／R-4／R-7 直接使用） | T4.5／T4.7／T4.10 |
| O-4 | C4 **靶向复用**（完整真 SDK 验收归 P8，不在本 RFC） | T4.16 |
| O-8 | C4 authority publish | T4.8 的 unpark 活性对照 + parked ticks |
| R-11 / O-6 | 每 commit 共同门 | 同 §0.3 |

### commit invariant

- **A 集** production 调用 symbol population **为零**；合法 pre-owner allowlist 保持非零。
- **B 集** production consumer population **为零**；`noteWinner` 迁 `selectWinner` 窄 command。
- **C 集** resolution population **为零**；construction **精确等于** composition-root 私有 allowlist；sink→session lookup 运行期不可达。
- **D 集** 声明只接／只返回 command port 与窄 observer，或退化为纯 transform；**运行期无路径可从其取得 emission 能力**。
- 每个 physical send 有 registered command family 与 command id；**一个 serializer／一个 timer／一次 sampling／一次 emit**。
- winner／round provenance 完整且不授予第二 authority。
- C1～C11、Q5、terminal 与 WS ownership 同时成立。
- typecheck 绿、`unit it http` 确定性全绿、O-6 PASS。

**任何正确样本 false-red、mutation 不咬、Q5 实测超预测或全套非确定性失败，均按 R-11 停下回报**——**禁止 skip、双接受 golden、手工补 state 或把失败标成既有**（§7.13）。

---

## Commit 5 — Per-command telemetry 与 History generation operation detail

**目标**（RFC §7.8）：独立 generation operation detail 保存 rich per-command records 并关联稳定 `wirePartialDelivery` 摘要；TelemetrySink 投影 bounded dimensions／measures，迁 telemetry.db 四层读写。

### 🔴 前置停门：Q1 未裁则本节不可开工

> **Q1 仍 open。** 用户 2026-08-03 裁的是「**现在不裁，到 Commit 5 前再说**」——**裁的是时机，不是内容**；A／B／C 三个选项**一个都没选**。RFC §9.2「已裁决、不得重开的事项」**至今不含 Q1**，`q1-locations.sh` 的 `PHASE=pre` 仍是正确相位。
>
> **别把它读成「Q1 已裁」**——RFC §7.8 首行原本就写过「Q1 已裁」（与同行「Q4 已裁决方案 B」并列），已改成「Q1**必须已裁**——截至本 RFC 交付时仍 open，这是入场条件不是状态」。KICKOFF 的第一步是读 RFC §7，接手方最容易先撞见那句、把 Commit 5 建在未定形的 telemetry schema 上。
>
> **本节所有 task（T5.1～T5.7）在 Q1 裁定前一律不可开工。** Q1 不阻塞 Commit 0～4。

**裁决材料必须一并带上 §4.8 的冲突，别只端 A／B／C 出去**——见 §11 待裁项 #2 与 #3。

**Q1 裁定落地后的机械动作**（属本节验收，不是脚本注释里的建议）：

```bash
cd /home/xp/src/copilot-api-js && PHASE=post exp/inter-block-anchor-allocator/q1-locations.sh
```

必须 rc=0。**裁决之后照默认 `PHASE=pre` 跑会全红；那不是脚本坏了，是跑错了相位。**

脚本冻结的位置有两组，**别只顾 RFC**：**RFC 内 8 个小节**（`EXPECTED`：§4.7／§4.8／§4.9／§4.12／§7.8／§9.1／§9.2／§9.4）＋ **2 份载体文档**（`CARRIERS`：`KICKOFF.md` 的「裁决：Q1」行、`HANDOVER.md` 的 T2 标题行）。载体漏改的后果具体而实在——KICKOFF 是新会话贴进去的第一条消息，它还写着「未裁」就会让下个会话拿一个已裁的问题去重新问用户。

RFC 内 8 处分三类，**别混**：`statement`（今天就说了 Q1 的事）／`destination`（今天**按设计是空的**，裁决必须把它填上——把 destination 的空当成「已同步」正是最容易犯的错，§4.7 与 §9.2 属此类）／`constraint`（限制有哪些选项可选，即 §4.8）。

⚠️ **`rc=0` 不是完备性证明，已有反例。** 谓词是自然语言，可被没人想到的措辞绕过——**§4.8 至今不被该谓词命中**（命中数 0），它是评审换一条结构性问题找出来的。`rc=0` 的意思只是「冻结名单之外没有新小节开始使用我们冻结的词汇」，即**漂移绊线**。扩写 RFC 遥测部分的人**仍欠一次人工通读**，且**换轴提问比加词有效**。

### 前置调查（RFC §9.3 第 6 项，证据槽在本 commit 之前）

per-command rich records 最合适的 request-scoped owner（`PipelineInfo` 摘要／独立 History detail／ctx snapshot）与 settle 冻结点；**必须保证 success／failure 同源且 settle 前冻结**。答不上就只冻结性质，不写字段表。

### 逐 task

| id | 先写什么失败测试 → 预期怎么红 | 实现什么 → 预期怎么绿 |
|---|---|---|
| **T5.1** | request-scoped、**bounded** 的 command telemetry accumulator 的 unit：断言 owner 在 operation 期间追加每个 command observation，且 accumulator 有界。**先写一条「无界增长」的 mutation 确认它红。** | 转绿。**不从 owner 热路径直接新增 telemetry package free-function 或 SQLite writer**——今天 `TelemetrySink` 已是 completed／failed 请求的唯一 registry feed，runtime 唯一的 settled-request 记录入口是 `recordSettled`。 |
| **T5.2** | bounded 字段的 canonical registry／normalizer unit，按 §4.8 逐字段：`command`／`formatProfile`／`expectedEffect`／`actualEffect`／`targetKind`／`legKind`／`outcome`／`committed`／`wireTorn`／`stateBefore`／`stateAfter`。**先写一条「`wireIndex` 进 label」的 mutation 确认它红**——`wireIndex` 与 `commandId` 只进 trace／History detail。 | 转绿。`formatProfile` 用 canonical 枚举（`anthropic_messages`／`responses_http`／`responses_ws`／`chat_completions`／`azure_chat_completions`／`gemini`），**不直接用 route path 或 client 输入**。 |
| **T5.3** | **单一口径分裂判据**（§4.11，本项目已栽过一次：model 维成功腿用规范名、失败腿回落客户端别名）：对同一 `formatProfile + command + expectedEffect + targetKind + legKind` 驱动一次成功与一次 pre-write／wire 失败，断言除 `outcome`／`committed`／`phase`／`stateAfter` 等本就应变的字段外，**其余 canonical keys 完全相等**。**mutation 让失败路径回落函数名／route path／raw effect string，必须产生额外 key 并使断言转红。** | 转绿。再用 alias route（OpenAI 与 Azure 同 command family）验证**只在已声明的 `formatProfile` 轴分开**。<br>⚠️ **比较冻结 key 集合，不用总数凑巧相等。** |
| **T5.4** | compound `phase`（`validated \| stop_sent \| real_start_sent \| terminal_sent`）与 partial measures 的 unit：至少分别累加 `validatedCount`／`stopSentCount`／`realStartSentCount`／`terminalSentCount`／`committedCount` 与各 outcome count。**先写「partial failure 只记 `outcome=wire_error`」的 mutation** 确认聚合后答不出「stop 成功但 real start 失败」。 | 转绿。普通 command 用 `phase: none`（**避免把「不适用」与「尚未 validated」混淆**）；`closedThenWireTorn` 固定表达 `stop_sent + committed=true + wireTorn=true + outcome=closed_then_wire_torn`，**不能降成普通 `ok:false`**。 |
| **T5.5** | History **方案 B** 双层（Q4 已裁）：`wirePartialDelivery` 保持稳定摘要 `operation + cause + committed`；独立 generation operation detail 保存完整 per-command records（含 `phaseReached`、attempted segment、成功 segments、error），以 operation／command identity 关联摘要。**先写一条「摘要被扩字段」的 mutation 确认它红**——摘要的稳定性是契约。 | 转绿。同 commit 同步**后端 SSOT schema、ui-v4 re-export 与相关 tests**。 |
| **T5.6** | telemetry.db 四层 round-trip：`tel_raw → tel_hourly → tel_daily` 与 `tel_cumulative` 各读一次。**先只加 measure 不改 schema 跑一遍**，确认它失败——「开放 counters bag 零版本 bump」**不等于** SQLite 无需 schema migration。 | 按 telemetry.db 现行 Umzug／store 约定**增加列**并验证四腿；同步 `FEATURE_MEASURE_NAMES`／`SettledMeasures`／column registry／read projection。**不重新建 command event 表。** |
| **T5.7** | R-9 的诊断判别力：同 command 驱动 success、preflight 拒绝、wire partial 三种，断言 §4.10 的四个诊断问题都能答上。**先构造「只存 `committed` 不存 phase」的 mutation** 确认诊断缺口出现。 | 转绿。<br>⚠️ **R-9 是辅助诊断门，不计 behavior 等级**（§4.12）：实现可以在仍有 direct send 旁路时把日志打得完全正确，也可以在 behavior 正确时因 sink 未 settle 而漏计。**telemetry 缺失不反判 wire 错误。** |

### factory／锚点表

| 符号 | `file:line` | **树** | 用途 |
|---|---|---|---|
| dimension names 与 cardinality | `packages/telemetry/src/dimension-names.ts:19-64`（`TelemetryDimensionName` 定义在 `:56`） | **两树同行**——`packages/telemetry` 与 `src/lib/observability` 在两树间**无差异**（`git diff --name-only master...feat` 不含它们） | T5.2 的 registry；**穷尽 `Record<TelemetryDimensionName,...>` 使新增 spec 但漏 extractor 时 compile-red** |
| extractor（依赖 `HistoryEntryData`／ctx） | `src/lib/observability/telemetry-dimensions.ts:1-25,141-170` | 同上 | T5.2 |
| settled-request 聚合叶 | `packages/telemetry/src/request-telemetry.ts:337-407` | 同上 | 只收 resolved key bag 与 measure inputs，开放 `Record<string, number>` counters |
| feature measures 单一 name registry | `packages/telemetry/src/request-telemetry.ts:115-149`（`FEATURE_MEASURE_NAMES` 在 `:124`）、`:856-931` | 同上 | T5.6 的 `FEATURE_MEASURE_NAMES` |
| telemetry store / rollup | `packages/telemetry/src/telemetry/store.ts:34-95,104-133`、`rollup.ts:1-20,95-147` | 同上 | T5.6 的四层；rollup 对可加 columns 泛型迭代 |
| `TelemetrySink`（唯一 registry feed） | `src/lib/observability/sinks/telemetry.ts:31-43,49-103` | 同上 | T5.1 的接入点 |
| `recordSettled`（runtime 唯一入口） | `packages/telemetry/src/runtime.ts:67-100`（`recordSettled` 签名在 `:86`）、`:145-150` | 同上 | 同上 |
| 现状 generic write 失败日志 | `delivery/session.ts:311-355` | feature | §4.10 的「答不了」对照：统一记 `[delivery] owner wire write failed` |
| 现状 snapshot | `delivery/types.ts:44-51` | feature | 只有 state／winner／wire ledger／rounds／总 `writeCount` |
| 现状 partial History | `src/lib/history/types.ts:217`（**feature only**——`wirePartialDelivery` 在 master 的 `src/` 零命中，是 M1 引入的） | feature `2c339784` | 只有 `operation + cause + committed` |

> ⚠️ **上表 `packages/telemetry/**` 与 `observability/**` 的行号取自 RFC §4.7（原锚在 feature `854421d4`），已在 master `c259dd9d` 上逐条复核在范围内且命中目标符号**；这两个目录在两树间无差异。master 每天前进，**引用前重取**：
> ```bash
> cd /home/xp/src/copilot-api-js && rg -n "TelemetryDimensionName|FEATURE_MEASURE_NAMES|recordSettled" packages/telemetry/src src/lib/observability
> ```

### 本 commit 的门

| id | 段与等级 | 可复跑命令 |
|---|---|---|
| R-9 | C5 `辅助门`（诊断，**不计 behavior 等级**） | T5.3／T5.7 落盘的测试路径 + 四层 round-trip（T5.6） |
| — | Q1 相位守卫 | `PHASE=post exp/inter-block-anchor-allocator/q1-locations.sh` |
| R-11 / O-6 | 每 commit 共同门 | 同 §0.3 |

### commit invariant

production 旧 API population **持续为零**；telemetry **不新增 emission 或 state authority**，wire 不变；A／B／C／D 四集状态与 Commit 4 终态相同；typecheck 绿、全套绿、O-6 PASS。

---

## Commit 6 — Legacy definitions／exports 删除与 population 审计

**目标**（RFC §7.9）：删除已零调用的定义与 exports，并对三张 symbol 集合分别做 AST／checker 审计。

### 逐 task

| id | 先写什么失败测试 → 预期怎么红 | 实现什么 → 预期怎么绿 |
|---|---|---|
| **T6.1** | 重跑 T0.7 的闭包与 inventory AST，断言 A／B／C 三集 population 仍为零（C 集 construction 仍精确等于 allowlist）。**先手工加回一个旧调用点确认审计会红。** | 审计绿。 |
| **T6.2** | 删除 **A 集**已零调用的定义：`ClientSink.write*` generation surface、`WireBlockAllocationPort`、caller envelope factory、legacy anchor fields／bridge、`commandPortActivation`、raw production exports。**删之前先跑一遍全套确认真的零引用**（TypeScript 会替你找剩余引用，别猜）。 | typecheck 与全套绿。<br>⚠️ **`commandPortActivation` 在两棵树的 `src/` 都零命中**（实测）。它要么是 Commit 1～4 期间新引入的名字，要么是 RFC 的前瞻性命名——**到达本 commit 时先确认它存在再删，不存在就在 plan 里标注并回报**，别为了让清单成立而发明一个符号。 |
| **T6.3** | 删除 **B 集**已零 consumer 的旧 `DownstreamDeliverySession` public surface：`writeScaffold`、`noteWinner`、`noteUpstreamRoundStarted`、`noteUpstreamRoundEnded`。**先确认 `identity`／`snapshot` 若内部保留，它们不作为旧 session handle 暴露给 driver。** | 绿。 |
| **T6.4** | 删除 **C 集**已零 resolution consumer 的 exported `getDownstreamDeliverySession`、等价 WeakMap lookup 及 allowlist 外 construction exports。 | 绿。 |
| **T6.5** | **R-10 硬门**：test-only adversarial seam **仍能在旧边界造出分裂**，而新 production route **拒绝同一行为**。**mutation：把 `allocation-outside-owner-control` 改走合法 owner，或删掉 adversarial seam——coverage gate 必须红。** | 绿。<br>false-red 对照：**owner-backed array adapter 与 raw transport byte units 合法存在，不被零命中 guard 误杀**。<br>锚点：`tests/pipeline/allocation-outside-owner-control.it.test.ts`（**两树皆存在**，已实测）。 |
| **T6.6** | **R-6 的 C6 段**：import guard 断言 `src/lib/pipeline/delivery/**` 对 concrete codec 模块零 import，**并提供一条故意加入违规 import 的正样本，确认守卫真实转红**。**单纯 `rg` 零命中不自证。** | 绿。<br>🔴 **本段等级未定，见 §11 待裁项 #1。** 若裁为 `辅助门`，则 import guard 失去阻断力；若裁为 `production 硬门`，Commit 6 通过条件变严。**别自己填。** |
| **T6.7** | 独立 guard 裁决记录齐全：本 commit 删除或放宽的每一条 guard 都有独立 reviewer 或用户裁决记录（CLAUDE.md `[hard]`）。 | 记录落盘。 |

### factory／锚点表

| 删除对象 | master | feature | 备注 |
|---|---|---|---|
| `WireBlockAllocationPort` | `types.ts:309-322` | `:319-332` | 五方法 + `wireState` |
| `DownstreamDeliverySession` public 面 9 项 | `delivery/session.ts:50-59` | `:57-67` | B 集 |
| `getDownstreamDeliverySession` | `delivery/session.ts:83` | `:90` | C 集 |
| `getDeliverySessionForAllocationPort` | `delivery/session.ts:88` | `:95` | C 集 |
| `createDownstreamDeliverySession` | `delivery/session.ts:93` | `:100` | C 集 construction，**只留 composition-root allowlist** |
| `OwnerRawSink` | **master 零命中** | `delivery/types.ts:12` | raw production export |
| `ClientSink.write*` generation surface | `types.ts:737` 起 | `:747` 起 | 含 `write`／`writeSynthetic`／`writeKeepalive`／`writeSyntheticEnvelope`／`writeAnchor` |
| 架构守卫既有位置 | `tests/architecture/` | 同 | T6.6 的 import guard 归属目录；同目录已有 `package-boundaries`／`circular-deps-ratchet`／`anchor-remap-single-authority` 等 |

### 本 commit 的门

| id | 段与等级 | 可复跑命令 |
|---|---|---|
| R-10 | C6 `production 硬门` | inventory AST 重跑（T6.1）+ test-only adversarial seam（T6.5） |
| R-6 | C6 段，**等级未定见 §11 待裁项 #1** | import guard + 违规正样本（T6.6） |
| R-11 / O-6 | 每 commit 共同门 | 同 §0.3 |

### commit invariant

A 集 calls、B 集 consumers、C 集 resolution population 自 Commit 4 起持续为零，construction 收敛 composition allowlist；**四类 test oracle 与 adversarial 旧边界 positive control 保留**；typecheck 绿、全套绿、O-6 PASS。

---

## Commit 7 — Golden／oracle 纯审计与旧 fixture 清理

**目标**（RFC §7.10）：**不改 production、不首次 recapture**；复核 Commit 4 goldens 具有 Q5 diff 与独立 oracle 证据，删除确被取代的旧 fixture／helper。

### 逐 task

| id | 先写什么失败测试 → 预期怎么红 | 实现什么 → 预期怎么绿 |
|---|---|---|
| **T7.1** | 逐份复核 Commit 4 更新过的 golden：每份都要指出**它的 Q5 diff 条目**与**独立 oracle 证据**（O-1／O-2／真 SDK 中的哪一条先绿）。**没有独立 oracle 证据的 golden 一律标红**——只靠新 golden 自洽等于把新代码的行为编码成期望。 | 复核表落盘。 |
| **T7.2** | 删除确被取代的旧 fixture／helper。**删之前先确认它守的不变量已由新 oracle 承载**（CLAUDE.md：改测试前先落盘记录该断言守的不变量是什么、依据来自哪里、本次为何这样处置）。 | 全套仍绿。 |
| **T7.3** | 断言本 commit `git diff -- src/` 为空。 | 空。 |

### 本 commit 的门

| id | 段与等级 | 可复跑命令 |
|---|---|---|
| R-12 | C7 `辅助门`（审计） | T7.1 的复核表 |
| R-11 / O-6 | 每 commit 共同门 | 同 §0.3 |

### commit invariant

production 零改动；O-1／O-2／真 SDK／goldens／O-6／全套均保持绿；**O-6 fixture 永不重捕**。

---

## Commit 8 — 文档同步与 merged-state 收口

**目标**（RFC §7.11）：同步 README C1～C11、anchor 精确帧序契约、DESIGN、旧 plan supersede 关系、telemetry／History 与 deferred items；**ADR 只按用户裁决编辑**。

### 前置停门

**Q2**（是否补充已接受 ADR `2026-07-05-richest-data-flow` 的 owner-minted provenance 说明）在本 commit 之前停，**默认不改 ADR**（方案 B）。**未经用户同意不得暗改 ADR**——ADR 来自用户决策，实施者无权因代码形状变化自行改写理由。

### 逐 task

| id | 先写什么失败测试 → 预期怎么红 | 实现什么 → 预期怎么绿 |
|---|---|---|
| **T8.1** | README 的 C1～C11 回填：C2／C5／C6／C7／C9／C10／C11 属「措辞需扩展」，逐条按 §6.2 末列的「需要同步的权威位置」改。**先跑一遍 doc-vs-code claims 检查确认现状对不上**。 | 回填完成。**C1／C3／C4／C8 语义不变，不得顺手改语义。** |
| **T8.2** | 把 **anchor 精确帧序**登记为 C1～C11 **之外**的独立可观察契约（§6.3）：它不属于 C2（C2 只要求 `maxOpen<=1` 且 anchor stop 先于 real start，中间多一帧合法 keepalive 仍成立），也不属于 C7（C7 不规定 synthetic 帧相对 real start 的精确位置）。**先确认没有人把它包装成 C2／C7 的「实现细节」。** | 契约落盘。 |
| **T8.3** | 同步 `docs/DESIGN.md` 的「活的架构现状」表与类型架构节。**先跑一次跨文档 grep 验证**（session-closeout §2）。 | 同步完成。 |
| **T8.4** | 旧 plan supersede 关系：`docs/plan/2026-07-27-inter-block-anchor-allocator/` 的 M2～M4 mapping 步骤被本 RFC supersede；M5～M8 中 gap lifecycle／开门／多 gap **保留并重锚**；O-1～O-9 继续继承。**别把 supersede 写成删除**——§10.3 明写 O-9「绝不删除」。 | 注解完成。 |
| **T8.5** | **旧 API disposition 与 doc-vs-code claims 审计**：对 §0.1 两棵树的合并结果逐项确认。**并完成 HANDOVER 遗留的那件事**：先冻结一份权威文档 manifest（三个范围共 **122 份 Markdown**），再**按契约轴而非新 API 名**检索——index allocation/order/reuse/offset、anchor open/close/lifecycle、serializer/write/emit、synthetic provenance、winner/candidate/dispatch、heartbeat/escalation、continuation/recovery、History/telemetry；对 manifest 里**每一份**给 disposition，并对 C1–C11 与用户裁决做双向 trace。<br>⚠️ **「除上述外无冲突」这个否定性断言在本 plan 写作时并不成立**：HANDOVER 记录的五个检索词只命中 21／122 份，未命中的里面恰恰包括承载 C1／C4／C6／C7／C8、D2、continuation offset、anchor 生命周期与 P7／P8 的核心文档。**少命中不能证明无冲突。** | 审计表落盘。 |
| **T8.6** | telemetry／History 文档与 deferred items 同步；`docs/todo/deferred-backlog.md` 记入 §8「范围外」表里归属它的两项（vendor 协议完整状态机、统一 `CompleteResponseEmitter`）。 | 同步完成。 |
| **T8.7** | 独立 **merged-state review**（`review-merged-state`）：跨 phase 集成缝、doc↔code 对账、commit message 与内容是否相符。 | review 记录落盘。 |

### 本 commit 的门

| id | 段与等级 | 可复跑命令 |
|---|---|---|
| R-11 / O-6 | 每 commit 共同门 | 同 §0.3 |
| — | 完成判定 | 见 §10 |

### commit invariant

runtime、API population 与 goldens 已稳定；**docs 不承担推迟迁移**；typecheck 绿、全套绿、O-6 PASS。

---

## 10. 完成判定（RFC §10.4）

R-1～R-14 中标为「本 RFC 必须／gate」的项目**全部**具备 positive 与 negative controls。**R-14 与其余必过项同级**——它是非 Anthropic candidate provenance 的唯一守卫，漏掉它等于让 §3.3 已认定「缺了会全绿交付」的回归照常交付。辅助类型／遥测门失败**同样阻止交付**，但其通过**不升级** behavior 等级。

O-3／O-5／O-7／O-9 以及 O-4 的完整验收明确留给后续 M2～M8／P7／P8，**不得因「不属于本 RFC」从 roadmap 删除**。

执行者必须在验收记录中**逐项**写 `PASS / FAIL / NOT-YET-IN-SCOPE` 和证据命令；**不能用一条「全套件绿」折叠全表**。

**升级／降级规则**（§5.5）：某一行只有在其真实 production 入口的正样本为绿、目标缺陷 mutation 为红、且 false-red 对照证明正确实现可通过后，才能从「仅降低概率」升级为「结构性闭合候选」。**升级只适用于该 operation／profile／transport witness 覆盖的边界**，不外推为「整个 socket lifetime」或「全应用唯一 writer」。若后续发现 direct send、raw capability 供给、双 serializer、telemetry-only 证明或无法触达目标的 mutation，**该行立即回到「仅降低概率」**，无需等待另一次架构裁决。

---

## 11. 待裁项 —— 本文不解决，如实转述并标为待裁

> 以下五项**都不是实施者可自判的**。走 RFC §9.1／§9.4 的 open question 机制交主会话／用户，按 `scope-ambiguity-then-ask` 摆带量化影响的选项而非 yes/no。
>
> **#1～#3 是 RFC 与已有裁决自带的停点**（如实转述，不解决）；**#4／#5 是本 plan 撰写过程中新发现的**，RFC 里没有对应停点。

### #1 R-6 的等级读不出来（**RFC 既有缺口**）

§10.2 末列 14 条里 13 条可直接读出等级，**唯独 R-6 是 `本RFC辅助门；Commit 1／6` —— 两个 commit、一个等级、没有分段**。

**自行推断没有 RFC 出处；两段同填「辅助门」则是矩阵 §0 明确禁止的压平**（把六轮评审建立起来的分级压平，等于拿判据去破坏它要保护的东西）。

| 候选 | 拆法 | 量化影响 |
|---|---|---|
| 1 | compile fixtures → C1（§7.4）、import guard → C6（§7.9），两段各自定级 | 与其余 4 条两段式判据（R-1／R-2／R-5／R-12）形状一致；**需要 RFC 补一句分段措辞** |
| 2 | 两段同为 `辅助门`（维持 §10.2 末列字面读法） | 改动最小；**代价是 C6 的 import guard 失去阻断力**——`delivery` 不 import concrete codec 这条分层边界破了，R-6 的价值就没了 |
| 3 | C6 那段升 `production 硬门` | 守住分层边界；**代价是 C6 的通过条件变严**，且与「类型门只作 presence ratchet、不计 behavior 闭合」（§3.7）的措辞需要协调 |

**本 plan 的处置**：矩阵与本文的 R-6 行一律写「等级未定，见待裁项 #1」，**不填**。

### #2 Q1 —— telemetry 联合查询能力（**用户裁的是时机，不是内容**）

用户 2026-08-03 的裁决原文是被选中的选项文本「**现在不裁，到 Commit 5 前再说**」。**A／B／C 三个选项一个都没选**；§9.2 至今不含 Q1；`q1-locations.sh` 的 `PHASE=pre` 仍是正确相位。

选项（RFC §9.1）：**A** 预组合一个严格有界的 compound dimension（RFC 推荐）／**B** 扩展 registry 为 typed multidimensional key／**C** 只提供单维 breakdowns 与 History 明细。

**Commit 5 的所有 task 写成「Q1 未裁则本节不可开工」**，见 §Commit 5 的前置停门。Q1 **不**阻塞 Commit 0～4。

### #3 §4.8 与选项 A 的冲突（**由实施者自判是无出处的自裁**）

`design.md:392` 对 `command` 维写着：

> 取RFC冻结的command family枚举；**不得使用函数名、任意error字符串或动态compound名称**。

而选项 A（`design.md:695`）正是新建一个 compound dimension `generation_command_outcome`。

**两种读法都成立**：

- A 的 key 由 canonical registry **笛卡尔积**生成、是**静态有界**的，未必算「动态」；
- 也可能这条禁令本就覆盖它。

**处置**：把这个冲突连同两种读法一起摆进 Q1 的裁决材料，**由主会话／用户在裁 A/B/C 时一并裁掉**。裁完 §4.8 那一行必须写明结论，`q1-locations.sh` 的 `PHASE=post` 会要求它从 `mentions` 变成 `ruled`。

⚠️ **这一处不被 Q1 谓词命中**（命中数 0），是评审换轴提结构性问题找出来的。**取材只抄 A/B/C 那一行，就会把它漏在十几行之后。**

### #4 cutover 的 entry commit 落在哪棵树（**本 plan 新提，非 RFC 既有停点**）

见 §0.2。两棵树都不能直接当 entry，而 RFC §7.1 只说「实际 entry commit」，没说树。

| 候选 | 做法 | 量化影响 |
|---|---|---|
| 1 | 把 feature `2c339784` merge 进 master，以 merge commit 为 entry | M1 与缺陷修复都在；**代价是 merge 本身会引入需要解决的语义冲突**（feature 改了 `driver.ts` 106 行、`handler-v4.ts` 124 行、`session.ts` 64 行，master 同期前进数十个 commit），且 merge 后须重跑入场条件的 15 次 |
| 2 | 把 master rebase 到 feature 上（或 cherry-pick 缺陷修复到 feature），以结果为 entry | 同样得到两者；**代价是 rebase 数十个 commit 的冲突面比 merge 大**，且改写了已发布的 master 历史（本项目共享主树，**不可接受**） |
| 3 | 在 master 上从零重塑 M1（不复用 feature 树代码） | 无 merge 冲突；**代价是丢弃 M1 的实现与其 8 个 commit 的测试，与用户裁决「M1 由 cutover 重塑而非丢弃」相冲突**——「重塑」不是「重写」 |
| 4 | 起隔离 worktree、以 feature 为基先合入 master，再在该 worktree 上做 entry 与全部 8 个 commit | 冲突在隔离树内解决、不污染共享主树；**代价是 cutover 期间 master 会继续前进，最终合回时有第二次 merge**——但这正是本项目 `docs-merge-before-execute` 的既定形状（文档先合主线，执行走隔离 worktree 新分支） |

**本 plan 的倾向是候选 4**，理由是它与本项目已确立的执行形状一致，且把 merge 冲突关在隔离树内。**但这是调度决策，交主会话裁。T0.1 在裁定前不可开工。**

### #5 R-5 的 C1 辅助门段实际落在 Commit 2（**次要，本 plan 已如实标注**）

矩阵把 R-5 的辅助门段记在 C1，本 plan 把它排在 Commit 2（T2.3），理由是 cardinality assertion 属于 owner state primitives（RFC §7.5 的目标清单里逐字含「cardinality assertion」，而 §7.4 的 Commit 1 目标清单里没有）。

**Commit 1 与 Commit 2 之间旧 API population 机械相等、行为等价**，门落在哪一个准备 commit 不改变可达性，因此本 plan 判为**如实标注即可、不改矩阵**。若评审认为这构成漂移，**交主会话裁**，别自行改矩阵——`traceability-check.py` 只校验「production 硬门不早于其依赖能力」，辅助门段落在 C1 还是 C2 它不判，**正因如此才更需要人来看一眼**。

---

## 12. 本 plan 未采纳的写法（`record-not-adopted`）

| 未采纳 | 为什么 |
|---|---|
| 把 Commit 4 拆成「先收 raw authority、后迁 producer」两个 commit | RFC §7.1 明确否定该分段；拆开必然产生「旧路径已禁而新 command 尚不可用」的中间态，或需要一个按 payload 猜 intent 的临时 adapter——§7.13 逐字禁止 |
| 在锚点表里只写一棵树的行号，另一棵「读者自己换算」 | 两棵树互不为祖先，行号偏移**不是常数**——实测：`client-sink.ts` 偏 +9 或 +11（**同一文件内就不一致**）、`handler-v4.ts` 偏 +7／+8／+38／+40、`driver.ts` 有正有负（+8／−4／−3／+2）。换算必错 |
| 把 R-6 两段都填「辅助门」以消掉待裁项 | 矩阵 §0 明确禁止压平；这是「最省事的修法正好破坏它要保护的东西」的典型 |
| 自行判定 §4.8 的「动态 compound 名称」不涵盖选项 A | 无 RFC 出处的自裁（HANDOVER T4 证伪①）。两种读法都成立时，实施者的判断没有外部 oracle |
| 把 `commandPortActivation` 当成既有符号写进删除清单并给 `file:line` | **实测两棵树的 `src/` 都零命中**。给一个不存在的符号编行号，正是「跨一条没读过的缝规定行为」 |
| 用 `withAllocatedRealBlock`／`writeBlockFrame` 的现有签名作为 `openRealBlock`／`writeRealBlockFrame` 的终态签名 | RFC §3.4 明确：终态 public port 应暴露 owner 验证的 **opaque handle**，不把 mutable registry 或 mapping 实现对象交给 caller。现有签名是**迁移起点，不是终点** |
| 为 O-3／O-5／O-7／O-9 硬塞一个归属 commit 好让矩阵没有孤儿 | §10.4 明写「不得因『不属于本 RFC』从 roadmap 删除」，§10.3 明写 O-9「绝不删除」。硬塞与删除是同一错误的两个方向 |

