# HTTP/2 termination provenance 阶段 2–3 交接

> **状态：进行中（阶段 1 已交付，阶段 2/3 未开工）**
>
> **核验基线：** 2026-08-08，本地 `master` = `d1011fe7eb1f26c0c646b667164ddb0e4dd80bf0`；阶段 1 代码终点 = `bea1dfa3d61896bf2089958676bd1236269877d9`，spec 状态提交 = `d47492a69d1cd7a66fa08b63ad8d717bafbdf194`。复现：`git -C /home/xp/src/copilot-api-js rev-parse refs/heads/master`。**未 push**，全部提交都在本地。
>
> **分支与 worktree：** 阶段 1 在隔离 worktree `/home/xp/src/copilot-api-js/.claude/worktrees/nghttp2-header-deadline`（分支 `worktree-nghttp2-header-deadline`）完成，已 fast-forward 进 `master`。阶段 2 请**另开新 worktree**，不要复用该树。
>
> **未提交 WIP：** 本交接落盘时，共享主树 `/home/xp/src/copilot-api-js` 有其他会话的未提交改动（`config.yaml`、`docs/plan/2026-07-28-session-closeout-skill-review-claude.md` 及若干未追踪 `docs/` 文件）。**那些不是本任务的**，不得 stage、commit、stash 或还原。接手时自行 `git -C /home/xp/src/copilot-api-js status --short` 重取。
>
> **已跑门禁（阶段 1 合并态，锚定 `bea1dfa3`）：** `bun run typecheck` 绿；`bun run lint:all` 绿；`bun run test:backend` = `7279 executed / 30 skipped / 0 fail`。独立 code reviewer 与 verifier 各自复评 PASS（0 blocker / 0 major / 0 minor）。

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
