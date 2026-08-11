# HANDOVER：超长驻留 operation lifecycle（Tasks 1–4 已合入 master，5–8 待做）

**状态：进行中（Tasks 1–4 已合入 master，5–8 未开工）**

- **2026-08-09 首版经独立 reviewer 逐条核验**：0 blocker，两条 major（行数衍生数字错误、Task 4 门禁数字陈旧）已修，1 条 minor 已补入正文。报告存档于 `docs/tmp/2026-08-08-long-resident-operation-lifecycle-handover-review.md`。
- ⚠️ **其后为反映「代码已合入 master」而做的改写未经独立评审**：涉及「必须最先做的事」整节、`test:backend` 负载敏感专节、待办 2、以及头部各条状态行。事实断言均已重新取证（命令写在正文里，可自行复跑），但**没有第二双眼睛看过**。接手方若要依赖这几节做决策，按 `no-self-review` 先派一次评审。

- **文档与代码现在都在 master**（2026-08-09）：文档由 `6bda73d8` 先合（CLAUDE.md `docs-merge-before-execute`）；**Tasks 1–4 + B1 的代码随后经 `merge-long-resident-lifecycle` 分支四轮集成合入 master**，最终 fast-forward 到 `0e0768ee`。所以在 master 上既读得到计划、也读得到实现。原分支 `fix-long-resident-operations` 已被取代，**不要再从它起步**。
- **核验基线**：两层，别混用。
  - **合并态断言**（头部状态、「必须最先做的事」、`test:backend` 专节、待办 2）取证于 **master `0e0768ee`**（2026-08-09）。
  - **Task 1–4 实现期的断言**（硬事实表、各 Task 的评审结论与门禁读数）取证于特性分支 `3e418cdb` / `a8eeaf4c`（2026-08-08）。那些 commit 已随合并进入 master，结论未变。
- **从哪起步**：从 **master** 新开隔离 worktree（放 `.worktrees/`）。历史分支 `fix-long-resident-operations` 与集成分支 `merge-long-resident-lifecycle` 都已被合并取代，**不要从它们起步**。
- **主树状态**：合并落地时主树只有其他会话的 WIP（本特性零残留）。**接手时自己跑一次 `git status --short`**，别采信这句——它是快照。
- **已跑门禁**：十文件 focused gate + **Task 4 焦点集（`tests/context/manager-dual-registry.unit.test.ts`、`tests/context/context-manager.it.test.ts`、`tests/shutdown/drain-waits-operation.unit.test.ts`）** + `tests/history/worker/admission-shutdown.unit.test.ts` + `tests/infra/entry-evidence-schema.unit.test.ts`，共 15 文件 → **`0 fail`**；`bun run typecheck` exit 0；`bun run lint:all` exit 0（全树）；`bun run test:backend` 见下方专节。**可复制的完整 15 文件命令在 KICKOFF「测试门禁现状」节**——那里给的是命令，不是数字。
  - **判据是 `0 fail`，不是某个通过数。** 通过数会随后续提交增长：`3df0e08d` 上测得 236，`e120a49c` 上复测为 **239**，两次都 `0 fail`。写死通过数只会让接手方把正常增长误判成回归（项目裁决：文档里直接写易变数字是怪味）。要当前值就跑那条命令。
  - **口径必须说清**：`236` 那组读数取自 **`3df0e08d`**，而它比最终合并态 `0e0768ee` 早 **17 个提交**（`git rev-list --count 3df0e08d..0e0768ee`）——**这道 gate 没有在 `0e0768ee` 上原样跑过**；合并之后的实测是 `e120a49c` 上的 `239 pass / 0 fail`。别把「已跑门禁」读成「最终合并态已被这道门覆盖」。
  - **实现期的读数（分支上，供追溯，不要拿来当合并态判据）**：十文件 gate `197 pass / 0 fail / 687 expect`（`e397720a`）；Task 4 焦点集 `30 pass / 0 fail / 74 expect`（`a8eeaf4c` 之后，独立 reviewer 在自己的副本复现同一数字）。
  ⚠️ **不要引用更早的 `26 pass / 62 expect`**——那是 `3e418cdb`（修 blocker 之前）的真实读数，blocker 整改新增了用例后已变为 30/74。它不是错数，是**陈旧数**；照它核对会误判成回归。
  `bun run test:backend` 见下方专节（**负载敏感，红了先判归属再下结论**）。
- **未推送**。本特性的全部提交都在本地 master 上，是否推送由用户决定。

## `bun run test:backend` 是负载敏感的（**别误判成自己弄坏的**）

**这不限于 History 子系统**——这是 2026-08-09 合并期间修正的认识。同一棵树、同一 commit 连跑三次：`0 fail` → **`28 fail + 4 分片崩溃`** → **`3 fail + 2 崩溃`**，失败集合每次都不同。更早（2026-08-08）在特性分支上连跑四次也是四种签名（`0 fail` → `0 fail` → `2 崩溃` → `2 fail`），当时命中的是 `tests/history/v3/store-performance.it.test.ts` 与 `tests/history/worker/packaged-runtime.it.test.ts`。

命中过的用例横跨三类，共同点是**都对 wall-clock 或扫描耗时敏感**：

- **性能/计时断言**：`tests/history/v3/store-performance.it.test.ts`、`tests/history/v3/summary-query-performance.it.test.ts`、`tests/history/v3/db-health.it.test.ts`（VACUUM freelist，实测 5690ms）。
- **5s 超时的架构 AST 扫描**：`tests/architecture/package-boundaries.unit.test.ts`、`telemetry-domain-surface.unit.test.ts`、`anchor-remap-single-authority.unit.test.ts`（失败耗时精确落在 5004–5132ms，即超时本身）。
- **钩子超时**：`tests/history/worker/packaged-runtime.it.test.ts`。

- **分片崩溃会吞掉该分片的 skip 计数**：28-fail 那次 skip 从 43 掉到 9。**别把 skip 数的异动当成 gate 配置被改了**去查一圈。
- **判定**：16 分片并发 + 本机同时有多个 peer 会话在跑各自的套件 → 负载敏感 flake。
- **本轮的实证（比推断强）**：对其中最可疑的四个文件（`history/search` 两个、`architecture` 两个）做了定向 A/B——**纯 master 与合并态逐字相同**，均为 `24 pass / 20 skip / 0 fail`。全部三条最终失败也在隔离下通过（`28 pass / 0 fail`）。
- **诚实边界**：**未**在纯 master 上以同等负载跑完整 `test:backend` 做全量 A/B。所以「非本次改动引入」依据的是「文件面不相交 + 隔离通过 + 签名不稳定 + 定向 A/B 相同」四条，**不是全量 A/B 实证**。
- **怎么用**：把 `test:backend` 的绿视为**必要非充分**；判断自己是否破坏了东西，以十文件 focused gate 与 Task 4 焦点集为准（它们稳定绿）。红了先看失败文件**是否落在自己的改动面内**，不在就隔离复跑确认。
- **旁证**：master 上有 peer 维护的 `docs/tmp/2026-08-08-load-sensitive-test-dispositions.md`（及其 `-review`），记录的是同一批用例——这个问题不是本特性独有的。

## 立案证据：那条 operation 的身份（此前没记，补上）

本特性的立案证据是一条**真实的**长驻留 operation，此前只在 spec 里记了症状文本，**没记它是哪条记录**——后来人因此无法复查原始数据。

- **operationId**：`req_1786064856101_137`（`sessionId` `529807d9-28f0-4e56-85c8-03adaf016bb7`，进程 `pid=597291`、`gitSha=ccb645f5`、`version=0.8.4-beta.18`）。
- **怎么重取**：`GET /history/api/entries/req_1786064856101_137/export`（[API.md](../../API.md)「History REST」，返回服务端 zstd 压缩的 `.json.zst`）。
- **调查期间导出过一份 manifest**（formatVersion 2，含完整 arena payload/frame 谱系），但它只存在于当时会话的临时目录、**未提交**——里面是用户的真实请求与响应内容，是否长期留存属用户决定，不由本次收尾代劳。若 History 已按保留策略淘汰该记录，该导出即不可再生。

## 入口指引（按序读）

1. **本文**——先读「已确证的硬事实」与「各 Task 当前状态」；「必须最先做的事」那节已完成，只需扫一眼确认不要重做。
2. `docs/plan/2026-08-08-long-resident-operation-lifecycle.md`——计划正文，Tasks 5–8 在第 384 行之后。**注意它对 `shutdown.ts` 的描述可能已陈旧，见下。**
3. `docs/tmp/2026-08-08-long-resident-operation-lifecycle-progress-impl-1.md`——逐轮进度、在途意图、**已作废路线（四条，别重试）**。
4. 三份评审证据（都已进仓库，不会被 `git clean` 删）：`docs/tmp/*-task-3-report.md`（M1–M9 变异证据）、`*-b1-verification.md`（verifier 三轮）、`*-b1-merged-review.md`（reviewer 三轮）。

## 已完成、不要重做：先合并 master（2026-08-09 完成）

**这一节曾是本交接最重要的一条；它已经做完了。** 保留在此是为了让接手方一眼看出「不必再合一次」，并留下当时的取舍。

- **结果**：Tasks 1–4 + B1 已在 master 上，最终 fast-forward 到 `0e0768ee`。集成走的是独立分支 `merge-long-resident-lifecycle`（共四轮：主集成 + 三次追 master），不是在共享主树上直接合。
- **当时怎么解的两处代码冲突**（下次遇到同一区域可复用这个判断）：
  - `src/lib/context/manager.ts` —— 保留 master 新增的 History reservation 释放（`failBeforeTerminal`），丢掉 Task 4 有意删除的 `operationScopes.delete` + `failures.push`。**代码里留了合并注记**，别再把那两行加回来。
  - `src/lib/shutdown.ts` —— 保留 master 新增的三行 admission 依赖解析，同时应用 Task 4 的方法改名 `drainModelOperationFinalizations` → `drainLifecycleFailures`。`ShutdownDeps` 的字段名仍是旧名，**那是 Task 6 的责任**，代码里已有接缝注释。
- **前提仍成立（已在合并后的 master 上复核）**：`formatActiveRequestsSummary` **仍然打印 `request.state`**——正是产生 `(failed, 17620s)` 的那个字段。**本特性要修的缺陷至今仍在，Tasks 5–8 没有作废。** 摘要文案已是 `accepted operation(s)`（不再是 `active request(s)`），**Task 8 里任何按旧文案写的断言都要重新校准**。当前行号自己取：`git grep -n "request.state" -- src/lib/shutdown.ts`。
- **仍然有效的纪律**：这仓库并发极高（一天内 master 前进数百个提交），追 `--ff-only` 不会收敛。做法是**在隔离 worktree 里集成、验证、再回主树做一次无风险的 fast-forward**；期间 master 又动就再吃一轮增量，按 `moving-shared-head-is-not-failure` 只对**与自己改动面相交**的部分做定向验证，不每轮全量重跑。

## 已确证的硬事实（别再重新推导）

| 事实 | 证据等级 | 出处 |
|---|---|---|
| 退出日志矛盾的根因是**四类独立 lifecycle 事实被混为一谈**：logical terminal（`pending/executing/streaming/completed/failed/aborted`）、operation scope（`sealed`/`childCount`/`quiesced`）、delivery lifecycle（`open/finalizing/finalized/failed`）、canonical finalization（`waiting/running/completed/failed`）。`failed` ≠ quiesced。 | 源码读证 + 冻结 spec | spec §§5–7 |
| 合法终止是**偏序不是总序**：候选/派发所有权先闭合 → logical terminal seal operation scope → operation quiescence 与 delivery finalization 并行 → canonical finalizer join 二者 → manager 释放 registry。 | 源码读证 | spec §7 |
| `failureRegistered: true` 的权威语义是 **process shutdown lifecycle failure barrier 已同步持有该错误**。**不得**改成 context-local ledger。 | 独立 reviewer 证伪过后者 | 见进度文件「已作废路线」第 4 条 |
| candidate reservation 的真实 owner 是 `coordinator.ts`；scheduler 只拥有 dispatch active slot，candidate 只拥有 verdict。 | 源码读证 + 探针 | 进度文件 |
| **release-first ownership**：catch 保存原始错误 → finally 释放 → 之后传播。 | 冻结 spec §7.1 + 九轮评审 | spec |
| unknown rejection **不能用 value sentinel**（`throw undefined` 合法）；存在性必须由显式 flag 或数组长度表达。 | verifier 实测探针 | `*-b1-verification.md` Finding I-1 |
| 字段存在性用 `"error" in settlement` / `Object.hasOwn()` 区分，不能按值过滤。 | reviewer 实测 | `*-task-3-report.md` 第四轮 |

## 各 Task 当前状态

| Task | 状态 | 落地 commit | 备注 |
|---|---|---|---|
| 1 lifecycle 纯模型 + OperationScope snapshot | ✅ 完成并评审通过 | `62f572c1..8c9c85d5` | |
| 2 RequestContext 四事实状态机 | ✅ 完成并评审通过 | `0af6850b..f05db881` | |
| 3 dispatch cleanup failure ownership | ✅ 完成，历经六轮评审 | `4de3cd6e..cf8f4380` | |
| **B1 合并态评审** | ✅ **已闭合** | — | reviewer approved（0 Critical / 0 Important / 1 Minor）；verifier 0 findings。那条 Minor 已在 `4b961615` 消除 |
| 4 manager registry + lifecycle failure barrier | ✅ 完成并评审通过 | `3e418cdb` + `a8eeaf4c` | 首轮判 1 blocker + 1 major，整改后复评关闭（R1–R5 全部由 reviewer 独立探针复跑）。遗留 1 minor + 1 边界形态，见待办 1 |
| 5 从真实 delivery owner 发布 begin/success/failure | ⬜ 未开工 | — | plan 第 384 行起 |
| 6 暴露 tracked-operation 运维真相 | ⬜ 未开工 | — | plan 第 454 行起；**受 master 重写影响最大** |
| 7 全 producer 与现场僵尸回归矩阵 | ⬜ 未开工 | — | plan 第 510 行起 |
| 8 Mutation、全量验收、文档与最终评审 | ⬜ 未开工 | — | plan 第 557 行起；**文案断言需按 master 新措辞校准** |

## 待办（每条带验收判据与证伪方式）

1. **Task 4 遗留的两条（评审已通过，这两条是记录在案的后续项，非 blocker）**
   - 完整评审报告（含复评）已存档在仓库内 `docs/tmp/2026-08-08-long-resident-operation-lifecycle-task-4-review.md`。首轮的 blocker（已登记 delivery failure 永不进 drain）与 major（barrier 单调增长）已在 `a8eeaf4c` 关闭，reviewer 独立探针复跑确认 `errors[0] === err` identity 相等、barrier 归 0。
   - **遗留 minor**：注入 `onLifecycleFailure` 恒 false 时，**未登记的 canonical 拒绝现在一个都不推**（父提交会推），drain 静默。**生产不可达**，是本次改法的天然缺口；reviewer 已在报告里给出不引入双计的闭合写法。
     验收：按该写法闭合后，未登记的 canonical 拒绝仍能进入 drain，且 canonical 双来源不双计（现有那条 `toHaveLength(1)` 断言仍绿）。证伪：注入 `onLifecycleFailure` 恒 false，若 drain 仍静默即未修。
   - **遗留边界形态**：「失败先于 settle 且 ctx 永不 settle」时，ctx 与 barrier **各留 1 条**——有界性等同于 release，该形态下 release 永不发生。**这正是本项目要消灭的僵尸形态**，reviewer 建议由 **Task 7 的僵尸回归矩阵**覆盖。
     验收：Task 7 矩阵含该形态并断言最终被回收或被 `/api/status` 如实呈现。
   - **两条已记录、本轮不改的观察**（见进度文件）：C2 的「未登记 failure」保护分支**生产不可达**（`request.ts:910` 的 outcome lock 在登记前就 return），只有推理无正负样本，**待独立裁决，别自行删除该分支**；C3 现实现下终态到 release 全是 microtask 链，`/api/status` 撞不上 `blocker==="none"` 的 invariant throw，**Task 6 接线时若在其间插入 await 就会变 500**。
2. ~~**合并 master**~~ —— **已完成**（2026-08-09，fast-forward 到 `0e0768ee`），见上同名小节。
   - 当时的验收已满足：typecheck / `lint:all` / `test:backend` 三道门（`test:backend` 的红逐条隔离复核后全部归因为负载敏感，见同名小节）。
   - **但它的证伪判据现在指向 Tasks 5–8 仍要做的事**，别误读成已修：`git grep -n "request.state" -- src/lib/shutdown.ts` 仍能命中——drain 摘要**依旧直接读 `request.state`**、未经 lifecycle blocker 归一。**这正是 Task 6 要修的缺陷，至今仍在。**
3. **Tasks 5–8 按计划推进**，但先做一次 **plan-vs-code 对账**
   - 验收：逐条核对 Tasks 5–8 引用的每个 `file:line` 与符号在合并后的树上仍存在；不存在的当场标注并改写计划。
   - 证伪：任一被引用符号 grep 不到，即证明该 Task 的步骤已陈旧。
   - 已知一处：Task 4 已发现 plan 的 Files 清单漏了 `src/lib/shutdown.ts`（被改名方法的唯一生产调用点在那里），**Task 6 会撞上同一接缝**，代码里已留注释标出切分点。

## 与既有裁决的对账

- 本项目所修的 drain 行为与 master 新落地的 **lossless shutdown** 系列（`04e6ecb1 fix: drain accepted requests losslessly on shutdown`、`d254d8ae refactor: remove shutdown-owned request cancellation`、`71c043cf docs: finalize lossless shutdown lifecycle`）**处在同一区域**。
- **尚未对账**：本文作者未逐条核对这两套工作的取舍是否冲突（例如「shutdown 不拥有 drain deadline，只有 request 级机制可终止工作」这条 master 新裁决，与本计划的 blocker 聚合是否一致）。
- **这是一条正式待办，至今未闭合**：合并 master 已完成，但这条对账**没做**。**动 Tasks 6/8 之前先读 `71c043cf` 引入的那份 lossless shutdown 文档**；若发现取舍冲突，交用户裁决，不要自行取舍。

## 本轮我犯过的错（每条绑复现点）

1. **把承重的类型断言当成多余的清理**——我判定 `failures.push(failure as HedgeRaceFailure)` 的 `as` 是冗余并删掉，typecheck 立刻报 TS2322（换条件后 `else` 分支不再收窄 `outcome`）。
   **复现点**：待办 3 做 plan-vs-code 对账时，凡想「顺手清理」类型断言，先跑 `bun run typecheck` 再下结论。
2. **据 mtime 判定 agent 已死**——我据 transcript 27 分钟不增长认定 reviewer 失败，随后 `SendMessage` 返回「已排队待送达」证明它仍在运行。mtime 只是弱信号。
   **复现点**：待办 1 等待评审结论时，不要据文件 mtime 判活；只有调用真的失败才算不可达。
3. **引用了不稳定的数字**——`bun run test:backend` 的测试总数在同树同 commit 连跑之间会变（4032/3756/6681），我一度把它当成范围差异去追。
   **复现点**：待办 2 合并后重跑门禁时，只引用 `0 fail`，别写总数。已记入 memory `reference-parallel-test-total-count-unstable`。
