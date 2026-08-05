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

> 🔴 **`OwnerTerminalDecision` 与本 RFC 要引入的 `TerminalEmissionResult` 是两个正交轴，不是同一件事的两种命名**：前者是**任意 owner command 失败**（`beginLeg`、`close-anchor-before-real`…）的 caller action，后者只是 `terminate` 的结果。**这不是实施者可自裁的职责边界**，见 §11 #6——**触发点在 Commit 1 kickoff 之前，不是 Commit 4**。

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

### 0.2 Entry：隔离 worktree，**显式从 `ENTRY_SHA=A` 建**（已裁 Git 图）

**用户已裁**：Commit -1 在独立 worktree 实现并合 master，合入后产生 entry **A**；cutover 在隔离 worktree 里做，**从 A 起**。master 随后会提交 pointer **P**，所以**「从当前 master 起」在 P 已存在时是错的**——那会从 P 起步，把所有「从 A 开始」变成口头。

**执行形状固定为**（`ENTRY_SHA` 是 post-merge preflight 的外部参数，来自已裁图与 HANDOVER pointer，不是猜当前 master HEAD）：

```bash
ENTRY_SHA=<A 的完整 40 位 SHA>
cd /home/xp/src/copilot-api-js && git worktree add ./.worktrees/<name> -b <branch> "$ENTRY_SHA"
TREE=/home/xp/src/copilot-api-js/.worktrees/<name>
# 机械确认：执行树真的从 A 起，不是从 P 或当前 master 起
test "$(git -C "$TREE" rev-parse HEAD)" = "$ENTRY_SHA"
```

**Git 图消费门**（T0.0d 也验证）：`git -C /home/xp/src/copilot-api-js merge-base --is-ancestor "$ENTRY_SHA" "$POINTER_SHA"` 必须成功；它证明 A 是 P 的祖先。**不允许把 `POINTER_SHA` 当 entry，也不允许把 P 合回执行分支来重定义 A。**

后续所有命令绑到该树根，记作 `$TREE`。**这不是可选风格**——共享主树常有并发 agent 的未提交改动，而 T0.1 的脚本对脏树是**硬拒**（见 §0.3b）。

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

`byte-equivalence.sh:5` 是 `REPO="${REPO_OVERRIDE:-$(cd "$DIR/../.." && pwd)}"`，`:137` 用 `bun run "$REPO/packages/cli/src/main.ts" start` 起服务器。**即使 `cd "$TREE"`，跑 `/home/xp/src/copilot-api-js/exp/…/byte-equivalence.sh` 起的仍是 master 的代码。** 两条正确写法：

```bash
# 开发趟写法 A（推荐）：用树内那份脚本——REPO 自然推导到 $TREE
cd "$TREE" && EVIDENCE_TIMING=dev exp/inter-block-anchor-allocator/byte-equivalence.sh
# 开发趟写法 B：用任意位置的脚本 + 显式覆盖
EVIDENCE_TIMING=dev REPO_OVERRIDE="$TREE" /home/xp/src/copilot-api-js/exp/inter-block-anchor-allocator/byte-equivalence.sh
# 收口趟：同样显式设 closeout（产物自指，按 §0.4b 必须落 $TREE 外）
cd "$TREE" && EVIDENCE_TIMING=closeout exp/inter-block-anchor-allocator/byte-equivalence.sh
```

⚠️ **写法 B 有一个必须知道的分裂**：`BASELINE`（`:11` `$DIR/pre-change-wire.sse`）与 `deterministic-hook.ts` 跟着**脚本位置**走，而被测代码跟着 `REPO` 走。**这正是想要的**（fixture 是权威基线，不该随被测树变），但你必须知道它是这样，否则会误以为「树里的 fixture 没生效」。**须打印 `O-6 PASS`、rc=0、fixture blob 不变；禁止 `RECAPTURE=1`。**

**③ `traceability-check.py` 与 `q1-locations.sh` —— 根同样由脚本位置推导，但它们审的是文档**

两者都是 `parents[2]`／`$DIR/../..`。**文档在 master 主线上**（CLAUDE.md `docs-merge-before-execute`），所以这两个**本来就该在 master 侧跑**，不要覆盖到 `$TREE`：

```bash
cd /home/xp/src/copilot-api-js && python3 exp/inter-block-anchor-allocator/traceability-check.py
cd /home/xp/src/copilot-api-js && PHASE=pre exp/inter-block-anchor-allocator/q1-locations.sh
```

（`traceability-check.py` 支持 `MATRIX=`／`DESIGN=`／`PLAN=` 覆盖，只用于把 mutation 正控跑在副本上；`q1-locations.sh` 支持 `DOC=`。**不要**用它们把门指向 `$TREE` 里的文档副本。）

> 🔴 **③ 的两条命令与 ② 的写法 B 共享同一个绝对路径前缀 `/home/xp/src/copilot-api-js/exp/inter-block-anchor-allocator/`，而语义相反**——③ **必须**是 master，② 的写法 B 里那个前缀只是「脚本放在哪」、被测树由 `REPO_OVERRIDE` 决定。**照着上下文复制粘贴，很容易把 ② 敲成没有 `REPO_OVERRIDE` 的版本，于是量的是 master。** 第 ④ 条门就是抓这个的。

**④ 门跑在哪棵树 —— 每 commit 共同门的第四条（不是一次性仪式）**

「我 `cd` 对了」不是证据（user-rule `proving-where-a-command-ran`），**而且失效是逐次调用发生的**：写法 B 少打一个 `REPO_OVERRIDE`、复制到 ③ 的行、`$TREE` 变量在新 shell 里没设——每一次都可能悄悄回到 master。**因此本条与 ①～③ 同频，每个 commit 都要。**

`byte-equivalence.sh` 现在会在 spawn 前打三行 provenance、并在 PASS 行重复 `repo=`（`:131-133`、`:194`）：

```text
repo=<被测树>
server_entry=<被测树>/packages/cli/src/main.ts
head=<短 sha> tree=clean|DIRTY
O-6 PASS: captured wire is byte-identical to <baseline> (repo=<被测树>)
```

**判据（每 commit）**：

1. **`repo=` 的值必须等于 `$TREE`**。⚠️ **只能取 `repo=` 这一行，不能取进程 cwd**——脚本从不 `cd`，写法 B 下**它的 cwd 与被测树无关**；用 cwd 判会在写法 B 上给出错误答案。
2. `server_entry=` 落在 `$TREE` 下（同源交叉核对，防 `REPO` 被部分覆盖）。
3. **`head=` 与 `tree=` —— 判据分两趟，别在开发趟上判**（见 §0.4b 的时序定义）：<br>
   • **开发趟**（写完代码 → 跑门 → 再提交）：`tree=DIRTY` 且 `head=` 还是**上一个** commit —— **这是正常的，不判**。<br>
   • **收口趟**（commit 生成后重跑）：断言 `head=` 等于**本 commit 的 sha**、`tree=clean`。<br>
   🔴 **这条区分不是措辞讲究。** 脚本对这两个值**只报不判**（`tree=DIRTY` 照样 rc=0，实测），所以若把判据写成「每次都要 `clean` + 本 commit sha」，**在自然时序下它每次都假红**——而每次假红的门，**第一次收口就会被当噪声删掉，删掉的正好是「门量的是另一个 commit」这道检查**。<br>
   ⚠️ **不要改脚本让它对 DIRTY 判红**：跑门本来就在提交前，那会把正常流程堵死。要定的是**时序**，不是脚本行为。
4. typecheck／测试侧：`bun run typecheck` 与 `parallel-test.ts` 读 cwd，所以 `cd "$TREE"` 已经绑定；**但同样要有一次可复算的证据**——见 T0.10 的哨兵法，它建立的是**判据本身**，不是一次性通过。

> **为什么这条必须是门而不是 task**：T0.10 只在 Commit 0 建立判据；**若不进每 commit 共同门，Commit 1～8 就没有任何一步要求重证**，而上面四种失效方式在每个 commit 都能重新发生。

第 ② 条即 **R-11／O-6**，第 ④ 条是它的树向绑定；**本文各节的「门」表只写 id，不重复这四段。**

⚠️ **这四条门管的是 suite 终态，不管 mutation probe 的退出码。** 本文各处「mutation 必须红」指的是**隔离运行的探针**——它们本就该非零退出，**不受共同门约束**（详见 §0.4c）。把「全绿」推广到探针会把全部正控判成违规。 另外每个 commit 结束还须满足 §7.1 的两条状态断言：本 commit 已激活的 witness 正样本绿、production mutation 红、false-red 对照绿。

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

### 0.4a production 变更判据 —— **tracked 全集 减 显式排除表**（一处定义，全 plan 共用）

多个 commit 的 invariant 都要断言「production 未改动」。**这些断言必须用同一把尺子**，否则会出现「用刚改过的尺子量基线」——T0.1／T0.11 要求 junit 枚举，而最自然的实现就是改 `scripts/parallel-test.ts`（`:64` 已为刷新计时驱动过 junit）；若门扫不到它，**改尺子那次会被判绿**。

> 🔴 **这份清单错过四次，每次换个范围**：只扫 `src/`（漏 `packages/`）→ 整个 `scripts/` 一刀切（误杀 test artifact）→ 漏 `ui-v4/` 与根级构建输入 → 漏 `ui/` 的二级条目。
>
> **第四次的成因与前三次不同，值得单独记**：第三次之后我加了导出命令 `git ls-files | awk -F/ 'NF>1{print $1"/"}'`，但它**只枚举到顶层**；而 `ui/`／`ui-v4/`／`scripts/` 是嵌套项目，**它们的二级条目我又回到「凭想到的列」**——`ui-v4` 列了 6 条、`ui` 列了 3 条，漏的正是没想到的那几个。评审的措辞precise：**「第三次是我没想到，第四次是我以为机器替我想了。」**

**因此本轮反转判据方向，而不是把导出命令递归下去。**

**为什么不选「递归到嵌套目录」**（评审候选 a，已考虑并否决）：它仍是 allowlist，**第五个嵌套项目出现时同样静默**——`ui-v5/`、新的 `packages/*`、或某个现有目录长出二级结构，都不会有人被提醒去更新递归清单。**它修的是这一次的实例，不是复发机制。**

**失败方向不对称，这才是选型依据**：

| 形状 | 漏一项时会怎样 | 可见性 |
|---|---|---|
| allowlist（枚举 production） | 漏掉的**默认在门外** → production 改动被判绿 | **静默假绿**，已发生四次 |
| **exclusion（tracked 全集 减 排除表）** | 漏掉的**默认在门内** → 合法的非-production 改动被判红 | **误红一次、当场可见**，加进排除表即可 |

**判据（全 plan 统一，不在别处另立）**：

```bash
# production 未改动 == 下面这条命令输出为空（FROM/TO 见 §0.4b）
cd "$TREE" && git diff --stat "$FROM".."$TO" -- . \
  ':(exclude)docs/' ':(exclude)tests/' ':(exclude)exp/' ':(exclude)refs/' \
  ':(exclude).claude/' ':(exclude).agents/' ':(exclude).workflow/' \
  ':(exclude).serena/' ':(exclude).superpowers/' ':(exclude).vscode/' \
  ':(exclude)*.md' ':(exclude)LICENSE' ':(exclude)*.gitignore' ':(exclude).gitattributes' \
  ':(exclude)skills-lock.json' ':(exclude)eslint.config.js' ':(exclude)prettier.config.mjs' ':(exclude)knip.json' \
  ':(exclude)config.yaml' ':(exclude)config.example.yaml' \
  ':(exclude)scripts/test-timings.json' ':(exclude)scripts/update-circular-deps-baseline.ts' \
  ':(exclude)ui/tests/' ':(exclude)ui-v4/tests/' ':(exclude)ui/vitest/' \
  ':(exclude)ui/vitest.config.ts' ':(exclude)ui-v4/vitest.config.ts' \
  ':(exclude)ui/playwright.config.ts' ':(exclude)ui-v4/docs/'
```

**排除表逐条理由**（**只需为「排除」举证；不在表里的一律在门内，无需列举**——这正是反转的价值）：

| 排除项 | 为什么不算 production |
|---|---|
| `docs/`／`*.md`／`LICENSE`／`refs/` | 文档与参考资料 |
| `tests/`／`ui/tests/`／`ui-v4/tests/`／`ui/vitest/` | 测试面——cutover 的正事就在这里 |
| `ui/vitest.config.ts`／`ui-v4/vitest.config.ts`／`ui/playwright.config.ts` | 测试 runner 配置（⚠️ **`vite.config.ts` 不在此列**，它是构建配置、在门内） |
| `ui-v4/docs/` | 前端文档 |
| `exp/` | 实验与本 plan 的门脚本；**改门脚本要单独 review**，不走本判据 |
| `scripts/test-timings.json` | 生成的 test artifact，自称「perf hint, not correctness」；C7 删 fixture 后同步它是合法审计 |
| `scripts/update-circular-deps-baseline.ts` | 只写 `tests/architecture/circular-deps-baseline.json` |
| `config.yaml`／`config.example.yaml` | 用户本地状态与样例 |
| `eslint.config.js`／`prettier.config.mjs`／`knip.json` | 工具配置，不改运行时产物 |
| `.claude/`／`.agents/`／`.workflow/`／`.serena/`／`.superpowers/`／`.vscode/` | agent／编辑器配置 |
| `*.gitignore`／`.gitattributes`／`skills-lock.json` | 仓库元数据 |

**门内因此自动包含**（无需维护清单，实测 `git ls-files` 减排除表后的根：`src/`、`packages/`、`ui/`、`ui-v4/`、`scripts/`、`native/`、`hooks/`、`contrib/`、`config.schema.json`、`package.json`、`bun.lock`、`bunfig.toml`、`tsconfig.json`、`tsdown.config.ts`、`start.bat`）。**`ui/` 与 `ui-v4/` 的二级条目现在自动对称**——实测两边都是 `src`／`index.html`／`package.json`／`vite.config.ts`／`tsconfig.json`（＋各自的 `bun.lock`／`bunfig.toml`／`components.json`），**不再需要我逐条想全**。

⚠️ **`scripts/parallel-test.ts` 在门内是有意的**：若 T0.1／T0.11 的 junit 枚举要动它，那是一次**独立的、先于 Commit 0 的基础设施改动**（相位归属见 §0.4b），**不能夹在 cutover 任何 commit 里**。

**四条对照已实跑**（`/tmp` 一次性仓库，未碰本仓）：

| # | 注入 | 期望 | 实测 |
|---|---|---|---|
| M1 | 改 `ui/package.json` | 红 | ✅ `1 file changed` |
| M2 | 改 `ui/bun.lock` | 红 | ✅ `1 file changed` |
| FR1 | 同时改 `ui/tests/`＋`tests/`＋`docs/`＋`test-timings.json` | 绿 | ✅ 输出为空 |
| **FR2** | **新增嵌套项目 `ui-v5/src/x.ts`** | **默认在门内 → 红** | ✅ `1 file changed` |

**FR2 就是「为什么第五次不会静默复发」的答案**：新出现的东西默认被门看见。它可能误红一次——那次误红是**可见的、当场处理的**，不是四个月后才发现 production 改动一直没被门量到。

🔴 **但「当场处理」不等于「当场自己加进排除表」**：判定「这是合法的非-production 改动」与执行「加进排除表」若由同一方完成、且无外部 oracle，**就是 `downgrade-self-adjudicated-gates` 的形状——误红处理会退化成随手 bypass**，而每 bypass 一次，门就少看住一块。

**新增 exclusion 走「当场记录 + 本 commit 收口前裁决」**——⚠️ **粒度是 commit，不是相位**：

> **上一版写「相位收口时批量交裁」是错的**：那允许临时豁免**跨多个 commit 累积**，而那些 commit 的门**实际没受完整约束**就通过了。补票补在相位末，**漏掉的正是「门本该咬住的那一刻」**。

1. **当场（开发趟）**：在门的调用处加一个**具名临时豁免**（不是直接改 §0.4a 的排除表），同时在进度文件记：**哪个路径、为什么算非-production、本次为何不得不放行**；
2. **本 commit 收口前**：完成**独立裁决**（独立 reviewer 或用户）。通过的**正式并入 §0.4a 排除表**，未通过的当场回滚——**两者都必须在本 commit 收口之前完成**；
3. **临时豁免只在开发趟有效**：收口趟**不接受任何残留豁免**；
4. **§0.4a 的排除表只由裁决结果修改**——它是被评审的产物，不是执行者的草稿纸。

**收口命令如何机械拒绝残留豁免**

⚠️ **上一版写 `[ -s "$PEND" ]` 即失败，可被绕**：改文件名、直接往命令里追加 `:(exclude)`、收口前清空或 `rm` 掉 `$PEND`，四种都放行且不留痕（实测：`rm PEND.txt` 后该检查直接 pass）。**同一个病**——它在**推断**「有没有残留豁免」，而让那个文件不存在就绕开了。

**形状：exclusion 只能经单一 wrapper 应用，收口四者对账。**

1. **单一 wrapper**：production 判据**不许手敲**，一律经一个具名 wrapper 调用。任何临时 exclusion **只能作为该 wrapper 的参数传入**，wrapper 负责两件事——把 exclusion 追加进 **applied ledger**（append-only），并把**本次实际执行的完整命令**规范化后取 **`canonical_command_hash`** 一并记下。
2. **收口对账四者**（缺一即拒绝，且必须报出**具体差异**而不只是失败）：

   | 对账项 | 回答什么 |
   |---|---|
   | **pending ledger** | 声称还有哪些未裁决 |
   | **applied ledger**（wrapper 写的） | **实际被应用过**哪些 exclusion——**它不受 `$PEND` 被删的影响** |
   | **裁决回执** | 每条 applied exclusion 是否有对应的独立裁决记录 |
   | **`canonical_command_hash`** | **收口趟跑的到底是不是那条「无豁免」的命令**——把执行者的自述换成可核对的事实 |

3. **`canonical_command_hash` 是这里的承重件**：收口趟必须跑 §0.4a 的**无豁免**形态，其规范化命令的 hash 是一个**固定常量**（该 commit 的 `FROM`／`TO` 已知），**与冻结值不符即拒绝**。这样「我跑的是干净那条」不再是自述——追加了任何 `:(exclude)` 都会改变 hash。
4. **applied ledger 非空但裁决回执缺失 → 拒绝**；**`$PEND` 被删而 applied ledger 有条目 → 拒绝**（这正是绕过 `[ -s ]` 的那条路，现在会被 applied ledger 抓住）。

**正控（四条，各打一条绕法）**：①留一条未裁决豁免 → 拒绝并列出该条；②`rm $PEND` 但 applied ledger 有条目 → 拒绝；③收口趟手动追加一个 `:(exclude)` → **hash 不符**而拒绝；④改文件名另起一份 pending → applied ledger 与裁决回执对不上而拒绝。
**false-red 对照**：全部 exclusion 均已裁决并并入 §0.4a、applied ledger 本 commit 为空、hash 与冻结值相符 → 放行。

🔴 **诚实边界（不得省略）**：**wrapper、两个 ledger 与回执都由执行者自己运行和维护**——它们把「随手绕过」变成「必须动手伪造多份互相印证的记录」，**但不构成执行者无法伪造的证明**。真正独立的一环是**裁决回执来自独立 reviewer 或用户**（§0.4a 要求的那次裁决）。**本项目对此的定性**：这是 `downgrade-self-adjudicated-gates` 意义上的「记录在先、事后裁决」，**不是密码学意义的不可抵赖**。把它写成后者就是假绿。

⚠️ **别把这条读成「不许加排除表」**：反转的前提就是排除表会增长。要防的是**增长过程无人复核**——那会让反转带来的可见性一点点漏回静默。

### 0.4b 门与提交的时序 —— **两趟，别混**（`FROM`／`TO` 在这里定义）

本 plan 全文的门分**两趟跑**。**不写死它，第 ④ 条判据 3 与 T7.3 的 `<from>..<to>` 都无从判断。**

| 趟 | 何时 | 树状态 | 跑什么 | 判什么 |
|---|---|---|---|---|
| **开发趟** | 写完代码、**提交之前** | `tree=DIRTY`、`head=` 还是**上一个** commit | ①typecheck ②全套 ③O-6 ④`repo=`／`server_entry=` | 功能是否正确、门是否跑在 `$TREE`。**不判 `head=`／`tree=`** |
| **收口趟** | **commit 生成之后**，进入下一个 commit 之前 | `tree=clean`、`head=` 本 commit | **重跑 ①②③④** + 本 commit 的 invariant + population 审计 | 全部判据，**含 `head=` 等于本 commit、`tree=clean`** |

**`<from>`／`<to>` 的定义（全 plan 统一，不在别处另立）**：

```bash
TO=$(git -C "$TREE" rev-parse HEAD)          # 本 commit（收口趟才存在）
FROM=$(git -C "$TREE" rev-parse HEAD^)       # 它的父 commit
```

- **落哪棵树**：`$TREE`（entry worktree），**不是 master**——被审的是 cutover 的产物。
- **Commit 0 的 `FROM`** 就是 entry commit 本身；**entry commit 的 sha 在前置基础设施落地后必须重取**（见下）。

🔴 **前置基础设施改动的相位归属**：§0.4a 说 `parallel-test.ts` 的 junit 改造「先于 Commit 0、不能夹进 cutover 任何 commit」。**它落地后 entry commit 就变了**，因此：

1. 基础设施改动在 `$TREE` 上先提交；
2. **重取 entry commit sha = A**，T0.1 的 15 次连跑锚在 **A** 上（锚在旧 sha 上跑的那批作废——它测的是没有 file identity 的 runner）；
3. **日志落 `$TREE` 外**，把 `measured_sha=A` 冻结进**树外 evidence manifest**，master 状态文档只放指针（见 Commit -1 收口与 §0.4b「证据落盘位置」）；
4. Commit 0 的 `FROM` = **A**。

⚠️ **第 3 步之后不得再有任何「为了安放证据」而产生的 commit** —— 那会让 entry 从 A 前移，**日志随即不再描述 entry**，而这正是上一版的循环缺陷。事后归档到 `docs/tmp/` 是允许的，**但它只是副本，不重新定义 entry**（实测：归档后 A 仍是 `HEAD` 的祖先、日志正文 `measured_sha` 不变）。

⚠️ **收口趟必须真的重跑，不能引用开发趟的结果**。差别不只是 `head=`：提交动作本身可能带进未预期的文件（`git add` 的 pathspec 写宽了），而开发趟的绿证明不了这一点。

#### 🔴 证据落盘位置 —— **T0.1 的原始日志必须落在 `$TREE` 外**

**朴素读法下三条要求互斥**（实测确认，别以为是措辞问题）：

1. `OUT=docs/tmp/…` 是**相对路径** → `baseline-runs.sh:105-107` 解析成 `$REPO/$OUT` ⇒ 15 份 `run-*.log` 落在 **`$TREE` 内**；
2. `byte-equivalence.sh:135` 的 `git status --porcelain` **计未跟踪文件**（`/tmp` 探针实测：未跟踪的 `out/run-1.log` 使 porcelain 输出 `?? out/` ⇒ `tree=DIRTY`）；
3. §0.4b 收口趟要求 `tree=clean`。

🔴 **「把日志提交进 commit」解不了它——那个方案是循环的**（曾被采纳一轮，实测证否，留作反例）：日志在 sha **A** 上生成 → 提交进去得到 **B** ⇒ **日志不再描述最终的 entry commit**；另开 evidence commit 同样把 entry 前移，**递归下去没有不动点**。`/tmp` 探针：`A=2856653`、提交后 `B=49cb4c8`，而日志正文仍写 `measured 2856653`。

> **它当初为什么通过了检查**：只验了**机械**半边（提交后 porcelain 为空、`tree=clean` 可达——这半边确实成立），没验**语义**半边（**日志说的还是不是原来那件事**）。**可迁移判据**：验证任何「把 X 放进 Y」的方案，除了问「放得进去吗」，必须问「**放进去之后 X 说的还是不是原来那件事**」。

**处置（三条，实测通过）**：

| # | 要求 | 为什么 |
|---|---|---|
| 1 | **原始日志落 `$TREE` 外**：`OUT=/abs/path/outside/tree`（`:105-107` 的 `/*)` 分支支持绝对路径，实测 `OUT_DIR` 直接取该值、不拼 `$REPO`） | 树内不产生未跟踪文件 ⇒ `tree=clean` 成立，**且 entry sha 不被证据动作改变** |
| 2 | **冻结 `measured_sha=<A>` 写进树外 evidence manifest**（连同 `OUT` 绝对路径、日期、批次） | 它是「这 15 次测的是哪个 commit」的**权威记录**；master 状态文档只放指针，**不反向定义 entry** |
| 3 | **证据可事后归档进仓库**（如 `docs/tmp/<date>-entry-runs/`），但**归档动作产生的 commit 与 entry 无关，绝不反向定义 entry** | 实测：归档后 `HEAD` 前进，但 `A` 仍是 `HEAD` 的祖先、日志正文的 `measured_sha` 不变——**它只是多了一份副本，没有重新定义任何东西** |

**因此收口趟的 `tree=clean` 可达**：证据不在树里，工作区自然干净。**若收口趟发现 `tree=DIRTY`，那是真信号**——有该提交而未提交的东西，或有不该产生的产物。

#### 自指产物是**一类**，不是 entry 日志一个实例

⚠️ **上一版把这条规则只应用到 T0.1 的 entry 日志上，那是错的**（与 manifest 那次同型：补第 N 个实例堵不住一族）。**实测同类至少还有**：

| 产物 | 为什么自指 | 证据 |
|---|---|---|
| **每个 commit 收口趟的 O-6 输出** | `byte-equivalence.sh:133` **每次都打 `head=<当前 HEAD>`** | 探针：输出写 `head=9fb2f24`，提交进去后 HEAD 变 `0d5446e` ⇒ 断裂 |
| **population／invariant 审计报告** | §0.4b 的判据含 `TO=<本 commit sha>` | 同上 |
| T0.10 的树向取证材料 | 可能含当时的 HEAD | 按下面的机械判据逐份判 |
| T0.1 的 entry 日志 | `baseline-runs.sh:123,134,145,152` 记 `head_sha`／`before_head`／`after_head` | 已实测（上文） |

**通用规则（按类，不按实例）**：

> **凡内容含「本 commit sha」的产物，一律落 `$TREE` 外，并把 `measured_sha=<该 sha>` 冻结进树外 evidence manifest；master 状态文档只放指针；树内只放不自指的产物。**

**判据形状：产生方声明，门读声明——不是让门去 grep 猜**

⚠️ **上一版用 `grep -qE "\b($SHA|$SHORT)\b"` 判「这份算不算自指」，两向都漏**：假阴——`HEAD` 字样、**不同长度的 sha prefix**、大写 sha 都能穿过去；假阳——合法的历史说明里碰巧引用当前短 sha 就被误判。**再补第三种模式仍是同一个错**：`grep` 在**推断**产物的性质，而绕过它只需换一种写法。

> **推断型判据的正确升级方向不是换一种推断，是加一个独立的 intent 输入**（记忆 `methodology-relocate-invariant-when-guard-cannot-keep-up`）。

**因此：产物由脚本生成时写结构化标记，门读标记。** 这里**产生方是脚本、不是被门约束的执行者**，所以标记是真正独立的输入（对比 §0.4a 的 pending ledger，那里产生方就是执行者本人——见该节的诚实标注）。

**脚本字段前置基础设施已实现**（协调者 commit `d7f6c222`，本 plan 不改脚本，避免 script／plan 两份分叉）：

| 字段 | 实际格式／验证 | 含义 |
|---|---|---|
| `evidence_timing` | `evidence_timing=dev` 或 `evidence_timing=closeout` | 这份产物出自开发趟还是收口趟；其他值脚本 `exit 2` |
| `measured_sha` | `measured_sha=<完整 40 位小写 SHA>` | **这次测的是哪个 commit**（取代靠 `head=` 反推）；非完整 SHA fail-closed |
| `claims_current_head` | `claims_current_head=true` | 产物断言「`measured_sha` 就是生成时的 HEAD」；故它**自指，必须出树** |

`baseline-runs.sh` 在 stdout 与**每一份** `run-*.log` 输出这三行；两种 timing 的正控已 rc=0、字段 SHA=HEAD。`byte-equivalence.sh` 两种 timing 的**结构化输出路径**已验证；但真请求连续两次 HTTP 500，**因此只声称字段路径正确，不声称完整 O-6 PASS**（4141 未受影响）。

**门的判据变成**：读 `claims_current_head`，为 `true` 则该产物必须落 `$TREE` 外并把 `measured_sha` 冻结进外置 evidence manifest。**没有标记的产物一律按 `true` 处理**（fail-closed：缺声明不等于安全）。

**执行者手写的产物**（审计表、覆盖表、mutation 记录）**在文件头自己写这三行**——它们由执行者产生，所以这一条**不是独立输入而是自述**；对应的诚实边界见 §0.4a 末尾。

**因此可以随 commit 提交的，是判据为空的那些**：mutation 记录、逐 site 覆盖表、纯命令与计数的审计表、进度文件（它记的是意图不是 sha）。`docs/` 在 §0.4a 排除表里，提交它们不会让 production 判据变红。

⚠️ **这里没有循环**（已显式验证，因为「收口趟要跑门、门要产出、产出又自指」看起来像个环）：**产物落树外**，所以跑门**不改变树状态**——探针确认收口趟跑完后 porcelain 仍为空、`tree=clean` 成立，且输出里的 `head=` 仍等于当前 HEAD。**环在「产物出树」这一步就断了。**

⚠️ **`baseline-runs.sh` 拒绝混批次**（`OUT_DIR` 已有 `run-*.log` 即 rc=2）：重跑必须换 `OUT` 目录，**且旧批原样留盘、脚本不打作废标记**。**旧批当场手工标作废**（目录内写 `SUPERSEDED.md`，注明被哪个 `measured_sha` 的哪一批取代）——**entry sha 变更后这里最容易出事**（相位归属见下：旧 sha 那批已作废）。

---

### 0.4c T0.6 的退出语义 —— **三份 SSOT 已对齐（2026-08-04），此处只留口径**

| 文档 | 现在写的 | 状态 |
|---|---|---|
| **本 plan** T0.6／C0 门表／C0 invariant | **rc=0 的 characterization，绿 = 缺陷仍在**；C4 反转断言 | ✅ 已改 |
| **矩阵** `traceability.md` R-3 行 | 同上 | ✅ 已改 |
| **冻结 RFC** `design.md:597`（§7.3）、`:750`（§10.2 R-3 行） | 已补澄清：**「red」修饰「缺陷仍在」，测试自身 rc=0**；并写明按字面读成「测试必须失败」会与共同门互斥、使 C0 终态不可满足 | ✅ 已改（`93e300d3`） |

**统一口径**：**「red characterization」里的 red 指「被观察到的产品缺陷仍在」，不是「测试进程返回非零」。** 上一版按字面读成后者，才产生了「必须红」与「该档确定性全绿」的终态互斥。

⚠️ **这个口径的论域是「进入 Commit 0 默认 suite 的测试」，不要放大**：RFC §7.1 的共同门管的是 **suite 终态**（`unit it http` 确定性全绿），**不管隔离运行的 mutation probe 的退出码**。**本 plan 各处 mutation「必须红」指的正是那类隔离探针——它们本就该非零退出，不受本口径约束。** 把「一律 rc=0」推广到 mutation 探针会把所有正控判成违规。

### 0.4d 已知边界 —— **哪些门是机械的，哪些靠执行期的人守**

**别把本 plan 的门一律当成机械闭合的。** 下表是诚实分层；**把靠纪律守的那类当成机械门，是本 plan 最可能的假绿来源**。

| 门 | 独立性来源 | 等级 |
|---|---|---|
| production 判据（§0.4a 反转形态） | `git ls-files` 的输出**不由执行者决定** | **机械** |
| 树向绑定（§0.3 ④，读 `repo=`） | 脚本打印，**产生方不是被约束方** | **机械** |
| 自指产物外置（§0.4b） | 脚本写 `claims_current_head` 标记 | **机械**（脚本产物）／**自述**（执行者手写的产物） |
| `traceability-check.py` | 独立程序，读文档不接受声称 | **机械** |
| O-6 字节等价 | fixture + `cmp`，双向自检过 | **机械** |
| exclusion 未裁决拒绝（§0.4a） | wrapper／ledger／hash **全由执行者自己跑** | **纪律 + 事后裁决**——见该节诚实边界 |
| 「mutation 确实打中目标机制」 | 靠执行者读 FAIL 消息判断 | **纪律** |
| 「调查证据齐全」（§9.3 各槽） | 靠执行者自评 | **纪律 + kickoff 停门** |
| 「T0.6 的 characterization 仍守着原不变量」 | 靠执行者读测试头部三样 | **纪律** |

🔴 **末四行不是缺陷，是边界。** 它们的共同结构是**同一方既执行又判定、且无外部 oracle**——按 `downgrade-self-adjudicated-gates`，正确处置**不是继续加固**（加固只会让被加固的一方同时也是绕过它的那一方），而是**降级为「当场记录 + 到必经时点交独立方裁决」**，并**在此显式登记**，让接手方知道哪些绿是机器给的、哪些绿是人给的。

**为什么写下这一节**：本 plan 的门经过多轮加固后已经**看起来**很机械。**「看起来机械」正是最危险的状态**——它诱使人说「机器会查的」而放松人工复核，而本项目已有实证：一个**宣称覆盖面大于实际覆盖面的守卫本身就是假绿**（记忆 `methodology-relocate-invariant-when-guard-cannot-keep-up` 的 2026-07-28 条）。

#### 元判断：这是收敛，不是「把靠纪律的流程无限硬套机械门」

**数据，而非感觉**：首两轮评审发现的是 RFC／plan 的真实契约矛盾与执行不可达（T0.6 红绿终态互斥、60 格 false-red、T0.1 证据跑错树、T4 缺调查 owner）；后续 blocker 的位置逐步收缩到**上一轮新加的 meta-gate**（证据落点 → 自指产物 → `grep` 推断／pending 文件推断）。这说明原 cutover contract 已被逐项闭合，剩下的是「我们能否机械证明执行者确实照流程做」这个**不同问题**。

**结论**：机械边界已经收敛到上表前四行——它们有独立输入／外部 oracle。**上表后四行不应继续加推断型门；剩余项应记为已知边界，交执行期的人守。** 具体规则是：

- 若要新增机械门，先指出**产生方与被约束方不同**的结构化 intent／外部 oracle；答不上，**不得再加 regex、文件存在性、计数或另一份 ledger 来猜**；
- 属「纪律 + 事后裁决」的项，当场在进度文件记录，按本文已写的 kickoff／收口触发点交独立 reviewer 或用户裁；
- 评审后若只剩这类已登记边界，**可以放行进入执行**，不以「还能再造一个推断 gate」为由无限阻塞。

这不是降低不变量：TDD、production witness、mutation、独立 review 和用户裁决都仍在；改变的是**谁在何时裁定**，不再把执行者自己的自述伪装成机械事实。

---

### 0.4e Mutation 共同协议 —— **Commit -1 的 T0.0a、T0.0b、T0.0c 必须走隔离，不得在将成为 entry 的 `$TREE` 上变异**

T0.0a、T0.0b、T0.0c 的三类正控都要**主动改坏 runner／test**。若在将成为 entry 的 `$TREE` 上做，会出现两种已知灾难：①从**不含真实实现**的基线恢复，把刚写好的 runner 一起抹掉；②共享／执行树上整文件覆盖恢复，抹掉同伴或尚未提交的真实 WIP，或把残余 mutation 提交成 entry A。**这不是「小心一点」能解决的风险，是 `mutation-baseline-must-contain-the-real-impl` `[hard]`。**

**允许路径二选一**：

| 路径 | 何时用 | 机械步骤 |
|---|---|---|
| **A．第二隔离 worktree／`/tmp` 一次性 repo（推荐）** | mutation 分散、跨多文件，或无法构造精确 patch | 先确认该树的基线**含真实实现**（`git show <ref>:scripts/parallel-test.ts` 等）；在隔离树改坏、跑正控、读目标 FAIL；隔离树内可整树恢复；结束后 `git diff` 复核 |
| **B．冻结 exact patch** | mutation 只改一处或少数可精确描述的 hunk | **先构造只描述目标 mutation 的 patch，再注入 mutation**（不是变异前跑 `git diff`——那会把真实 WIP 一起捕进 patch）；正控前先证明目标 hunk 真变了；恢复前 `git apply --reverse --check <patch>`，失败／重叠即**停下问**；用同一 patch 反向应用恢复；恢复后 `git diff` 复核只剩 mutation 前已有改动，出现不属于冻结 patch 的改动即停 |

**所有 Commit -1 mutation 的顺序**：①确认基线含真实 runner；②注入 exact target mutation；③**先证明目标 hunk 真变了**；④跑门；⑤**读 FAIL 消息，确认红来自目标机制**（不是旁路断言／环境／mutation 没生效）；⑥按 A/B 恢复；⑦恢复后 `git diff` 复核。**只看 rc 不算通过。**

> 这条是共同 protocol，**不要在 T0.0a、T0.0b、T0.0c 各复制一遍**；task 只说各自要改坏什么。

---

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
- **收口证据在 commit 生成后重跑**（§0.4b 的收口趟）：`head=` 等于本 commit、`tree=clean` 只有那时才成立，且提交动作本身可能带进未预期的文件。**开发趟的绿不能当收口证据引用。**

> 🔴 **Commit 4 是本 plan 唯一「中断即全丢」的结构**：16 个 task 同属一个 semantic commit，中途按设计**不产生 commit**，所以 git log 上什么都没有。**因此 Commit 4 的进度文件必须逐 task 更新并单独提交**（进度文件在 `docs/tmp/`，与 `src/` 改动分开 pathspec，不破坏「Commit 4 不拆」）。每完成 T4.x 就写一行：做完了什么、下一个 task 需要的前置在哪、已经否掉了哪条路。

---

## Commit -1 — Entry test-discovery oracle 基础设施（**不是 cutover commit，必须先收口**）

**目标**：让实际 `parallel-test` shard 的运行时 file identity 与独立磁盘 manifest 逐次对账；没有它，T0.1 的 15 次只会证明 runner 自己报告一致，**证明不了 shard 静默漏文件时门会红**。

> ⚠️ **`d7f6c222` 只实现了结构化 evidence intent，没实现这个 oracle。** 当前 `parallel-test.ts` 的 JUnit 只在 `refreshTimings()`（`:61-70`，`--update` 的另一次 run）；真实 shards 在 `:120` 跑裸 `bun test`，`:157-167` 只正则聚合 pass/fail。**前置基础设施当前不能声称已过门。**

### 逐 task

| id | 先写什么失败测试 → 预期怎么红 | 实现什么 → 预期怎么绿 |
|---|---|---|
| **T0.0a** | 从**独立磁盘 manifest** 枚举 `tests/**/*.{unit,it,http}.test.ts`，再让真实 shard 执行产出 file-level JUnit identity。**先在 `balance()` 之后、spawn 之前从某 bucket 删一个文件**——必须报出**缺失的具体文件名**。⚠️ 打在 `discover()` 的 mutation 不够，它抓不到这层。 | 每一次门运行的实际 shards 各自产 JUnit，runner 合并 file identity；**每次**与磁盘 manifest 双向比较，缺／多任一文件即 rc≠0。正确状态绿。 |
| **T0.0b** | skipped identity multiset：整文件 skip、native 不可用 skip、todo 文件各一；**mutation 把一条 runnable test 改 skip**，必须报它的 `file+classname+name+ordinal`，不许只报少了一个数。 | 输出 `executed`／`skipped` 两数与 skipped identity multiset；native history-search 这类环境 skip 独立具名 disposition。 |
| **T0.0c** | runner 自身 mutation control：把 JUnit reporter 只加在 `refreshTimings()` 而不加真实 shards → file identity 门必须红；把 JUnit 合并器丢一个 shard → 门必须红。 | 真实 shard 的 identity 被收集，mutation 都红；正确 full run 绿。 |

> ⚠️ **T0.0d 不属于 Commit -1**：它需要 A／15 logs／pointer P，而这些输入只在 Commit -1 合 master之后才存在。把它列为 Commit -1 自己的收口门，等于**用未来输入验过去 commit**——因果不可达。它已移到 §0.4f 的 **post-merge entry-evidence preflight**。

### 本 commit 的门（前置基础设施自己的门）

| 门 | 判据 |
|---|---|
| shard 漏文件正控 | T0.0a 在 `balance()` 后删文件 → rc≠0 且点名该文件 |
| skipped 多集正控 | T0.0b 把 runnable 改 skip → rc≠0 且点名该 identity |
| runner 接线正控 | T0.0c 两条 reporter／merge mutation 各自因目标机制红 |
| 正样本 | 正确真实 shard run：磁盘 manifest＝运行时 identity；executed／skipped 口径一致 |
| 收口 | `bun run typecheck` 绿、前置基础设施自己的测试绿、上面三种 mutation 红；**此 commit 本身不得被 T0.1 的 15 次自洽运行替代验收**。T0.0d 的 evidence 消费门属于 P 后的 post-merge preflight，**不在本 commit 验** |

### 收口与 entry 重锚（不可省略）

1. 本 commit 收口后，**重取 entry sha = A**；
2. T0.1 的 15 次只对 **A** 有效；任何在此之前跑出的 15 次作废；
3. 原始日志落 `$TREE` 外（§0.4b），脚本结构化字段中的 `measured_sha` 必须 = A；
4. 建立**树外 evidence manifest**（推荐 `OUT/evidence-manifest.json`），至少含：`measured_sha`、`evidence_timing`、绝对 `OUT`、run log 文件清单、磁盘 manifest hash、运行时 identity manifest hash、`executed`／`skipped` multiset hash、命令与时间；它是「这 15 次测了什么」的权威，不在 git 工作树里；
5. **master 状态文档只放指针**：执行时更新 `docs/plan/2026-07-27-inter-block-anchor-allocator/HANDOVER.md` 的「entry evidence」状态行（这是 master 上的状态真相源），写 `measured_sha=A`、树外 manifest 的绝对路径／hash、归档副本的位置、以及「该 pointer commit 不定义 entry」这一句。**该指针只回答「证据在哪里」，绝不写「当前 HEAD=A」或反向定义 entry**；pointer commit 是 A 的后代，不改变 A 是 entry 的事实；
6. 进度文件 frontmatter `base` **保留任务起始基线／plan 工作起点**，不冒充 entry truth；HANDOVER pointer P 只在 master 状态线被引用。接手方通过 validator 的外部 `ENTRY_SHA=A` 与 P 的 Git 图关系找到证据，**不要求 A tree 自含未来 P**。

> **为什么不用把 `measured_sha=A` 直接写进 `$TREE` 的 plan**：写 plan 会产生新 commit B，entry 就从 A 前移到 B，而日志仍测 A——循环重现。**树外 manifest 冻结 A，master 指针只定位 manifest；归档动作不重新定义 entry。**

### Post-merge entry-evidence preflight —— **P 后、Commit 0 前；不是 Commit -1 收口门，也不是 cutover commit**

**因果相位（已裁 Git 图）**：Commit -1 在独立树收口 → 合 master 得 **A** → 从 A 建 cutover worktree → 树外跑 15 次／生成 manifest → master 提交 pointer **P** → **此处运行 T0.0d** → 才允许执行树进入 T0.1／Commit 0。

> ⚠️ **T0.0d 不能列在 Commit -1 收口门里**：它需要 A／15 logs／P，而这些输入只在 Commit -1 合 master**之后**存在。把未来输入拿去验过去 commit 是因果不可达；这不是「task 放哪方便」的排版问题。

| id | 先写什么失败测试 → 预期怎么红 | 实现什么 → 预期怎么绿 |
|---|---|---|
| **T0.0d**（post-merge preflight） | entry evidence 消费 validator：先对正确 A／P／树外 manifest／15 原始 logs 跑一遍绿；再按下表**逐行**注入 mutation。 | validator 绿后才允许执行树开始 T0.1／Commit 0。pointer 缺失／树外 manifest 缺失**一律 fail-closed，不是 warning**。 |

**单一 validator 的输入**：

- validator 调用方提供的外部参数 **`ENTRY_SHA=A`** 与 **`POINTER_SHA=P`**（均为完整 40 位 SHA；不写进 A tree）；
- 由 `git show "$POINTER_SHA":docs/plan/2026-07-27-inter-block-anchor-allocator/HANDOVER.md` 读取的**唯一、机器可定位的 entry-evidence pointer block**（格式固定为 `<!-- entry-evidence-pointer:v1 -->` 到 `<!-- /entry-evidence-pointer:v1 -->`）；
- pointer block 指向的**树外** `evidence-manifest.json`；
- manifest 记录的 15 份原始 `run-*.log` 与每次真实 shard JUnit artifact。

**validator 必须逐条验证，任一缺失／不等即非零退出。** 🔴 **不接受「manifest 内部自洽」当证据**：一次错误生成 manifest 与 artifact 可以一起错；必须从**原始 artifact 独立重算**再比 manifest。

#### Validator condition → mutation ID 对账

**condition 表只定义被测性质；最后一列只引用稳定 mutation ID。** 不再把「缺／多／hash 不等」这类不同机制折进同一个 action。

| # | 机械检查（从何处独立重算） | fail-closed 条件 | mutation IDs |
|---|---|---|---|
| 1 | `POINTER_SHA` 是完整 SHA 且当前 master 状态线包含 P：`git merge-base --is-ancestor "$POINTER_SHA" master` 成功；再 `git show "$POINTER_SHA":HANDOVER` | P 缺失／不是 master 可达状态线／`git show` 失败 → fail；**不许猜 P=当前 master HEAD** | `EV-01`, `EV-02` |
| 2 | 从 `git show "$POINTER_SHA":HANDOVER` 提取**唯一** `entry-evidence-pointer:v1` block | block 缺失／多于一个 → fail；不靠未规定格式的 blame／自然语言 grep | `EV-03`, `EV-04` |
| 3 | pointer block 含 `entry_sha`、manifest path、manifest sha256 | 任一字段缺失 → fail | `EV-05`, `EV-06`, `EV-07` |
| 4 | pointer block 的 `entry_sha == ENTRY_SHA == A`；preflight 中 `git -C "$TREE" rev-parse HEAD == ENTRY_SHA`；`git merge-base --is-ancestor ENTRY_SHA POINTER_SHA` 成功 | 任一不等／Git 图关系不成立 → fail；**P 是 A 的后代，不许拿 P 代替 A** | `EV-08`, `EV-09`, `EV-10` |
| 5 | pointer 的 manifest path 存在；从原始 manifest bytes 重算 `sha256(manifest)` = pointer block 冻结 hash | 树外 manifest 被清理／覆盖／hash 不等 → **fail，不是 warning**；pointer 不能凭空恢复它 | `EV-11`, `EV-12` |
| 6 | manifest 的 run log 列表**恰 15 个**；每个原始 log 存在且独立 `sha256(log)` = manifest 记录 | 缺／多／hash 不等 → fail | `EV-13`, `EV-14`, `EV-15` |
| 7 | 从每份**原始 JUnit**重算 file identity 集合；15 次逐次比较，并与磁盘 manifest／manifest 记录比对 | 任一 run 缺／多文件或与 manifest 不等 → fail | `EV-16` |
| 8 | 从每份原始 JUnit + log 重算 skipped identity multiset（`file+classname+name+ordinal`）与 `executed`；15 次逐次比较，并与 manifest 记录比对 | 任一 skip identity／executed 不等 → fail | `EV-17` |
| 9 | 从每份原始 log 重取 canonical command、`evidence_timing=closeout`、完整 `measured_sha=A`、`claims_current_head=true` 与 run verdict | 任一字段缺失／不等／verdict 非绿 → fail | `EV-18`, `EV-19`, `EV-20`, `EV-21`, `EV-22` |
| 10 | 从原始 disk manifest、runtime identity manifest、skipped multiset artifact **重算各自 hash**，再比 evidence manifest 记录 | 任一空值／hash 不等 → fail | `EV-23`, `EV-24`, `EV-25` |

#### Evidence validator mutation 表（**每个 ID 只改一个输入**）

| ID | condition # | 单一 action | 唯一预期 FAIL |
|---|---:|---|---|
| `EV-01` | 1 | 提供不存在的 `POINTER_SHA` | `FAIL C1: pointer SHA does not resolve` |
| `EV-02` | 1 | 提供不在 master 祖先链的 `POINTER_SHA` | `FAIL C1: pointer SHA is not master-reachable` |
| `EV-03` | 2 | 删除 pointer block | `FAIL C2: pointer block missing` |
| `EV-04` | 2 | 添加第二个 pointer block | `FAIL C2: pointer block is not unique` |
| `EV-05` | 3 | 删除 pointer block 的 `entry_sha` 字段 | `FAIL C3: entry_sha missing` |
| `EV-06` | 3 | 删除 pointer block 的 manifest path 字段 | `FAIL C3: manifest path missing` |
| `EV-07` | 3 | 删除 pointer block 的 manifest sha256 字段 | `FAIL C3: manifest sha256 missing` |
| `EV-08` | 4 | 把 pointer block 的 `entry_sha` 改为 B | `FAIL C4: pointer entry SHA differs from ENTRY_SHA` |
| `EV-09` | 4 | 让 `$TREE` checkout 到 B | `FAIL C4: execution HEAD differs from ENTRY_SHA` |
| `EV-10` | 4 | 提供包含 pointer block 但不含 A 的 `POINTER_SHA` | `FAIL C4: ENTRY_SHA is not an ancestor of POINTER_SHA` |
| `EV-11` | 5 | 删除树外 evidence manifest | `FAIL C5: evidence manifest missing` |
| `EV-12` | 5 | 修改 pointer block 的 manifest sha256 | `FAIL C5: evidence manifest hash mismatch` |
| `EV-13` | 6 | 删除 manifest 列出的一个 run log | `FAIL C6: run log missing` |
| `EV-14` | 6 | 向 manifest 添加第十六个 run log 条目 | `FAIL C6: run log count is not 15` |
| `EV-15` | 6 | 修改一个原始 run log 的字节 | `FAIL C6: run log hash mismatch` |
| `EV-16` | 7 | 从一个原始 JUnit 移除文件 identity | `FAIL C7: JUnit file identity mismatch` |
| `EV-17` | 8 | 把一个 runnable JUnit case 标成 skipped | `FAIL C8: skipped identity multiset mismatch` |
| `EV-18` | 9 | 修改一个原始 log 的 canonical command | `FAIL C9: canonical command mismatch` |
| `EV-19` | 9 | 修改一个原始 log 的 `evidence_timing` | `FAIL C9: evidence timing mismatch` |
| `EV-20` | 9 | 修改一个原始 log 的 `measured_sha` | `FAIL C9: measured SHA mismatch` |
| `EV-21` | 9 | 修改一个原始 log 的 `claims_current_head` | `FAIL C9: current-head claim mismatch` |
| `EV-22` | 9 | 修改一个原始 log 的 verdict | `FAIL C9: run verdict is not green` |
| `EV-23` | 10 | 修改 disk manifest hash | `FAIL C10: disk manifest hash mismatch` |
| `EV-24` | 10 | 修改 runtime identity manifest hash | `FAIL C10: runtime identity manifest hash mismatch` |
| `EV-25` | 10 | 修改 skipped multiset hash | `FAIL C10: skipped multiset hash mismatch` |

#### Mutation table mechanical reconciliation

**本对账由 Commit -1 validator 的测试辅助脚本执行；不接受人工声称。** 它必须输出四项：

```text
condition coverage: C1=2 C2=2 C3=3 C4=3 C5=2 C6=3 C7=1 C8=1 C9=5 C10=3
mutation ownership: 25 IDs each map to exactly one condition
duplicate IDs: none
orphan IDs: none
```

- 每个 condition 至少一个 ID；
- 每个 ID **恰好**属于一个 condition；
- `EV-01`…`EV-25` 无重复；
- 不存在 condition 表未引用的 ID，也不存在 mutation 表未列出的 ID；
- **action 列**动作文本扫描 `／|分别|之一|任一` 必须 **0 命中**——这些词出现时说明又把多个机制合进一个 action；说明文字可用这些词，action 列不可用。

**正样本**：正确 `ENTRY_SHA=A`、正确 Git 图、15 原始 logs/JUnit、三类 hash 与每次独立重算一致为绿。

> ⚠️ 这是**消费门的需求与验收形状**，不在本 plan 内发明 validator 脚本实现。它由 Commit -1 基础设施交付者交付、独立评审；直到它实际存在并通过上表每个 `EV-*` mutation 前，**T0.1 不能开工**。

---

## Commit 0 — Legacy 基线、旧缺陷 characterization 与 oracle 分型

**目标**（RFC §7.3）：不改 production；冻结 O-1／O-2／O-6 与现有 goldens、搭建 handle-level physical recorder 并自检、把测试面分四类、并把「旧生成 delivery 的完整能力面」按 §7.2 的双向闭包冻结成 A／B／C／D 四集。

### 逐 task

| id | 先写什么失败测试 → 预期怎么红 | 实现什么 → 预期怎么绿 |
|---|---|---|
| **T0.1** | **入场条件，不是测试。** 🔴 **本条依赖一件尚不存在的基础设施，见右栏——先建它，别硬跑。**<br>**① `MIN_TESTS` 不能从待测命令自己取**（`baseline-runs.sh:23-25` 逐字点名的假绿：selector 悄悄缩窄，「实测」出 6800，下限也冻成 6800，此后每次都与自己一致）。<br>**② 口径必须先定死：`MIN_TESTS` 比的是 `executed = tests - skipped`，不是 JUnit 的 `tests`。** 两边口径**现在是相反的**——Bun JUnit 的 `<testsuites tests=N>` **含 skipped／todo**，而 `parallel-test.ts:148-167` 把 `tests` 定义为 `passSum + failSum`（**不含 skipped**）。**照 JUnit 总数取 floor，正确状态必然过不了**：仓库现有整文件 `describe.skip`、native `skipIf`、`test.todo`；且 **native 产物在主树存在而在新建隔离树天然没有**，那批测试在 `$TREE` 会 skip——**同一 commit 在两处的 `tests` 数不同，`executed` 才稳定**。 | 🔴 **前置基础设施（本 task 无法绕过，也不得夹进 cutover 任何 commit —— 见 §0.4a）**：<br>**`parallel-test.ts` 当前不为门运行产出 file identity**。它的 JUnit 只存在于 `refreshTimings()`（`:61-70`，`--update` 时**另起一次**独立 run），而真正的门运行在 `:120` 用**裸 `bun test`** 起 shards、无 reporter，`:148-167` 只聚合 pass/fail 总数。<br>⚠️ **因此「磁盘 glob vs 一次 refresh JUnit」只能证明 `discover()` 当时完整**——它**证不了** `balance()` 之后、bucket spawn、以及那 15 次实际运行没有静默漏 shard／漏文件。**而 plan 自己的正控恰恰是「让某个 shard 静默少跑文件」**，用另一次运行的证据给这次运行背书，正是前几轮反复在堵的形态。<br>**要做的**：让**每一次**门运行的实际 shards 各自产 JUnit，runner 内合并 file identity；**每次**都与独立磁盘 manifest 双向比集合，缺一文件即 rc≠0，并**分别输出 `executed` 与 `skipped` 两数**。<br>**正控**：在 **`balance()` 之后、spawn 之前**从某 bucket 删一个文件 → 必须报出**缺失的文件名**（打在 `discover()` 上的正控抓不到这一层）。<br>**false-red 对照**：整文件 skip、native 不可用而 skip、`todo` 文件——实测 Bun JUnit **仍为它们输出 file-level `<testsuite>`**，故「被发现」成立、合法为绿。<br>
🔴 **但「另记 skipped 数」不够——必须逐次核对 skipped 的 identity set**：只比数量时，**把一条 runnable test 改成 skip、同时另一条 skip 改回 runnable，总数不变而 floor 被悄悄降低**。判据是**每次运行的 skipped test identity multiset**与冻结集合相等；不等时必须报出**具体是哪几条变了**，再逐条 disposition（`freeze-hit-set-not-zero-hits`）。<br>**identity key 定义**（缺任一项都会把不同的 case 混成一条）：`file` + `classname` + `name` + **`ordinal`**（同名 case 在同文件内的出现序号——参数化与模板名会产生同名项，只用前三项会把它们折叠）。**用 multiset 不用 set**，理由同上。<br>
**mutation**：把任意一条 runnable test 改成 `skip` → 必须报出**该条的 identity**（只比 executed 数的版本会因为 floor 是 `>=` 而放过它）。<br>
⚠️ **native 那批要具名，不能混进「正常 skip」当背景噪声**：`history-search` 的 `.node` 产物**主树有、新建隔离树天然没有**，故 `describe.skipIf(!isNativeHistorySearchAvailable())` 那批（本文写作时 **18 条**，**执行时按上述 identity set 实测重取，别引用这个快照数**）在 `$TREE` 会 skip 而在主树会执行。**按项目契约这是可接受的**（CLAUDE.md 明写不得强制构建 native、有产物就真跑没有就显式 skip），**但必须在冻结集合里单列一类具名审核**——否则「环境性的 skip」会成为掩护，本项目 2026-07-28 已因此把环境性的红当「既有失败」挥手放过一次。<br>**然后**才是 15 次：`cd "$TREE" && EVIDENCE_TIMING=closeout OUT=/abs/path/outside/tree/<date>-entry-runs RUNS=15 MIN_TESTS=<executed 口径的数> exp/inter-block-anchor-allocator/baseline-runs.sh`，rc=0 且保存每次原始输出。<br>🔴 **`OUT` 必须是 `$TREE` 之外的绝对路径**——相对路径会解析成 `$REPO/$OUT`（`:105-107`），日志落进树里就再也回不到 `tree=clean`，而「把它们提交进去」是**循环的**（见 §0.4b「证据落盘位置」）。**跑完把 `measured_sha=<当时的 HEAD>` 连同 `OUT` 路径与批次冻结进树外 evidence manifest，并由 master 状态文档只放指针**。<br>⚠️ 必须在 **`$TREE`（干净的隔离 worktree）** 里跑**树内那份**脚本（`REPO` 由脚本位置推导、无 override，见 §0.3b）。**`ALLOW_DIRTY=1` 禁止用于通过本条**。重跑换 `OUT` 目录。<br>⚠️ **这就是 HANDOVER 的 T3-b**。它落地前本条只能按缩小版命题引用，**不得表述成「全后端套件已验证」**。 |
| **T0.2** | 先把 O-6 脚本在**未改动的 `$TREE`** 上跑一次，确认打印 `O-6 PASS`、rc=0、fixture blob 未变；再注入一字节，确认 rc=9。**这是 false-red／false-green 双向自检，不是形式**——该门此前恒真（脚本覆盖自己的基线、全脚本无 `cmp`），`4f7a3989` 才修好。 | 把这两条写进每 commit 检查清单，绑根方式照 §0.3 ②。**禁止 `RECAPTURE=1`**。<br>**先确认手上是修好的那份**：`grep -c 'O-6 PASS' exp/inter-block-anchor-allocator/byte-equivalence.sh` ≥1（**看文件存在不够**）。 |
| **T0.3** | 写 handle-level physical recorder，**先让它在「什么都没包住」的状态下断言零 direct send**——此时断言平凡为真，是**假绿**。 | recorder 必须包裹 composition root 实际取得的 `stream`／`ws` handle 并**位于 raw emitter 之下**；再加一条 test-only direct-send seam，断言 recorder **确实看得见**绕过 owner 的发送。看不见就说明探测层装错了深度（RFC §10.1「探测深度必须与被测对象对齐」）。**注入 owner 的 test raw adapter 不用于本判定**。 |
| **T0.4** | 对 warmup fake／drop 写真实 route behavior test：断言完整字节、upstream 零调用、delivery observer **零 session**、一次响应。**先在缺失 observer 的状态下跑**，确认「零 session」这条断言此刻还够不到 delivery 层。 | 接上 delivery session observer（`delivery/session.ts:74` 的 `setDeliverySessionObserverForTests`，**已存在，不用自己造**），四条断言转绿；mutation「提前创建 owner」或「双写」必须红。这是 **Q3 已裁方案 A**，是 §5 唯一没有现成 behavior witness 的出口，也是 composition-root 互斥性的 gatekeeper。 |
| **T0.5** | 对 AUQ fallback SSE 与四格式 non-streaming JSON 各写一条 route observer 基线：断言该 operation 零 delivery owner、完整响应只写一次。**先构造「提前创建 owner」的 mutation 确认它会红**。 | 基线转绿。注意 AUQ 的正确状态是 **upstream／ctx 可能已存在但 client wire 未 commit**——不得把「有 upstream」误判成「有 owner」。 |
| **T0.6** | 🔴 **本条的形状被重写过，别照「提交一个红测试」执行**——那与共同门「`unit it http` 确定性全绿」**终态互斥**（RFC §7.1 同样要求每 commit 全绿）。<br>**正确形状：写一条进程退出码为 0 的 characterization test**，它**断言旧缺陷被稳定观察到**：让一个与 active anchor index 同字节的 stop 走普通 generic `write`，然后断言「wire 已 closed **且** owner lease 仍 open」这一分裂**确实发生**。**测试绿 = 缺陷在**。<br>**先把断言写反**（断言 lease 已被清除）跑一遍确认它红——否则这条 characterization 可能根本没触达那条分裂。 | 转绿（`rc=0`），并在测试文件头**落盘三样**：①它守的是什么（R-3 的旧缺陷现状）；②**它为什么现在是绿的**（绿 = 缺陷仍在，不是「已修」）；③**何时必须反转**——Commit 4 的 T4.5／T4.7 把 authority 发布后，本测试**必须**改成相反的正确性断言，届时「维持原样仍绿」即说明 authority 没生效。<br>⚠️ **不得用 `skip`／`todo` 把它排除出默认发现集**——那样 R-3 的 C0 辅助门可被假绿（跳过的测试永远不会告诉你缺陷是否还在）。 |
| **T0.7** | 实现 §7.2 的**双向不动点闭包**并先跑一次：种子 = §7.2 列出的 6 个 capability 类型（**按 declaration identity 取，不按文件路径也不按名字文本**）；向上（消费者）+ 向下（成员，含**声明**的参数与返回类型）交替迭代。**先构造一个反例确认判据有牙**：`createGenerationWireIndexAllocator()` 零参数、返回类型不是种子——只做向上方向时它与调用点 `messages/handler-v4.ts:1160` 都进不了闭包，**必须**由向下方向捞进来。 | 输出完整 symbol hit set（不是数字），再切成互不相交的 A／B／C／D 四集。四条结构停止点写死（原始／内置类型、`node:`、`node_modules`、别名解析后判断），`any`／`unknown` **不是停止点**、落入 unclassified 并具名 disposition。C／D 相交时按 §7.2 tie-break：**construction／resolution 语义优先归 C，有疑义入 C**。任何 export／production reference 既未进 A／B／C、也未被具名判为合法 pre-owner／test-only，**Commit 0 与 Commit 4 均 fail loud**。 |
| **T0.8** | 把测试面分四类（owner-backed array adapter／raw transport 字节与 observation unit／owner→adapter seam／**test-only adversarial 旧边界正控**）。**先验证第四类真的还能在旧边界造出 wire／state 分裂**——造不出来说明它已经被「合法化」掉了，那正是 R-10 要防的。 | 四类分档落盘。<br>⚠️ **口径数字（92 fake 构造点／40 文件、57 编译期 sink API 依赖文件、65 raw factory 调用／14 文件）来自 `docs/tmp/2026-08-03-emission-surface-inventory.md` §9，锚在 `854421d4`（= 合并前的 feature `src/`，与今日 master 的 `src/` 逐字节相同，但 `tests/` 已随 merge 变化）。本 task 必须在 `$TREE` 上重算这三个数并记差异**，别照抄。<br>**不得机械把所有 fake 改成合法 owner 路径后丢掉 positive control**。 |
| **T0.9** | 冻结现有 anchor／terminal goldens 的文件清单与当前哈希；对每份写明它锁的是什么。**先挑一份注入帧重排，确认它会红**——不会红的 golden 是摆设。 | 清单落盘，作为 Commit 4 「Q5 逐帧预测 diff」的比对基座与 Commit 7 审计对象。 |
| **T0.10** | **建立「门跑在哪棵树」的判据**（§0.3 ④，user-rule `proving-where-a-command-ran`）。**先在不做任何绑定的情况下跑一次 O-6**，读它打出的 `repo=` —— 那一行会指向 master，**这就是 F-1 那 24 次假绿的实物**。 | 判据落盘，并**进入每 commit 共同门第 ④ 条**（不是本 commit 一次性做完）：<br>**O-6 侧** —— 断言 `repo=`／`server_entry=`／`head=`／PASS 行的 `repo=` 四项（判据全文见 §0.3 ④）。⚠️ **只取 `repo=` 行，不取进程 cwd**：脚本从不 `cd`，写法 B 下 cwd 与被测树无关。<br>**typecheck／测试侧** —— 在 `$TREE` 里植入一条**只在该树存在**的哨兵（会失败的临时断言），确认门看得见它，再撤除。<br>⚠️ **哨兵是「建立判据」的一次性动作，不是判据本身**——判据是「每个 commit 都按 §0.3 ④ 核对 `repo=`」。**别把 T0.10 读成「Commit 0 做完就不用管了」**：写法 B 少打 `REPO_OVERRIDE`、把 ② 敲成 ③ 的形状、新 shell 里 `$TREE` 没设——这三种失效**每个 commit 都能重新发生**。 |
| **T0.11** | **test-oracle manifest**（T6.5 的 coverage gate 依赖它，见 §Commit 6）。**先确认默认 runner 对「删掉一条测试」是绿的**——那正是 T6.5 的 mutation 需要被咬住的形态。 | 冻结三样并落盘：①四类分档里 **adversarial 旧边界正控**的测试**文件路径**；②这些文件**运行时枚举**出的 test name 集合（**用 `--reporter=junit` 取，不用 `rg` 扫 `test("...")`**——后者对参数化与模板名结构性失明）；③**该 seam 依赖的 production symbol identity，外加一个空的『迁移关系』槽位**（C0 时为空，C4 填）。<br>🔴 **第 ③ 项绝不能写成「这些 identity 必须恒存」**——现有 seam 直接依赖 `OwnerRawSink`（`:20`）、`createDownstreamDeliverySession`（`:31`）与 allocation port，而 **T6.2／T6.4 的正事就是删掉它们**，T4.15 还要把 raw tests 迁到 test-only entrypoint。**恒存判据会把正确迁移判红**——与上一轮 T0.10 同型：新加的门自己没过检验。<br>锚点：`tests/pipeline/allocation-outside-owner-control.it.test.ts`（已存在；`:20,31` 即上述依赖）。 |

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
| `classifyOwnerFailure` / `OwnerTerminalDecision` | `delivery/owner-failure.ts:41` / `:11` | **M1 新模块**。⚠️ **它管的是任意 owner command 失败**（经 `driver.ts:933 ownerFailureOutcome`，调用点 `:886,1018,1060,1106,1186,1525,1583` 多数是 `beginLeg`），**不只 terminal**——与 `TerminalEmissionResult` 是正交轴，见 §11 #6 |
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
| — | **每 commit 共同门：门跑在哪棵树** | §0.3 ④ —— 断言 O-6 打出的 `repo=` 等于 `$TREE`（**不取 cwd**） |

### commit invariant

production 源码与运行时行为**逐字节不变**（**按 §0.4a 的判据**：tracked 全集减排除表，输出为空）；A／B／C／D 四集全部原样存活；新 core 不存在；**T0.6 的 characterization 绿**（绿 = 旧边界的 wire／lease 分裂仍在，其头部三样已落盘）；typecheck 绿、`unit it http` 确定性全绿、O-6 PASS；**T0.10 已证明这三条门跑在 `$TREE`**。

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
| **T1.6** | `openMessageEnvelope`／`runEmissionBatch`／typed `TerminalEmissionResult` 的**类型层**存在性与 `terminalFrameDisposition` 三态（`emitted` / `suppressed_client_gone` / `suppressed_session_terminating`）穷尽性 unit。 | 转绿。**`finalize(result)` 只能消费本 owner 签发的 opaque result**——类型层先把「无 result 时只允许 client-aborted／零 terminal-frame 分支」表达出来。<br>🔴 **前置停门：§11 #6 未裁则本 task 不可开工。** M1 的 `OwnerTerminalDecision`（`delivery/owner-failure.ts:11`）已经有一套三态，**本 task 一旦把 `terminalFrameDisposition` 三态写进类型层并加穷尽性断言，形状就定死了**——之后 T2.7／T3.5／T4.10 全建在它上面。**这是 #6 最早咬人的地方，不是 Commit 4。** |
| **T1.7** | 属性存在性快照工具（§0.4 第 2 条）在 Commit 0→1 之间跑一次。**先手工加一个 optional 方法确认它会红。** | 快照相等，rc=0。 |

### factory／锚点表

| 符号 | `file:line` | 用途 |
|---|---|---|
| `ClientFormat`（四值 union） | `src/lib/pipeline/envelope.ts:21` | profile discriminant 的 `format` 取值来源 |
| `FormatCodec` | `types.ts:948` | RFC §2.6 的既有格式抽象；沿用「格式方提供知识、driver／delivery 消费窄口」的依赖方向 |
| `DeliveryTerminalCommand` | `delivery/types.ts:69` | 迁移**输入**；其 `frames?: ReadonlyArray<DeliveryFrame>` 允许 caller 提交已铸 provenance，**不能原样成为终态公共签名** |
| `OwnerTerminalDecision` 三态 | `delivery/owner-failure.ts:11-14` | **T1.6 必读**：它与 `terminalFrameDisposition` **论域不同**（任意 command failure 的 caller action vs terminate 的 effect），**别当成同一三态的两种命名**。职责边界见 §11 #6 |
| `ClientBlockLedger` | `delivery/types.ts:37` | observation 层既有形状，T1.5 的对照 |
| `WireBlockAllocationPort` 五方法 | `types.ts:319-332` | **被替换的双面能力**，不是可继续扩展的终态 |

> **调查任务（本 commit 内必须回答，答不上就只冻结性质）**：`makeDeliverySseSink`／`makeDeliveryWsSink` 当前都是 exported function 且返回静态 `ClientSink`；新 composition factory **是否需要 export**、哪些调用方拿 `GenerationDeliveryOwner<P>`、哪些只拿 `CommandsFor<P>`——RFC §9.3 第 1 项，**最终证据槽在 Commit 4 publish kickoff**，Commit 1 只取最小子集。

### 本 commit 的门

| id | 段与等级 | 可复跑命令 |
|---|---|---|
| R-6 | C1 `辅助门`（compile fixtures，**已裁 2026-08-04**） | `cd "$TREE" && bun run typecheck` + compile fixture harness（T1.1～T1.3） |
| R-2 | C1 `辅助门`（classifier 三态 unit） | T1.4 落盘的测试路径 |
| — | **§11 #5 的必经触发点** | **未裁则本 commit 不得开工**——候选②要改的正是 C1 的内容（把 T2.3 前移进来）。裁后同步 RFC／矩阵／plan 三处 |
| — | **§11 #6 的必经触发点** | **未裁则本 commit 不得开工**（不只是 T1.6）——T1.6 冻结类型、T2.7 实现状态机、T3.5 产出映射，**取代／合并类候选到 C4 才裁就要重写 C1～C3**。把**四个**候选交主会话／用户 |
| R-11 / O-6 | 每 commit 共同门 | §0.3 ② |
| — | **每 commit 共同门：门跑在哪棵树** | §0.3 ④ —— 断言 O-6 打出的 `repo=` 等于 `$TREE`（**不取 cwd**） |

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
| **T2.4** | owner serializer 与 non-enqueue internal command primitives 的 unit：断言所有 commands 共用**一个** serializer，且 internal primitive 不重复入队（否则 compound command 会自死锁或产生第二个排序点）。<br>🔴 **「确认它当场炸」不可判**：非可重入 serializer 在持锁时再入队的**典型表现是 promise 永不 settle，不是同步 throw**。测试若不 await 它会悄悄绿；若直接 await 会挂到全局 timeout，**分不清目标自锁与环境慢**。<br>**可判形状**：用**可控 barrier** 把执行停在 serializer callback 内部 → 触发 internal primitive → 断言它**同步走 non-enqueue 路径并完成**（正确实现）。 | 转绿。<br>**mutation**：把该 internal primitive 改走 **public enqueue** → 以**短的、确定性的测试级 deadline + queue-state probe** 断言目标 callback **未前进**。<br>⚠️ **不得依赖全套测试的默认超时**作为判据——那既慢又分不清成因。<br>⚠️ **不许改用可重入锁把自锁掩盖过去**：那是把错误藏起来，不是修好（保持非可重入，让它当场可观测）。 |
| **T2.5** | `runEmissionBatch` 的 unit：断言在**一个** serializer callback 内完成「suspend heartbeat → 全量 build／validate → 顺序执行一批 commands → fresh interval 重臂」；若 batch 含 terminal 则**不得**重臂。**先写一条「caller 直接拿到 timer 控制方法」的测试确认它拿不到。** | 转绿。它替代 caller 直接 `freezeHeartbeat`／`suspendHeartbeat`／`resumeHeartbeat`。 |
| **T2.6** | heartbeat **unpark 活性对照**（RFC §10.1 硬性要求）：在**不 park** 的对照中推进 N×interval，断言恰有 N 个 keepalive。**这条必须先于任何 parked 否定断言**——没有它，「parked 后没有插帧」可能只是 timer 根本没触发的假绿。 | 活性对照转绿；再写 parked unit tests 断言 suspend 阻止插帧、terminal 后不复活、`freeze→close` 与「恢复 raw timer」「双 timer」mutation 必须红。 |
| **T2.7** | `terminate`／`finalize(result)` 状态机 unit：断言 first terminal command wins、terminal frame exactly once、`finalize` 只 seal／callback once **且不是第二个 emission 入口**。**先写一条「finalize 发帧」的 mutation 确认它红**；再写一条「无 result 调 finalize」确认只有 client-aborted／零 terminal-frame 的显式分支被允许。 | 转绿。**`terminate` 不调用 ctx settle、不运行 delivery-finalized callback**——顺序 `anchor balance／terminal attempt／sampling → recordForwarded → ctx.fail／complete → finalize` 由 route 保持。 |
| **T2.8** | raw emitter 接口的 unit：断言它**只**消费 owner-validated envelope，不接收公开 `ClientFrame` 作为 generation 发送入口；且它不决定业务 intent、block authority 或 provenance。 | 转绿。**本 commit 不调用它**（production 不构造新 owner）。 |
| **T2.9** | 属性存在性快照（§0.4 第 2 条）在 Commit 1→2 之间跑。 | 快照相等，rc=0。 |

### factory／锚点表

| 符号 | `file:line` | 用途 |
|---|---|---|
| `openAnchorIndex`（裸 number） | `types.ts:496-502` | **被 `OpenAnchorLease` 取代的现状**：裸 index 回答不了「属于哪个 generation／哪一次 anchor／是否仍 current」 |
| owner close 读写 `openAnchorIndex` | `delivery/session.ts:422-430` | T2.1 的现状对照：读 index，physical write 成功后清成 `undefined` |
| generic `write` 只更新 ledger／clocks | `delivery/session.ts:127-137` | **D1 的分裂证据**：它**不**清 `openAnchorIndex` |
| `ClientBlockLedger`（observation） | `delivery/types.ts:37` | T2.2 双层分离的 observation 侧既有形状 |
| owner serializer 现状（`write` → `writeToSink`） | `delivery/session.ts:127,131`；`writeToSink` 定义 `:581` | T2.4 的迁移起点 |
| heartbeat **四个** producer | `delivery/session.ts:175`（`contentFrame`）、`:184`（`injectContentScaffold`）、`:209`（`injectScaffold`）、`:219`（normal ping） | T2.6 被测对象；inventory §13 单列这四个 **owner-internal producer**（**是四个不是三个**） |
| `DeliveryHeartbeat` | `delivery/types.ts:55` | 含 `injectScaffold`；§7.2 点名它是闭包 sanity 成员 |
| `OwnerFailureReason` 三值 | `types.ts:295` | `client-gone` / `session-terminating` / `wire-torn` 生命周期失败通道。**`AuthorizationCardinalityError` 与 `CommandEffectMismatchError` 不走这条通道，直接 throw** |
| `ownerFailure` / `classifyOwnerFailure` | `delivery/session.ts:300-309` / `delivery/owner-failure.ts:41` | 同上；**M1 已把散落的提前返回收敛成 `OwnerTerminalDecision`**，T2.7 写 `terminate` 状态机前必读，别再造第二个分类器（§11 #6） |
| commit point（`committed` 翻转） | `delivery/session.ts:323-354` | C9 现状；T2.2 ③④ 的注入点 |
| owner→raw 存在性分派 | `delivery/session.ts:584-596` | §0.4 第 2 条快照的必覆盖对象（`sink.writeAnchor ?? sink.write` 四处） |

> **调查任务（RFC §9.3 第 6 项，证据槽在 Commit 5 之前，但 T2.x 需要最小子集）**：per-command rich records 的 request-scoped owner 是 `PipelineInfo` 新字段、独立 History detail 还是 ctx snapshot；settle 冻结点在哪。**答不上就只冻结「owner 先保留 rich command observations、sink 在末端投影、成功与失败走同一 normalizer」这三条性质**，不写字段表。

### 本 commit 的门

| id | 段与等级 | 可复跑命令 |
|---|---|---|
| R-5 | **段归属未裁，见 §11 #5** —— T2.3 在本 commit 实现，矩阵记 C1 | T2.3 落盘的测试路径 |
| — | **§11 #5 的复核**（首次裁决在 **Commit 1 kickoff**，不在这里） | 复核裁决已被贯彻：RFC／矩阵／plan 三处对 R-5 辅助段的归属一致 |
| R-11 / O-6 | 每 commit 共同门 | §0.3 ② |
| — | **每 commit 共同门：门跑在哪棵树** | §0.3 ④ —— 断言 O-6 打出的 `repo=` 等于 `$TREE`（**不取 cwd**） |

> **为什么必须挂成一行门**：`traceability-check.py` 只校验「production 硬门不早于其依赖能力」，**辅助门段落在 C1 还是 C2 它不判**（该格已逐字写明）。所以这里没有机械绊线，只能靠一个必经的人工触发点——**「若评审认为构成漂移」不是触发点**，没有任何流程保证有人会去看。

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
| **T3.2** | Responses output-item boundary 的 effect taxonomy：从 **HTTP renderer、WS renderer、terminal fixtures** 三个来源分别枚举 **runtime 观测到的** event／effect 命中集合，每项记 canonical family 与依据。**先冻结这三份 hit set**，别从 RFC §3.6 那一句话猜 enum。 | taxonomy 落盘 + unit 转绿。<br>**mutation 正控（三条，各打一个来源）**：分别删掉一个 **HTTP-only**、一个 **WS-only**、一个 **terminal-only** 的 effect，要求**对应的真实入口**转红——这能区分「taxonomy 漏了某来源」与「命名不同」。<br>**false-red 对照**：允许**多个 wire event 映射到同一个冻结 effect family**，不得因聚合而误红。<br>⚠️ **比集合与映射，不比名称文本**。「随手臆造一个 enum 看它不匹配」不是稳定 mutation——它可能碰巧与当前 renderer 一致，也可能只因命名差异而红。 |
| **T3.3** | opaque LegHandle 在 candidate binding 中的承载。<br>🔴 **这不是 `5 × 3 × 4 = 60` 格笛卡尔积**——**RFC §9.3 第 3 项冻结的是三个独立覆盖轴的人口口径，不是组合可达性**。实测五个 site 的 kind 是**字面量写死的**：`driver.ts:885/1014/1102` 固定 `"primary"`、`:1521` 固定 `"recovery"`、`:1579` 固定 `"continuation"`。要求在 primary-only site 驱动 recovery，只能靠伪造入口或错误扩宽 production site，**三种做法都在削弱门**。<br>**正确形状是关系覆盖表**：先为每个 site 列出它**可达**的 leg kind／source scenario，不适用的格**具名 `N/A` 并附控制流证据**（哪一行的字面量／哪个分支决定了它不可达）。 | 覆盖判据（三条同时成立，缺一不可）：<br>① **5 个 site 各至少一条正向 witness**；<br>② **3 种 leg kind 的全集**各至少被一个适用 site 覆盖；<br>③ **4 种 source scenario 的全集**（sole primary／hedge winner／continuation／recovery）各至少被一个适用 site 覆盖。<br>**mutation 正控**：**逐 site** 删掉它的 LegHandle 接线，**该 site 专属的生产路径**必须转红（这才证明五个 site 都真的接上了；一条聚合断言做不到）。<br>⚠️ **hedge winner 属于 primary kind，不是第四种 leg kind**（§9.3 第 3 项）——它是 source scenario 轴上的值。**先写一格「hedge winner 是第四种 leg kind」的错误映射，确认它红。**<br>**owner 能从 state 推导的字段不得重复让 caller 提交。** |
| **T3.4** | producer-to-command 转换 helpers 的 unit。**先写一条「helper 接收或返回闭包内任何符号」的检查确认它红**——准备期新增声明**不得**把闭包内任何符号放进签名（RFC §7.2 表，注意是「闭包内任何符号」而非只有种子类型）。 | 转绿。 |
| **T3.5** | 逐点可表达性演练（§9.3 第 7 项）：五类 handler、**8 个 handler anchor terminal-close 决策 + 2 个 driver 决策**如何产出 `TerminalEmissionResult` 并保持顺序；`terminalFrameDisposition` 三态如何映射原 client-gone／session-terminating 提前返回；driver 所有 `freezeHeartbeat`／`suspendHeartbeat`／`resumeHeartbeat`／`close` 如何映射到 `runEmissionBatch` 或 terminal。**任何无法表达的点都使 Commit 4 停门**（§7.13），**不得反向调用 legacy writer**。 | 逐点映射表落盘。**还须逐 tick 比较旧／新重臂时点并输入 Q5 diff**（T4.1）。 |
| **T3.6** | 10-root cutover harness 与 test-only handle recorder：在**isolated test composition** 中完整演练一遍 publish。**先确认 harness 跑完后 production route goldens、O-6 与全套保持原样**——演练泄漏到 production 就是越界。 | harness 转绿，production 侧零变化。 |
| **T3.7** | 属性存在性快照（§0.4 第 2 条）在 Commit 2→3 之间跑。 | 快照相等，rc=0。 |

### factory／锚点表

| 符号 | `file:line` | 用途 |
|---|---|---|
| 5 个 `beginLeg` production lexical sites | `driver.ts:885`（primary，hedge race winner）、`:1014`（primary，unhedged binding）、`:1102`（primary，unhedged binding）、`:1521`（**recovery**）、`:1579`（**continuation**） | T3.3 的五个 site。**kind 是字面量写死的**——这正是「不是 60 格笛卡尔积」的证据 |
| `beginLeg` 被 `wireState` 门挡住 | `driver.ts:883-885`（`if (allocationPort?.wireState)`） | **R-14 存在的唯一理由**：`wireState` 只有 Anthropic 有；`noteWinner`（`:888`）不受该门控（但仍受 optional chaining 约束——反查不到 session 时不调用，**「无条件」不是绝对必调用**） |
| anchor frame builders | `keepalive-anchor.ts:155`（start）、`:164`（delta）、`:173`（stop）、`:186`（synthetic message_start）、`:207`（remap）、`:232`（`resolveRemappedFrame`） | T3.1 的**纯函数核心，复用不重写**（skill `large-refactor` §5「保算法核、丢渲染壳」）。终态它们**只能由 owner command 在读取 current lease 后调用** |
| `reconcileLiveFrame` | `live-reconcile.ts:90` | T3.1：decorator 要**退化为纯 decision／transform** 的目标形状 |
| `makeReconcilingSink(inner: ClientSink, …): ClientSink` | `live-reconcile.ts:138` | **D 集头号成员**（§7.2 逐字点名）。T3.4 的对照 |
| 两个 injector 工厂 | `keepalive-anchor.ts:266`（anchor）／`:351`（envelope） | D 集成员；其 options 含 `getSink: () => ClientSink \| undefined` |
| `classifyOwnerFailure` → `settleMessagesOwnerFailure` | `delivery/owner-failure.ts:41` → `messages/owner-failure-settlement.ts:4` | **T3.5 必读**：M1 已把「client-gone／session-terminating 提前返回」收敛到这里，**不再是散落的提前返回**。照旧描述干会造出第二条 terminal 分流路径，撞 Commit 4 的「first terminal command wins」。取舍见 §11 #6 |
| 10 个 anchor terminal-close 决策 | 见 §Commit 4 锚点表 | T3.5 的映射对象 |

### 本 commit 的门

| id | 段与等级 | 可复跑命令 |
|---|---|---|
| R-11 / O-6 | 每 commit 共同门 | §0.3 ② |
| — | **每 commit 共同门：门跑在哪棵树** | §0.3 ④ —— 断言 O-6 打出的 `repo=` 等于 `$TREE`（**不取 cwd**） |

**本 commit 无新增 R-* 段。** builders 的 SDK 校准与 harness 演练都在 isolated test composition 中，不构成 production witness——RFC §7.6 明确「production route goldens、O-6 与全套保持原样」。

### commit invariant

**不替换任何 live call site**；**不读取准备态 handle 影响 routing**；不发 frame、不采样、不启动 timer；旧 API population 与 Commit 0 精确相等；存在性分派解析结果不变；typecheck 绿、全套绿、O-6 PASS。

---

## Commit 4 — 原子发布全部 generation authority 与 producer commands

**目标**（RFC §7.7）：raw authority 从旧 sink 发布给 `GenerationDeliveryOwner` 的那一个 semantic commit，**同时**切换全部 generation producers。本 commit 结束后 production 旧 generation write API 调用 population 必须为零；**不存在按 payload 猜 intent 的临时 adapter，也不存在新 command 回落旧 raw writer**。

> 🔴 **这是唯一可观察切换点，也是唯一的不可满足停门（§7.13）。** 若 PoC 证明全部 producer 无法在同一 semantic commit 切到可授权 commands，或 typed terminal result／heartbeat coordination 不能覆盖真实顺序：**允许继续增加无行为准备 commit，但不得发布部分 authority、不得引入 `legacy_adapted`／payload-guessing facade、不得让 new command 回落旧 writer。**

### 前置停门（缺任一项不得发布）

> 🔴 **RFC §7.12 那句同样适用于本 commit，逐字照抄**（Commit 3 有它、Commit 4 此前没有，而**压力全在这里**——Commit 4 被反复强调「唯一原子发布点、不许拆」，最容易在缺证据时现场编一个签名）：
>
> **到达本 commit kickoff 时先读证据槽；没有 `file:line` 或 PoC 结论，就交付已完成部分与具体问题、结束本轮，不生成猜测签名。**

1. **Q5 逐帧预测 diff 已复核**（§9.2 Q5、§6.3）：产出旧 golden → 预测新序列的逐帧 diff，逐项标明保留／删除／移动及理由，与 Q5 批准范围核对。**若 heartbeat 重臂时点无法证明逐 tick 中性，其预测 diff 必须纳入 Q5 批准范围。** 缺 diff 或实测超出预测即停止，**不得借已接受的 Q5 吞并额外 wire 漂移**。
2. **§9.3 全部调查证据齐全**——见下面的 **T4.0a～T4.0d**。⚠️ **Commit 3 对第 1／2／5／8 项只被要求交「最小子集／候选／方案」，「完整证据槽」那一列的值是「C4 publish kickoff」——那是一个时刻，不是一个负责人。** 因此这四条在本 commit 有显式 task，**不得在 kickoff 时口头判「C3 交的就是它被要求交的，所以齐全」**。
3. **§7.2 的 A／B／C／D 四集闭包输出仍是最新**（T0.7 产物在 Commit 1～3 期间机械相等）。
4. 🔴 **§11 #6 已裁**——`OwnerTerminalDecision`（M1 引入，`delivery/owner-failure.ts:11`）与本 commit 的 `TerminalEmissionResult` 是竞争抽象，**未裁则不得进入 T4.10**。<br>⚠️ **这里只是兜底，真正的触发点在 T1.6（Commit 1）**：那一步就要把三个态写进类型层并加穷尽性断言，形状在那时已经定死。**若拖到这里才发现未裁，C1～C3 的沉没成本已经在了**——那会污染候选①（「一并重塑」）的成本栏，与上一轮 #4「merge 有冲突」是同一种病。

### 逐 task

> **顺序说明**：**T4.0a～T4.0d 补齐调查**，T4.1～T4.3 是停门与骨架，T4.4～T4.12 是 §7.7「完整切换清单」的 12 项，T4.13～T4.16 是验收。**它们在同一个 semantic commit 内完成**，task 划分是施工顺序，不是发布粒度。**中途不产生 commit ⇒ 进度文件必须逐 task 更新并单独提交**（§0.5）。

| id | 先写什么失败测试 → 预期怎么红 | 实现什么 → 预期怎么绿 |
|---|---|---|
| **T4.0a** | **§9.3 第 1 项补完**（C1／C3 只取了最小子集）：最终 composition factory **是否需要 export**；哪些调用方拿 `GenerationDeliveryOwner<P>`、哪些只拿 `CommandsFor<P>`；returned object **不得**能恢复 raw emitter。**这是 T4.2 第一步就要写的东西**——答不上就按上面那句停下回报。 | 结论带 `file:line` 或 PoC 落盘。 |
| **T4.0b** | **§9.3 第 2 项补完**：HTTP／WS generation runner 实际可返回的 typed operation result 是什么；**WS close intent 产生时是否已具备 keep-open／code／reason**；socket composition 在哪个时点消费它。**T4.11 依赖它。** | 同上。 |
| **T4.0c** | **§9.3 第 5 项补完**（C3 只要求「记录候选」）：production authorization 双命中 mutation 的**精确注入点**——改哪一个 production registration primitive。**T4.9 的 R-5 production 硬门依赖它。** | 同上。**若完成 mapping 接线后仍不可达**，必须点名是「单一拒重复 key registry 从结构上消除了该状态」还是「witness 未触达」——前者改用 registry insert-conflict production mutation，**后者停下修 oracle**。 |
| **T4.0d** | **§9.3 第 8 项补完**（C3 只要求「记录迁移方案」）：raw factory test imports 如何迁到 test-only entrypoint，**65 个 raw factory tests 仍覆盖 transport bytes／observation**，而 production barrel 不泄漏 capability。**T4.15 依赖它。** | 同上。 |
| **T4.1** | **Q5 停门**（非测试）。产出逐帧 diff 预测，含 heartbeat 重臂时点的逐 tick 比较（输入来自 T3.5）。**先拿 T0.9 冻结的 goldens 做基座**。 | diff 落盘并复核。缺材料**不得进入后续 task**。 |
| **T4.2** | **8 个 sink 构造点**创建唯一 owner 与 private raw emitter；**2 个 Anthropic 接线点**改为接收 owner／command port（**不自己构造**）。⚠️ **别读成「10 个并列 root 各建一个 owner」**——`messages/handler-v4.ts:574`／`:658` 与 `:1192` 是**同一条链上的两层**（前两者调用 `makeAnchoredSseSink`，后者在其内部），照 10 个各建会让**单条 Anthropic 请求出现两个 owner**，直接违反本 commit 的「一个 serializer／一个 timer／一次 sampling／一次 emit」。<br>**先断言「recorder 包裹的是 composition root 实际取得的 `stream`／`ws` handle」**——用 T0.3 的 direct-send seam 复验它仍看得见绕过 owner 的发送。**注入 owner 的 test raw adapter 不用于本判定。** | 8 构造 + 2 接线切换；**删除 raw 第二 serializer 与 raw heartbeat**。转绿。<br>**验收计数是 `8 + 2`，不是裸 `10`**——R-1 的覆盖面按 8 个构造点核对（四 vendor HTTP + WS），Anthropic 那 2 个接线点单独断言「未构造 owner」。 |
| **T4.3** | 断言 runner／driver／terminal helper／decorator 参数里**没有** raw handle、closure 返回值与可恢复 registry 里也没有；且**不存在能从已传出的 sink／wrapper／observer 反查完整 session、allocation port 或 raw authority 的 lookup**。**先用 test-only adversarial runner 试着 resolve 回 session，确认它做不到**——窄 port 若可被 lookup 还原，只是形式收窄。 | 转绿。**源码／类型扫描只作 presence ratchet**。 |
| **T4.4** | 所有 ordinary／winner／live common producers 切 `emitGeneric`；generic pings 切 `emitKeepalive`；可解析未知 event 按 unknown passthrough。**先写 adversarial `emitGeneric(block-stop)`，断言它在 external write 前以 `CommandEffectMismatchError` 失败。** | 转绿。mutation 恢复 generic passthrough 后，**wire／owner-state 双 oracle 转红**。 |
| **T4.5** | 默认 on-demand／`empty_text` 切 `openAnchor`，`enveloped_ping` 切 `openMessageEnvelope`，anchor pulse／close 切 indexed commands。**先写「`enveloped_ping` 误走 `openAnchor`」的 mutation**，断言它因多 block／index shift／extra stop 转红——以 `tests/anthropic/enveloped-ping.it.test.ts` 为正样本基座。 | 转绿。<br>🔴 **同时反转 T0.6 的 characterization**（按其头部第③条）：断言方向从「wire closed 且 lease 仍 open」改成相反的正确性断言。**反转后绿；若维持原样仍绿，说明 authority 没生效**——这是 T0.6 特意留的探测器。**不许删掉它当过时测试**（C4 同时在跑十几个 mutation，删一条「过时的 characterization」看起来会很合理，但那会永久丢掉这个探测器）。`openMessageEnvelope` **不分配 block index、不创建 lease**；`openAnchor` 的 `prelude.kind` 至少区分 `captured` 与 `fabricated`，**owner 铸 provenance，caller 不自报 marker**。 |
| **T4.6** | 5 个 `beginLeg` lexical sites 按 **T3.3 的关系覆盖表**（**不是 60 格笛卡尔积**，见 T3.3）接好 LegHandle；primary、hedge winner、continuation、recovery 的 real start／delta／stop 全部切 `openRealBlock`／`writeRealBlockFrame`。**先删掉 caller offset 算术再跑 O-1**，确认没有第二条 legacy arithmetic 旁路（C4 双偏移作废）。 | 转绿，覆盖判据沿用 T3.3 的三条（5 site 各有正向 witness／3 kind 全覆盖／4 scenario 全覆盖；不适用格具名 `N/A` + 控制流证据）。<br>**mutation 逐 site**：删除任一 site 的 open／write 接线或恢复 caller offset 算术，**该 site 专属的生产路径**必须由 O-1／O-2／cross-leg oracle 转红。 |
| **T4.7** | close→real-start 用 **compound command**。**先在不 park 的对照中推进 N×interval 断言恰有 N 个 keepalive**（活性对照，缺它则下一条是假绿）；再把 tick 停在旧两 operation 之间，断言新 production live HTTP 只见相邻 `stop@leaseIndex → real-start@next` 且 `maxOpen<=1`。 | 转绿。**mutation 拆回两个 enqueue 必须产生插帧并红**；`wireTorn` 时按已裁决语义只 close、不 reserve／不写 real start，返回 typed `ClosedThenWireTorn`——调用方**不得**把它误解为「零副作用失败」。 |
| **T4.8** | 所有 `freezeHeartbeat`／`suspendHeartbeat`／`resumeHeartbeat`／`close` 切 `runEmissionBatch` 或 terminal；owner 成为唯一 timer。**先写「双 timer」与「恢复 raw timer」两条 mutation 确认它们红。** | 转绿。**caller 拿不到 timer 控制方法。** |
| **T4.9** | **production 双命中 mutation**（R-5 硬门）：改 production reservation／registration 路径，使新 real mapping 的 `wireIndex` 错误地等于当前 active anchor lease 的 index，或第二个 real mapping 复用第一个的 index；然后从**真实 Anthropic HTTP production path** 驱动「先打开 anchor 再开始 real block」或「同腿／跨腿保留两个 active real blocks」。 | 预期 `AuthorizationCardinalityError` 在阶段 A 抛出、**external attempt 为 0**、anchor lease／已有 mapping 不变、reservation rollback、frontier 不额外 commit。<br>⚠️ **若采用单一拒重复 key registry**，mutation 改为破坏 insert-conflict 守卫。**若完成 mapping 接线后仍不可达**，必须点名是「registry 从结构上消除了该状态」还是「witness 未触达」——前者改用 registry insert-conflict production mutation，**后者停下修 oracle**（§9.3 第 5 项）。 |
| **T4.10** | 20 个 handler synthetic terminal、3 个 `[DONE]`、normal terminal、Responses WS post-owner errors 切 `terminate → recordForwarded → ctx settle → finalize(result)`；**10 个 anchor terminal-close 决策被 `terminate` 吸收**。<br>🔴 **一条「`terminate` 跳过 active anchor balancing」的 mutation 不够**——它只证明 owner 内部会平衡，**证不了每个 handler 都已从旧 write 迁入 owner**，更覆盖不到无 anchor 的 CC／Responses／Gemini terminal。RFC §5.3 逐字要求「**逐 handler** 恢复旧 write mutation 必须红」，并单列 3 个 `[DONE]` **任一站点**恢复 handler write 必须红。<br>**因此先冻结 site manifest**：20 synthetic terminal + 3 `[DONE]` + normal terminal + WS post-owner，**每个 site 一行**，各配一条 production-route witness。 | 转绿。result 表达 `emitted \| suppressed_client_gone \| suppressed_session_terminating`；socket composition **最后**执行 close intent。**不再在 caller 先 close。**<br>**mutation 逐 site**：对每个 site 分别删除其 command 接线、或恢复它的旧 write，**该 site 专属的 witness 必须转红**。<br>**另加一条 owner 内部 mutation**：`terminate` 跳过 active anchor balancing → O-2 出现终局悬挂 block。<br>⚠️ **A 集静态归零继续保留，但不得替代行为 mutation**——它只证明旧 symbol 不出现，证不了某站点没有漏发 terminal 或改用了等价 direct transport。<br>⚠️ **`OwnerTerminalDecision`／`settleMessagesOwnerFailure` 已经在做 terminal 分流**（M1 引入），本 task 与它的关系见 §11 #6，**别在它之外再造一条**。 |
| **T4.11** | Responses WS direct transport 按 authority 分域：post-owner error／truncation 不再 direct send，改走 `terminate` ＋ typed socket close intent；control-with-inflight 先协调 active owner。**先在 keep-open socket 上启动 parked generation 并打开 anchor，再发坏 JSON、超长、并发 create，并推进 idle clock**——断言无 orphan anchor、active operation 先被协调、**无 5 分钟 idle timer 误杀**。 | 转绿。**真正 pre-owner admission／AUQ／warmup writers 保持独立且 observer 证零 owner，不纳入归零集。** |
| **T4.12** | 收口 **C 集**：删除 production `getDownstreamDeliverySession(sink)` 及等价 lookup 引用。**先写「恢复 sink lookup」的 authority-leak mutation**，确认 production bypass witness 咬得住。<br>收口 **D 集**：闭包命中的每个声明改为只接／只返回 command port 与窄 observer，或退化为纯 transform。**判据不是「签名里不再出现 `ClientSink` 这个名字」**——那会被局部同构 interface 再 cast 绕过（本项目已实测过），而是**运行期没有任何生产路径能从这些声明拿到 emission 能力**。 | 转绿。`createDownstreamDeliverySession` 只留 composition-root 私有 construction allowlist。 |
| **T4.13** | 迁移旧 session observation／provenance consumers：`noteWinner` 改用 `selectWinner(source)` 或等价窄 observation command。**先写 FF-2 描述的退化实现**——让 `selectWinner` 只更新 snapshot／telemetry 而不参与 provenance 铸造——断言 CC／Azure／Responses HTTP／Responses WS／Gemini **五种 profile 的 forwarded provenance 全部转为 `legacy`** 并使 R-14 转红。 | 转绿：五种 profile 各从真实 route 跑一次**有 winner 的 generation**，断言 forwarded 记录携带**真实** candidate／dispatch identity 且与该请求实际胜出的 candidate 一致；同一断言在 **hedge winner 场景重跑一次**。<br>false-red 对照：Anthropic profile 经 `beginLeg` 得到 provenance 仍绿；**无 winner 的路径（pre-owner 拒绝、warmup）不要求 candidate provenance，不得被本条误伤**。<br>`noteUpstreamRoundStarted`／`noteUpstreamRoundEnded`／`writeScaffold` 当前零 production consumers，**不继续暴露给 driver**。新 observer 不得返回 session／command port／raw handle，也不得产生 wire effect。 |
| **T4.14** | **转发腿的独立 oracle**（RFC §2.7／§11.1 的诚实边界）：producer 常以与 classifier 同族的 frame 谓词选择 command，**共享谓词漏形态时两侧会共因判绿**。因此除 wrong-command mutations 外，**直接破坏 producer 与 classifier 共用的 frame 谓词**，使其漏一种合法 block shape。 | **O-2 状态机／wire golden／真 SDK oracle 必须转红**——这三者**不复用**该谓词。这条不能由 builders 的自洽测试替代。 |
| **T4.15** | 同步迁移 raw／heartbeat 11 文件、common／indexed／terminal／finalize／WS、winner observation 与 session-resolution tests。<br>🔴 **同时填 T0.11 manifest 第 ③ 项的迁移关系槽位**：为每个被退役的旧 identity（`OwnerRawSink`／`createDownstreamDeliverySession`／`WireBlockAllocationPort` 等）登记它的 **test-only replacement**，**并让它满足 T6.5 第 ③ 项的 (a)(b)(c) 三条**——只登记名字不算数。**不填则 T6.5 的门在 C6 无法判别「正确退役」与「seam 被悄悄拆掉」**。**任何 guard 删除或放宽必须有独立裁决记录**（CLAUDE.md：删除或放宽既有 guard，合并前必须交独立 reviewer 或用户裁决，不得自判放行）。 | 转绿。 |
| **T4.16** | **先跑独立 O-1／O-2／真 SDK**，再在本 commit 同步更新 Q5 批准范围内的 anchor／heartbeat goldens 并复跑。**注入 duplicate index、orphan delta、悬挂 block，必须先由 O-1／O-2 红**——不能只靠新 golden 自洽。 | goldens 更新并复跑绿。**O-6 fixture 永不重捕。** 实测 diff 超出 T4.1 预测即**停下回用户重裁**。 |

### factory／锚点表

> 全部锚 **master `80a4b6fc`**（merge 后），路径简写见 §0.1a。master 每天前进，**引用前重取**。

#### composition 点：**8 个构造 + 2 个接线**（T4.2）

⚠️ **别把它读成 10 个并列 root。** Anthropic 那条链是**两层**：`:574`／`:658` 调用私有 helper `makeAnchoredSseSink`（定义 `messages/handler-v4.ts:1124`），helper 在 `:1192` 内部调 `makeDeliverySseSink`。**一次 Anthropic 请求走 `(:574 或 :658) → :1192`。**

**A. sink 构造点 —— owner 在此构造，共 8 个**

| # | `file:line` | 说明 |
|---|---|---|
| 1 | `chat-completions/handler-v4.ts:523` | direct CC SSE delivery |
| 2 | `chat-completions/handler-v4.ts:760` | reverse CC SSE delivery |
| 3 | `responses/handler-v4.ts:351` | direct Responses SSE delivery |
| 4 | `responses/handler-v4.ts:600` | reverse Responses SSE delivery |
| 5 | `gemini/handler-v4.ts:429` | direct Gemini SSE delivery |
| 6 | `gemini/handler-v4.ts:634` | reverse Gemini SSE delivery |
| 7 | `responses/ws.ts:358` | Responses WS delivery |
| 8 | `messages/handler-v4.ts:1192` | **Anthropic**：`makeAnchoredSseSink` 内部创建 delivery sink |

**B. Anthropic 调用点 —— 改为接收 owner／command port，共 2 个**

| # | `file:line` | 说明 |
|---|---|---|
| 9 | `messages/handler-v4.ts:574` | delayed-commit：`const { sink, anchorState, anchorHooks } = makeAnchoredSseSink(stream, …)` |
| 10 | `messages/handler-v4.ts:658` | immediate：同上 |

**Anthropic 的 composition root 必须落在 `makeAnchoredSseSink` 这一层**（定义 `messages/handler-v4.ts:1124`，返回类型标注在 `:1140`），**不能只下沉到 `makeDeliverySseSink`**——只有这一层同时拥有 allocator／wire state／anchor state／injector、History callbacks 和 raw `stream`。**它是 #8 的宿主函数，不是第 11 个 root。**

内部 factory chaining 另 4 点：`client-sink.ts:496`（`makeSseSink`）、`:497`（`createDownstreamDeliverySession`）、`:698`（`makeWsSink`）、`:699`（`createDownstreamDeliverySession`）。

#### raw factory 与 physical adapter（T4.2／T4.3）

| 符号 | `file:line` | 处置 |
|---|---|---|
| `makeSseSink(stream): OwnerRawSink` | `client-sink.ts:188` | 私有化：**不 export、不挂 returned object** |
| raw SSE physical `stream.writeSSE` | `client-sink.ts:209` | recorder 必须**位于它之下** |
| `makeWsSink(ws)` | `client-sink.ts:619` | 同上 |
| raw WS physical `ws.send` | `client-sink.ts:645` | 同上 |
| `makeDeliverySseSink` | `client-sink.ts:494` | 被 composition root 反转取代 |
| `makeDeliveryWsSink` | `client-sink.ts:696` | 同上 |
| `makeArraySink` | `client-sink.ts:720` | **test 面**：T0.8 归 owner-backed array adapter |

#### 10 个 anchor terminal-close 决策（T4.10）

原语是 `closeAnchorViaOwner(sink, anchorHooks, ctx, "terminal")`（**M1 引入**，定义 `messages/handler-v4.ts:1105`；driver 侧是局部 helper，定义 `driver.ts:1178`）。

| 位置 | `file:line` |
|---|---|
| handler 8 处 | `messages/handler-v4.ts:702, 1464, 1584, 1623, 1688, 1808, 1848, 1893` |
| driver 2 处 | `driver.ts:1436, 1611` |

另有 `"before-real"` 模式 2 处（`driver.ts:1236, 1314`），**不计入这 10 个 terminal 决策**。

#### 旧 emission API 的归零对象（T4.4／T4.10／T4.12）

| 集合 | 人口（**已在 merge 后 master 上实测**） | 锚点 |
|---|---|---|
| A-1 `ClientSink.write` | **10 点／4 文件**。另有 1 处 `OwnerRawSink.write` physical call（`delivery/session.ts:600`），**按 inventory 口径不计入本类** | `driver.ts:948, 952, 1048, 1265, 1319`；`keepalive-anchor.ts:375`；`live-reconcile.ts:157`；`chat-completions/handler-v4.ts:662, 833, 839` |
| A-1 子集：`[DONE]` **3 点** | 是 A-1 的**子集**，不重复计数 | `chat-completions/handler-v4.ts:662, 833, 839`。目标是 `terminate` 而非 `emitGeneric` |
| A-2 named synthetic APIs | **28 点／7 文件**（`writeSynthetic` 22 / `writeKeepalive` 3 / `writeSyntheticEnvelope` 3，AST 实测） | 20 个直接 handler 点 + decorator 转发 3 点（`live-reconcile.ts:160,161,162`）+ owner→raw fallback 3 点（`delivery/session.ts:588,592,596`）+ 2 个 fallback 调用点 |
| A-3 allocation／anchor commands、caller heartbeat controls、旧 terminal／finalize | 见 T4.8／T4.10；`terminate`+`finalize` 共 **53 点／6 文件**（AST 实测：session 2、messages 15、CC 11、Responses HTTP 11、WS 4、Gemini 10） | `driver.ts:1220`（freeze）、`:1346,1370`（suspend）、`:1348,1403`（resume）；51 个 handler `finalize` |
| A-4 client-facing direct transport 的 **post-owner** 成员 | 9 个 generation direct transport 词法点中的 2 个（**实测 11 个 `writeSSE`／`ws.send` 调用，扣掉 `src/lib/ws/broadcast.ts` 的 2 个管理 broadcast**——注意第二个是 `rawWs.send`，用 `\bws\.send\(` 会漏） | `responses/ws.ts:165`（error／truncation，混合 helper）、`:667`（control-with-inflight） |
| **pre-owner allowlist（不得归零）** | | `responses/ws.ts:595`（connection-cap admission）、`error-shaping-glue.ts:131`（AUQ）、`warmup.ts:214,230,243` |
| B 集 | 旧 session public 面 9 项（`delivery/session.ts:57-67`）；production consumer 当前 **`noteWinner` 1 点** | `driver.ts:888`（经 `getDownstreamDeliverySessionForPortOrSink`，定义 `:940`） |
| C 集 | `getDownstreamDeliverySession` production **调用点 9 处／4 文件**（定义 1 处不计入）。⚠️ **`driver.ts:888` 是 `noteWinner`，属 B 集不属 C 集** | 定义 `delivery/session.ts:90`；调用 `driver.ts:883, 944, 1012, 1097`、`messages/handler-v4.ts:1112, 1422, 1772`、`live-reconcile.ts:139`、`keepalive-anchor.ts:280`。<br>**逐点以 T0.7 的 AST 输出为准，别照抄本表** |
| D 集 | **不能靠列举穷尽，以 T0.7 闭包输出为准** | sanity 成员：`makeReconcilingSink`（`live-reconcile.ts:138`）、两个 injector 工厂（`keepalive-anchor.ts:266, 351`）、各 raw factory 返回类型、driver／handler 中带 capability 类型的 helper |

> ⚠️ **这些计数是本轮在 `80a4b6fc` 上的实测快照，不是冻结契约。** 按 `freeze-hit-set-not-zero-hits`，**执行时以 T0.7／T0.11 的机器输出（冻结命中集合）为准**，本表只作 sanity 对照；数字与集合冲突时以集合为准并修本文。

### 本 commit 的门

| id | 段与等级 | 可复跑命令 |
|---|---|---|
| R-1 | C4 `production 硬门` | 四 vendor HTTP root + Responses WS 的 zero／exactly-once 断言（T4.2／T4.3） |
| R-2 | C4 `production 硬门` | 每 profile 从真实 route 发 generic／keepalive／terminal（T4.4）＋ T4.14 |
| R-3 | C4 `production 硬门` | 真实 Anthropic live consumer（T4.5／T4.7）；**T0.6 的 characterization 在此按其头部第③条反转为正确性断言**（反转后绿；⚠️ **维持原样仍绿 = authority 没生效**——那正是它要抓的） |
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
| R-11 / O-6 | 每 commit 共同门 | §0.3 ② |
| — | **每 commit 共同门：门跑在哪棵树** | §0.3 ④ —— 断言 O-6 打出的 `repo=` 等于 `$TREE`（**不取 cwd**） |

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
| **T5.1** | request-scoped、**bounded** 的 command telemetry accumulator。<br>🔴 **「有界」不是可判定的判据，「无界增长 mutation」按字面无法转红**——普通 `Array.push` 在任何有限测试里长度都恰为 N，删掉 cap 后测出来还是 N。**先冻结可执行性质，再写测试**：`MAX_COMMAND_RECORDS` 的具体值、**达到上限后的行为**（`droppedCount` 计数／`truncated` marker／首尾保留规则），以及**完整记录去哪**。<br>🔴 **两条腿必须分别冻结，否则「telemetry 有界」与「History 完整」不能同时成立**：Q4 已裁方案 B 要求完整 per-command records 进 generation operation detail，**若 History detail 在 settle 时从这个 bounded accumulator 读取，`cap+1` 之后的 records 已经没了**——「完整」就是假的。<br>**因此**：①**bounded telemetry projection** 只存可加聚合与 drop diagnostics；②**History detail 从独立的 append-only request record source 取完整 records**，其 owner、写入时点、失败语义与双腿一致性都要一并冻结（RFC §9.3 第 6 项的调查槽正是这个）。<br>⚠️ **若裁定 History 也可截断，那是 Q4 已裁契约的变更，须回用户重裁**——不是实施者可定的。<br>⚠️ **这些值属 Q1 裁决的下游**——Q1 未裁则本 task 连同本节一起停（见前置停门）。 | 测试驱动 **`cap-1` / `cap` / `cap+1` / 多倍 `cap`** 四档。<br>**四档在两条腿上都要断言**：telemetry 侧有界且 drop 可见；**History 侧在 `cap+1`／多倍 cap 下 command id 集合、顺序与 error chain 仍完整**。<br>**mutation（两条）**：①移除截断或移除 `droppedCount`／`truncated` marker → 必须红（`cap+1` 那档看得见）；②**让 History detail 复用 truncated telemetry buffer** → 必须红。**只有第 ① 条时，「两条腿其实是一条」这个缺陷会全绿交付。**<br>**false-red 对照**：低流量（远小于 cap）的正确实现必须绿，**不得因测试自行假定某个 cap 而误红**。<br>**不从 owner 热路径直接新增 telemetry package free-function 或 SQLite writer**——`TelemetrySink` 已是 completed／failed 请求的唯一 registry feed，runtime 唯一的 settled-request 记录入口是 `recordSettled`。 |
| **T5.2** | bounded 字段的 canonical registry／normalizer unit，按 §4.8 逐字段：`command`／`formatProfile`／`expectedEffect`／`actualEffect`／`targetKind`／`legKind`／`outcome`／`committed`／`wireTorn`／`stateBefore`／`stateAfter`。**先写一条「`wireIndex` 进 label」的 mutation 确认它红**——`wireIndex` 与 `commandId` 只进 trace／History detail。 | 转绿。`formatProfile` 用 canonical 枚举（`anthropic_messages`／`responses_http`／`responses_ws`／`chat_completions`／`azure_chat_completions`／`gemini`），**不直接用 route path 或 client 输入**。 |
| **T5.3** | **单一口径分裂判据**（§4.11，本项目已栽过一次：model 维成功腿用规范名、失败腿回落客户端别名）：对同一 `formatProfile + command + expectedEffect + targetKind + legKind` 驱动一次成功与一次 pre-write／wire 失败，断言除 `outcome`／`committed`／`phase`／`stateAfter` 等本就应变的字段外，**其余 canonical keys 完全相等**。**mutation 让失败路径回落函数名／route path／raw effect string，必须产生额外 key 并使断言转红。** | 转绿。再用 alias route（OpenAI 与 Azure 同 command family）验证**只在已声明的 `formatProfile` 轴分开**。<br>⚠️ **比较冻结 key 集合，不用总数凑巧相等。** |
| **T5.4** | compound `phase`（`validated \| stop_sent \| real_start_sent \| terminal_sent`）与 partial measures 的 unit：至少分别累加 `validatedCount`／`stopSentCount`／`realStartSentCount`／`terminalSentCount`／`committedCount` 与各 outcome count。**先写「partial failure 只记 `outcome=wire_error`」的 mutation** 确认聚合后答不出「stop 成功但 real start 失败」。 | 转绿。普通 command 用 `phase: none`（**避免把「不适用」与「尚未 validated」混淆**）；`closedThenWireTorn` 固定表达 `stop_sent + committed=true + wireTorn=true + outcome=closed_then_wire_torn`，**不能降成普通 `ok:false`**。 |
| **T5.5** | History **方案 B** 双层（Q4 已裁）：`wirePartialDelivery` 保持稳定摘要 `operation + cause + committed`；独立 generation operation detail 保存完整 per-command records（含 `phaseReached`、attempted segment、成功 segments、error），以 operation／command identity 关联摘要。**先写一条「摘要被扩字段」的 mutation 确认它红**——摘要的稳定性是契约。 | 转绿。同 commit 同步**后端 SSOT schema、ui-v4 re-export 与相关 tests**。 |
| **T5.6** | telemetry.db 四层 round-trip：`tel_raw → tel_hourly → tel_daily` 与 `tel_cumulative` 各读一次。**先只加 measure 不改 schema 跑一遍**，确认它失败——「开放 counters bag 零版本 bump」**不等于** SQLite 无需 schema migration。 | 按 telemetry.db 现行 Umzug／store 约定**增加列**并验证四腿；同步 `FEATURE_MEASURE_NAMES`／`SettledMeasures`／column registry／read projection。**不重新建 command event 表。** |
| **T5.7** | R-9 的诊断判别力：同 command 驱动 success、preflight 拒绝、wire partial 三种，断言 §4.10 的四个诊断问题都能答上。**先构造「只存 `committed` 不存 phase」的 mutation** 确认诊断缺口出现。 | 转绿。<br>⚠️ **R-9 是辅助诊断门，不计 behavior 等级**（§4.12）：实现可以在仍有 direct send 旁路时把日志打得完全正确，也可以在 behavior 正确时因 sink 未 settle 而漏计。**telemetry 缺失不反判 wire 错误。** |

### factory／锚点表

| 符号 | `file:line` | 用途 |
|---|---|---|
| dimension names 与 cardinality | `packages/telemetry/src/dimension-names.ts:19-64`（`TelemetryDimensionName` 定义在 `:56`） | T5.2 的 registry；**穷尽 `Record<TelemetryDimensionName,...>` 使新增 spec 但漏 extractor 时 compile-red** |
| extractor（依赖 `HistoryEntryData`／ctx） | `src/lib/observability/telemetry-dimensions.ts:1-25,141-170` | T5.2 |
| settled-request 聚合叶 | `packages/telemetry/src/request-telemetry.ts:337-407` | 只收 resolved key bag 与 measure inputs，开放 `Record<string, number>` counters |
| feature measures 单一 name registry | `packages/telemetry/src/request-telemetry.ts:115-149`（`FEATURE_MEASURE_NAMES` 在 `:124`）、`:856-931` | T5.6 的 `FEATURE_MEASURE_NAMES` |
| telemetry store / rollup | `packages/telemetry/src/telemetry/store.ts:34-95,104-133`、`rollup.ts:1-20,95-147` | T5.6 的四层；rollup 对可加 columns 泛型迭代 |
| `TelemetrySink`（唯一 registry feed） | `src/lib/observability/sinks/telemetry.ts:31-43,49-103` | T5.1 的接入点 |
| `recordSettled`（runtime 唯一入口） | `packages/telemetry/src/runtime.ts:67-100`（签名在 `:86`）、`:145-150` | 同上 |
| 现状 generic write 失败日志 | `delivery/session.ts:311-355`（`consola.error("[delivery] owner wire write failed", …)`） | §4.10 的「答不了」对照 |
| 现状 snapshot | `delivery/types.ts:44-51` | 只有 state／winner／wire ledger／rounds／总 `writeCount` |
| 现状 partial History | `src/lib/history/types.ts:217` | 只有 `operation + cause + committed`（M1 引入） |

> ⚠️ 上表行号锚 master `80a4b6fc`。**引用前重取**：
> ```bash
> cd /home/xp/src/copilot-api-js && rg -n "TelemetryDimensionName|FEATURE_MEASURE_NAMES|recordSettled" packages/telemetry/src src/lib/observability
> ```

### 本 commit 的门

| id | 段与等级 | 可复跑命令 |
|---|---|---|
| R-9 | C5 `辅助门`（诊断，**不计 behavior 等级**） | T5.3／T5.7 落盘的测试路径 + 四层 round-trip（T5.6） |
| — | Q1 相位守卫 | `PHASE=post exp/inter-block-anchor-allocator/q1-locations.sh` |
| R-11 / O-6 | 每 commit 共同门 | §0.3 ② |
| — | **每 commit 共同门：门跑在哪棵树** | §0.3 ④ —— 断言 O-6 打出的 `repo=` 等于 `$TREE`（**不取 cwd**） |

### commit invariant

production 旧 API population **持续为零**；telemetry **不新增 emission 或 state authority**，wire 不变；A／B／C／D 四集状态与 Commit 4 终态相同；typecheck 绿、全套绿、O-6 PASS。

---

## Commit 6 — Legacy definitions／exports 删除与 population 审计

**目标**（RFC §7.9）：删除已零调用的定义与 exports，并对三张 symbol 集合分别做 AST／checker 审计。

### 逐 task

| id | 先写什么失败测试 → 预期怎么红 | 实现什么 → 预期怎么绿 |
|---|---|---|
| **T6.1** | 重跑 T0.7 的闭包与 inventory AST，断言 A／B／C 三集 population 仍为零（C 集 construction 仍精确等于 allowlist）。**先手工加回一个旧调用点确认审计会红。** | 审计绿。 |
| **T6.2** | 删除 **A 集**已零调用的定义：`ClientSink.write*` generation surface、`WireBlockAllocationPort`、caller envelope factory、legacy anchor fields／bridge、`commandPortActivation`、raw production exports。**删之前先跑一遍全套确认真的零引用**（TypeScript 会替你找剩余引用，别猜）。 | typecheck 与全套绿。<br>⚠️ **`commandPortActivation` 在合并后 master 的 `src/` 零命中**（实测）。它要么是 Commit 1～4 期间新引入的名字，要么是 RFC 的前瞻性命名——**到达本 commit 时先确认它存在再删，不存在就在 plan 里标注并回报**，别为了让清单成立而发明一个符号。 |
| **T6.3** | 删除 **B 集**已零 consumer 的旧 `DownstreamDeliverySession` public surface：`writeScaffold`、`noteWinner`、`noteUpstreamRoundStarted`、`noteUpstreamRoundEnded`。**先确认 `identity`／`snapshot` 若内部保留，它们不作为旧 session handle 暴露给 driver。** | 绿。 |
| **T6.4** | 删除 **C 集**已零 resolution consumer 的 exported `getDownstreamDeliverySession`、等价 WeakMap lookup 及 allowlist 外 construction exports。 | 绿。 |
| **T6.5** | **R-10 硬门**：test-only adversarial seam **仍能在旧边界造出分裂**，而新 production route **拒绝同一行为**。<br>🔴 **「coverage gate 必须红」此前没有定义任何 gate**——默认 runner 对「删掉一条测试」是**绿**的（少跑一条而已），T6.1 的 production AST 审计也看不见 test-only seam，所以这条预测按原样必然落空。<br>**gate 的实现是一条独立架构测试**，断言 **T0.11 冻结的 manifest 三样仍成立**：①那些测试文件仍存在；②它们**运行时枚举**出的 test name 集合仍等于冻结集合（用 `--reporter=junit`，**不用 `rg` 扫 `test("...")`**）；③**每个旧 identity 要么 (i) 仍存在且仅 test 可达，要么 (ii) 其 replacement 通过下面三条可执行判据**（C4 在 T4.15 填的迁移关系）。⚠️ **不是「恒存」**，见 T0.11。<br>🔴 **(i) 这条岔路不得用来保留 T6.2／T6.4 明令删除的 legacy export**——否则「仅 test 可达」就成了它们的避难所，C6 的归零变成纸面。**(i) 仅适用于本 commit 删除清单之外的 identity**；凡出现在 T6.2／T6.4 清单上的（`OwnerRawSink`／`WireBlockAllocationPort`／`createDownstreamDeliverySession`／`getDownstreamDeliverySession` 等），**只能走 (ii)**。<br>**正控**：把某个删除清单上的 identity 保留下来、只是收窄成 test 可达 → **门必须红**（这条专打本岔路）。<br>
🔴 **「具名一个 replacement」本身不构成豁免**——只写名字就是万能逃生舱。**三条缺一不可，且都要可执行**：<br>
**(a) 实际被使用**：adversarial seam 的 **runtime import／调用图**里出现该 replacement（**从运行时取，不是 grep 源码文本**——参数化与再导出会骗过文本扫描）。**正控**：把 seam 改成不碰 replacement（例如改用自建 stub）→ 门必须红。<br>
**(b) 语义等价（按 seam 需要的那部分）**：该 seam 用旧 identity **造出 wire／state 分裂的那条行为路径**，换成 replacement 后**仍能造出同一分裂**。**这是行为判据，不是签名判据**——`(a)` 只证明它被引用了。**正控**：把 replacement 换成一个签名相同但不产生分裂的空壳 → 门必须红。<br>
**(c) production 零可达**：replacement **只能从 test entrypoint 到达**；`src/`／`packages/` 的 production 引用面对它为零（沿用 T0.7 的 checker 输出，不用文本扫描）。**正控**：从任一 production 文件 import 它 → 门必须红。 | 绿。<br>**mutation（三条，各打一型）**：①在副本里**删掉**该 test 文件或其中一条 case → manifest 门报出**缺失的具体 name／文件**；②把它**改走合法 owner** → 行为门红（seam 不再能造出分裂）；③**删掉某个旧 identity 的 replacement 映射**（identity 没了、replacement 也没登记）→ 门红；④**登记一个只有名字的 replacement**（seam 不实际用它／它不产生分裂／它仍可从 production 到达，三选一）→ 门红——**这条专打「具名即豁免」**。<br>**false-red 对照（两条）**：①owner-backed array adapter 与 raw transport byte units 合法存在，**不被零命中 guard 误杀**；②**按计划退役 `OwnerRawSink`／`createDownstreamDeliverySession`／`WireBlockAllocationPort` 并登记了 replacement 时必须绿**——这正是 C6 的正事，判红即说明门写反了。<br>锚点：`tests/pipeline/allocation-outside-owner-control.it.test.ts`。 |
| **T6.6** | **R-6 的 C6 段（已裁为 `production 硬门`，2026-08-04）**：import guard 断言 `src/lib/pipeline/delivery/**` 对 concrete codec 模块零 import，**并提供一条故意加入违规 import 的正样本，确认守卫真实转红**。**单纯 `rg` 零命中不自证。** | 绿。<br>**用户裁决（候选 1，按判据列拆）**：compile fixtures → C1 `辅助门`（§7.4）、**import guard → C6 `production 硬门`**（§7.9）。<br>⚠️ **「辅助门」不等于「不阻断交付」**——RFC §10.4 与本文 §10 都写明**辅助类型／遥测门失败同样阻止交付**，两档的差别只在**能否升级 behavior／closure 等级**：`production 硬门`的通过可支撑「结构性闭合候选」，`辅助门`只作 presence ratchet。<br>**RFC §10.2 的 R-6 行末列仍是无分段的 `本RFC辅助门；Commit 1／6`**，与本裁决不一致——**已列入 T8.1 的文档同步，别落空**。 |
| **T6.7** | 独立 guard 裁决记录齐全：本 commit 删除或放宽的每一条 guard 都有独立 reviewer 或用户裁决记录（CLAUDE.md `[hard]`）。 | 记录落盘。 |

### factory／锚点表

| 删除对象 | `file:line` | 备注 |
|---|---|---|
| `WireBlockAllocationPort` | `types.ts:319-332` | 五方法 + `wireState` |
| `DownstreamDeliverySession` public 面 9 项 | `delivery/session.ts:57-67` | B 集 |
| `getDownstreamDeliverySession` | `delivery/session.ts:90` | C 集 |
| `getDeliverySessionForAllocationPort` | `delivery/session.ts:95` | C 集 |
| `createDownstreamDeliverySession` | `delivery/session.ts:100` | C 集 construction，**只留 composition-root allowlist** |
| `OwnerRawSink` | `delivery/types.ts:12` | raw production export（M1 引入） |
| `ClientSink.write*` generation surface | `types.ts:747` 起 | 含 `write`／`writeSynthetic`／`writeKeepalive`／`writeSyntheticEnvelope`。⚠️ **`writeAnchor` 不在 `ClientSink` 上**——它是 `OwnerRawSink` 的成员（`delivery/types.ts:13`），随该 interface 一并删除 |
| 架构守卫既有位置 | `tests/architecture/` | T6.6 的 import guard 归属目录；同目录已有 `package-boundaries`／`circular-deps-ratchet`／`anchor-remap-single-authority` |

### 本 commit 的门

| id | 段与等级 | 可复跑命令 |
|---|---|---|
| R-10 | C6 `production 硬门` | inventory AST 重跑（T6.1）+ manifest 门与行为门（T6.5） |
| R-6 | C6 `production 硬门`（import guard，**已裁 2026-08-04**） | import guard + 违规正样本（T6.6） |
| R-11 / O-6 | 每 commit 共同门 | §0.3 ② |
| — | **每 commit 共同门：门跑在哪棵树** | §0.3 ④ —— 断言 O-6 打出的 `repo=` 等于 `$TREE`（**不取 cwd**） |

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
| **T7.3** | **断言本 commit 未改动 production**。<br>🔴 **不要自己列 production 路径**——那份清单已经错过四次（见 §0.4a）。**用 §0.4a 的反转判据**：tracked 全集减排除表。**先在 `packages/telemetry/src/request-telemetry.ts` 加一字节，确认只扫 `src/` 的旧写法判绿**——那就是漏洞的实物。 | **用 §0.4a 的判据与 §0.4b 的 `FROM`／`TO`**（都不在这里另立，两处并存必漂）：跑 §0.4a 那条 `git diff --stat ... ':(exclude)...'`，**输出必须为空**。本 commit 的 `FROM` 即 C6 的 sha。<br>**mutation**：在 `packages/telemetry` 与 `scripts/` 各加一字节 → 都必须红。<br>**false-red 对照**：合法的 `tests/`／fixtures／`docs/` 清理仍绿（本 commit 的正事就是删旧 fixture）。 |

### 本 commit 的门

| id | 段与等级 | 可复跑命令 |
|---|---|---|
| R-12 | C7 `辅助门`（审计） | T7.1 的复核表 |
| R-11 / O-6 | 每 commit 共同门 | §0.3 ② |
| — | **每 commit 共同门：门跑在哪棵树** | §0.3 ④ —— 断言 O-6 打出的 `repo=` 等于 `$TREE`（**不取 cwd**） |

### commit invariant

production 零改动（**按 T7.3 的 manifest 判，不是只扫 `src/`**）；O-1／O-2／真 SDK／goldens／O-6／全套均保持绿；**O-6 fixture 永不重捕**。

---

## Commit 8 — 文档同步与 merged-state 收口

**目标**（RFC §7.11）：同步 README C1～C11、anchor 精确帧序契约、DESIGN、旧 plan supersede 关系、telemetry／History 与 deferred items；**ADR 只按用户裁决编辑**。

### 前置停门

**Q2**（是否补充已接受 ADR `2026-07-05-richest-data-flow` 的 owner-minted provenance 说明）在本 commit 之前停，**默认不改 ADR**（方案 B）。**未经用户同意不得暗改 ADR**——ADR 来自用户决策，实施者无权因代码形状变化自行改写理由。

### 逐 task

| id | 先写什么失败测试 → 预期怎么红 | 实现什么 → 预期怎么绿 |
|---|---|---|
| **T8.1** | README 的 C1～C11 回填：C2／C5／C6／C7／C9／C10／C11 属「措辞需扩展」，逐条按 §6.2 末列的「需要同步的权威位置」改。**先跑一遍 doc-vs-code claims 检查确认现状对不上**。<br>**另有两处 RFC 本体的同步，别落空**：①**RFC §10.2 的 R-6 行末列**仍是无分段的 `本RFC辅助门；Commit 1／6`，须按 2026-08-04 的裁决改成两段（C1 `辅助门` compile fixtures／C6 `production 硬门` import guard）；②凡描述「辅助门」处，措辞须与 §10.4 一致——**辅助门失败同样阻止交付**，两档差别只在能否升级 closure 等级。 | 回填完成。**C1／C3／C4／C8 语义不变，不得顺手改语义。** |
| **T8.2** | 把 **anchor 精确帧序**登记为 C1～C11 **之外**的独立可观察契约（§6.3）：它不属于 C2（C2 只要求 `maxOpen<=1` 且 anchor stop 先于 real start，中间多一帧合法 keepalive 仍成立），也不属于 C7（C7 不规定 synthetic 帧相对 real start 的精确位置）。**先确认没有人把它包装成 C2／C7 的「实现细节」。** | 契约落盘。 |
| **T8.3** | 同步 `docs/DESIGN.md` 的「活的架构现状」表与类型架构节。**先跑一次跨文档 grep 验证**（session-closeout §2）。 | 同步完成。 |
| **T8.4** | 旧 plan supersede 关系：`docs/plan/2026-07-27-inter-block-anchor-allocator/` 的 M2～M4 mapping 步骤被本 RFC supersede；M5～M8 中 gap lifecycle／开门／多 gap **保留并重锚**；O-1～O-9 继续继承。**别把 supersede 写成删除**——§10.3 明写 O-9「绝不删除」。 | 注解完成。 |
| **T8.5** | **旧 API disposition 与 doc-vs-code claims 审计**：对 M1 合入后的主线状态逐项确认（§0.1 列出的 M1 到货物是必查起点）。**并完成 HANDOVER 遗留的那件事**：先冻结一份权威文档 manifest（三个范围共 **122 份 Markdown**），再**按契约轴而非新 API 名**检索——index allocation/order/reuse/offset、anchor open/close/lifecycle、serializer/write/emit、synthetic provenance、winner/candidate/dispatch、heartbeat/escalation、continuation/recovery、History/telemetry；对 manifest 里**每一份**给 disposition，并对 C1–C11 与用户裁决做双向 trace。<br>⚠️ **「除上述外无冲突」这个否定性断言在本 plan 写作时并不成立**：HANDOVER 记录的五个检索词只命中 21／122 份，未命中的里面恰恰包括承载 C1／C4／C6／C7／C8、D2、continuation offset、anchor 生命周期与 P7／P8 的核心文档。**少命中不能证明无冲突。** | 审计表落盘。 |
| **T8.6** | telemetry／History 文档与 deferred items 同步；`docs/todo/deferred-backlog.md` 记入 §8「范围外」表里归属它的两项（vendor 协议完整状态机、统一 `CompleteResponseEmitter`）。 | 同步完成。 |
| **T8.7** | 独立 **merged-state review**（`review-merged-state`）：跨 phase 集成缝、doc↔code 对账、commit message 与内容是否相符。<br>**必查项**：①§11 各未裁项**都已在其触发点被真正裁掉**（不是「一路走过来没人拦」）；②RFC §10.2 的 R-6 行已按裁决改写（T8.1）；③本文与 RFC／矩阵三处对「辅助门是否阻断交付」的措辞一致。 | review 记录落盘。 |

### 本 commit 的门

| id | 段与等级 | 可复跑命令 |
|---|---|---|
| R-11 / O-6 | 每 commit 共同门 | §0.3 ② |
| — | **每 commit 共同门：门跑在哪棵树** | §0.3 ④ —— 断言 O-6 打出的 `repo=` 等于 `$TREE`（**不取 cwd**） |
| — | 完成判定 | 见 §10 |

### commit invariant

runtime、API population 与 goldens 已稳定；**docs 不承担推迟迁移**；typecheck 绿、全套绿、O-6 PASS。

---

## 10. 完成判定（RFC §10.4）

R-1～R-14 中标为「本 RFC 必须／gate」的项目**全部**具备 positive 与 negative controls。**R-14 与其余必过项同级**——它是非 Anthropic candidate provenance 的唯一守卫，漏掉它等于让 §3.3 已认定「缺了会全绿交付」的回归照常交付。

🔴 **「辅助门」不是「不阻断」**（RFC §10.4 逐字：辅助类型／遥测门失败**同样阻止交付**）。两档的唯一差别是**能否升级 closure 等级**：

| 档 | 失败时 | 通过时 |
|---|---|---|
| `production 硬门` | **阻止交付** | 可支撑该 witness 覆盖范围内的「结构性闭合候选」升级 |
| `辅助门` | **同样阻止交付** | **不升级** behavior／closure 等级，只作 presence ratchet |

**本文任何地方若出现「辅助门失去阻断力」「升 production 硬门才变严」之类措辞，都是错的**——那种说法会诱导用户为了拿回一个本来就有的阻断效果而升档。R-6 的裁决材料曾犯过这个错，记在 §11 #1。

O-3／O-5／O-7／O-9 以及 O-4 的完整验收明确留给后续 M2～M8／P7／P8，**不得因「不属于本 RFC」从 roadmap 删除**。

执行者必须在验收记录中**逐项**写 `PASS / FAIL / NOT-YET-IN-SCOPE` 和证据命令；**不能用一条「全套件绿」折叠全表**。

**升级／降级规则**（§5.5）：某一行只有在其真实 production 入口的正样本为绿、目标缺陷 mutation 为红、且 false-red 对照证明正确实现可通过后，才能从「仅降低概率」升级为「结构性闭合候选」。**升级只适用于该 operation／profile／transport witness 覆盖的边界**，不外推为「整个 socket lifetime」或「全应用唯一 writer」。若后续发现 direct send、raw capability 供给、双 serializer、telemetry-only 证明或无法触达目标的 mutation，**该行立即回到「仅降低概率」**，无需等待另一次架构裁决。

---

## 11. 裁决项 —— 已裁的记结论，未裁的如实转述

> **未裁项（#2／#3／#5／#6）不是实施者可自判的。** 走 RFC §9.1／§9.4 的 open question 机制交主会话／用户，按 `scope-ambiguity-then-ask` 摆带量化影响的选项而非 yes/no。
>
> **每一条未裁项都必须有一个「一定会到达」的触发点**（`downgrading-a-gate-needs-a-reachable-trigger`）——「若评审认为……」这种条件性上诉**不是触发点**，因为没有任何流程保证有人会去看。下表每条的触发点写在各自小节里，并同时挂进对应 commit 的门表或 T8.7 的 merged-state review 必查项。

| # | 状态 | 触发点 |
|---|---|---|
| #1 R-6 等级 | ✅ **已裁 2026-08-04**（候选 1，按判据列拆） | — |
| #2 Q1 telemetry 联合查询 | ⏳ **未裁** | **Commit 5 全节不可开工** |
| #3 §4.8 与选项 A 的冲突 | ⏳ **未裁**（绑进 #2 的裁决材料） | 同 #2；`q1-locations.sh PHASE=post` 要求 §4.8 变 `ruled` |
| #4 entry 拓扑 | ✅ **已裁 2026-08-04/05**（Commit -1 先合 master得 A；P 后执行树显式从 `ENTRY_SHA=A` 建） | — |
| #5 R-5 的 C1／C2 归属 | ⏳ **未裁** | **Commit 1 kickoff 之前**——候选②要改的正是 C1 的内容 |
| #6 两个正交轴的职责边界 | ⏳ **未裁**（**本轮重框**：不是「同一件事的两种命名」） | **Commit 1 kickoff 之前**——T1.6 一写就冻结形状；C4 停门第 4 项是兜底 |

### #1 R-6 的等级 —— ✅ **已裁 2026-08-04：候选 1，按判据列拆**

**用户裁决**：compile fixtures → **C1 `辅助门`**（§7.4）、import guard → **C6 `production 硬门`**（§7.9），两段各自定级。矩阵与本文 T1／T6 的门表已按此填。

⚠️ **裁决前本节列出的「候选 2 代价是辅助门失去阻断力」是错的**，一并记在这里免得复发：**辅助门失败同样阻止交付**（RFC §10.4 与本文 §10 都这么写），两档的真实差别只在**能否升级 behavior／closure 等级**——`production 硬门`通过可支撑「结构性闭合候选」，`辅助门`只作 presence ratchet。用一个不存在的阻断差异去塑造裁决，会诱导用户为了拿回一个它本来就有的效果而升档。

**遗留同步项**：RFC §10.2 的 R-6 行末列仍是无分段的 `本RFC辅助门；Commit 1／6` → **T8.1**。

### #2 Q1 —— telemetry 联合查询能力（**用户裁的是时机，不是内容**）

用户 2026-08-03 的裁决原文是被选中的选项文本「**现在不裁，到 Commit 5 前再说**」。**A／B／C 三个选项一个都没选**；§9.2 至今不含 Q1；`q1-locations.sh` 的 `PHASE=pre` 仍是正确相位。

选项（RFC §9.1）：**A** 预组合一个严格有界的 compound dimension（RFC 推荐）／**B** 扩展 registry 为 typed multidimensional key／**C** 只提供单维 breakdowns 与 History 明细。

**触发点**：**Commit 5 全节（T5.1～T5.7）在裁定前不可开工**，见该节前置停门。Q1 **不**阻塞 Commit 0～4。

### #3 §4.8 与选项 A 的冲突（**由实施者自判是无出处的自裁**）

`design.md:392` 对 `command` 维写着：

> 取RFC冻结的command family枚举；**不得使用函数名、任意error字符串或动态compound名称**。

而选项 A（`design.md:695`）正是新建一个 compound dimension `generation_command_outcome`。

**两种读法都成立**：

- A 的 key 由 canonical registry **笛卡尔积**生成、是**静态有界**的，未必算「动态」；
- 也可能这条禁令本就覆盖它。

**触发点**：绑进 #2 的裁决材料，**由主会话／用户在裁 A/B/C 时一并裁掉**。裁完 §4.8 那一行必须写明结论，`q1-locations.sh` 的 `PHASE=post` 会要求它从 `mentions` 变成 `ruled`。

⚠️ **这一处不被 Q1 谓词命中**（命中数 0），是评审换轴提结构性问题找出来的。**取材只抄 A/B/C 那一行，就会把它漏在十几行之后。**

### #4 Entry 拓扑 —— ✅ **已裁 2026-08-04/05：Commit -1 先合 master 得 A，P 后从 `ENTRY_SHA=A` 建执行树**

M1 已 merge 进 master（`8125f123`），**「两棵树」不再存在**。用户已通过 AskUserQuestion 选项 **「Commit -1 先合 master（推荐）」**裁定完整图：

1. Commit -1 在独立 worktree 实现并过自己的 TDD／mutation 门；
2. **先合入 master**；
3. 以合入后的新 master SHA 作为 entry **A**，从 A 建 cutover worktree；
4. 在树外 `OUT` 对 A 跑 15 次，manifest 冻结 `measured_sha=A`；
5. master 再提交 pointer **P**，机械满足 `git merge-base --is-ancestor A P`；
6. cutover worktree **仍从 A 开始 Commit 0**；P 是 master 状态线，**不得把 P 合回执行分支来重定义 A**；
7. Commit -1 落地后，旧 15 次全部作废，必须重取 A。

执行形状见 §0.2、Commit -1 与 §0.4b；门的绑根见 §0.3。

⚠️ **裁决前本节的候选 1 量化影响写着「merge 会引入需要解决的语义冲突」，实测是错的**：`git merge-tree --write-tree` rc=0、冲突列表为空，master 自 merge-base 起**未触及 feature 改过的任何一个文件**。**这条错误成本差点把裁决推向另一边**——记在这里当反例：**量化影响栏里的每个成本都要有可复跑命令，没实测过的不要写成事实**（`anchor-numbers-to-commits`）。

### #5 R-5 的 C1／C2 归属 —— ⏳ **未裁（本轮撤回自裁）**

⚠️ **本 plan 上一版在正文里断言「这不是错配」并按 C1 记账，同时在本节称「待裁」——那是实质自裁。** 本轮撤回该断言，**在裁决前不得声称任何一方成立**。

**事实**（双方都可查）：

- **矩阵** `traceability.md:35` 把 R-5 的辅助门段记为 **C1**；矩阵 §0 把「归属 commit」定义为**该门生效的 commit**。
- **本 plan** 把 cardinality assertion 的实现排在 **Commit 2**（T2.3），依据是 RFC §7.5 的 Commit 2 目标清单**逐字含「cardinality assertion」**，而 §7.4 的 Commit 1 清单**没有**。
- 因此按矩阵的定义，**C1 终态并不存在该辅助门**——「Commit 1 与 Commit 2 行为等价」不能让一个尚未实现的门追溯生效。

**候选**：①矩阵改成 C2（与 RFC §7.5 一致，本 plan 认为证据最强，但**不自行改**）；②plan 把 T2.3 前移到 Commit 1（与 RFC §7.5 的目标清单冲突）；③RFC §7.4／§7.5 补一句说明该 assertion 跨两个准备 commit。

**触发点**：**Commit 1 kickoff 之前——未裁则 C1 不得开工。**

⚠️ **上一轮把它挂在 Commit 2 门表是「可达但过晚」**：候选②是「把 T2.3 前移到 Commit 1」，而执行者走到 Commit 2 的门时 **C1 已经作为 semantic commit 提交并通过了它自己的 invariant**。那时才裁只剩三条路——改写已落盘的 C1、重排历史、或接受 C1 终态缺门，**plan 三条都没授权**。**触发点必须早于「该裁决还能无成本执行」的那一刻**，不是「流程一定会看到它」。

机械校验帮不上忙：`traceability-check.py` 只校验「production 硬门不早于其依赖能力」，辅助门段落在 C1 还是 C2 **它不判**，所以只能靠人工触发点。Commit 2 的门表**保留一行，但降为「复核裁决已被贯彻」**，不再承担首次裁决。

### #6 两个**正交轴**的职责边界（**本轮重框；上一版把它们误称为「同一件事」**）

⚠️ **上一版说这两者「处理的是同一件事、词汇高度重叠但不同构」——那个框法不成立**，据它做的裁决会丢东西。实测：

| | `OwnerTerminalDecision`（M1 引入） | `TerminalEmissionResult`（本 RFC 要引入） |
|---|---|---|
| **论域** | **任意 owner command 失败 → caller 该做什么** | **`terminate` 这一个 command 的结果** |
| **三态** | `client-aborted` / `delivery-finished` / `fail-loud`（`delivery/owner-failure.ts:11-14`） | `emitted` / `suppressed_client_gone` / `suppressed_session_terminating` |
| **回答的问题** | request 怎么 settle | terminal frame 发了没、哪些 segment 成功、socket close intent 是什么 |
| **实际调用面** | **不只 terminal**：`driver.ts:886,1018,1106,1525,1583` 全是 `beginLeg` 失败，`:1060` 是 `close-anchor-before-real`，`:1186` 是 close；经 `ownerFailureOutcome`（`:933`）→ `classifyOwnerFailure` | 只在 terminate 路径 |

**两者在 lifecycle reason（`client-gone`／`session-terminating`／`wire-torn`）上相邻，但不是同一判别函数的两个名字。** 因此：

- **候选①「Result 取代 Decision」会丢掉非-terminal command failure 的 caller action**——`beginLeg` 失败时没有 terminal frame 可言，却仍要决定 settle 形态。
- **候选③「合并成一个三态」覆盖不了两个正交轴**——一个是「caller 该做什么」，一个是「terminal effect 是什么」，笛卡尔积不是三态。

**四个候选**（第 ④ 个是本轮新增，也是重框后最自然的那个）：

| 候选 | 形状 | 代价／风险 |
|---|---|---|
| ① | `TerminalEmissionResult` 取代 `OwnerTerminalDecision`，M1 两模块一并重塑 | **已知会丢非-terminal 的 caller action**，除非另建一套；范围最大 |
| ② | `OwnerTerminalDecision` 保留为 owner 内部分类器，`TerminalEmissionResult` 只做它的对外投影 | 改动小；**但两套三态论域不同，「投影」关系并不成立**——非 terminal 的那些态投影到什么？ |
| ③ | 二者合并成一个三态 | **覆盖不了两个正交轴**；且要改 RFC §3.3 冻结形状，属契约变更 |
| ④ **（新增，推荐由 architect-advisor 确认）** | **保留正交职责**：`OwnerCommandFailureDisposition`（任意 command failure → caller action，即今天的 `OwnerTerminalDecision`，建议改名以免读者继续误以为它只管 terminal）与 `TerminalEmissionResult`（terminate 的 effect／result）各司其职，**只在「terminate 自身失败」这一格架一条具名映射桥** | 不丢任何一侧论域；**需要 exhaustive mapping 测试 + 顺序测试防双 settle**（同一失败既走 disposition 又走 result 时，settle 必须恰好一次） |

**为什么不能由实施者自裁**：T3.5 要求把「原 client-gone／session-terminating 提前返回」映射到 `terminalFrameDisposition`，但合并后主线上**那些提前返回已经被 `classifyOwnerFailure` 收敛了**，且**其中大部分根本不是 terminal**。照旧描述干，会在 `settleMessagesOwnerFailure` 之外再造一条分流路径，撞 Commit 4 的「first terminal command wins、terminal frame exactly once」。

**触发点**：**Commit 1 kickoff 之前——未裁则 C1 不得开工**（不只是 T1.6）。C4 前置停门第 4 项保留为**兜底**。

⚠️ **为什么必须早于 C1 而不是 C4**：T1.6 冻结 `TerminalEmissionResult` 类型并加穷尽性断言、T2.7 实现 `terminate`／`finalize` 状态机、T3.5 产出逐点映射——**取代／合并类候选（①③）到 C4 才裁就要重写 C1～C3**。**等干完再端候选出去，成本栏会被沉没成本污染**：候选①届时要连带推翻三个 commit 的类型层工作，看起来会比它实际的长远代价贵得多。**上一轮 #4 的「merge 有语义冲突」正是这样把裁决推向另一边的**（实测零冲突）。

**建议由 `architect-advisor` 先出重框提案**（两个轴的职责边界属架构合同，不是 plan 层可定的），再交主会话／用户裁。

---

## 12. 本 plan 未采纳的写法（`record-not-adopted`）

| 未采纳 | 为什么 |
|---|---|
| 把 Commit 4 拆成「先收 raw authority、后迁 producer」两个 commit | RFC §7.1 明确否定该分段；拆开必然产生「旧路径已禁而新 command 尚不可用」的中间态，或需要一个按 payload 猜 intent 的临时 adapter——§7.13 逐字禁止 |
| 把 T0.6 写成「提交一个红测试，红到 Commit 4」 | 与共同门「该档确定性全绿」**终态互斥**。改用 rc=0 的 characterization（绿 = 缺陷仍在）。**也不用 `skip`／`todo` 排除它**——跳过的测试永远不会告诉你缺陷是否还在，那让 R-3 的 C0 段可被假绿 |
| 把 `5 sites × 3 kinds × 4 scenarios` 当笛卡尔积逐格断言 | kind 在五个 site 上是**字面量写死的**（`driver.ts:885/1014/1102` = primary，`:1521` = recovery，`:1579` = continuation）。要求 primary-only site 驱动 recovery，只能伪造入口或错误扩宽 production site——**两种做法都在削弱门** |
| 把 10 个 composition 点当成 10 个并列 root 各建一个 owner | Anthropic 的 `:574`／`:658` 与 `:1192` 是**同一条链的两层**，各建会让单请求出现两个 owner，撞「一个 serializer／一个 timer」 |
| 只用一条「`terminate` 跳过 balancing」的 mutation 代替逐 handler mutation | 它只证明 owner 内部会平衡，**证不了每个 handler 已从旧 write 迁入**，也覆盖不到无 anchor 的 CC／Responses／Gemini terminal。RFC §5.3 逐字要求逐 handler |
| 用 `git diff -- src/` 作为 Commit 7 的「production 零改动」门 | 本 RFC 自己把 production 分布到 `packages/telemetry/**`，只扫 `src/` 时在那里改一字节仍判绿 |
| 从待测命令自己取 `MIN_TESTS` | 正是 `baseline-runs.sh:23-25` 点名的假绿：selector 缩窄后「实测」值同步变小，下限与被测对象同源、永远自洽 |
| 用 `ALLOW_DIRTY=1` 让 T0.1 在共享脏树上跑起来 | 脚本自己声明那批日志「do not satisfy a gate」。正确出路是隔离 worktree（已裁的 entry 形状天然满足） |
| 自行判定 §4.8 的「动态 compound 名称」不涵盖选项 A | 无 RFC 出处的自裁。两种读法都成立时，实施者的判断没有外部 oracle |
| 在 #5 上一边声称「待裁」一边在正文断言「这不是错配」 | 那是实质自裁。**已撤回**，并给了必经触发点（Commit 2 门表） |
| 把 `commandPortActivation` 当成既有符号写进删除清单并给 `file:line` | **实测合并后 master 的 `src/` 零命中**。给一个不存在的符号编行号，正是「跨一条没读过的缝规定行为」 |
| 用 `withAllocatedRealBlock`／`writeBlockFrame` 的现有签名作为 `openRealBlock`／`writeRealBlockFrame` 的终态签名 | RFC §3.4 明确：终态 public port 应暴露 owner 验证的 **opaque handle**，不把 mutable registry 或 mapping 实现对象交给 caller。现有签名是**迁移起点，不是终点** |
| 为 O-3／O-5／O-7／O-9 硬塞一个归属 commit 好让矩阵没有孤儿 | §10.4 明写「不得因『不属于本 RFC』从 roadmap 删除」，§10.3 明写 O-9「绝不删除」。硬塞与删除是同一错误的两个方向 |
| 把裁决材料的量化影响栏写成未实测的估计 | #4 候选 1 的「merge 有语义冲突」实测为**零文本冲突**，而候选 4 的卖点整个建立在「把冲突关在隔离树内」。**用错的成本对照做出的裁决，方向可能正好相反** |

