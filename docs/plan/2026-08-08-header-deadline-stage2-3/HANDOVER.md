# HTTP/2 termination provenance 阶段 2–3 交接

> **状态：进行中（阶段 1 已交付，阶段 2/3 未开工）**
>
> **核验基线：** 2026-08-08，本地 `master` = `d1011fe7eb1f26c0c646b667164ddb0e4dd80bf0`；阶段 1 代码终点 = `bea1dfa3d61896bf2089958676bd1236269877d9`，spec 状态提交 = `d47492a69d1cd7a66fa08b63ad8d717bafbdf194`。复现：**`git rev-parse refs/heads/master`**（**别写 `git -C <主树>`**——在隔离 worktree 会话里会被护栏拒绝；worktree 共享 refs，裸命令实测同值）。**未 push**，全部提交都在本地。
>
> **分支与 worktree：** 阶段 1 在隔离 worktree `/home/xp/src/copilot-api-js/.claude/worktrees/nghttp2-header-deadline`（分支 `worktree-nghttp2-header-deadline`）完成，已 fast-forward 进 `master`。阶段 2 请**另开新 worktree**，不要复用该树。
>
> **收尾后的分支状态（2026-08-08，由独立评审证伪后更正）：** ⚠️ 本行先前写「该分支全部提交已是 `master` 祖先」，**那是错的**——写下它时分支已有若干收尾提交未进主线。**别用字面数字，它会漂**（一度写 5，随后就成了 7）；用命令取当前值：`git merge-base --is-ancestor worktree-nghttp2-header-deadline master`（未合入时退出 1）与 `git rev-list --count master..worktree-nghttp2-header-deadline`。**因此本刷新段在写作时并不在 `master` 上**（`git show master:<本文件> | grep 收尾时刷新` 零命中）——从 `master` 开新树的接手方会读到没有刷新段的旧版。
>
> **一个更稳的事实（不随提交数变化）**：`git diff --name-only master...worktree-nghttp2-header-deadline` **只有 `docs/` 下的路径、无任何代码路径**——即这些未合入提交全是文档，孤立它们不会丢失代码，但会丢失本轮的收尾记录与两份评审报告。
>
> **正确顺序（用户已裁决：分支删除、worktree 保留）**：① 先在主树 `git merge --ff-only worktree-nghttp2-header-deadline`；② 确认 `merge-base --is-ancestor` 退出 0；③ 再删分支。**顺序不能颠倒**：`git branch -d` 对未合入分支会拒绝，而 `-D` 会把这些 docs 提交打成孤立提交。另注意该分支正被本 worktree 检出，**`branch -d` 在检出状态下物理上删不掉**（`cannot delete branch ... used by worktree`），须先在该 worktree `git checkout --detach` 或移除该 worktree。**执行前以 `git branch --list worktree-nghttp2-header-deadline` 与上面两条命令为准，不要相信本行的时态。**
>
> **未提交 WIP：** 本交接落盘时，共享主树 `/home/xp/src/copilot-api-js` 有其他会话的未提交改动（`config.yaml`、`docs/plan/2026-07-28-session-closeout-skill-review-claude.md` 及若干未追踪 `docs/` 文件）。**那些不是本任务的**，不得 stage、commit、stash 或还原。接手时自行 `git -C /home/xp/src/copilot-api-js status --short` 重取。⚠️ **若你也在隔离 worktree 里，这条命令会被护栏拒绝**（实测：`-C` 指向共享 checkout 的 git 操作被拦），改到主树会话里跑，或让用户代跑。
>
> **已跑门禁（阶段 1 合并态，锚定 `bea1dfa3`）：** `bun run typecheck` 绿；`bun run lint:all` 绿；`bun run test:backend` = `7279 executed / 30 skipped / 0 fail`。独立 code reviewer 与 verifier 各自复评 PASS（0 blocker / 0 major / 0 minor）。
>
> **⚠️ 收尾时刷新（2026-08-08 23:21 UTC，`master` = `5720855929c78b6b601b64c57b9329513edcd98e`）：** 上面那组数字仍然成立，但**只在它锚定的 `bea1dfa3` 上成立**；此后主线大幅前进，你现在跑会得到**不同的数字**，那不是回归：
>
> - 最近一次合并态实测（`f4efacfe`）是 `7297 executed / 35 skipped / 0 fail`。executed 涨是主线新增测试；skipped 从 30 涨到 35 的 **5 条增量全部是 `describe.skipIf(!NATIVE)`**（已核，无 todo／whole-suite-skip 混入；本机无 native 产物即 skip，属预期，见 CLAUDE.md 测试分档节）。⚠️ **`0 fail` 不是稳定可复现的，且不止一条**：全套件 16 分片并行下，实测**两个**文件会因负载而红，单独跑均绿——
>   - `tests/history/v3/store-performance.it.test.ts`（撞 15s timeout；单跑 3 pass / 0 fail）
>   - `tests/e2e-client/keepalive-idle-reset.it.test.ts`（`keepalive M-2 … armSilent (positive control)`；单跑 3 pass / 0 fail）
>
>   撞到时**先按文件单跑判别**（`bun test <该文件>`）是真回归还是机器负载，别当成你的改动引入。收尾时这两条在同一次 `test:backend` 里同时红过一次，而当时分支 delta 是纯文档（`git diff --name-only master...<branch>` 无代码路径），故与本轮改动无关。
> - `tests/infra/entry-test-discovery-baseline.json` 的 `allowed_skipped` 与实测 skip 数存在缺口（收尾时为 31 vs 35，**这两个数会随 peer 补登记而变，别当固定值**；重取：`bun -e 'console.log(require("./tests/infra/entry-test-discovery-baseline.json").allowed_skipped.length)'` 与 `bun run test:backend` 输出行里的 `skipped`）。⚠️ **归因已更正**：先前写「差的 4 条来自 `08046d5c`」是错的——`08046d5c` 实测**是 `bea1dfa3` 的祖先**（`git merge-base --is-ancestor 08046d5c bea1dfa3` 退出 0），早于阶段 1，不可能是来源。真实来源是 **`d38fcb9c`（+4，给 `tests/history/search/daemon.it.test.ts` 加了 191 行）**；另 +1 来自 `7a99a254`，**已由本分支 `7af27044` 登记**。（我原先用 `git log -S '<describe 名>'` 定位，那找到的是**引入该字符串**的提交，不是**新增这些测试**的提交——`-S` 查的是字符串出现次数变化。）**这部分缺口不归你修**，但下面这条归你：
> - ⚠️ **`test:backend` 会读这份 baseline，别记成「不读」**：`tests/infra/entry-evidence-schema.unit.test.ts:13,17` 用 `readFileSync` 读的就是真实文件，且在 backend 档内；`:25` 精确 `toEqual` 断言 `baseline.files` 等于实际发现的测试文件集合。**推论——阶段 2 你只要新增／改名／**删除**任何 `tests/**` 下的 `*.{unit,it,http}.test.ts`，`test:backend` 就会红在这条，必须同步更新 `files`**（判据是**集合相等**，所以删文件与加文件同样会红），这属于你的活。⚠️ **限定别丢**：glob 只覆盖 `tests/` 目录下这三个后缀；`.pty` / `.e2e` 与 `tests/` 之外的路径**不在其中，误加进去会让 `toEqual` 当场红**。它校验的另一半是 canonical 形态（`parseDiscoveryBaseline` 查键序、字节序排序、唯一性，含 `allowed_skipped` 自身结构），但**不**把 `allowed_skipped` 与运行时实际 skip 集合比对——那个 exact multiset 比对只在 `scripts/capture-entry-evidence.ts` / `scripts/validate-entry-evidence.ts`，且 **`capture-entry-evidence.ts:265` 的 `runner_git_blob` / `files` 检查（`fail(4)`）排在 multiset 门之前**，所以 producer 先撞哪一道要看实际。`minimum_executed`（当前 7279）是**地板**不是等式，实测 7297 满足它、不会红。
> - **阶段 1 的验收证据不因主线前进而失效**（user-rule `moving-shared-head-is-not-failure`）；要重新验证时按上面的锚点重跑，别拿新数字去对旧断言。

**阅读顺序：** ① 本文；② 同目录 [KICKOFF.md](KICKOFF.md)（可直接复制成新会话第一条消息）；③ 冻结规格 [spec/2026-08-06-http2-cancel-provenance-and-header-deadline.md](../../spec/2026-08-06-http2-cancel-provenance-and-header-deadline.md) 的 §3 不变量、§5.2/§5.3 阶段产物与 §6 夹具纪律；④ 实施计划 [2026-08-06-http2-cancel-provenance-and-header-deadline.md](../2026-08-06-http2-cancel-provenance-and-header-deadline.md) 的阶段 2/3 任务；⑤ 需要 transport 背景时读 [DESIGN.md](../../DESIGN.md) 的 transport 活架构行。**spec 是阶段契约的 SSOT**，本文只交接状态、证据、冲突与开工顺序。

## 已确证的硬事实（别再重新推导）

| # | 事实 | 证据等级 |
|---|---|---|
| F1 | response-header deadline 现在只覆盖 pre-header 阶段：`upstreamFetch` 建 watchdog、transport resolve/reject 即解除；headers 后合法长 body 不再受它影响 | **实测**（`tests/transport/upstream-fetch.unit.test.ts`、`tests/transport/http-transport.it.test.ts` 的 pre-header stall oracle，合并态 87 pass/0 fail） |
| F2 | HTTP 腿传 scalar `responseHeaderTimeoutMs`；WS first-event 腿保留持久 signal `createUpstreamFirstEventTimeoutSignal`。旧 `createResponseHeaderTimeoutSignal` 已退役 | **实测 + 源码读证**（`rg createResponseHeaderTimeoutSignal src` 零命中；架构守卫 `tests/architecture/response-header-timeout-scope.unit.test.ts`） |
| F3 | HTTP/2 post-response abort listener 有具名幂等 cleanup；`req.once("close")` 是**唯一**释放 reservation 的点，natural end / abort / physical close 三路都 detach | **实测**（`tests/transport/http2-client.it.test.ts` 断言 listener 1 add/1 remove、`onStreamClosed===1`、`activeStreamCount===0`） |
| F4 | Bun 的 `node:http2` 对**本地** `req.close(NGHTTP2_CANCEL)` 与 **peer** `RST_STREAM(CANCEL)` 产生**同一条**错误文本，单看字符串无法判定发起方 | **实测**（阶段 0 调查探针；这是整个阶段 2 设计的前提，别再花时间重验） |
| F5 | 公开 API 里 `stream.destroy(error)` 能忠实产生非零 peer RST（INTERNAL_ERROR=2）并被 production `http2Fetch` 观测到；而 `stream.close(code)` 在实测 post-header 形态下**不忠实** | **实测**（spec §6.1／§6.3 记录的 wire oracle 校准） |

**集合边界声明**（否定性结论，别当全称命题读）：

- 「阶段 2/3 未实施」的口径 = 在 `master d1011fe7` 上 `rg 'TransportTerminationEvidence|TransportTerminationObservation' src tests packages` 与 `rg 'transportTermination' src tests packages` **均零命中**；正样本对照 `rg -c 'TransportErrorReason' src packages` 命中 2 文件，证明 grep 确实触达该树。排除项：未查 `ui-v4/`、未查 `docs/`（文档里当然有这些词，那是规格不是实现）。

## 与冻结上游文档的对账

- **[ADR 2026-07-11 block-level buffered retry](../../decisions/2026-07-11-block-level-buffered-retry.md)**：阶段 2 会让 `peer`/`session` attribution 进入既有 transport-cut 分支。**依据未被拆**——该 ADR 判定的是「已提交边界内不得重放」，阶段 2 不新增 server-execution-risk gate、不改提交边界，只把「谁砍的」从字符串猜测换成结构化事实。**无需重裁**。
- **旧 `anthropic.protect_streaming_generation`（whole-response L2）**：用户 2026-08-06 明确「不是用户想要的、不符合 block-level buffering、未来会删除、不启用」。阶段 2/3 **不得**启用或扩展它；它的删除是**独立后续项**，不要顺手夹带进本系列。
- **[NGHTTP2_CANCEL 系列交接](../2026-08-06-nghttp2-cancel-series/HANDOVER.md)**：那份是 A1–A4 + CANCEL 主线的系列级档案，其「CANCEL transport 主线尚未实施」的表述**已被本轮阶段 1 部分推翻**（deadline 作用域已落地，provenance 仍未落地）。两份并存时：**阶段状态以 spec 的「实施状态」节为准**，系列档案只作历史与调查线索。
- **检索证据**：上述对账基于 `rg -l 'NGHTTP2|http2-cancel|header deadline' docs/` 与 `docs/decisions/`、`docs/todo/deferred-backlog.md` 的逐份查看；**未发现**与阶段 2/3 设计冲突的其他冻结裁决。

## 待办（阶段 2 起）

**T1 — 在 `packages/foundation` 定义 evidence/observation 类型与追加/派生 primitive**
- 验收判据：`TransportTerminationEvidence` 六个 kind 与 `TransportTerminationObservation` 的 `firstObserved`/`attribution`/`evidence` 三字段**定义在 `packages/foundation`**；core／server 只通过包导入消费；`tests/architecture/package-boundaries.unit.test.ts` 绿。
- 证伪方式：把定义搬进 core，再让 foundation 反向 `import ... from "~/lib/..."` 取用——该守卫必须变红（这是它**实际**检测的方向：foundation 叶子不得引入 `~/` 或兄弟包）。
- ⚠️ **该守卫的边界（实测于 `f0cb1f1e`）**：它的三个检测器只匹配 **import specifier**，**不检测「core 里另抄一份同名类型」**这种纯复制——不新增 import 就不会触发。若要真正防复制，需在阶段 2 另加一条 AST 检查（扫同名 export 符号出现在两个包），**这是本交接明确留下的待补项**，别以为现有守卫已覆盖。
- 鉴别力正控（**待执行期跑**）：删掉 union 的一个 member，消费端穷尽检查必须编译失败。

**T2 — `http2-client` 在产生点追加 evidence**
- 验收判据：local signal / body cancel / stream error / stream close / session error / session close 六类都在**调用 `req.close()` 之前**追加 intent；自然 `end` 不产生 failure observation。
- 证伪方式：构造 local-only、peer-only、session-only、local+peer、bare-close、GOAWAY+clean-end 六种相邻状态，各自 attribution 必须分别为 `local`/`peer`/`session`/`ambiguous`/`unknown`/无。
- 鉴别力正控（**待执行期跑**）：让 first-writer 吞掉后到的 evidence，`ambiguous` 用例必须变红。

**T3 — `classifyError` 与 block-level recovery 消费结构化 observation**
- 验收判据：`local`/`ambiguous`/`unknown` **不得**进入 upstream-cut 重试；`peer`/`session` 在既有提交/预算门允许时仍能进入。
- 证伪方式（**双向**，缺一不可）：① 错误状态不能冒充 peer；② 正确 peer/session 样本不能被过严判据压成 unknown。
- 鉴别力正控（**待执行期跑**）：把 `ambiguous` 当 `peer` 处理，方向①的用例必须变红。

**T4 — 阶段 3：canonical History 与诊断投影**（阶段 2 合并后再开工，spec §5.3）
- 验收判据：`disposeDispatch`、正常 `scheduler.settle()`、RequestContext 最终 terminal fallback **三条** settlement 路径都写入**最终**（quiescence 后的）observation，且 V3 persist→hydrate→REST 投影字段与顺序不丢。
- 证伪方式（**不能只写「漏接一条就变红」**——那只是验收判据的否命题，挡不住下面三种「字段确实写了但值是错的」形态）：① 只等第一道 barrier 就取 observation（拿到未 finalize 的中间快照）；② 从 `errorSnapshot` 读 tag 而非结构化 observation；③ logical terminal 当场 settle、不等 transport quiescence。**三种缺陷下「三条路径都写了字段」仍然成立**，故必须有能区分「最终值 vs 中间值」的断言。
- 鉴别力正控（**待执行期跑**）：依次注入上面三种 mutation，对应测试必须分别变红；只验证「删字段变红」不够。

**每阶段的合并门（spec §5.2/§5.3 已冻结）**：定向测试 + typecheck + 架构守卫 + `bun run test:backend` + 独立 review 全绿，然后**立即合并 `master`**，不许攒成一次大合并。

## 我这一轮犯过的错（每条绑复发点）

1. **把 `--ff-only` 失败当成「跑错目录」**。真因是交付窗口内 `master` 前进造成分叉。**复发点：T1/T2/T3 每次准备合并 `master` 之前**——先跑 `git merge-base --is-ancestor master <branch>`，是祖先才可能 FF；不是就先在隔离树 merge 主线。
2. **合并冲突时差点在两侧 baseline 数字里选边**。两侧都错，正解是合并态实跑。**复发点：T1–T4 任一次合并主线后**——重跑 `test:backend` 重取 floor，并用 JUnit 叶节点交叉验证。教训已固化为记忆 `methodology-merge-invalidates-branch-frozen-test-floor`。
3. **一次 JUnit 交叉验证用错口径**（按 `<testsuite tests=...>` 属性求和得 14475，因 suite 嵌套重复计数）。**复发点：同上**——只数 `<testcase>` 叶节点。
4. **在隔离会话里让 ambient cwd 漏回共享树**，导致一条带 gate 的命令在共享 `master` 上打印后被拒。没有造成损害，但说明**不能依赖上一条命令留下的 cwd**。**复发点：阶段 2 的每条 Bash**——同一调用内 `cd <绝对路径> &&` 自带目录根。
5. **信了 CodeGraph 的返回**——它的索引指向另一个 worktree 且 auto-sync 已停，返回的是缺阶段 1 字段的旧源码。**复发点：阶段 2 查 `http2-client` 结构时**——它自己会打警告，看到警告就改用磁盘 Read。
6. **给 T1 编了一个不成立的证伪方法**（「在 core 里另抄一份同名类型 → `package-boundaries` 守卫变红」）。实际该守卫只匹配 import specifier，纯复制不触发；是收尾评审的接手视角实地读测试才发现。**复发点：T1–T4 每写一条「证伪方式」时**——**去打开那个守卫/测试，确认它真的检测你说的那件事**，别从测试文件名推断它的能力。同族教训见记忆 `methodology-new-oracle-discriminating-power-is-experimental`。

## 本轮遗留的独立后续项（不属于阶段 2/3）

- **删除旧 whole-response L2（`anthropic.protect_streaming_generation`）**：用户已裁决「未来会删除」，但**尚未授权何时做**，也不在本系列范围内。要做需单独起任务并确认。
