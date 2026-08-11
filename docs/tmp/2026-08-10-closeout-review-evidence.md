# 收尾产物独立评审（证据链核验）—— 2026-08-10 三档信号 / VACUUM gate

> 评审者：`reviewer`（独立实例，未参与本轮任何实现、评审或收尾）。
> 评审时点：2026-08-11，仓库 `/home/xp/src/copilot-api-js`，评审开始时 `master` HEAD = `11558f81`（peer 会话并发提交中，逐条证据自带 commit）。
> 评审范围：① `docs/todo/deferred-backlog.md` 末尾两条新条目；② `docs/tmp/2026-08-10-third-tier-signal-test-gaps-review.md` 的「落地状态」处置表与「收尾：非文件证据」节；③ `docs/decisions/2026-08-10-vacuum-gated-on-lock-contention.md` 的四格实测表与「不证明什么」段。
> 裁判轴：长远正确 + 完整 > ROI/YAGNI。收尾产物不因「只是文档」降低标准。
>
> **本文件边验边写**：证据日志按闭合顺序自上而下 append，verdict 与发现在全部证据闭合后回填至开头。

## 总体 verdict

**修复 major 后可进入下一阶段。blocker 数：0。**

- 你点名要我重算的**每一个数字/时间/commit/失败集合，全部独立复算过，无一处对不上**（C1–C3、C5、C7–C9、C11–C12）。核心证据链（native 产物过期 → 14 条假红、四格探针 → ADR 声称降级、变异 4 → 3 条横幅用例）**成立**。
- 1 条 major 不在这些数字里，而在**条目之间的缝**：新登记的 `isNativeHistorySearchAvailable` 那条与既有 `:1428` 是同一笔债的两份记录，且新那条的修法更弱、并丢掉了 `:1438` 记的阻断性交互（F1）。逐条核对查不出这类缺陷，只有把 backlog 当成一份要被执行的文档、第一人称走一遍「我明天来修这条会怎样」才撞得到。

### 双视角覆盖证据

**机械核对做了哪些扫描/对账/查证**
- `stat` 取 native 产物 mtime；`git log -1 -- native/history-search/src` 与 `--since='<产物 mtime>'` 两种口径取源码改动集合。
- `git show 14f7c6d4 -- native/history-search/src` 读 diff 判因果；`git log -S "pub async fn generation"`、`git merge-base --is-ancestor` 定位漏记的 commit。
- 处置表 G1–G8/H1–H3 共 11 条**逐条打开代码实体**并记 `file:line`（C7）；G3 backlog 条目引用的 3 处 `file:line` 逐个打开（C8）。
- ADR 改名后的入链对账：3 处入链 + 全仓 `grep vacuum-gated-on-live-connections` 零命中。
- `git diff --stat 29048d80..<HEAD> -- tests/history/search/ src/lib/history/search/ …` 确认合并未碰这些路径（A/B 的机械旁证）。
- `state-defaults.ts` / `config.yaml` / `config.schema.json` 三处对账 `stale_request_max_age` 的默认值口径。
- 二进制导出面 vs 当前 Rust `#[napi]` 方法表逐项比对（不靠 mtime 推理的独立 oracle）。

**第一人称执行模拟了哪些流程/分支/用户路径**
- **「我是下一个来修这条 backlog 的人」**：照 `:1496` 的 mtime 方案走一遍 → 撞上 checkout 刷 mtime 的假绿路径，再撞上 `:1445` 已经写好的多重集门 → 得出 F1。
- **「我是重跑变异台账验证鉴别力的人」**：四条变异逐条注入实跑（第 3 条的两种读法都试），发现台账第 3 格已失真 → F2。
- **「我是想知道这条 gate 到底值不值得留的人」**：补跑四格表没有的那一格（peer 持写事务），得到「无 gate = 阻塞 5013ms 再抛」→ F3。
- **「我是照着 `connection.ts` 读代码的人」**：按行序读完整个 `maybeVacuumOnStartup`，在 SCOPE 注释之后又读到相反结论 → F5。
- **「我是相信 PTY 层守着横幅文案的人」**：去找那条守卫，发现它在 G6 里已被换掉 → F6。
- **「我是在新建 worktree 里跑测试的人」**：在无产物树实跑同两个文件，拿到 `2 pass / 26 skip / 0 fail`（两个方向各跑一次，而不是只验假红那一侧）。
- **「我是要证明替身承重的人」**：构造「缺陷在场而判据全绿」的场景（删 skip + 替身退回判别式 → 49 pass / 0 fail），反证 G5/H3 的理由真的承重（C10）。

## 证据日志

### C1 —— native 产物 mtime 与 Rust 源码最后改动（**断言成立**）

- 产物：`stat -c '%y' native/history-search/copilot_history_search.node` → `2026-08-06 20:08:21 +0000`。与文档写的「构建于 2026-08-06 20:08」逐字一致。
- Rust 源码最后改动：`git log -1 --format='%H %cI %s' -- native/history-search/src` → `14f7c6d4cd150c3d1c0cfa950db63b4b026c3a8b 2026-08-09T01:06:26+00:00 fix(history-search): report an unparsable query as a result field, not a napi status`。与文档写的「`14f7c6d4`（2026-08-09 01:06）」一致。
- 补充口径（文档未写、但不影响结论）：`native/history-search/` 目录下 `Cargo.toml` / `Cargo.lock` 的最后改动更早（`git log` 同一命令扩到整个目录，top commit 仍是 `14f7c6d4`），故「源码最后改动」这个说法用整个 native 目录口径也成立。

### C2 —— 「失败用例 `reports an unparsable query as invalidQuery` 正是 `14f7c6d4` 修的东西」（**因果成立，非事后叙事**）

- `git show 14f7c6d4 -- native/history-search/src`：该 commit 在 `ListSearchResult` 上**新增** `pub invalid_query: bool` 字段，并删除 `invalid_query_error()`（原先靠 `Status::InvalidArg` 传递）。
- 消费侧用例 `tests/history/search/daemon.it.test.ts:388` 名为 `reports an unparsable query as invalidQuery, keeping a malformed request an error`，`:414/:416` 断言 `invalidQuery: false` / `invalidQuery: true`。
- 主检出实跑该文件，失败形态为 `Expected - 1 / Received + 0`：期望里有 `"invalidQuery": false`，实收对象**没有该键**——即旧 `.node` 的返回结构里没有这个字段。**因果链闭合**：产物构建于 08-06，字段引入于 08-09。

### C3 —— 「14 条失败全部既有、与本次合并无关」（**独立 A/B 复现，断言成立**）

独立重跑（未复用主会话的任何中间产物）：

- 主检出（`master`，评审时 HEAD `11558f81`）：`bun test ./tests/history/search/daemon.it.test.ts ./tests/history/search/search-rest-cutover.it.test.ts` → `14 pass / 14 fail`，exit 1。
- pre-merge 对照：`git worktree add --detach /tmp/ab-premerge-review 29048d80`，拷入**同一份** `copilot_history_search.node`（mtime 保持 08-06 那份内容）、`node_modules` 软链主树，**同一调用内** `cd` 并 `pwd -P` + `git log -1` 自证（避免主会话自己记的「A/B 跑错了树」那个坑）→ 同样 `14 pass / 14 fail`。
- 失败用例名集合逐条 `diff` → **完全相同**（`diff /tmp/ab-master-fails.txt /tmp/ab-premerge-fails.txt` 为空）。
- 机械旁证：`git diff --stat 29048d80..11558f81 -- tests/history/search/ src/lib/history/search/ src/lib/history/search-native.ts native/` **输出为空**，合并根本没碰这些路径。

结论：「14 条既有、与合并无关」成立。**另注**：backlog 写的分布「`daemon.it.test.ts` 12 条 + `search-rest-cutover.it.test.ts` 2 条」也与实测一致（cutover 文件贡献 `GET entries?search traverses…` 与 `an unparsable query is 400 while an unreachable sidecar stays 503` 两条）。

### C4 —— 独立旁证：陈旧 `.node` 的导出面确实缺少当前源码的方法（**加强 C2**）

不依赖 mtime 推理，直接看二进制自己的导出面：

```
bun -e 'const m=require("./native/history-search/copilot_history_search.node"); console.log(Object.getOwnPropertyNames(m.HistoryIndex.prototype).sort().join(","))'
→ close,constructor,flush,listSearch,search,upsert,upsertSummary
```

当前 Rust 源码有 `pub async fn generation(&self) -> Result<IndexGeneration>`（`native/history-search/src/lib.rs`，`#[napi]`）——**二进制里没有 `generation`**，因此实跑里出现 `TypeError: options.index.generation is not a function (src/lib/history/search/daemon.ts:561)`。`generation` 由 `7a99a254`（2026-08-08T19:51:36）引入。

**口径补充（不是缺陷，是精度）**：产物落后的不止 `14f7c6d4` 一个 commit——`git log --since='2026-08-06T20:08:21' -- native/history-search/src` 列出 **6 个** commit（`7a99a254`/`907302dc`/`d38fcb9c`/`a7a2da0d`/`0fef1143`/`14f7c6d4`）。backlog 写「源码最后改动是 `14f7c6d4`」字面正确，且它只把该 commit 当作**其中一条**失败用例的解释，没有声称 14 条都源于它——但读者容易把落后幅度读成「一个 commit」。

### C5 —— ADR 四格实测表 + 两条关键条件（**两条都成立，独立两进程探针复现**）

我没有复用 ADR 的探针脚本，改用**真正的两个进程**（`Bun.spawn` 起 peer，stdin 逐步驱动 open/begin/commit），每格前 INSERT 制造新 WAL 内容：

| 场景 | 我实测的 `PRAGMA wal_checkpoint(TRUNCATE)` | ADR 写的 | 一致？ |
| --- | --- | --- | --- |
| 无 peer，WAL 有内容 | `{busy:0,log:0,checkpointed:0}` | 同 | ✅ |
| peer 连接已开、**无事务**，WAL 有内容 | `{busy:0,log:0,checkpointed:0}` —— 放行 | `busy:0` 放行 | ✅ |
| peer 持**读**事务，WAL 有内容 | `{busy:1,log:1,checkpointed:0}` | `{busy:1,log:1,checkpointed:0}` | ✅ 逐字段相同 |
| peer 事务已提交，WAL 有内容 | `{busy:0,log:0,checkpointed:0}` | `busy:0` | ✅ |

「WAL 必须非空」这条**第二必要条件**单独设对照（这是四格表里最容易被自证的一格，因为要**在 peer 已持读事务时**把 WAL 清空才测得到）：

```
truncate 后 wal = 0B
WAL 为空(0B)  + peer 持读事务 → {"busy":0,"log":0,"checkpointed":0}
WAL 非空(4152B) + 同一个 peer 读事务仍持着 → {"busy":1,"log":1,"checkpointed":0}
```

同一个 peer 事务、只变 WAL 是否为空，`busy` 就从 0 翻到 1 —— **「空 WAL 恒 busy:0」成立，且它确实是必要条件而非巧合**。ADR 第 43 行与 `connection.ts` 的 SCOPE 注释都如实写了这一点。探针脚本：`/tmp/vprobe/{peer.ts,main.ts,main2.ts}`（一次性，评审后可弃）。

### C6 —— 补测 ADR 没测的那一格：peer 持**写**事务

四格表只覆盖读事务。我补了危害形态那一格：

```
peer 持【写】事务(BEGIN IMMEDIATE + INSERT，未提交) + WAL 非空
  → probe = {"busy":1,"log":3,"checkpointed":3}     ← gate 会拦
  → 同一状态下直接 VACUUM = VACUUM THREW 5013ms: SQLiteError: database is locked
```

两点结论：
1. **ADR 的定夺在危害形态上是成立的**（写者在场 → `busy:1` → 跳过），四格表只是没写这一格。
2. 但它证否了评审报告处置表 G7 里那句「真正危害形态（writer）里 VACUUM 本来就会被 `connection.ts:241` 吞掉——**有没有 gate 观测结果相同**」：数据库终态相同，**启动路径不同**——无 gate 时是「阻塞满 5 秒再抛、被吞」，有 gate 时是「立即跳过」。5 秒的启动停顿正是 ADR 自己在「探测必须用零 busy_timeout」一节点名过的可观测回归。详见 F3。

### C7 —— 处置表 G1–G8 / H1–H3 逐条落地核验（**10 条「已修」全部在代码里查得到实体**）

先更正一处口径：派活提示说「11 条中 9 条修完、2 条拆出」，**文档实际写的是 G 轮 7 修 + 1 拆（G3）、H 轮 3 修**，即 10 修 + 1 拆。以文档为准，逐条查：

| # | 声称 | 代码实体（file:line） | 判定 |
| --- | --- | --- | --- |
| G1 | fake 镜像 `releasesOnSettle` + 新增 settled 用例 | `tests/helpers/mock-tracker.ts:61,69`（`releasesOnSettle ?? true`，`fail()` 内按它决定是否移出）；用例 `tests/shutdown/shutdown.unit.test.ts:746` | ✅ |
| G2 | `abandonDrain` 返回 `{started,terminated,finalizing}`、settled 跳过 | `src/lib/shutdown.ts:624`（签名已含 4 字段）、`:641-645`（`if (operation.settled) { finalizing++; continue }`） | ✅（且已含 H1 的 `lightweight`） |
| G3 | 拆出并登记 backlog + ADR 内加 ⚠️ 段 | `docs/todo/deferred-backlog.md:1481-1489`；`docs/decisions/2026-08-10-three-tier-shutdown-signal-contract.md:45` 确有 ⚠️ 段，且明写「在那条闭合前，不得声称第二档的终态『绝不被读成 timeout』」 | ✅ |
| G4 | 新增 `describeDrainAbandonment`，未开始时不含 "now flushing" | `src/lib/shutdown.ts:666-669`（`if (!outcome.started) return "the drain has not started yet…"`）；用例 `:793` | ✅ |
| G5 | lightweight 替身带上可用原语 | `tests/helpers/mock-tracker.ts` `buildLightweight` 内挂 `reapInFlight`/`fail` 两个 spy，并有注释说明「若 skip 被删，调用会落在 spy 上被看见，而不是掉进 catch 继续绿」；用例 `:827` | ✅ |
| G6 | PTY 断言改钉「选中第二档且存活」 | `tests/shutdown/fixtures/two_signal_pty.py:95` `read_until(b"Second termination signal")`、`tests/shutdown/shutdown-signals.pty.test.ts:85` `toContain("Second termination signal")`，两处均带 scope 注释 | ✅ |
| G7 | ADR 改名 + 三处入链同步 + 复现步骤进 ADR | 文件名 `docs/decisions/2026-08-10-vacuum-gated-on-lock-contention.md`；入链 3 处（`docs/lifecycle.md`、`docs/todo/deferred-backlog.md`、`docs/decisions/2026-08-10-three-tier-shutdown-signal-contract.md`）；全仓 `grep vacuum-gated-on-live-connections` **零命中**（旧名无残留）；ADR:79-93 有探针 | ✅ |
| G8 | `try/finally` 恢复 `busy_timeout` | `src/lib/history/sqlite/connection.ts:225-231`（`try { … } finally { database.exec(\`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};\`) }`） | ✅ |
| H1 | 增计 `lightweight`，仅残余为空才说 `now flushing` | `src/lib/shutdown.ts:631,635`（计数）、`:671-678`（`stillHolding` 为空才 `now flushing`，否则 `STILL HELD by …`）；用例 `:868` | ✅ |
| H2 | 源码注释与 skill 收窄因果 | `src/lib/shutdown.ts:640` 注释已改成「canonical finalizer **does NOT** read that signal (it waits on `whenOperationQuiesced()`)，真正消费的是 operation body / transport / delivery」 | ✅ |
| H3 | `buildLightweight` 构造完整形状 | `tests/helpers/mock-tracker.ts` 的 `buildLightweight` 产出 `operationId/kind/method/path/startTime/requestedModel`，与 `src/lib/context/lightweight-model-operation.ts:30-37` 的 `LightweightInFlightOperation` **逐字段对齐** | ✅ |

### C8 —— G3 backlog 条目的引用位置逐个打开（**引用全部准确**）

- `src/lib/context/request.ts:1124-1126` = `reapInFlight() { lifecycleAbort.abort(cancellationAbortError("stale-reaper", "Request cancelled by the stale-request reaper")) }` —— **无参数、成因写死**，属实。
- `src/lib/error/forward.ts:573` = `if (cancellation === "request-deadline" || cancellation === "stale-reaper") {`，其下 `:580` 生成 `stale-request reaper ${state.staleRequestMaxAge}s` 并 `defaultError(..., 504)` —— **504 + 该文案**属实。
- `packages/foundation/src/error/cancellation-reason.ts:35` = `export type CancellationCause = "stale-reaper" | "request-deadline" | "request-cancel" | "dispatch-cancel"` —— 行号精确，「既有 4 个 cause」属实。

### C9 —— 变异台账四条逐条复现（**第 4 条成立；第 3 条在合并态已失真**）

方法纪律：**没有在共享工作树里做变异**。另建隔离 worktree `git worktree add --detach /tmp/mut-review HEAD`（复现时 HEAD `ca20b9e8`，peer 仍在推进），软链主树 `node_modules`，每次注入后 `git checkout -- src/lib/shutdown.ts` 复原并 `git status --short` 确认为空。主树全程只有 peer 的既有 WIP，`git diff` 无我方源码改动。

基线：`bun test ./tests/shutdown/shutdown.unit.test.ts` → **49 pass / 0 fail**。

| 台账第 N 条 | 我注入的变异 | 台账写的 | 我实测 | 判定 |
| --- | --- | --- | --- | --- |
| 1 | `if (operation.settled)` → `if (false)` | 只红这一条 | **1 fail**：`an already-settled operation still finalizing is left alone…` | ✅ 相符 |
| 2 | `!source` 分支 `started: false` → `true` | 只红这一条 | **1 fail**：`tier 2 before the drain has started says so…` | ✅ 相符 |
| 3 | 去掉 lightweight 的 `continue`（两种读法都试了：只删 `continue`／整块删除） | **只红这一条**：`tier 2 deliberately leaves lightweight operations alone` | **2 fail**：上述那条 **＋** `with only lightweight operations left, tier 2 does not claim it is flushing` | ⚠️ **不符**，见 F2 |
| 4 | `if (stillHolding.length === 0)` → `if (true)` | 同时红 3 条 | **3 fail**：`an already-settled operation…` / `tier 2 deliberately leaves lightweight…` / `with only lightweight operations left…` | ✅ 相符，且就是文档点名的那三条横幅用例 |

第 3 条不符的成因是可解释的、且方向无害：台账那一格记录于 **H1 落地之前**，当时 `:868` 那条用例还不存在；H1 新增用例后同一变异的爆炸半径从 1 变成 2。**但台账没有任何快照限定词**，它与 H1 处置写在同一份文档里、读起来像同一时刻的观测。

### C10 —— G5/H3 的理由是否**真的**承重（正样本对照，两个方向）

处置表说「lightweight 替身**故意带上可用原语**，否则丢失判别式只会掉进 catch 里继续绿」。这是一条关于**判据鉴别力**的因果断言，我按它构造反证：**同时**注入「删掉 `continue`（保留 `lightweight++`）」与「把 `buildLightweight` 退回只有 `operationId` 判别式的旧形状」——

```
49 pass / 0 fail
```

**缺陷完全隐身。** 而只注入前者（替身保持完整形状）时是 2 fail。所以该理由**成立且承重**：替身上的 `reapInFlight`/`fail` spy 就是这条判据全部鉴别力的来源。这是本轮最强的一条正控证据，文档没有把它写出来（只写了理由，没写反证），建议补进 skill 的自验表。

### C11 —— 「新建 worktree 天然没有产物 → 全部 skip → 假绿」（**成立**）

在**没有** `.node` 的隔离 worktree（`/tmp/mut-review`，`ls native/history-search/` 只有 `Cargo.*`/`build.rs`/`src`）里跑同两个文件：

```
2 pass / 26 skip / 0 fail   （exit 0）
```

而主检出同两个文件是 `14 pass / 14 fail`。**同一 commit、同一套判据，在两种环境里朝相反方向失效**——backlog 这句话是准确的，且我这次是**在两个方向上各跑了一次**才这么说。

### C12 —— `isNativeHistorySearchAvailable()` 的实现（**断言成立**）

`src/lib/history/search-native.ts:133-141`：

```ts
export function isNativeHistorySearchAvailable(): boolean {
  if (nativeOverride) return true
  return candidates().some((candidate) => { try { require.resolve(candidate); return true } catch { return false } })
}
```

只做 `require.resolve`（存在性），**不读任何版本/时间信息**——「只检查产物存在、不检查是否过期」属实。

### C13 —— 环境清理

我自建的两棵 worktree（`/tmp/ab-premerge-review`、`/tmp/mut-review`）在移除前 `git status --short` 均为空，已 `worktree remove --force`（`GIT_DISCIPLINE_OK=1`，二者均由我数分钟前建于 `/tmp`、detached HEAD、无同伴）。移除后 `git worktree list` 中二者零命中，目录已不存在。**主检出的 `native/history-search/copilot_history_search.node` mtime 仍为 `2026-08-06 20:08:21`（未被我重建或覆盖）**；主树 `git status` 中的已修改文件全部是同伴的既有 WIP，我只新增了本文件这一个未追踪文件。

---

## 事实性发现

### F1 [major] `docs/todo/deferred-backlog.md:1491-1498` —— 与既有条目 `:1428-1436` 是同一缺陷的第二份登记，且修法更弱、丢掉了一条阻断性交互

**证据**

- 两条的**根因句几乎同义**：`:1430`「`isNativeHistorySearchAvailable()` 只判断 `native/history-search/*.node` **是否存在**，不判断它是否与 Rust 源码同代」；`:1493`「该判据只问『在不在』，**不问它是否落后于 Rust 源码**」。
- 同一失败集合（都写 14 条、都指 `daemon.it.test.ts` + `search-rest-cutover.it.test.ts`）、同一绕过命令（`bun run build:history-search`）、同一修复方向（判据改为版本感知、过期时 skip 而非红）。
- 新条目**零交叉引用**既有条目，而该文件有明确的既定惯例（`:1383`「本条**取代**上面 2026-07-30 那条」）。
- **修法分叉且新的那条更弱**：`:1434` 提的是**指纹**（构建时把 `native/history-search/` 的 tree hash / 源码 sha 写进 sidecar，或由 napi 导出版本常量）；`:1496` 提的是**比 mtime**。mtime 在本仓是已知不可靠信号——实测 `native/history-search/src/lib.rs` 的 mtime 是 `2026-08-09 08:54`，**晚于**它的提交时间 `2026-08-09 01:06`，那是**检出时刻**。于是「checkout 过一次分支再切回来」就会把内容未变的源码刷成「比产物新」，mtime 判据据此判过期 → 按 `:1496` 方案①**静默 skip** → **假绿**。方向正是最难发现的那个：`:1495` 自己刚说完「新建 worktree 全部 skip → 假绿」是问题，`:1496` 的修法却会制造同一形态的假绿。
- **丢掉的阻断性交互**：`:1445` 明写「**上一条 backlog 的指纹修法落地（它会把 34 条 skip 变成条件性显式 skip，直接踩中本条）**」——即 `scripts/validate-entry-evidence.ts` 的 skip 多重集精确相等门（`:1440`）。`:1496` 的方案①**完全踩中同一交互**，条目内只字未提；它建议的正样本对照「故意 touch 一个 Rust 源文件，确认判据翻转」恰恰是会翻转那 34 条 skip 的动作。

**修法**（二选一）

1. **合并**：删除 `:1491-1498`，把它**真正新增的信息**并入 `:1428`——① 合并态 A/B（pre-merge `29048d80` 对照，失败集合逐条相同）；② 双向实测（主检出 `14 pass/14 fail` vs 无产物树 `2 pass/26 skip/0 fail`），这条对称性是既有条目没有的。
2. **保留但降格**：`:1491` 显式写「本条与 `:1428` 同源；修法**以 `:1428` 的指纹方案为准**，mtime 只作为廉价告警（对应 `:1496` 方案②，不改 skip 状态）」，并把 `:1445` 的多重集交互抄进「若做需改什么」。

### F2 [minor] `docs/tmp/2026-08-10-third-tier-signal-test-gaps-review.md:94` —— 变异台账第 3 条在合并态已失真，且无快照限定词

**证据**：台账写「只红这一条」，实测（隔离树、HEAD `ca20b9e8`）**红 2 条**（新增 `with only lightweight operations left, tier 2 does not claim it is flushing`）。两种读法（只删 `continue` / 整块删除）结果一致。成因可解释：该格记于 H1 落地前，H1 新增用例后爆炸半径从 1 变 2。但它与 H1 处置写在同一份文档里，读起来像同一时刻的观测。

**修法**：给第 3 行加限定「（记于 H1 落地前；H1 之后同一变异红 2 条）」，或直接更新为 2 条并写明口径 commit。同表其余三条我实测全部相符，不必动。

### F3 [minor] 同文件 `:55`（G7 处置栏）—— 「有没有 gate 观测结果相同」被写事务探针证否，文档未更正

**证据**：C6。peer 持**写**事务时 `probe = {busy:1,...}`（gate 会拦），而同状态下直接 `VACUUM` 是 `THREW 5013ms: database is locked`。数据库终态相同，**启动路径差 5 秒**——这正是 ADR「探测必须用零 busy_timeout」一节点名过的可观测回归形态。该文档对 G3、G6 都写了「本轮的更正」，唯独 G7 这句原文被原样留着。

**修法**：在 G7 处置栏补一行同格式更正：「**更正**：写事务在场时无 gate 会阻塞满 `busy_timeout` 再抛（实测 5013ms），与有 gate 的『立即跳过』并非观测等价；gate 的收益是**这段启动停顿**，不只是危害窗口。」

### F4 [minor] `docs/todo/deferred-backlog.md:1484` —— 「`stale_request_max_age` 现在默认 0」口径错

**证据**：代码默认是 **600**（`packages/foundation/src/state-defaults.ts:257` `staleRequestMaxAge: 600`，`git log -S` 显示只被 `a485b6e1` 搬过文件、值未变）；是**本仓 `config.yaml:240` `stale_request_max_age: 0`**（tracked，`a6eeebc1` 起）把它设成 0。同一错误也出现在 commit `7f3eae4a` 的 message（「since `stale_request_max_age` now defaults to disabled」）与 `docs/lifecycle.md:201`（「两个 wall-clock guard **默认都禁用**」——`requestDeadline: 0` 属实，`staleRequestMaxAge: 600` 不属实）。

**影响范围要说清**：这**不动摇**该条目的核心缺陷（`reapInFlight()` 写死 `stale-reaper` → 客户端读到 504「我方时钟」）——那条我逐个打开引用位置核过，全部属实（C8）。错的只是「0s 自相矛盾读数」的**普适性**：它只在本仓 config 下成立。

**修法**：改成「本仓 `config.yaml:240` 把 `stale_request_max_age` 设为 0（代码默认 600，`packages/foundation/src/state-defaults.ts:257`），因此**在本部署下**文案读作『stale-request reaper 0s』」。顺带修 `docs/lifecycle.md:201`。

### F5 [minor] `docs/decisions/2026-08-10-vacuum-gated-on-lock-contention.md:20-24` —— 「同一文件里另一条注释……一并修正」没有真的修掉那个前提

**证据**：ADR 引用并否定的旧句是「We are still single-connection at startup … so TRUNCATE takes its exclusive moment uncontended」。该句确实被改写了，但**现文本 `src/lib/history/sqlite/connection.ts:245-247` 是**：

```
// The probe above established that we hold this database alone, so TRUNCATE gets its
// exclusive moment uncontended and shrinks the -wal back to zero.
```

「the probe above **established** that we hold this database alone」正是 ADR 第 43 行与同一函数上方 SCOPE 注释（`:222`「**do not read this as** "is another process using the db?"」）明确否定的那句话。同一个函数里两段注释互相矛盾，**且被否定的那句在下面**——按阅读顺序，读者最后看到的是错的那条。

**实际危害有限但非零**：此处 TRUNCATE 失败只会返回 `busy` 不抛，所以没有运行时后果；危害是**认知**的——下一个读者会带走「探针证明了独占」这个恰恰被本轮推翻的心智模型。

**修法**：把该句改为不依赖探针的真实理由，例如「VACUUM 自身已成功取得过独占锁，说明此刻大概率仍独占；即便被抢占，`wal_checkpoint` 只返回 `busy` 而不抛，代价是 WAL 停在高水位、下次启动再收」。

### F6 [minor] `docs/tmp/2026-08-10-third-tier-signal-test-gaps-review.md:61` —— 「false-red 评估」在 G6 修完后已不成立，却标为「主会话认可」的现结论

**证据**：该行说「`read_until(b"abandoning the drain wait")` …… 该字面量**存在于三处**且 fixture 被 4 个用例共用，改文案会一次打红 4 条」。评审时点（`6dace278`）确实三处（`src/lib/shutdown.ts:664`、`tests/shutdown/fixtures/two_signal_pty.py:94`、`tests/shutdown/shutdown-signals.pty.test.ts:84`）。**G6 修完后只剩一处**（`src/lib/shutdown.ts:675`），PTY 两处已改钉 `Second termination signal`。

**为什么值得改**：错的方向是**高估守卫**——读者会以为横幅文案在 PTY 层有守卫（「改文案会打红 4 条」），实际**现在没有任何一层守横幅文案**，改文案只会打红 unit 层那三条断言。

**修法**：把该段标为「评审时点（`6dace278`）快照」，并补一句当前状态：「G6 修复后该字面量仅存于 `src/lib/shutdown.ts:675`；横幅文案的守卫现在只在 unit 层。」

### F7 [minor，范围外但同文件] `docs/todo/deferred-backlog.md:1431` —— 「此后有 5 个提交」实为 6

**证据**：`git log --since='2026-08-06T20:08:21' -- native/history-search/src` 列出 6 个：`7a99a254`(08-08 19:51)、`907302dc`、`d38fcb9c`、`a7a2da0d`、`0fef1143`、`14f7c6d4`。条目漏的正是 `7a99a254`「bind the tail cursor to its index generation」——它引入 `pub async fn generation`，而陈旧二进制里**没有** `generation`（实测导出面为 `close,constructor,flush,listSearch,search,upsert,upsertSummary`），那批 `TypeError: options.index.generation is not a function` 失败全由它造成。`git merge-base --is-ancestor 7a99a254 638f6f3c` 为真，故在该条目声明的口径 commit 上它已存在。

**修法**：按 `anchor-numbers-to-commits`，把「5 个提交」换成可重算的那条命令；确需写值则改 6 并补上 `7a99a254`。

## 主观建议

- **[建议] 变异台账与四格表 —— 给命令而非只给值。** 预期影响：F2 那类失真不会再发生（台账的值随代码演进必然过期，而读者无从判断）。推荐做法：每格附「怎么重跑这一格」的一行命令（四格表已在 ADR 里做到了，台账没有）。
- **[建议] 把 C10 的反证补进 skill `process-lifecycle-shutdown` 的自验表。** 预期影响：目前 skill 只写了「替身故意带原语」的**理由**，没写**证明**；我实测「删 skip + 替身退回只有判别式 → 49 pass / 0 fail」是本轮最强的一条正控，它把「fake 比真依赖友好会吃掉整条判据」从主张变成可复跑的事实。推荐做法：连同 exact patch 一起登记进该 skill 已有的正控表（`:148` 那节的格式）。
- **[建议] `:1496` 若最终采用 mtime 方案，把比较对象钉到 git 而非文件系统。** 预期影响：绕开 F1 里那条「checkout 刷 mtime → 误判过期 → 静默 skip → 假绿」的路径。推荐做法：构建时把 `git rev-parse HEAD:native/history-search` 的 tree hash 写进产物旁的 sidecar，判据比 tree hash（这也正是 `:1434` 已经提出的方案）。
