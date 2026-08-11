# 独立评审报告：负载敏感测试处置（8 条）

> 评审对象：分支 `command-algebra-entry-gate-fix`，`2a4898e8..aa79ad57`；处置记录 `docs/tmp/2026-08-08-load-sensitive-test-dispositions.md`。
> 工作树 `/home/xp/src/copilot-api-js/.worktree/command-algebra-commit-minus-1`，`git rev-parse HEAD` = `aa79ad574a7aebc311f14ebe06359d41b26ae293`。
> 评审者：Claude 侧 `reviewer`（实施方为 GPT 侧 implementer，取异模型对抗）。仓库只读，除本文件外未改动任何文件。

## 总体 verdict

**修复 major 后可进入下一阶段（可合并，但本轮目标未收口）。blocker 数：0；major 数：4。**

本分支相对 master **零生产代码改动**，没有删除或 skip 任何用例，没有放宽任何阈值或内容型断言；第 5–7 条的改动经我独立 mutation 复现，是**净增强**而非放宽。**合并本身不引入回归，我不反对合并。**

但「消除过分敏感的测试」这个中心目标**尚未达成**，有两条必须继续处理（都不阻塞合并、都须交裁决而非由实施者自决）：

1. `store-performance.it.test.ts:144` 的 `commitRatio < 5` 在合并态**首跑即 false-red**（本评审实测），且未处置清单给出的「不能修」的机械理由经代码复核指错了一层机制。
2. `bus.unit.test.ts:227` 的 200ms 上界并非不可放宽——「必须留在 200」只在把 `DEADLINE_MS` 钉死为 50 时成立；把 fixture deadline 按比例放大即可在**鉴别力不变**的前提下把绝对抖动容忍度从 150ms 提到 1500ms，我已在 `/tmp` 克隆里两个方向实测闭合。

另两条 major 是记录层面的：新探针的覆盖窗口被写得比实测强一档（同一类「命题强于证据」的错误在本轮已是第三次复发），以及处置记录文末的悬挂结论块与倒置的章节顺序。
> 本报告边审边落盘，逐条追加。

## 双视角覆盖证据

**机械核对**：`git log/diff` 全范围逐文件扫描（并把两次 merge 带入的改动与 agent 自己的提交分离）、六个改动测试文件的完整 diff 逐 hunk 读、`entry-test-discovery-baseline.json` 用 `jq` 在 BASE/HEAD 两侧取计数与集合差、读 `scripts/validate-entry-evidence.ts:744-759` 确认 skip 多重集是**相等**比较而非子集、`bun run typecheck` 实跑、`bun run test:backend` 实跑、`setDefaultTimeout` 作用域在 `/tmp` 一次性目录实测（不在本树注入任何 mutation）。

**第一人称执行**：以「照这份记录去判某条断言该不该动」的读者身份走查第 1/5/6/7/8 条的推理链——自己重建 `result.ok === false` 的蕴含关系（读 `delayedSseResponse` 的实际发帧与关闭时机）、自己判微任务探针能覆盖到哪个窗口、自己算每条上界与 per-test 预算 / `idleTimeoutMs` 的相对关系；以「未来想统一这三条」的人身份走第 5–7 条对比表；以「照 C13 去刷新 baseline」的人身份重算 skip 集合增量。

---

## 逐条核验记录（按核验顺序追加）

### C8 —— `setDefaultTimeout` 是文件作用域：**独立实测确认，断言成立**

不采信推理。在 `/tmp/rev046d/sdt/` 一次性目录复现 `scripts/parallel-test.ts:156` 的调用形状（`bun test a.test.ts b.test.ts`，**不带** `--isolate`，同一进程）：

- `a.test.ts`：`setDefaultTimeout(30_000)` + 一条睡 6s 的用例 → **pass**
- `b.test.ts`：无自己的 `setDefaultTimeout` + 一条睡 6s 的用例 → **fail，`this test timed out after 5000ms`**

同进程内兄弟文件仍用 5000ms 默认预算，宽松度**不泄漏**。**C8 成立**，且这四处文件级预算不会把其它文件的敏感度一并抹掉（这一点对「新判据是否太松」很关键：预算放宽的作用域被机械限死在四个文件内）。

### C10 —— `bun run typecheck`：**绿**（`tsc`，无输出即无错）。`bun run test:backend` **不绿**（`4899 pass · 1 fail · 7297 executed · 35 skipped · 99.02s`），详见下方第一条 major。

---

## 事实性发现（最严重在前）

### [major] `tests/history/v3/store-performance.it.test.ts:144` —— `commitRatio < 5` 在合并态首跑即 false-red，C10「test:backend 全绿」不可复现

**证据（本评审在本工作树实跑，HEAD `aa79ad57`）**：

```
[parallel-test] 16 shards · 4900 tests · 4899 pass · 1 fail · 7297 executed · 35 skipped · 99.02s
✗ History V3 store performance > prepare and commit do not depend on prior session history length [2567.66ms]
  store-performance.it.test.ts:144  expect(commitRatio).toBeLessThan(5)
  Expected: < 5   Received: 8.295001962441273
  HISTORY_V3_PERF history-length {"coldCommitMs":2.845937,"hotCommitMs":23.607053,"commitRatio":8.295}
```

同一 HEAD **隔离单跑**同一文件：`3 pass / 0 fail`，`commitRatio = 0.617`（`coldCommitMs 5.81` / `hotCommitMs 3.59`）。**同一份代码，比值在 0.62 与 8.30 之间摆动 13 倍**——判据完全被噪声支配，这正是本轮要消灭的形态。

为什么这是 major 而不是 blocker：该断言本轮**一个字没改**，不是本分支引入的回归，合并本分支不会让它变差。但三件事必须点名：

1. **C10 的断言在独立复现下不成立。** 处置记录里两次 `test:backend` 全绿（56–66s）是在较空闲的机器上取的；本次运行 99.02s（负载更高）即红。按 `every-number-carries-scope`，「合并态全绿」这个数字的口径应写成「在 loadavg 较低时全绿」，不能作为交付断言。
2. **它是本轮 T0.0f 门（15 连跑全绿）的现存阻塞项。** 本轮把四条会被争用误杀的测试修好了，但套件里**仍留着一条命中率不低的同类**——首跑即中。
3. **未处置清单第 2 条给出的「不改的机械理由」经代码复核站不住脚。** 记录写「同一 record 重复 commit 会命中 CAS 去重……要正确修必须为每个样本造不同的 `operationId`」；而 `:134`/`:138` 的调用点**本来就已经在给每次采样造不同的 `operationId`**（`target-cold` / `target-hot`）。真正会造成偏置的是**内容相同 → CAS payload 已存在**，不是 `operationId` 相同——机制被指错了一层。修法因此也不同：给每个样本造**内容不同、形状相同**的 fixture（`highBranchFixture` 已经按 name 取种子），即可取 5 次中位数而**不改变被测量的量**。

**建议**（不由评审自决，交裁决）：把 `timedCommit` 改成与 `timedPrepare` 同构的多样本中位数，样本用形状相同、内容不同的 fixture；并给分母加地板（`hotCommitMs < Math.max(coldCommitMs * 5, <绝对下限>)`）避免用 2.8ms 级的单次采样当除数。这是**放宽既有 guard 的相邻操作**，须按 `red-tests-may-be-guarding-something` 交独立裁决——本报告只提供「它已在合并态实测红过一次」这一新证据。

### [major] `tests/observability/bus.unit.test.ts:227` —— 「200 不能放宽」是一个假约束；已实测出既保覆盖又把抖动容忍度放大 10 倍的改法（回应 C11 + C12）

**C11 的因果链独立复核：成立。** `src/lib/observability/bus.ts:184` 的 failure message 嵌的是**请求值** `deadlineMs`，不是实际等待时长，所以因果 oracle 对「实际时长 ≠ 自报值」这一类完全无感。我在 `/tmp/rev046d/clone`（本仓 `--local` 克隆，**未在本工作树注入任何 mutation**）重跑 Mutation F（`bus.ts:177` `setTimeout(..., deadlineMs)` → `deadlineMs * 6`）：

```
Expected: < 200   Received: 301        ← 红在 :227，与记录一致
```

301 < 2000，故「放宽到 2000 就抓不到」属实。**C11 成立。**

**但 C12 的回答是：现有证据不足，且这条约束是可以解开的——两者都实测了。**

(a) **证据不足。** 96 spinner 全绿这一条，按**本文档自己确立的口径**就不够格：第 1 条已经写明「纯 CPU spinner 不是原始故障的等价复现」（64 spinner 下旧断言仍绿，而真实分片下它红了）。用一个已被自己判定为**非等价**的压力源去证明「另一条断言不会被真实分片误杀」，是拿失效的 oracle 当证据。当前的绝对余量是 **150ms**（`elapsed ≈ 50ms 定时器 + 调度延迟`，上界 200ms）——而同一轮里 `store-performance` 的毫秒级采样已实测摆动 13 倍。

(b) **约束是假的。** 「200 不能放宽」只在**把 `DEADLINE_MS` 钉死在 50** 时成立；而 50 这个数字从来不是承重的。把 fixture 的 deadline 按比例放大、上界保持 `DEADLINE_MS * 4` 的**相对**形状，鉴别力（能抓「实际时长 ≥ 4x 请求值」）一点不变，而**绝对抖动容忍度从 150ms 变成 1500ms**。在 `/tmp` 克隆里两个方向都跑了：

| 配置 | Mutation F（6x） | 健康 |
|---|---|---|
| `DEADLINE_MS=50`，上界 200（当前） | 红，`Received: 301` | 绿 |
| `DEADLINE_MS=50`，上界 2000（记录里被否决的那个） | **绿（失去覆盖）** | 绿 |
| **`DEADLINE_MS=500`，上界 `DEADLINE_MS*4`=2000** | **红，`Received: 3016`** | **绿（11 pass / 0 fail）** |

代价是这条用例多花约 450ms 墙钟；`expect(...message).toBe(\`...after ${DEADLINE_MS}ms\`)` 与 `expect(done).toBe(0)` 都已按 `DEADLINE_MS` 参数化，无需其它改动。

**结论（明确表态，不含糊）**：C12 问「200 在争用下会不会 false-red、证据够不够、与用户判据是否相容」——**不相容，这是本轮唯一需要继续处理的一条**。记录里给的两条出路（改生产契约把实际时长写进 failure、注入时钟 seam）都对，但都不是必需的；上面这条**不动生产代码**的改法已经实测闭合。它同样属于「重塑既有 guard」，须交裁决，不由实施者或评审自决。

### [major] 三条新微任务探针的**实际**窗口比注释和记录声称的窄一档：不是「一个微任务 tick 内未 settle」，而是「探针那一刻尚未 settle」

`tests/streaming/stream-shutdown-race.it.test.ts:159-163`（第 5 条）与 `:718-720`（第 7 条）的注释写：

> the race has not settled **within one microtask tick** … (Strictly: a path needing **two or more** microtask ticks to settle would slip past this probe — the claim is one tick, not "never".)

处置记录 §5 末尾的「注释精度更正」也是这个措辞。**实测推翻它**（`/tmp/rev046d/race-probe2.ts`，bun 1.3.14）：

```
already-settled: ALREADY        ← 只有「已经 settle」才会被探针抓住
one-tick:        Symbol(pending)   ← 恰好一个微任务后 settle 的路径，探针照样判「pending」
two-ticks:       Symbol(pending)
setTimeout0:     Symbol(pending)
never:           Symbol(pending)
```

原因是 `Promise.race([p, Promise.resolve(S)])` 只有在 `p` **在 race 构造时已 settled** 时才让 `p` 赢（反应作业按参数顺序入队）；晚一个 tick，sentinel 的作业就先跑完了。所以该探针的真实命题是「**在这一行执行的瞬间尚未 settle**」，**一个 tick 也覆盖不了**。

影响：`STILL_PENDING` 探针的鉴别力精确等于「同步/快路径立即 resolve」（即 Mutation B 那一类），比注释宣称的窄。写下的命题**又一次强于证明的命题**——这与记录自己撤回的「鉴别力为零」、以及 §5 那次更正是**同一类错误的第三次复发**，而且这一次是**写进了会长期留在仓库里的测试注释**。

不影响已落地的 mutation 结论（B 是同步 resolve，确实被抓住）。**建议**：把三处注释改成「not already settled at this point」，并明确写出「任何晚于本行的 settle 都区分不了是不是 abort 造成的——要覆盖一段真实窗口，用第 6 条那样的 stall 后第二探针」。第 6 条 `:650` 的第二探针（真实睡 50ms 之后）**确实**覆盖整段 50ms 窗口（届时微任务已排空，已 settle 的 promise 会赢），所以第 6 条的替换是真加强，`>= 40` 的覆盖没有丢——这一条我复核后确认成立。

### 判据之间的缝（派活件第 2 件）：一个「实现坏掉而 8 条判据全绿」的具体场景

由上一条推出的、可构造的缺陷形态：

> `raceIteratorNext` 在 `idleTimeoutMs > 0` 时，**未收到 abort 也会自行 resolve `STREAM_ABORTED`，且这次 resolve 发生在构造后的第一个微任务**（例如把快路径判断挪进 `.then()`、或空闲超时腿被误写成 resolve sentinel 的异步形态）。

逐条走一遍：

- 第 5 条：`idleTimeoutMs: 0` → 缺陷不触发，绿。
- 第 6 条：`idleTimeoutMs: 0` → 不触发，绿（它那条强力的 stall 后第二探针**恰好用不上**）。
- 第 7 条：`idleTimeoutMs: 5000` → 触发。但探针在同一 tick 执行 → 判 `STILL_PENDING`（已实测，见上）；随后 `controller.abort()`、`await racePromise` 立刻返回 `STREAM_ABORTED`；`Date.now() - abortedAt ≈ 0 < 1000`。**全绿。**
- 第 1、2、3、4、8 条与 `raceIteratorNext` 无关，全绿。

即：**8 条判据全绿，而「abort 赢过空闲超时」这条不变量已经被架空**（返回 sentinel 与 abort 无因果关系）。这个缝不是本轮引入的（改前更盲：连同步形态都抓不到），但它**正落在本轮新加探针宣称覆盖的那一类上**，所以值得点名：把探针从「同 tick」升级为「跨一段真实窗口」（第 6 条的双探针形态）即可关闭，而第 7 条当前明确写了「不加第二探针，因为没有对应窗口要接」——那个理由在此形态下不成立。

### 未处置清单第 3 条的表述复核（派活件第 3 件）

改写后的表述**总体已经校准**：它把「真空通过」与「盲」分开、把 V1 结果如实写成 inconclusive、点名了技术障碍并把下一步交出去，比原来的「鉴别力为零」准确得多，我**不认为它过弱**。

但仍留一处**比证据强**的因果预测：

> 「若心跳真的泄漏，数组就非空、且该项剩余延迟很短 → `.every()` 为 false → 红。」

V1 自己的记录恰恰证否了这句话的前半段——四级加码注入的真实泄漏（含 inline 心跳无限自我重排 + `close()` 完全失效）之后，断言点仍然是 `[]`。也就是说，「让它在断言点消失」的那条未定位路径**可能与泄漏是否存在无关**，因而「泄漏 ⟹ 数组非空」未经证实。建议改成条件式：「**只要泄漏的定时器在断言点对 FakeClock 可见**，谓词形状是对的（实测剩余延迟 = 2000，`2000 > 2000` 为 false）；而『泄漏一定可见』正是 V1 没能证明的部分。」——这样它就只声称已测到的两件事。

### 其余可核验断言（C1–C7、C9、C13）逐条回应

- **C1 —— 需修正口径，实质结论更强。** `2a4898e8..aa79ad57` **确实**含生产代码改动：`config.yaml`（1 行）与 `native/history-search/src/lib.rs`（504 行）。但它们**全部来自被并入的 master `c672dda8`**。正确、且更强的写法是：`git diff c672dda8..aa79ad57 -- src packages native scripts config.yaml` → **完全为空**。即 HEAD 相对 master 的生产代码**逐字节相同**，本轮零生产改动。
- **C2 —— 成立（运行时枚举，非 grep）。** 相对 master 的 `tests` diff 中，`^+`/`^-` 两侧**均无** `test(` / `describe(` / `.skip` / `.todo` / `.only`；新增行里与用例声明相关的只有 4 处 `setDefaultTimeout`。运行时口径来自本评审的实跑：`7297 executed · 35 skipped`，与 `entry-test-discovery-baseline.json` 的 `minimum_executed = 7297`、`allowed_skipped` 35 条**逐项相等**（`scripts/validate-entry-evidence.ts:749-757` 是**相等**比较而非子集，所以这一致性是有判别力的）。
- **C3 —— 不成立：被删除的断言是 2 条，不是 1 条。** 相对 master 删除的 `expect` 共 6 行，其中 4 行是同一性质的替换（`< SILENCE_MS`→`< OUTLIER_CEILING_MS`、`< 200`→`DEADLINE_MS*4`(=200)、两处 `< 200`→`< 1_000` 改帧）。**真正失去一条独立性质的有两处**：第 1 条的 `elapsedMs < SILENCE_MS`，以及**第 6 条的 `expect(elapsed).toBeGreaterThanOrEqual(40)`**（`tests/streaming/stream-shutdown-race.it.test.ts` 改前 `:638`）。处置记录 §6 对后者是**透明**的（明确写了「必须删掉」并论证被第二探针接住），所以这是**派活件 C3 的措辞错**，不是实施者隐瞒。我独立复核了「覆盖被接住」这一主张，**成立**（见下条）。
- **C6 —— 成立，且关键格我独立复现了。** 在 `/tmp/rev046d/clone` 里把 `packages/foundation/src/stream.ts:248` 改成 Mutation B（`abortSignal?.aborted` → `abortSignal`），再 `git checkout 2a4898e8 -- <该测试文件>` 取**改前**用例体：
  - 第 5 条「during blocked next()」——**绿**（盲）
  - 第 7 条「wins over idle timeout」——**绿**（盲）
  - 第 6 条「during stall」——**红**，`Expected: >= 40 / Received: 0`
  与记录的对照表逐格一致。换回**改后**用例体同样打 Mutation B：三条全红在各自的 `STILL_PENDING` 探针上。**「同文件不等于同结构」有独立证据，不得统一成一种写法。**
- **C4 —— 成立。** `10x` 比值、逐字节 wire、`detail` 序列、`exitCode`、stderr 正则在 diff 中均未出现于任何 `+`/`-` 行；`bus` 那条上界数值 200 逐字未变（只是改写成 `DEADLINE_MS * 4`）。唯一被放大的阈值是第 1 条的 `4500 → 25_000`，记录已如实标注其鉴别力「很薄」。
- **C5 —— 基本成立，但蕴含关系有一个前提要写出来。** `delayedSseResponse`（`tests/e2e-client/keepalive-idle-reset.it.test.ts:109-120`）在 `delayMs` 之后一次性 enqueue 全部 tail 并**立即 `controller.close()`**，所以「看到 tail」⟹ 流随即结束 ⟹ `result.ok === true`。反过来 `result.ok === false` ⟹ 没看到 tail，**前提是代理在 tail 之后确实会关掉客户端流**。「代理拿到 tail 却不终结客户端流」这一形态下，客户端仍会在 tail 之后再吃一次 2.5s body idle 而 `ok === false`（elapsed ≈ 7s，旧的 `< 4500` 会红、新的 `< 25_000` 不会）。该形态由同文件 armPing（断言 `result.ok === true` 且收到 `message_stop`）守住，故**文件级没有净损失**；但记录里「已被 `result.ok === false` 证明」这句话，严格说少了「且流被正常终结（由 armPing 守）」这半句。
- **C7 —— 部分独立复现，其余按记录接受并标注。** 我独立跑通的：Mutation F（bus，红在上界 `:227`，`301` vs `200`）、Mutation B（stream，三条新探针分别变红；改前形态的绿/红分布如 C6）。**未独立复现**（需要在生产代码上注入，本评审只在 `/tmp` 克隆内动手，未逐条重跑）：第 2 条 CAS salt、第 3 条 A/B 两层、第 4 条终态不关 anchor block。这三条记录里都给了「红在哪一行 + 具体数值 + 恢复核验」，形态自洽，无矛盾迹象；按 `trust-first-but-keep-eyes-open` 接受，并在此标注为**未经本评审二次证实**。
- **C9 —— 三条成立，第 1 条那个 `30_000` 不是按该规则算出来的（规则本身需要补一句）。** `store-performance` 60_000：规则 1 = 4.5×10 = 45s，规则 2 = 18.03×3 = 54.1s，取大向上到 60s ✓。`upstream-ws-crash-safety` 30_000：0.7×10 = 7s，5.006×3 = 15s → 30s ✓。`delivery-lifecycle-baseline` 30_000：1.0×10 = 10s，7×3 = 21s → 30s ✓。**`keepalive-idle-reset` 的 30_000 不满足规则 1**——它最慢的 armPing 隔离约 4.8s，10x = 48s > 30s。它按的是 peer 先例、不是这条算术（记录里 B 类规则节明写「后面三条都按它」，第 1 条在其之前，所以不算自相矛盾）。**但规则少了一个维度**：该文件的耗时主要是**真实等待**（4.5s 的上游静默），而真实等待在 CPU 争用下**不放大**，所以 30s 仍有 >4x 实际余量。建议把「隔离最慢耗时里，真实等待部分不参与 10x 放大」写进那条规则——否则下一个照规则算的人会得到 60s，或者反过来在一个纯 CPU 文件上误用 30s。
- **C13 —— 成立，但增量是 +5 不是 +4，方向确认为收紧。** BASE `allowed_skipped` = **30** 条，HEAD = **35** 条（`jq` 两侧实测），即 **+5**；派活件写的「31 → 35」不准（31 是 runner 自报的 skipped 计数，与 baseline 文件的条目数在 BASE 处相差 1）。5 条新条目逐条核对：`tests/history/search/daemon.it.test.ts` 的 `:234`/`:271`/`:305`/`:371`（均在 `describe.skipIf(!NATIVE)("history-search native list-search")`，`:160`）与 `:490`（在 `describe.skipIf(!NATIVE)("history-search cursor is bound to the index that produced it")`，`:489`）——classname 与 name 逐字相符，`reason: native-unavailable` 属实（本工作树未 `bun run build:history-search`）。`minimum_executed` 7279 → **7297** 是**下限调高 = 收紧**，方向没反；本评审实跑的 `executed` 恰为 7297，即该下限被钉在实测值上、零冗余。`files` 数组两侧均 714 条、排序与 canonical 格式未破坏——由本次实跑中 `tests/infra/*` 全绿（唯一失败是 `store-performance`）作为运行时证据。

### [major] 处置记录文末 `:763-767` 是一段**无标题、内容已过期**的悬挂结论块，且整份文档的章节顺序倒置

**悬挂块**（`docs/tmp/2026-08-08-load-sensitive-test-dispositions.md:755-767`）：前后各约 8 个空行，没有任何小节标题，直接跟在第 8 条的「诚实边界」之后。它显然是**第一批**（1–4 条）的收尾清单，但停在了整份文档的**视觉终点**——读者会把它当成全文结论。内容有三处对合并态**已不成立**：

- `:765`「没有碰上述 4 个测试文件与本文档之外的任何文件」——第二批还改了 `tests/streaming/stream-shutdown-race.it.test.ts`、`tests/observability/bus.unit.test.ts`、`tests/responses/fixtures/ws-crash-probe.ts`、`tests/infra/entry-test-discovery-baseline.json`。
- `:765` 括号里的「第 3 条的注释更正另见下节」——文末之后**没有下节**，该引用悬空。
- `:767`「四个 commit 都在本地隔离 worktree 分支 `worktree-agent-a915058689631f211` 上」——该分支已在 `c5a8d631` 并入 `command-algebra-entry-gate-fix`，且本轮共 11 个 commit。

**章节顺序倒置**（`grep '^#\+ '` 实测）：`## 未处置清单`(`:358`) / `## 本轮的分类判断被实测推翻过几次`(`:403`) / `## 第二批收口验收`(`:436`) / `## 收口验收`(`:457`) 全部排在 `## 5.`(`:479`)–`## 8.`(`:680`) **之前**。也就是说，顺序读下来的人会先读到「未处置清单第 5 条：`bus.unit.test.ts` 的上界能否放宽」，而第 8 条正文还在 200 行之后。这份文档是本轮**唯一**的裁决输入，`red-tests-may-be-guarding-something` 要求的独立裁决就是照它做的——顺序与悬挂块都会实质影响裁决者读到什么。

判为 major 而非 minor 的理由：它对**当前状态**做出了错误断言（改了哪些文件、commit 在哪），而且位置正是读者取结论的地方；这正是本仓 `closeout-doc-goes-stale-the-moment-the-merge-lands` 记的那一类。修复只是编排，不涉及结论。

---

## 主观建议（不构成事实性缺陷）

- **[建议] `docs/tmp/2026-08-08-load-sensitive-test-dispositions.md:498` vs `:502`** —— 第 5 条处置步骤 3 写「上界……取 `5_000`」，紧接着的段落写「上界取 `1_000` 而非更大」，落地代码是 `1_000`。而且 `5_000` 会**违反该段自己的论证**（上界必须小于 5s 默认 per-test 预算才可能被求值）。**预期影响**：照 `5_000` 去改的人会得到一条永远不会被求值的断言。**推荐做法**：把 `:498` 改成 `1_000`，或直接删掉该处数值、只留下一段的推导。
- **[建议] B 类预算规则（`:99-104`）补一个维度** —— 规则 1「≥10x 隔离最慢耗时」隐含「耗时全是 CPU」。第 1 条那个文件的耗时主体是**真实等待**（4.5s 上游静默），真实等待在争用下不放大，所以它按 peer 先例取 30s 是对的、按规则 1 反而会得到 48s。**预期影响**：下一个照规则算的人，要么在等待型文件上过度放宽，要么在纯 CPU 文件上误用 30s。**推荐做法**：规则 1 改为「≥10x 隔离最慢耗时中的 **CPU 部分**，真实等待部分按 1x 计入」。
- **[建议] 四处文件级预算的作用域已实测不泄漏（C8），但值得在文档里点名一句** —— 这是「放宽预算不会顺带放松别的文件」的**唯一**机械保证；它现在只写在 `:106` 的括注里，且措辞是「协调方实测」。**预期影响**：将来有人把 `setDefaultTimeout` 挪到 `tests/helpers/*` 或 preload 里，作用域保证会静默消失而无人察觉。**推荐做法**：在 `tests/infra/` 加一条极小的守卫（或至少在四个文件的注释里各写一句「这是文件作用域，别挪到共享 helper」）。

---

## 两个方向都查了：结论

- **错误状态能否通过（假绿）**：新判据整体**更强**，不是更弱——第 5/6/7 条各自补上了改前完全看不见的缺陷类别（Mutation B 在第 5、7 条改前是全绿的，我独立复现了），第 8 条补上了「deadline 被完全忽略」这一类。唯一新增的假绿面是「探针只覆盖同 tick」，已在上面写成可构造的具体场景。
- **正确状态能否通过（假红，本轮中心目标）**：四条 B 类预算的处置**方向正确且作用域受控**；但**目标没有达成到套件层面**——`store-performance:144` 的 `commitRatio < 5` 在合并态首跑即红（本评审实测），`bus.unit.test.ts:227` 的 150ms 绝对余量仍在（且可以用一个不动生产代码的改法消掉，已实测）。我**没有**建议把任何一条上界收紧回去，也**没有**建议把三条结构不同的用例统一写法——恰恰相反，C6 那张表我复现后确认它是真差异，应当保留。

## 本评审的边界（未做/做不到的）

- 未在本工作树注入任何 mutation。所有 mutation 都在 `/tmp/rev046d/clone`（本仓 `git clone --local`，`node_modules` 软链到主树）内进行；本工作树 `git status` 只应出现本报告文件。
- 未独立复现第 2、3、4 条的 mutation（CAS salt / onClose 两层 / 终态不关 anchor block），已在 C7 处标注。
- 未跑 T0.0f 的 15 连跑；本评审只跑了一次 `test:backend`（即那一次就抓到了 `commitRatio` 的红）。

---

# 复评（第二轮）

> 对象：同分支，HEAD = `def7fdb7761dba6180a02f33a8b0bf649a4eec02`（`Merge branch 'master'`，含 M1–M4 四个处置提交 `fd18041b` / `dbccb898` / `bb20d402` / `50ff39e9` 与枚举记录 `4925a27f`）。
> 仓库仍只读；本轮全部 mutation / 变体实验都在 `/tmp/rev046d/clone`（`git clone --local`，已 `--force` 切到 `def7fdb7`）内做，本工作树 `git status` 只有本报告一个未追踪文件。

## 复评 verdict

**可以合并。blocker 0；major 1（M1 的处置引入了一个未登记的新盲区，且存在与 M2 同构的更优解）。** M2、M3、M4 三条我逐条复核，**处置正确且证据到位**，M2/M3 的复现结果与我上一轮在 `/tmp` 克隆里的实测逐行一致。

---

## M2（`bus.unit.test.ts`）—— **完全一致，无新问题**

`tests/observability/bus.unit.test.ts:183` 现为 `const DEADLINE_MS = 500`，上界表达式 `expect(elapsed).toBeLessThan(DEADLINE_MS * 4)` 逐字未动 —— 与我上一轮实测的第三行（`500/2000` 下 Mutation F 红在 `3016`、健康 11 pass）**完全一致**；实施方自己复跑得到 `3008`，同一量级。commit message 里三行结果与我的三行一一对应，没有采信、是复跑。

**新问题排查**：唯一副作用是这条用例多花约 450ms（gate 型 handler，`done === 0` 仍无条件成立）；`message` 断言与上界都按 `DEADLINE_MS` 参数化，无遗漏的硬编码 50。**未发现新假绿或新敏感。**

## M3（三处探针）—— **处置正确，且补的那条探针我确认关闭了我构造的缝**

- 三处注释均已改为「at the instant this line ran」，并写明「NOT a tick and not never」。实施方还独立复跑了微任务实验，并**多测了一个我没测的维度**（sentinel 在 `Promise.race` 参数中的位置不影响结论）——这一步是对的，位置确实会影响竞胜顺序，值得单独证。
- 第 7 条 `tests/streaming/stream-shutdown-race.it.test.ts:722-736` 补了 stall 后第二探针，并用**我上一轮构造的那个假绿场景**（`idleTimeoutMs` 已 arm 时晚一个微任务自发 resolve）做了正负对照：只有第一探针时 1 pass（假绿确认），补后 0 pass / 1 fail。**这正是我要求的「先证明缝可达、再补」的顺序。**
- 第 6 条未动：其第二探针本就存在、措辞本就准确 —— 与我上一轮的复核结论一致，**没有为了对称而多改**，这一点是对的。

**新问题排查**：第 7 条新增一段**真实** 50ms 睡眠，而该用例 `idleTimeoutMs: 5000`。理论上若这 50ms 被拉长到 >5000ms，空闲超时会先 reject，`await racePromise` 抛 `StreamIdleTimeoutError` → 假红。余量是 **100x**，远高于本轮实测到的 4–6x 争用放大，且定时器不像 CPU 那样按比例放大。**判为可接受，不构成发现**；只建议在注释里把「50ms ≪ 5000ms」这句保留（现已有）。探针本身单侧安全（睡得更久只让「仍 pending」更成立）。

## M4（文档重排与事实更正）—— **重排到位；「删除了 2 条断言」这个口径我判为偏低，但只影响记录不影响裁决**

重排后 `grep '^#\+ '` 实测顺序为：1–8 条正文 → 本轮没有做的事 → 评审 major 处置 → 收口验收 → 失败面枚举 → 未处置清单 → 教训。**上一轮点名的倒置与悬挂块都已消除**，「本轮没有做的事」也改成了带标题、带「随每轮重新锚定」的显式小节。

**口径判定（协调方点名要我判的那条）**：把第 1 条归为「换常量、断言仍在」，我认为**偏低**，正确的说法是**降级**，理由不是措辞偏好而是三条已落盘的事实：

1. 处置记录自己第 1 条写的是「把 `:175` **从判据降为**只抓粗大 outlier 的上界」，并自陈「该上界的鉴别力很薄……主要是意图文档而非独立门」。一条作者亲口说不再是门的断言，不能同时算作「断言仍在」。
2. 数值从 4500 放宽到 25000（5.6x），落在 `red-tests-may-be-guarding-something` 的「**放宽**既有 guard」触发面内 —— 该规则的触发词是「删除**或放宽**」，只数「删除」会漏掉整条腿。
3. 上一轮我复核 C5 时确认它确实丢了一个可辨形态（「tail 已送达但流未被终结」→ elapsed ≈ 7s，旧界红、新界不红），只是该形态被同文件 armPing 兜住，**文件级无净损失**——「有替代守护者」和「断言仍在」是两回事。

因此建议的口径是：**改变判别内容的共 3 处**（第 1 条降级、第 6 条 `>= 40` 删除、M1 `commitRatio < 5` 被替换），其中 2 处是删除、1 处是降级；三处均已有独立裁决记录。**这只影响记录的可审计性，不改变任何已做出的裁决**，故记为 minor 而非 major。

## M1（`store-performance.it.test.ts`）—— 稳定性确实修好了，但判据被**单调放宽**，且存在与 M2 同构的更优解

### 先确认实施方证否我的那一半：**它是对的，我的建议前提不成立**

`tests/history/v3/performance-fixtures.ts:66` `deterministicText(1, branchBytes)`、`:72` `deterministicText(index + 10, branchBytes)`、`:87` `deterministicText(index + 100, 2_048)` —— 三处种子全是常量与循环下标，`id` 只进 `beginRecord(id)`。**「`highBranchFixture` 已按 name 取种子」不成立，我上一轮写错了**，照我的建议做出来的样本内容逐字节相同。改用 `__sample` salt 是对这个证否的正确回应。

补充一条**只在本轮 fixture 上成立、但值得写下的边界**：`saltedSample` 只 salt `arena.payloads` 里 value 为纯对象的节点。`highBranchFixture` 恰好**只注册 payload、不注册 frame**（`:64-100` 无 `registerFrame`），所以本例覆盖完整；但同文件另有 `largeSseFixture`（`:111-116` 注册 2048 个 frame）与 `longConversationFixture`（`:56-58`），**若将来把 `timedCommit` 用在它们身上，frame 内容不会被 salt，去重会悄悄回来**。建议在 `saltedSample` 的 docstring 里点这一句。

### 但 salt 的**必要性**我没能实测出来（不影响结论，影响的是「证据强度」）

在 `/tmp/rev046d/clone` 里把 salt 拆掉（只保留 `operationId` 变化）与保留 salt 各跑一次，并打印**每个样本**的耗时：

```
salted    cold [5.31, 2.51, 2.11, 5.09, 1.85]   hot [1.30, 23.28, 1.33, 1.46, 2.30]
unsalted  cold [4.85, 6.85, 14.82, 4.33, 3.96]  hot [2.86, 2.99, 3.74, 8.51, 3.56]
```

**没有出现「样本 2..5 明显更便宜」的台阶**——去重命中带来的节省在这里落在噪声之下（合理解释：`prepareModelOperation` 的哈希/压缩在计时窗口**之外**，窗口里只剩 SQLite 写入）。所以：salt 在**结构上**是对的、无害、且方向正确；但「不 salt 就会量到去重查表」这个**后果**命题，双方都没有证据。这不是缺陷，是又一处「命题比证据强一档」，只是这次代价为零。

**顺带一个更要紧的观察**：`hot` 那一列里出现了 `23.28ms` 的单点尖峰——**正是改前那次 false-red 的量级（23.61）**。这直接证实了「单次采样 + 毫秒级分母」就是根因，中位数是对的解法。

### [major] 新判据对旧判据是**纯粹的放宽**（pass 区间只增不减），且在实测到的所有 regime 下「5x」都不参与判定

数学上：旧 `hot < cold * 5`，新 `hot < max(cold * 5, 60)`。因为 `max(cold*5, 60) ≥ cold*5`，**新判据的通过集合是旧判据的超集，对任意输入只可能更宽、不可能更严**。

实测 `commitBudgetMs` 恒为 **60**（floor 生效）：

| 环境 | coldCommitMs | hotCommitMs | commitBudgetMs |
|---|---|---|---|
| 本工作树隔离单跑 | 4.05 | 1.77 | **60**（cold×5 = 20.2） |
| `/tmp` 克隆隔离单跑 | 2.51–2.56 | 1.46–2.13 | **60** |
| 实施方记录的 5 次隔离 | — | 1.65–2.00 | （同前，cold 远低于 12ms） |

也就是说 **`cold` 必须 >12ms 才轮得到那个 5x**，而实测 cold 恒在 2.5–4ms。**结论：当前 regime 下，这条断言实际是一条绝对的 `hotCommitMs < 60ms` 预算，中位数与 salt 全部作用在一个被 `Math.max` 丢弃的量上；用例名声称的不变量（commit 成本不随历史长度增长）已经不由这条断言表达。**

处置记录 `:724` **确实明写了**「分母低于 12ms 时判据完全脱离比值、退化成一条固定的 60ms 预算」——所以这不是隐瞒，我上一轮草拟的「未登记」措辞会是错的。但两件事仍缺：

1. **它被写成收益（「比值不再可能被单次采样支配」），没有写成代价。** 代价可量化：旧判据在 cold≈4ms 时的通过上限是 ~20ms，新判据是 60ms，**接受区间放宽约 3x**；一个「只让 hot 变慢」的真实历史依赖缺陷（cold 4ms → hot 30ms，7.5x）**旧判据会红、新判据全绿**。这落在 `red-tests-may-be-guarding-something` 的「放宽既有 guard」触发面内，应当与未处置#7 并列登记、交裁决，而不是只登记「ratio 自归一化」那一条。注意 `:708` 写的「**5x 的语义一字未改**」与 `:724` 的自陈在事实上冲突，建议以 `:724` 为准改写 `:708`。
2. **存在一个不必付这个代价的解，而且正是 M2 已经采纳的那一招——把被测量放大，让分母离开噪声区。** 我在 `/tmp` 克隆里实测了两档：

| `highBranchFixture(...)` | coldCommitMs | hotCommitMs | commitBudgetMs | ratio 是否重新生效 |
|---|---|---|---|---|
| `(10, 8_192)`（当前） | 4.05 | 1.77 | 60（floor） | ❌ |
| `(40, 16_384)` | 8.79 | 5.44 | 60（floor） | ❌ |
| **`(80, 65_536)`** | **32.30** | 27.62 | **161.5（= cold×5）** | ✅，且 hot/cold = 0.855，余量充足 |

即：把 fixture 放大到 commit 落在 ~30ms 量级，`cold×5` 就重新压过 60ms 地板，**判据回到真正的比值形态，同时绝对余量从 60ms 变成 161ms（远大于实测到的 23ms 级尖峰）**——稳定性与鉴别力**同时**拿到，正是 M2 那次「scale the fixture instead of loosening the bound」的同构解。代价：`prepareRatio` 那一半的采样也跟着变重（该档下 coldPrepare 375ms、hotPrepare 281ms，`prepareRatio 0.748` 仍健康），整条用例约多花数秒；文件预算 60s、当前该文件只用了约 6s，**吃得下**。中间档位需要再调一次（`(40,16_384)` 还不够），本报告给的是可行性证明不是最终参数。

**这条判为 major 的理由**：M2 已经确立了「判据的鉴别力挂在相对形状上，放大被测量即可白拿余量」这条本轮自己总结出来的方法，而 M1 在同一份文档里对同一个问题选择了付出鉴别力的那条路，并且**没有比较过这两条路**。按项目裁判轴（长远正确 + 完整，架构健康 > 回归风险），这属于「有更好的内部替代方案而本轮未评估」，不是成本问题。**不阻塞合并**——当前形态比改前严格更稳定，且旧形态已被证明不可用。

## 第 1 件：枚举结果的解读，以及「还要多少轮」

### 自我限定**恰当**，且它的算术我逐条验过

`0.8^5 = 0.328` ✓；`0.8^14 = 0.0440 ≤ 0.05` ✓（故 n ≥ 14 才把 20% 那档压到 5% 漏检）；`0.55^5 = 0.0503` ✓（0/5 在 95% 置信下只排除 ≥45% 那一档）；`0.9^15 = 0.206` ✓。**拒绝据此撤下 `http2-generation-reconcile:377` 是正确的**——「5 次没撞到」对一条 10% 的 flaky 有 59% 的漏检率，撤下它就是把否定性结论当自证。

### 但它的**框架**还差一步：我们已经不在「0 失败」的区间里了

`0/n` 那张漏检表适用于**一次失败都没观测到**的情形。实际的后 M1 样本是：

| 来源 | 次数 | 失败 |
|---|---|---|
| M1 验证跑（记录 `:718-722`） | 3 | **1**（`http2-generation-reconcile:377`） |
| 失败面枚举（记录 `:828-832`） | 5 | 0 |
| 本评审本轮实跑（`def7fdb7`） | 1 | 0 —— `16 shards · 0 fail · 7297 executed · 35 skipped · 85.02s` |
| **合计** | **9** | **1** |

点估计 `p̂ = 1/9 ≈ 11%` → `P(15 连绿) = (1-0.111)^15 ≈ **17%**`。要让 T0.0f 的期望通过率到 50%，需要 `p ≤ 1 - 0.5^(1/15) = 4.5%`。

**再多绿跑无法把一次已发生的失败抹掉。** 在已有 1 次失败的前提下，要把 `p` 的 95% 置信上界压到 4.5% 以下，按 `k=1` 的上界近似 `4.74/n ≤ 0.045`，需要 **n ≈ 105 次**（每次约 95s ≈ 2.8 小时纯运行，是 T0.0f 门本身成本的 7 倍）。**这条路径被自身成本支配，不该走。**

### 因此给出的数是：**0**

再跑 0 轮枚举。理由不是「够了」，而是**枚举已经不是能推进决策的工具**：约束项不是样本量，是一条**已经被观测到**的缺陷（`tests/transport/http2-generation-reconcile.it.test.ts:377`，`test setup: server stream/session missing`，同 HEAD 隔离单跑 11 pass / 0 fail —— 同族的负载型 false-red）。正确的下一步是二选一，**都不需要新的枚举轮**：

1. **根因修它**（首选，符合项目「绝不推荐短期止血」）：它的症状形态（setup 阶段拿不到 server stream/session）与本轮四条同族，很可能同样是 wall-clock/调度假设；
2. 或**显式裁决后隔离它**（`describe.skipIf` 之类），并同步刷新 `entry-test-discovery-baseline.json` 的 `allowed_skipped` —— 这是放宽既有覆盖，须裁决，不可由执行者自决。

处置完成后**直接跑 T0.0f**：15 连跑本身就是这件事最便宜的采样器（15 次 < 105 次），中途红了就拿那次红当新证据，比先花 105 次买一个置信区间划算得多。记录 `:868` 已经把这个选项写出来了（「先跑 T0.0f，把它本身当成第 15 次采样」）——**我支持那一条，反对它并列的另一条（按漏检表定轮次）**。

## 第 2 件：baseline 合并碰撞的独立复验 —— **通过**

`peer 7af27044` 与 `b76d4769` 加了同一条条目，合并后：

- `jq '.allowed_skipped | length'` = **35**；按 `(kind, file, classname, name/suite_name, ordinal)` 组合键去重后 `unique` 也是 **35**，`duplicates = 0`。
- `minimum_executed` = 7297；**本评审本轮实跑**（`def7fdb7`，16 分片）得 `7297 executed · 35 skipped · 0 fail`——与 baseline **逐个数字相等**。这一点有判别力：`scripts/validate-entry-evidence.ts:749-757` 比的是**多重集相等**（不是子集），任何重复条目都会让 `identityMultiset` 不等而 fail。
- 排序与 canonical 格式：`scripts/entry-evidence-schema.ts:109-111` 会对非 bytewise-sorted 或重复直接 `fail`；本次全量运行中 `tests/infra/*` 全绿，是运行时证据。

**同意协调方的风险判断**：本次无重复是因为两边写出的条目**逐字节相同**且落在同一排序位——Git 对同一位置的相同插入不产生冲突也不产生重复，这是内容巧合，不是机制保证。若两边写的 `reason` 或空白有一个字节不同，就会得到两条只差一个字段的相邻条目，而 `unique` 检查（按组合键）**未必**能拦住（`reason` 不在 `expectedIdentities` 里，`scripts/validate-entry-evidence.ts:748` 会把它剥掉——两条 `reason` 不同、identity 相同的条目会让多重集出现重复 identity 而与实跑不等，那时才 fail，且报错文本是「skipped identity multiset mismatch」，指不到根因）。**建议**（低优先）：在 `entry-evidence-schema.ts` 的 `parseSkip` 后加一句「identity（剥掉 reason 后）必须唯一」的显式校验，让这类合并碰撞在**解析期**就报出可读的错，而不是留到跑完全量才以多重集不等的形式现形。

## 第 3 件：四条处置是否引入了新问题

逐条走查结果（M2、M3 见上文各自小节的「新问题排查」）：

| 处置 | 新假绿 | 新过分敏感 | 结论 |
|---|---|---|---|
| M1 | **有**：pass 区间从 `cold×5`（≈20ms）放宽到 60ms，纯超集 | 无（稳定性严格改善） | 已作为本轮唯一 major 写在上面 |
| M2 | 无（相对形状未动，覆盖经我与实施方各自实测保住） | 无（余量 150ms → ~1500ms） | 通过 |
| M3 | 无（新增探针只增不减；第 7 条那条经正负对照证明可达） | 极低（新增 50ms 真实睡眠 vs 5000ms 空闲超时，余量 100x） | 通过 |
| M4 | 不适用（纯文档） | 不适用 | 通过；口径一处偏低（见上，minor） |

另外核对了「改动没有外溢」：`git diff c672dda8..def7fdb7 -- src packages native scripts` 之外的生产面本轮未再动（新 master 带入的生产改动不属本分支）；本轮四个处置提交只碰 3 个测试文件与 2 个文档。

## 复评的主观建议

- **[建议] `store-performance.it.test.ts` 的 fixture 尺寸** —— 按上表把 `highBranchFixture` 放大到 commit 落在 ~30ms 量级，让 `cold×5` 重新压过地板。**预期影响**：判据回到比值形态、绝对余量 161ms、稳定性不降；代价是该用例多花数秒（文件预算 60s，当前用约 6s）。**推荐做法**：在 `(40,16_384)` 与 `(80,65_536)` 之间二分取一档，跑 5 次隔离 + 1 次 16 分片确认 `commitBudgetMs` 由 `cold×5` 决定而非 60。
- **[建议] `saltedSample` 的 docstring 补一句作用域** —— 它只 salt `arena.payloads` 中的纯对象节点；`largeSseFixture` / `longConversationFixture` 的 frame 内容不在其内。**预期影响**：避免将来把 `timedCommit` 复用到 frame 型 fixture 时去重悄悄回来。
- **[建议] 记录 `:708` 与 `:724` 的自相矛盾** —— 前者说「5x 的语义一字未改」，后者说「分母低于 12ms 时判据完全脱离比值」。**预期影响**：读者按 `:708` 会以为比值仍在守。**推荐做法**：`:708` 改成「5x 的**意图**未改；实测 regime 下它由 60ms 地板决定，见下」。

---

# 复评（第三轮）

> 对象：同分支，HEAD = `42275f3fa878d1f1bf2abd77a3c4ada806141875`。仓库仍只读（`git status` 只有本报告一个未追踪文件）；全部 mutation / 变体在 `/tmp/rev046d/clone`（已 `--force` 切到 `42275f3f`，实验后逐条 `--reverse` / `checkout --` 复原）。

## 复评 verdict（第三轮）

**可以合并。blocker 0；major 2** —— 一条是 R2 oracle 的边界少写了一整类语句（我给出了已验证的一行修法），一条是协调方「`executed` 含 skipped」的口径**与源码相反**、并已被写成给下一个人的警告。两条都不阻塞合并，但第二条会在下一次 gate 掉测试时**真的打掉 T0.0f**。

**T0.0f 表态：可以直接跑 15 连跑。** 依据见文末。

## R1 —— M1 回退与对我的方案的证否：**两半我都独立复跑，实施方全对，我上一轮的建议是错的**

**回退本身**：`tests/history/v3/store-performance.it.test.ts` 已逐字回到 `expect(commitRatio).toBeLessThan(5)`，`COMMIT_BUDGET_FLOOR_MS` 删除，中位数与 salt 保留。**回退一次放宽不需要裁决**，这个判断正确。

**对我方案的证否 —— 我在 `/tmp` 克隆里用它自己的冻结件 `/tmp/mut-r2-hot-only-history-dependence.patch` 复跑，结论成立：**

| fixture | coldCommitMs | hotCommitMs | commitRatio | 对 `< 5` |
|---|---|---|---|---|
| `(10, 8_192)`（现状） | 3.27 | 31.04 | **9.48** | **红** ✓ |
| `(80, 65_536)`（**我上一轮建议**） | 23.34 | 44.24 | **1.90** | **绿 —— 同一缺陷完全逃逸** |

**我的建议是错的，撤回。** 补一条比「方向相反」更可复用的判据，也是这次的真正教训：

> **比值判据对「加性」缺陷的灵敏度 ∝ 1/基线**（`ratio = 1 + Δ/baseline`）。把基线抬高来逃噪声，等于按同一比例交出灵敏度。M2 之所以能「放大即白拿余量」，是因为那里的缺陷是**乘性**的（实际时长 = 请求值 × 6），乘性缺陷在比值上是**尺度不变**的；本条的缺陷是加性的（多扫一遍表，Δ ≈ 21–28ms 与基线无关），于是尺度不变性不成立。
> **可执行的自检**：套用「放大被测量」之前，先问这个缺陷在被测量里是 `×k` 还是 `+Δ`；是 `+Δ` 就不能放大基线。

实施方记的 0.94/0.81 与我测的 1.90 有量级差异（同向、都远低于阈值），可能来自 salt 后冷端样本自身也被缺陷拖慢的程度不同；**不影响结论**，但如果要把这张表当长期依据，建议注明两次读数不一致。

## R3 —— `http2-generation-reconcile` 的根因修法与两处「良性」判定

**根因修法成立。** row 1 是四行里唯一不 await 响应的，`sleep(30)` 顶替缺失的就绪信号；`sleep(30)→sleep(0)` 必然复现，这是**内蕴的正样本对照**（零固定等待下改前红、改后绿），比「跑 N 次都绿」强得多。抽出的 `waitUntil(predicate, label, 2_000)` 带 label 也解决了「超时看起来像断言真的失败」这个分类难题——这一点是这次修复里最有长期价值的部分。

**两处「良性」判定我逐条查了，都成立；其中一处我做了主动证伪并失败：**

- **`:182`（原 `:163`）—— 成立，且我试图证伪未果。** 我的假设是：它不只是「被测刺激」，那 30ms 同时是「reconcile 必须在此窗口内被调用」的墙钟预算，而 `waitUntil` 的 5ms 轮询在争用下只需 6x 放大就会错过窗口 → `expect(connectCount).toBeGreaterThanOrEqual(2)`（`:203`）假红。**用它自己那招证伪：把 `sleep(30)` 改成 `sleep(0)`（最大收缩），该用例仍 1 pass / 0 fail。** 说明真正的竞态窗口是**真实 TCP 握手**、由 `await` 的顺序保证，不由那 30ms 的时长保证；而争用只会让注入的 sleep 更长（单侧安全）。**「良性」判定比它自己给的理由还更站得住。**
- **`:259`（原 `:260`）—— 成立，措辞也准确。** 它只声称 false-red 方向（「若 ping 真被取消，再多争用也变不出一个 ping」），这是对的；另一方向（争用下 45ms 窗口里恰好没有旧节拍 tick → 假绿）它没有声称，而且实际也不成立——15ms interval 的回调与 `sleep(45)` 在同一事件循环里排队，先排的先跑。**没有过强表述。**

## R4 —— identity 唯一性校验「已存在」：**证否成立，我上一轮的建议基于错误前提**

`scripts/entry-evidence-schema.ts:85-89` 的 `skipSortKey` 由 `(kind, file, classname, name, ordinal)` 或 `(kind, file, suite_name)` 组成，**`reason` 不在键里**；`:110-111` 的 `new Set(keys).size !== keys.length || keys.some(...compareStrings(...) >= 0)` 同时校验唯一与 bytewise 升序，失败即 `fail("allowed_skipped are not unique bytewise sorted")`。因此「两条 identity 相同、只差 `reason`」在**解析期**就被拒——正是我上一轮说「未必能拦住」的那个形态。

**我错了，撤回该建议。** 我上一轮的推理错在把 `validate-entry-evidence.ts:748` 剥离 `reason` 的那一步，当成了「唯一性检查也不看 reason，所以拦不住」——实际两处剥离的目的相反：那一处是为了和实跑的 identity 对齐，这一处（`skipSortKey`）恰恰因为不含 `reason` 而**更严**。**这是我这三轮里第二次把否定性结论说早了**（第一次是「baseline 可能有重复」，这次是同一条）。

## R2 —— 查询计划 oracle 与 perf 档

### ③ `whole-suite-skip` 名实相符：**成立**

`scripts/entry-evidence-schema.ts:1` 的 `SkipReason` 枚举含 `whole-suite-skip`，`:32` 对 `testcase` 与 `suite` 两种 kind 都允许它；`docs/rfc/2026-08-03-.../cutover-plan.md:529` 是该枚举的权威说明。baseline 里它**已被用过 8 次**（`postcommit-truncation-shaping.it.test.ts` 的 GATED 套件），本次是第 9 次，形态完全一致：`describe.skipIf(...)` 整套件 gate、Bun 按 testcase 逐条汇报。**不是为本次新造的语义。** 另外 identity 取自真实 JUnit 输出（classname 里有 `&gt;` 这类 XML 转义，手写必错）——这一步做对了。

### ② gate 的形状：**计时断言不是死代码，但它现在没有任何触发点**

- **不是死代码**：`describe.skipIf(!PERF_TIER)`，`PERF_TIER = process.env.RUN_PERF_TESTS === "1"`，`package.json:67` 的 `test:perf` 设置它；实施方实跑 4 pass 且计时行真打印。文件保留 `.it.test.ts` 后缀因而仍在 discovery baseline 的 `files` 里，后端档中表现为一条**显式 allow-listed skip** 而不是凭空消失——这个设计是对的，它让「被 gate 掉」这件事本身可审计。
- **但**：`package.json:57` 的 `test:ci` = `build:history-search && test:backend && test:pty && test:e2e`，**不含 `test:perf`**；全仓 `grep test:perf\|RUN_PERF_TESTS` 只命中 `package.json`、该测试文件、处置记录三处——**CLAUDE.md 的「测试分档」节（档位 SSOT）与 `docs/coding-conventions.md` 都没有它**。也就是说这条不变量现在只存在于一个**没有任何自动触发器、也没有出现在任何常读文档里**的档位中。用户的裁决是「保留计时于独立档」，「独立」已做到，「保留」只做到了一半：没人会想起来跑它。
- **建议（不阻塞合并）**：二选一并写进 CLAUDE.md 测试分档节 ——（a）在某个必经节点挂上它（如交付前 checklist 或 `test:ci` 末尾，它只有 4 条用例、秒级）；（b）明确写成「按需人工档，触发条件是改动 History V3 写路径时」。**只要不写进档位 SSOT，下一个会话就不知道它存在。**
- **另记一个陷阱**：`RUN_PERF_TESTS` 会改变 skip 多重集。若有人在设置了该环境变量的 shell 里跑 T0.0f 采集，这条 skip 会消失 → `validate-entry-evidence.ts:749-757` 的多重集相等检查失败，报错文本是「skipped identity multiset mismatch」，指不到根因。建议在 `capture-entry-evidence.ts` 起子进程时显式清掉它，或在 `test:perf` 旁注明。

### ① [major] oracle 的边界**写得很诚实，但漏掉了一整类语句**——写语句（`DELETE`/`UPDATE`）根本没被检查

先说做对的：oracle 包 `db.prepare` 观察**生产实际发出**的语句而不是在测试里重写 SQL（`:184-196`），反空洞断言 `expect(reads.length).toBeGreaterThan(0)`（`:200`）也确实是必需的一层；注释里把「计划保持索引」**窄于**「成本不增长」写死，并列出四类看不见的东西（N+1 点查、JS 侧的 per-operation 工作、本次未执行的代码路径、行**尺寸**增长）。这份边界声明的方向是对的。

**但过滤器是 `/^\s*SELECT/i`，写语句全部落在检查之外。** 我在 `/tmp` 克隆里把该 commit 实际发出的全部语句打印出来（29 条）：

```
22 条被检查（v3_meta / sqlite_schema / 1×v3_operations 存在性 / 20×SELECT canonical_gz FROM v3_objects WHERE hash=?）
5 条命中 history-sized 表却被过滤掉：
  INSERT OR REPLACE INTO v3_journal(...)
  INSERT INTO v3_operations(...)
  INSERT INTO v3_tracks(...)
  INSERT INTO v3_timeline_chunks(...)
  DELETE FROM v3_journal WHERE operation_id=? AND revision=?      ← 这条有 WHERE，计划可以退化成全表扫描
```

`DELETE ... WHERE` 正是「索引退化成扫描」能发生的形态，而它既不在检查内、也不在那四条边界声明里。读者按注释会以为「commit 路径上所有会扫表的地方都被盯住了」，实际只盯住了 `SELECT`。**这与本轮反复出现的「命题强于证据」是同一类**，只不过这次表现为边界列举不全。

**修法已验证，一行**：把过滤器改成 `/^\s*(SELECT|DELETE|UPDATE)/i`。我在克隆里实测：`readsInspected` 22 → **23**（多出的正是那条 `DELETE`），`scans` 仍为 **0** —— **健康态不变红，覆盖面严格增大**。`INSERT ... VALUES` 无 WHERE、无扫描语义，排除掉是对的，不必纳入。若不采纳，至少要把「写语句不在检查内」补进边界列表。

## 另外三件

### 1. 未处置#7「升级而非撤下」：**恰当，且结论写得准**

两者确实不是同一件事：oracle 抓的是「查询计划退化成扫描」，#7 记的是「比值判据的自归一化——缺陷同时拖慢冷热两端时比值吸收掉它」。后者在 oracle 存在之后**依然成立且依然无人守**（oracle 对不改变计划的成本增长是盲的，这一点注释自己写了）。所以撤下会丢东西，升级是对的。

**协调方补的那句「计时判据移出后端档后，后端档对该性质零尝试，敞口在门上变大了」——我确认属实且值得单独强调**：后端档现在对「commit 成本随历史长度增长」这条不变量的覆盖，**完全等于** oracle 能看见的那一小块；oracle 自己列出的四类（现在应该是五类，见上）在后端档里**一条都没有**。这不是反对这次改动（原判据 1/5 假红，留着它才是把门废掉），而是要求这句话必须留在记录里，不能被「已用确定性 oracle 替代」这种简写盖过去。

### 2. [major] 「`executed` 把 skipped 计在内」——**与源码相反，观测数据也不支持**

源码是决定性的：`scripts/parallel-test-artifacts.ts:129` 对每个 testcase 的处理是「若被 skip 则记入 skipped 集合，**`} else executed += 1`**」——**`executed` 严格排除 skipped**。

再看数据为什么会**看起来**像「含在内」：

| | executed | skipped |
|---|---|---|
| `def7fdb7`（上一轮，我实跑） | 7297 | 35 |
| `42275f3f`（本轮，我实跑 `0 fail · 63.63s`；与协调方读数一致） | 7297 | 36 |

本次改动同时做了**两件**事：新增 1 条会执行的 oracle 用例（executed **+1**），gate 掉 1 条原本执行的计时用例（executed **−1**、skipped +1）。**净变化恰好为 0，是这两件事互相抵消，不是「skipped 计在 executed 里」。** 两个假说都预测 skipped=36，但「含在内」假说预测 executed=**7298**，实测 7297 —— **数据本身就证否了它**。

**为什么这条必须改而不是留着**：它被写成了给下一个人的警告，而按它行事会踩坑——**下一次单独 gate 掉一条测试（不同时新增用例）时，`executed` 会真的下降到 7296**，触发 `scripts/validate-entry-evidence.ts:757` 的 `actualExecuted < baseline.minimum_executed` → T0.0f 直接 fail。**正确的规则是原来那条（协调方自称推理错的那条）：gate 掉测试就要同步下调 `minimum_executed`。** 本次之所以不必下调，纯粹是因为同时新增了一条用例。建议把记录里那段警告整段反转，并注明「本次 7297 不变是 +1/−1 抵消，不是口径特性」。

### 3. 计数拆成两个维度：**成因消除了，判定成立**

前两次数错都源于把「语法上还在不在」和「判别内容变没变」混在一个计数里。现在拆成「内容层面 4 处 = 1 删 + 3 降」与「移出后端档 1 / 新增判据 1」两个维度，两类不再互相污染，且每一处都能对上一个具体动作。我上一轮给的口径（改变判别内容 3 处 = 2 删 1 降）与现在的 4 处（1 删 3 降）差别只在 M1 那一条的最终归属——它先被替换、又被回退、最后被 gate 出后端档，归为「降」比归为「删」更准。**接受当前口径。**

## T0.0f 表态：**可以直接跑 15 连跑，现在就跑**

上一轮我给的是「再枚举 0 轮，先修那条已观测 flaky」。那条已修，条件已满足，**表态从「先修」变成「跑」**。依据分三层，从强到弱：

1. **两条已观测的失败模式都是在机制层面被消除的，不是被「多跑几次绿」掩盖的**，而且各自带正样本对照：
   - `commitRatio`：不再于后端档执行（`describe.skipIf(!PERF_TIER)`，baseline 里有对应 allow-listed skip）。它**不可能**再打掉 T0.0f——这是构造性的，不是概率性的。
   - `http2-generation-reconcile:377`：固定等待归零、换条件轮询，`sleep(30)→sleep(0)` 是内蕴正控（改前必红、改后必绿）；我另外用同一手法主动证伪了同文件 `:182` 的「良性」判定，未能证伪。
2. **合并态实测**：本评审在 `42275f3f` 实跑 `0 fail · 7297 executed · 36 skipped · 63.63s`，与协调方读数（85.13s）一致；加上上一轮 5 次枚举与实施方的验证跑，后 M1 至今**未再观测到任何失败**。
3. **成本论据（这条决定了「现在跑」而不是「再攒证据」）**：要靠纯绿跑把单次失败率的 95% 上界压到 T0.0f 需要的 4.5% 以下，需 ~67 次（0 失败时 `3/n ≤ 0.045`），是门本身成本的 4.5 倍。**15 连跑就是这件事最便宜的采样器**；失败也不亏——它会点名一个新文件，而这三轮已经证明这类 flaky 都是可根因、可机制性消除的（两条都做到了）。

**已知残余风险，点名如下（都不足以推迟开跑）**：

- **未知 flaky**：任何 ≥10% 命中率的未知项都会大概率打掉 15 连跑（`0.9^15 = 20.6%`）。目前没有任何观测支持它存在，也没有更便宜的办法排除它。
- **`RUN_PERF_TESTS` 污染**：若采集所在 shell 恰好设了该变量，skip 多重集会少一条而整个门 fail，报错指不到根因。**开跑前确认 `env | grep RUN_PERF_TESTS` 为空**——这是我唯一建议的开跑前动作。
- 本轮两条 major 与 T0.0f 无关：oracle 边界那条只影响未来的鉴别力，`executed` 口径那条影响的是**下一次** gate 测试时的操作，不影响本次采集（当前 7297 与 baseline 恰好相等）。

## 第三轮的边界（未做的）

- 未独立复跑 oracle 的 mutation（`insertObject` 点查退化为全表扫描 → 21/22 变 `SCAN v3_objects`）。我做的是**统计语句总体**（29 条，见上），从而发现了边界缺口；mutation 结论本身按记录接受并标注为未二次证实。
- 未跑 T0.0f 的 15 连跑本身（不在评审范围）。
- ~~未验证 `test:perf`~~ —— 补跑了：`bun run test:perf` 下 `HISTORY_V3_PERF history-length` 与 `HISTORY_V3_PLAN` **两行都真的打印**（cold 1.90 / hot 1.61 / ratio 0.848），计时用例确实执行，**不是死代码**。

---

# 复评（第四轮 · 只审 P1/P2/P3 增量）

> HEAD = `33b51ab4df3dbcecdce69638fee6bb14c6cad6ab`（增量两提交：`2995df8b` P2+P3、`33b51ab4` P1）。仓库只读（`git status` 只有本报告一个文件被修改）；mutation 全在 `/tmp/rev046d/clone`（已切 `33b51ab4`，实验后 `checkout --` 复原、`status` 干净）。
> 本轮合并态实测：`bun run test:backend` → **`0 fail · 7297 executed · 36 skipped · 67.28s`**。

## 第四轮 verdict

**可以合并。blocker 0；major 2**，两条都在 P1 的**文档层**：撤回没有覆盖到第二处复述（错误规则仍活着），以及撤回段里有一句与它自己上一行的表格直接矛盾、并且把教训提炼偏了。P2、P3 的**代码与脚本层**没有发现问题。

**T0.0f：维持「现在就跑」不变**，且多了一条可机械化的开跑前动作（见 P3-b）。

## P1 · `executed` 撤回

### ② 当前 `minimum_executed = 7297` 这个值本身：**对**

本轮实跑 `7297 executed / 36 skipped`，与 baseline `minimum_executed = 7297` 相等。增量两提交只改了过滤器表达式、脚本与文档，**没有增删用例**，所以数值不应变、实测也没变。✓

### ① 改正后的表述：主体准确，但有**两处**必须修

**准确的部分**：`:1018-1025` 引 `scripts/parallel-test-artifacts.ts:129` 的 `} else executed += 1`，结论「skipped 被严格排除、单独 gate 一条会掉 1、可能撞 `validate-entry-evidence.ts:757` 的下限」——与源码逐字相符；`:1040` 把 7297 的**理由**换成「本轮净变化恰为 0」也正确。

**[major] `:1226` 未处置#6 里那句错误复述还活着。** 原文：

> 6. …… **另注意 `executed` 计入 skipped**，见上文「多一条 skip ≠ 少一条 executed」。

这正是被撤回的那条断言，一字未改，而且它位于**面向未来的未处置清单**里——是最可能被下一个人直接照做的地方。缓解因素只有一个：它指向的小节标题现在读作「⚠️ 已撤回的错误结论……**是错的**」，顺着指针走的人会撞见更正。但**这句话本身仍在断言错误内容**，撞不撞见取决于读者会不会点进去。
这恰好是本文档 `:268` 自己记下的那条教训——「**改了内容不改指向它的东西，正是这类修复最常见的漏法**」——在同一份文件里复发。**修法**：把该句改成「另注意 `executed` **不含** skipped（见上文撤回小节）：gate 掉用例会让 `executed` 下降，须同步核对下限」。

**[major] `:1036` 有一句与它上一行的表格直接矛盾，而 `:1038` 的判据是从这句错话推出来的。**

`:1031-1034` 的表格写得很清楚：两个假说对同一次观测的预测是 **7298 vs 7297**，实测 7297 —— 也就是说**这次观测是有鉴别力的，而且它当场就证否了错误假说**。但紧接着 `:1036` 写：

> **一次同时改变两个变量的观测，区分不了两个假说**

这与上一行的表格**互相拆台**：预测不同就是能区分。真实的失败不是「观测没有鉴别力」，而是**根本没算过任何一个假说的预测**，于是把「数字没变」当成了确认。

### ③ 提炼的判据：**方向对、作为通则成立，但与本案不匹配，需要一般化**

`:1038` 写的是：「写下『实测证明了 X』之前，先问与 X 竞争的假说对这次观测的预测是什么——**如果两者预测相同**，这次观测就没有鉴别力。」

- 作为**通则**：成立。这是「似然比 ≈ 1 即无证据」的正确表述，值得留。
- 作为**本案的教训**：不成立。本案两个预测**不同**（7298 ≠ 7297），所以「预测相同→无鉴别力」这一条**拦不住本案**——下一次同样的人做同样的事，仍会算出「预测不同」然后照样不去对比，因为他压根没算。
- **建议改成能覆盖两种失败的形式**：「**先把每个候选假说对这次观测的预测分别写下来**，再看实测落在哪一侧。预测相同 → 该观测无鉴别力，换一个观测；预测不同 → 必须逐个对照，**不得用『数字没变／和上次一样』这类印象代替对照**。」后半句才是本案真正缺的那一步。

（顺带确认它自己的归类是对的：`:1038` 说这与「分类被推翻」那节同源、一个是**范围**写宽、一个是**鉴别力**没检验——这个区分本身准确。）

## P2 · 过滤器加宽

### 那条我没要求的对照：**成立，我逐格复现了**

在 `/tmp/rev046d/clone`（`33b51ab4`）注入 DELETE mutation（`src/lib/history/v3/store.ts:737` 的 `WHERE operation_id=?` → `WHERE +operation_id=?`，`+` 前缀禁用该列索引），两种过滤器对跑：

| 过滤器 | `HISTORY_V3_PLAN` | 结果 |
|---|---|---|
| **新**（`SELECT\|DELETE\|UPDATE`） | `{"statementsSeen":29,"planInspected":23,"scans":1}` | **红**，diff 指出 `"SCAN v3_journal"` |
| **旧**（SELECT-only）× 同一 mutation | `{"statementsSeen":29,"planInspected":22,"scans":0}` | **绿** |

**「加宽买到了真覆盖」这条正面证据成立**——旧过滤器对该缺陷确实是假绿。同时确认了「覆盖面变了就必须重做正控」这个动作是必要的，不是仪式。

### 边界声明是否**恰好**匹配实现：**是，且我核过统计口径**

- 覆盖侧：`planInspected = 23`，即 29 条语句里对 history 量级表发出的 `SELECT`/`DELETE`/`UPDATE`。剩下 6 条中，命中 history 表的全是 `INSERT ... VALUES` / `INSERT OR REPLACE`（无 WHERE，没有可退化的检索计划），排除它们是对的，**不算漏**。
- 不覆盖侧新增的「走了索引但选择性很差的计划」——这一条正是 `EXPLAIN QUERY PLAN` 只报 `SEARCH/SCAN` 而不报行估算所导致的真实盲区，补得准确。
- 变量与日志字段从 `reads`/`readsInspected` 改名为 `planned`/`planInspected`，并加了 `statementsSeen` —— **名实相符了**（旧名 `reads` 在包含 DELETE 之后就是撒谎的名字），而且 `statementsSeen` 让「总体 vs 被检查」的比例可审计，这一步做得比我要求的多。
- 反空洞断言 `expect(planned.length).toBeGreaterThan(0)` 仍在。**nit（不构成发现）**：加宽之后它稍微弱了一点点——即使所有 `SELECT` 都消失、只剩那条 `DELETE`，它也仍为真。若要更强可断言 `planInspected >= 20`，但那会引入一个需要维护的魔数，**我不建议改**。

## P3 · `test:perf` 接进 `test:ci` 与 CLAUDE.md（指令文本）

### a) 与既有条款是否互相拆台：**主要那条已被主动化解；剩一处未收口**

- **「后缀=真相域、绝不按速度命名」——不冲突，而且是被显式化解的**：新文写「**被 gate 掉的用例仍留在 `.it.test.ts` 里**（后缀=真相域，不因档位而改）」，正面回答了读者会问的那个问题。配套事实我核过：`tests/infra/test-discovery-matrix.unit.test.ts:12` 的 `VALID_SUFFIXES` 只认五个后缀，新增 `.perf` 会当场判红——所以「不新增后缀」不是偷懒而是被守卫钉死的。✓
- **[minor，但请修] 「tier=脚本按后缀组合」这半句没跟着更新。** 同一条 bullet 里这句仍是无条件的，而 `test:perf` 恰恰**不是**按后缀组合的——它是「env gate + 写死的单个文件路径」。只读 CLAUDE.md 的人要新建一个类似档位时，会照这句去加第六个后缀，然后撞上 `test-discovery-matrix` 判红，而 CLAUDE.md 里没有任何一句提示他别这么做（那句提示只存在于处置记录里，不是常读文档）。**建议改为**：「tier=脚本按后缀组合（唯一例外 `test:perf`：按 `RUN_PERF_TESTS` gate + 显式文件定义，**因为被 gate 的用例必须保留 `.it` 后缀**，新增第六个后缀会被 `test-discovery-matrix` 判红）」。

### b) [可被合理化绕过的措辞] ⚠️ 那条前置检查是**人肉自评闸门**，而它可以变成机械不变量

新文写「跑 entry evidence / T0.0f 前确认环境里 `RUN_PERF_TESTS` 为空」。这条**判官与被判者是同一方、条件全靠自评**，正是 `downgrade-self-adjudicated-gates` 说的结构；实际执行时最容易被一句「我这个 shell 应该没设」绕过，而失败形态又极难归因。

**它不必是一条指令——可以是一行代码。** `scripts/capture-entry-evidence.ts:283-292` 起子进程时构造的 env 是 `{ ...process.env, OUT, RUNS, MIN_RUNS, MIN_TESTS, EVIDENCE_TIMING, REQUIRE_TEST_ARTIFACTS, ALLOW_DIRTY }` —— **`...process.env` 会把 `RUN_PERF_TESTS` 原样带进去**。在这里加一个 `RUN_PERF_TESTS: undefined`（或起跑前显式校验并 fail-fast，报错文本直接点名该变量），这条前置条件就从「人记得看」变成「结构上不可能」。**强烈建议做**；做完之后 CLAUDE.md 那句 ⚠️ 可以保留为说明，但不再是唯一防线。

### c) `test:perf` 写死单文件：**算缺陷，但不该改成 glob；正确形状是补一条守卫**

**算缺陷，理由不是猜测的**：`test-discovery-matrix.unit.test.ts:9-11` 的注释把自己的存在理由写成「**此守卫从结构上杜绝『已分档但无脚本运行』的孤儿盲区**」。而 `test:perf = RUN_PERF_TESTS=1 bun test tests/history/v3/store-performance.it.test.ts` 恰好开了**同一类盲区的一个新入口**：将来第二个 `describe.skipIf(!PERF_TIER)` 套件，文件后缀合法（守卫绿）、在后端档里表现为一条 allow-listed skip（看起来被管着）、**但没有任何脚本会跑它**。它比原来的孤儿更隐蔽，因为 baseline 里还有一条条目在，看上去是「被登记过的」。

**不建议改成 glob**：`RUN_PERF_TESTS=1 bun test .it.test` 会把整个 it 档拖进 `test:ci` 再跑一遍（分钟级），代价远大于收益；而按后缀分档又被 (a) 里那条守卫堵死。

**建议的形状**（与本仓既有做法同族、约十行）：在 `test-discovery-matrix.unit.test.ts` 里加一条——**扫描 `tests/` 中出现 `RUN_PERF_TESTS` 的文件集合，断言它恰好等于 `package.json` 的 `test:perf` 脚本里列出的文件集合**，不等就红并打印差集。这样「加了第二个 perf 用例却忘了收录」在**加的当下**就红，而不是半年后被发现从未执行过。**现在就做**：成本极低，而它防的正是这条链路上唯一还剩的静默失效。

## 第四轮 T0.0f 表态：**维持「现在就跑」**

上一轮的三层依据未被本轮增量削弱，并有两处加强：
1. 后端档的失败面没有变化——本轮实测 `0 fail · 7297 executed · 36 skipped · 67.28s`，与上一轮一致。
2. P2 的加宽**只增加鉴别力、不增加 false-red 风险**（健康态 scans 恒 0，且它读的是查询计划、不读时钟，与负载无关）——我复现过健康与两个 mutation 三种状态。
3. P3 把 `test:perf` 接进 `test:ci`，**不影响 T0.0f**（T0.0f 跑的是 `bun scripts/parallel-test.ts unit it http`，不经 `test:ci`）。

**开跑前动作，从一条变成两条（第二条是新增的、可机械化）**：
- 确认 `env | grep RUN_PERF_TESTS` 为空；
- **更好的做法是先落地 P3-b 那一行**（`capture-entry-evidence.ts` 清掉该变量），把这条检查变成结构性的，之后就不用每次记得。

本轮两条 major 都是文档层，**与 T0.0f 无关**，不必等它们修完再开跑。

---

# 复评（第五轮 · 收口 · 只审 Q1–Q4 增量 + CLAUDE.md + 下限裁决）

> HEAD = `c918cc725776a2aced299fc3a9fd6c7f7121d9ae`（增量两提交：`94e182e4` Q3+Q4+CLAUDE.md、`c918cc72` Q1+Q2+口径记录）。仓库只读（`git status` 只有本报告一个文件被修改）；探针全在 `/tmp/rev046d/`。
> 采纳协调方提供的最终合并态读数：`16 shards · 0 fail · 7299 executed · 36 skipped · 65.53s`，`diff-skips` 双空。

## Q1 · 我自己 grep 了，**确认无第三处**

不采信「已经 grep 过了」。全仓 `rg -n "计入 skipped|含 skipped|skip ≠ 少一条|executed 不含|严格排除 skipped" --glob '!node_modules'` 的全部命中：

| 位置 | 判定 |
|---|---|
| `dispositions.md:1024` 小节标题「⚠️ 已撤回的错误结论……**是错的**」 | 更正本身 ✓ |
| `dispositions.md:1249`（未处置#6） | **已改**为「注意 `executed` **严格排除** skipped（`parallel-test-artifacts.ts:129` 的 `} else executed += 1`）……单独 gate 一条会让它掉 1」✓ |
| 本报告 `:346` / `:426` / `:490` | 我自己的发现正文与**引文**，语境正确 ✓ |

另外查了一处**看似冲突、实则不同字段**的旧文：`docs/tmp/2026-08-04-cutover-plan-review-criteria.md:227` 写「Bun JUnit 的 `<testsuites tests=N>` **包含** skipped／todo；`parallel-test.ts` 把最终 `tests` 定义为 `passSum + failSum`」——它讲的是 `tests` 字段，不是 `executed`，与本轮结论**不矛盾**，无需改。

**Q1 结论：撤回已覆盖全部复述点，无第三处。**

## Q2 · 判据本身**对本案与通则都成立**；但被它取代的那句错话**还留在上面 4 行**

`:1054-1058` 的定稿判据：

> 先把每个假说对这次观测的预测分别写下来，再看实测落在哪一侧。预测相同 → 换观测；预测不同 → **必须逐个对照**，不得用「数字没变／数字符合预期」代替对照。

- **通则**：成立。它同时覆盖「似然比≈1」与「压根没算预测」两种失败，比第一版严格更强。
- **本案**：成立且贴合。`:1050` 明确点出「上表自己写着两个预测是 7298 vs 7297，**不同**，这次观测**有**鉴别力」，`:1058` 再补一句「『数字没变』从来不是一个对照」——正是本案缺的那一步。✓

**[minor] 但 `:1046` 那句原话没删**：

> **一次同时改变两个变量的观测，区分不了两个假说**

它与 4 行之后的 `:1050` **直接相反**（那里说这次观测有鉴别力）。顺序读下来的人先撞见错的那句。这是本文档「**只补更正、不改原句**」的第三次复发——Q1 修的是「结论」的复述，这里漏的是「论证过程」里的一句。**修法**：把 `:1046` 那半句改成「而当时**没有算过任何一个预测**，于是把巧合的 +1/−1 抵消读成了实测背书」。
**机械化建议**：撤回时不要只 grep 被撤回的**结论**，还要 grep 支撑它的**论证措辞**（本例是「区分不了」「同时改变两个变量」）。

## Q3 · Bun 的 env `undefined` 语义：**我独立复现，是删键，修复前提成立**

探针 `/tmp/rev046d/env-probe.ts`（与生产同形：`Bun.spawnSync(..., { env: { ...process.env, PROBE_VAR: undefined } })`，父进程带 `PROBE_VAR=1`），子进程打印 `raw / typeof / "PROBE_VAR" in process.env`：

```
WITH_SCRUB   : {"typeofIt":"undefined","present":false}      ← 键被删除，不是 "undefined" 字符串
WITHOUT_SCRUB: {"raw":"1","typeofIt":"string","present":true}
```

**`present:false` 是关键**——它排除了「字符串化成 `"undefined"`」这个会让修复看着对、实则失效的形态。`scripts/capture-entry-evidence.ts:289` 的 `RUN_PERF_TESTS: undefined` 因此**真的**把变量从子进程环境里摘掉了。✓

**一处精度更正（不是缺陷，但按本轮标准要说）**：commit message 说若 Bun 字符串化「would have left a truthy value behind」，暗示修复会静默失效。对**本条链路**并非如此——唯一消费者是 `tests/history/v3/store-performance.it.test.ts:227` 的 `process.env.RUN_PERF_TESTS === "1"`，`"undefined" !== "1"`，那条用例照样会 skip，门也照样通过。这个隐患对**真值型**消费者（bash 的 `[ -n "$X" ]`、JS 的 `if (process.env.X)`）才成立；我 `rg` 过全仓 `RUN_PERF_TESTS` 的五处引用，**目前没有真值型消费者**。所以：**去查这件事是对的**（下一个消费者可能就是真值型），**但「不查就会失效」这句比证据强一档**。建议把注释改成「顺带确认了 Bun 是删键——若是字符串化，对真值型消费者会静默失效」。

**Q3 附带的口径变更（协调方要我核的那条）：写得够不够显眼——够，但建议再挪一处。**
`scripts/` 现在确实相对 `c672dda8` 有差异（`capture-entry-evidence.ts` 5 行），所以我前几轮那句「相对 master 生产代码逐字节相同」此后**只对 `src/`/`packages/`/`native/` 成立**。`dispositions.md` 已记该口径变更。**但本报告第一、二轮的原句仍在**（`:141` 一带），读者若只读报告会拿到过期口径——我在此**就地更正**：自 `94e182e4` 起，「零生产差异」的正确写法是 `git diff c672dda8..HEAD -- src packages native` 为空，**`scripts/` 不再包含在内**。

## Q4 · 新守卫：反方向**被断言覆盖**（但不是被那两条正控覆盖），另有一条真实副作用

### 反方向「脚本里多列了一个不存在的文件」——**抓得到**

`expect(gated).toEqual(scriptFiles)` 是两个**已排序数组的相等**，相等是对称的：脚本多列一个（无论该文件是否存在、是否 gated），`scriptFiles` 就多一个元素 → 不等 → 红。**所以反方向由断言本身覆盖，而不是由那两条正控覆盖**——这个区分值得写进注释，否则下一个人会以为正控数量等于覆盖方向数量。

我把可能的**静默通过**路径逐条列了一遍，确认没有漏网的：

| 情形 | 结果 |
|---|---|
| 脚本多列一个（含已重命名的陈旧路径） | `scriptFiles` 多一项 → 不等 → **红** |
| 脚本漏列一个新 gated 文件 | `gated` 多一项 → 不等 → **红** |
| 脚本改成 glob / shell 变量，正则匹配不到 | `scriptFiles = []`，`gated` 非空 → 不等 → **红** |
| perf gate 被整体移除（两侧同时变空） | `toEqual` 通过，但 `expect(gated.length).toBeGreaterThan(0)` → **红** |
| 同一文件在脚本里列两次 | `scriptFiles` 长度 2 vs `gated` 1 → **红** |

**结论：两条正控 + 对称断言合起来没有静默通过路径**，反方向不需要第三条正控。

### 但有一条**真正的边界**必须写进守卫注释：它只认字面量 `RUN_PERF_TESTS`

`PERF_ENV = "RUN_PERF_TESTS"`。若将来有人用**另一个环境变量名**开新的 gate（`RUN_SLOW_TESTS` 之类），扫描两侧都看不见它，**两边一致、守卫全绿，而新的孤儿完全不可见**。这不是本次实现的错（没有便宜的通用解），但它是这条守卫**唯一**的静默失效面，应当在注释里点名：「本守卫只覆盖 `RUN_PERF_TESTS` 这一个 gate 变量；新增别的 env gate 时必须同步扩这里。」

### [major] 正控把一个真实文件**写进仓库的 `tests/` 目录**，与本项目自己的纪律冲突，且爆炸半径正落在 T0.0f 上

`tests/infra/test-discovery-matrix.unit.test.ts` 的第二条正控做的是：`Bun.write("${REPO_ROOT}/tests/infra/perf-scan-control.unit.test.ts", ...)` → 跑全量扫描 → `finally` 里 `rm -f`。

三个具体问题：

1. **它违反本项目明写的纪律**：CLAUDE.md 战例库里的 `feedback_tests_never_touch_real_env`（「测试绝不碰真实环境」，配套做法是 DI 临时目录 + bunfig preload 沙箱）。这里写的不是临时目录，是**仓库自己的测试树**。
2. **窗口不短，而且不是理论值**：我实测该用例耗时 **184ms**（`--reporter=junit` 读数；同文件另一条新守卫 174ms），因为它要读遍 `tests/` 下每个文件的全文。也就是**每跑一次 `test:backend`，`tests/infra/` 里就有约 0.18 秒存在一个多出来的测试文件**。
3. **爆炸半径正好落在这次要跑的门上**：`scripts/capture-entry-evidence.ts:232` 用 `compareSets(baselineFiles, junitFiles)`、`:265` 用 `compareSets(baseline.files, discover(tree))`，baseline `files` 是**冻结的 714 条**。任何在这 184ms 窗口内**启动**的独立全量运行（本仓明确存在并发 agent 会话），其文件集合会变成 715 → 门以「discovery baseline differs from entry tree」失败，而那条报错**指向一个已经不存在的文件**，排查成本极高。
   **说清楚概率**：同一次 T0.0f 采集**不会自己毒到自己**——`parallel-test.ts` 在 spawn 分片**之前**就算好了文件清单，而植入发生在分片执行期间。真正的暴露是「**并发的另一个全量运行恰好在窗口内启动**」（15 次 × 0.18s / (15 × ~70s) ≈ **0.26%**），以及「**进程被硬杀时 `finally` 不执行、文件留在树里**」——后者概率更低但后果更持久（留下未追踪文件，在共享工作树里还可能被 peer 的全量暂存操作带进提交）。

**修法（约 5 行，不损失任何覆盖）**：把 `scan()` / `perfGatedFiles()` 的根目录参数化，正控在 **`/tmp` 下的一次性目录**里造一棵含标记文件的小树，断言扫描函数在那棵树上找得到它。这样既保留「证明扫得到」的正控语义，又不碰真实仓库。**建议合并前改**，因为它的代价是 5 行，而它的失效形态会伪装成 T0.0f 的门故障。

**判为 major 而非 blocker**：它不影响本次合并的正确性，实测概率也低；但它是本轮**新引入**的、与项目纪律直接冲突的副作用，且不修就会一直挂在最热的那条门旁边。

## CLAUDE.md（指令文本）· 合并后效果

**改对了的那处**：「后缀=真相域**绝不按速度命名**、tier **通常**=脚本按后缀组合，**但 `test:perf` 是例外：它是按环境变量 gate 的横切档，不新增后缀**（`VALID_SUFFIXES` 只认那五个，加第六个会被 `test-discovery-matrix` 当场判红）——需要新档位时优先考虑 env-gate + 显式脚本，别去动后缀集」。

这一处我逐项核过，**没有互相拆台**：

- 「后缀=真相域、绝不按速度命名」与新档位**不冲突**——`test:perf` 恰恰**不加**后缀，被 gate 的用例仍是 `.it.test.ts`，前文那句「被 gate 掉的用例仍留在 `.it.test.ts` 里（后缀=真相域，不因档位而改）」正面接上了。
- 「tier 通常=脚本按后缀组合」加了 `通常` + 显式例外 + **后果**（加第六个后缀会被判红）+ **正向指引**（下次优先 env-gate）。**给出后果与替代路径**这一步是关键：只说「是例外」会让人以为可以随便新增例外，说清「加后缀会红、该走 env-gate」才是可执行的。
- 我核了它引用的硬事实：`tests/infra/test-discovery-matrix.unit.test.ts:12` 的 `VALID_SUFFIXES` 确为五项，所以「加第六个当场判红」属实、不是吓唬。

**[minor] 但同一条 bullet 里那句 ⚠️ 现在**与 Q3 落地的机制**不同步**：

> ⚠️ **跑 entry evidence / T0.0f 前确认环境里 `RUN_PERF_TESTS` 为空**：它会改变 skip 多重集，令门以 `multiset mismatch` 失败且指不到根因。

Q3 已经把这件事做成了结构性不变量（`capture-entry-evidence.ts:289` 在 spawn 时删键，我独立复现过），所以：**经 `capture-entry-evidence` 的采集已经不需要人工自查**；而这句话既没提到机制存在，也没区分哪条路径受保护。两个后果：①读者不知道有机制，继续把「记得检查」当唯一防线（正是 `downgrade-self-adjudicated-gates` 要消灭的形态）；②真正仍暴露的路径（**手工直接跑 `bun scripts/parallel-test.ts` 采集**）反而没被点名。
**修法（一句话）**：「⚠️ `RUN_PERF_TESTS` 会改变 skip 多重集 → 门报 `multiset mismatch` 且指不到根因。经 `capture-entry-evidence` 的采集已在 spawn 时清除它（`capture-entry-evidence.ts:289`），**手工直接跑 `parallel-test.ts` 采集时仍需自查**。」

**可被合理化绕过的措辞**：本轮新增的三段里，除上面那条 ⚠️（改完即不再是自评闸门）之外，没有发现「看起来是规则、实则可自行判定豁免」的措辞。新增内容全部挂在可机械验证的事实上（脚本名、`VALID_SUFFIXES`、守卫文件名），这是好的形状。

## 裁决：`minimum_executed` 7297 → 7299 该不该重锚 —— **该，而且这不属于我会拦的那类改动**

### 先把数字锚死（三方独立读数一致）

| 来源 | 读数 |
|---|---|
| 实施方（`94e182e4` commit message） | `0 fail, 7299 executed, 36 skipped` |
| 协调方 | `16 shards · 0 fail · 7299 executed · 36 skipped · 65.53s`，`diff-skips` 双空 |
| **本评审自跑**（`c918cc72`，`bun run test:backend`） | `16 shards · 6269 tests · 6269 pass · 0 fail · **7299 executed** · 36 skipped · 64.44s` |

三方一致，`7299` 可作为交付数字引用（口径：`bun scripts/parallel-test.ts unit it http`，HEAD `c918cc72`，本工作树、未构建 native 产物、`RUN_PERF_TESTS` 未设）。

### 该不该重锚：**该**。协调方给的两条理由都成立，我再补一条决定性的

协调方的理由（下限的作用就是探测「套件被静默收窄」；低 2 = 白送 2 个用例的容忍度）——成立。补充：**这个 slack 会单调增长**。下限不会自己跟着套件长，套件每加 n 条用例，容忍度就变成 `n + 2`。不重锚的代价不是恒定的 2，是随时间发散的。

**我补的那条（这是真正决定能不能安全收紧的判据）：必须确认当前测得的 7299 是「合法环境里的最小值」，否则重锚就会在别的机器上 false-red。** 我逐条查了后端档（unit/it/http）里所有条件性 skip：

| 形态 | 条件 | 当前是否 skip | 在别的合法环境里会怎样 |
|---|---|---|---|
| `describe.skipIf(!NATIVE)` × 8 处（`tests/history/search/*`） | `isNativeHistorySearchAvailable()` | **skip**（本树未构建 native 产物） | 构建了就**执行** → executed **变大** |
| `describe.skipIf(!PERF_TIER)`（`store-performance.it.test.ts:229`） | `RUN_PERF_TESTS === "1"` | **skip** | 设了就**执行** → executed **变大** |
| `describe.skip`（`postcommit-truncation-shaping.it.test.ts:92`） | 无条件 | skip | 恒定 |
| `test.todo`（`cc-to-anthropic-stream.unit.test.ts:339`） | 无条件 | skip | 恒定 |
| `skipIf(!GATED)` / `getE2EMode()` 各处 | env | — | **都在 `.e2e.test.ts` 里，不属后端档**，与本下限无关 |

**结论：当前配置就是后端档的「最大 skip 配置」**——两个环境相关的 gate 都处在 skip 侧，任何其它合法环境只会执行**更多**。下限只在 `actualExecuted < minimum_executed` 时判红，所以 **7299 是合法环境下的下确界，重锚到它引入零 false-red 风险**。这一条我认为是本次裁决的关键，它把「收紧」从一次感觉判断变成了可验证的判断。

### 这属不属于「我会拦的那类改动」：**不属于**

- `red-tests-may-be-guarding-something` 的触发词是「**删除或放宽**既有 guard」。**收紧不在触发面内**——那条规则防的是覆盖被悄悄削掉，而抬高下限是往相反方向走。实施方登记为「收紧既有 guard，交裁决」是谨慎的、没有坏处，但**分类上略微过度适用了该规则**；正确的类比是本仓已有的 `circular-deps-ratchet`：降环之后跑 `update-circular-deps-baseline.ts` 重新冻结，属**例行维护**，不是需要裁决的 guard 变更。
- 唯一需要外部把关的部分是「7299 是不是安全的下确界」，而那是**可机械验证**的（上表），不是自评。既然可验证且已验证，就不构成 `downgrade-self-adjudicated-gates` 说的那种结构。

### 重锚时请带上两个附加动作

1. **数字带口径**：把 commit + 命令写在 baseline 旁或提交信息里（`every-number-carries-scope`），否则下一个人无法判断 7299 是在哪种配置下测的——尤其是「未构建 native 产物」这一条，它正是让本次读数成为下确界的前提。
2. **把「增删用例后同步重锚」写成明文步骤**（放在 `dispositions.md` 未处置区或 CLAUDE.md 测试分档节都可以）。否则本轮修好的 slack 会在下一次加用例时原样长回来——这正是它这次变成 2 的原因。

## 第五轮 verdict（收口）

**可以合并。blocker 0；major 1**（Q4 正控把真实文件写进 `tests/` 树），外加 minor 2（`:1046` 那句被自己 4 行后推翻的原话；CLAUDE.md 的 ⚠️ 与 Q3 已落地的机制不同步）。

Q1 我自己 grep 过、无第三处；Q2 的定稿判据对本案与通则都成立；Q3 的 Bun env 语义我独立复现（**删键，`present:false`**），修复前提成立；Q4 的反方向由对称断言覆盖、无静默通过路径；CLAUDE.md 那处收口改对了，并且给出了后果与替代路径。

**下限：同意重锚到 7299**，理由与前置检查见上节；这不是我会拦的改动。

## T0.0f：**维持「现在就跑」**

三方读数一致的 `0 fail · 7299 executed · 36 skipped`、`diff-skips` 双空；Q3 把 `RUN_PERF_TESTS` 从人肉前置检查升成结构性不变量，**上一轮我提的那条开跑前动作现在可以取消**（经 `capture-entry-evidence` 的采集已被机制保护；只有手工直跑 `parallel-test.ts` 采集才需自查）。

**唯一与 T0.0f 相关的建议**：Q4 那条 major 值得在开跑**前**花五行修掉——不是因为它会红（实测暴露概率约 0.26%），而是因为它一旦命中，表现形式是「discovery baseline differs from entry tree」并指向一个已不存在的文件，**会被误判成门本身坏了**，而这次采集要连跑 15 轮、任何一轮误红都得重来。

---

# 复评（第六轮 · 只审 `atomic-fs.unit.test.ts:263` 及其处置）

> HEAD = `20884723af379cb09e33c6f05c4ceafe235b7a9d`（`da6cb6e4` 测试修复 + merge master）。相对 master 只差两个文件，与派活件一致。仓库只读；mutation 全在 `/tmp/rev046d/clone`（已切至 `20884723`）。

## 1. 覆盖表复核 —— **`:227` 那一格是错的，而且错因正是本轮要治的那个病**

实施方给的表是：pass-through mutation 下 `:197` 红、`:227` 未抓到、`:263` 未抓到。我在 `/tmp` 克隆里把 `packages/foundation/src/atomic-fs.ts:90` 的 `chain.then(() => fn(...args))` 换成 `Promise.resolve().then(() => fn(...args))`（保留微任务跳、去掉串行链），**连跑 8 次**：

| run | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| `:197` 交错序列 | 红 | 红 | 红 | 红 | 红 | 红 | 红 | 红 |
| **`:227` 50 并发写** | **红** | **红** | **红** | **红** | **红** | **红** | 绿 | **红** |
| `:263` 负向对照 | 绿 | 绿 | 绿 | 绿 | 绿 | 绿 | 绿 | 绿 |

**`:227` 在 8 次里红了 7 次。** 也就是说「`:227` 未抓到」这个结论来自**一次采样**，而那一次恰好落在约 1/8 的绿区间里——**这正是它这一轮在修的那个错误（用单次采样给「有没有」下结论），只不过这次犯在 mutation 对照上而不是被测断言上。**

两个后果要分开说：

- **对主结论无影响**：`:197` 8/8 红，「核心不变量已被独立且确定性守住」成立。
- **对表本身有影响**：`:227` 不是「盲」，而是**一条会抖的对照**——它对 pass-through 有约 7/8 的鉴别力。把它记成「未抓到」会让下一个人以为 `:227` 与本不变量无关，从而在将来放心地改动或删除它。**这一格必须改**。

`:263` 8/8 绿属实且符合预期：它整条用例用的是 **raw `atomicWriteJson`**，根本不经过 `createSerializedAsyncFn`，所以对该 mutation 结构性免疫——「它是负向对照/文档，不是守卫」这个判型**成立**。

**这个结论不依赖我选的 mutation 形状。** 我把 pass-through 的两种合理写法各跑 8 次：

| pass-through 形状 | `:197` | `:227` | `:263` |
|---|---|---|---|
| A：`Promise.resolve().then(() => fn(...args))`（保留微任务跳） | 8/8 红 | **7/8 红** | 0/8 红 |
| B：`fn(...args)`（连微任务跳也去掉） | 8/8 红 | **7/8 红** | 0/8 红 |

两种形状结果一致，所以「`:227` 未抓到」不是 mutation 选型差异造成的，就是采样次数不够。**修法**：把那一格从「未抓到」改成「**约 7/8 会红——是一条有鉴别力但会抖的对照，不可据此认为它与本不变量无关**」，并注明是 8 次采样的结果（口径：HEAD `20884723`，`bun test tests/infra/atomic-fs.unit.test.ts`）。

## 2. 修法 (a)：闸门构造 —— **确实比原判据强，且没有引入新的时序假设**

**强在哪（不是「换了个写法」，是命题变了）**：

| | 旧 | 新 |
|---|---|---|
| 断言 | `expect(parsed.n).not.toBe(2)` | `expect(parsed.n).toBe(0)` |
| 通过集 | `{0, 1}`（两个值都算过） | `{0}`（唯一值） |
| 依赖 | 三个 `setTimeout(30/15/0)` 的相对到达顺序 | 无定时器；顺序由 `await` 与闸门**构造**决定 |
| 反空洞 | 无 | 有：中途先断言 `n === 2` 真的落盘过 |

新写法的通过集是旧写法的**真子集**，且多了一条中间断言——**严格更强**，不是等价改写。那条中间断言尤其关键：没有它，「最终读到 0」可能仅仅因为 `n=2` 从未写成功，最终断言就会真空通过。

**闸门有没有引入新的时序假设——我逐句查了，没有**：

- `firstInvoked` 的第一句就是 `await gate`，`gate` 只由 `releaseFirst()` 兑现，而 `releaseFirst()` 在 `await atomicWriteJson({n:2})` **之后**才调用。所以「n=0 的物理写晚于 n=2 的物理写」由**程序顺序**保证，不由调度器保证——负载再重也改不了 happens-before。
- `await atomicWriteJson(target, {n:2})` 是**完成**才继续，不是「发起」。中间那条读盘断言在它之后，读到 2 是必然的。
- 最后 `await firstInvoked` 再读盘，读到 0 也是必然的。
- 唯一的外部依赖是 `atomicWriteJson` 自身的原子性（temp + rename），那正是被测对象，不是脚手架假设。

**一处措辞可以更准（nit）**：用例名从「last-invoked write is NOT guaranteed to win」改成了「an earlier-invoked write overwrites a later-invoked one」。新名字描述的是**这次构造出来的那一种情形**，而原命题（「不被保证」）是**存在性**命题。新名字更诚实（它确实只演示了一条路径），但读者可能误以为「先发起的**总是**覆盖后发起的」——而真相是「物理写序说了算，本用例把物理写序钉死成了这一种」。建议在名字或首行注释里保留「physical write order decides」这半句（当前注释第一段其实已经写了，故只是 nit）。

## 3. 两方向证据 —— 成立，但我查出 `:263` 的那条红**不是独有的**

mutation「`atomicWriteText` 目标已存在就不 rename」我在克隆里复现了（`atomic-fs.ts:56` 改成「target 存在则删 tmp、不 rename」）。结果是**三条**同时红：

```
✗ atomicWriteJson > overwrites existing file atomically (target stays a valid file throughout)   ← :63
✗ createSerializedAsyncFn > concurrent atomic writes ... produce the last payload   Expected 49 / Received 0   ← :227
✗ createSerializedAsyncFn > ... an earlier-invoked write overwrites a later-invoked one   Expected 0 / Received 2  ← :263（新写法）
 7 pass / 3 fail
```

也就是说 `:263` 对该 mutation 变红**属实**（`Expected: 0 / Received: 2` 与记录逐字一致），**但 `:63` 是一条专门为「覆盖既有文件」写的、确定性的用例，且名字就叫这件事**。所以 `:263` 在这个方向上也没有独有覆盖。

## 4. (c) 退役还是保留 —— **我的意见：保留，但必须改名去掉「regression guard」**

先把两个方向的鉴别力钉死（都是我实测的，不是转述）：

| 缺陷 | `:263` 是否独有地抓到 |
|---|---|
| `createSerializedAsyncFn` 退化成 pass-through | **完全抓不到**（0/8）——它整条用例走 raw `atomicWriteJson`，结构性免疫 |
| `atomicWriteText` 不再覆盖既有文件 | 抓到，但 `:63` 与 `:227` 同时抓到，**非独有** |

**所以它确实没有独有的鉴别力——但我仍然建议保留，理由有三条，且都不是「保险起见」：**

1. **要退役它的那个前提已经消失了。** 当初把它列入候选，是因为它是「单次采样断言不确定性质」的坏形态；`da6cb6e4` 已经把它改成无定时器、通过集唯一、带反空洞中间断言的确定性构造。**拿旧前提（它会 false-red）去支持新决定（删掉它）是拿一个已不存在的状态做裁决。**
2. **它现在的成本近乎为零、收益是可执行的文档。** 实测 **10.98ms**，无定时器、无 sleep、20 次连跑 0 失败。而 `createSerializedAsyncFn` 存在的理由（物理写序决定最终状态，与调用顺序无关）**是这个文件里最不直观的一件事**；用一个 12 行的确定性构造演示它，比同样长度的散文强，也比 `:197`（只证「串行化后顺序对」）更能回答「不串行化会怎样」。按项目轴（长远正确 + 完整、`never-drop-a-right-thing`），把一个刚被修成确定性的用例删掉，换来的只有 11ms。
3. **「看着冗余」正是 `red-tests-may-be-guarding-something` 要防的误判形态**，而这次的冗余判断成立与否依赖于 `:63`/`:197` 未来不被改动——保留一条独立表述反而便宜。

**但必须改一件事**：用例名里的 **`(regression guard)`** 现在是**过度声称**。实测它对本文件唯一那条「helper 退化」缺陷 0/8 命中，叫 guard 会让下一个人把它当防线。**建议**：名字改成 `... (documents WHY serialization is needed — not a guard; the guard is the interleaving-order case above)`，并在注释里补一行实测事实：「本用例走 raw `atomicWriteJson`，对 `createSerializedAsyncFn` 的任何退化都免疫（实测 0/8）；它变红只在 `atomicWriteText` 不再覆盖既有文件时，而那条同时由 `:63` 确定性守住。」——**把「它守什么」写成可证伪的句子，而不是一个标签。**

## 5. 「新形态」归类是否准确 —— 准确；而且它确实证明前八条的扫描口径太窄

**归类准确**：前八条全都是 wall-clock 判据（`elapsed` 上界、per-test 预算、比值），扫 `elapsed|toBeLessThan|setDefaultTimeout` 能穷举；这一条**一个时间断言都没有**，扫不到。它的病灶在另一层：**命题是存在性的（「不被保证」＝「有时会输」），断言是单次采样的（「这次没发生」）**。

**共同根因（这才是该写进口径的东西）**：这九条的共同点不是「用了墙钟」，而是——

> **断言的取值由测试没有钉死的东西决定**（调度器、内核、文件系统、网络），而测试既没有把它构造死（闸门 / fake clock / 注入 seam），也没有用重复采样把「有时」变成可检验的统计命题。

墙钟预算只是这个根因的一个实例（时长由调度器决定）；`:263` 是另一个实例（物理写序由调度器决定）。

**可执行的扩大口径（三条扫描 + 一个判定问题）**：

| # | 扫描（机械） | 命中后要问的（可判定） |
|---|---|---|
| S1 | 用例名/注释里出现**可能性措辞**：`NOT guaranteed` / `may (or may not)` / `sometimes` / `depending on (the) scheduler` / `non-deterministic` / `race` / `either … or` / 「不保证」「可能」 | 该性质是被**构造**出来的，还是**指望**出来的？指望 → 本族 |
| S2 | `Promise.all` 或多个并发调用与 `setTimeout` / `sleep(` 出现在同一用例体内 | 断言是否依赖这些并发操作的**完成顺序**？是 → 本族 |
| S3 | 既有的 wall-clock 口径：`elapsed` / `toBeLessThan` / per-test 预算 / 比值判据 | （前八条已处置） |

**判定问题（S1–S3 之外的兜底，不可机械化但可逐条回答）**：对每条断言问「**这个值由谁决定？**」——答案里出现调度器 / 内核 / 文件系统 / 网络，而测试没有把它钉死，就是本族。

**我把 S1 真跑了一遍**（`rg -i "NOT guaranteed|not deterministic|depending on (the )?scheduler|may (or may not|vary)|sometimes (fails|wins|loses)|non-?deterministic" --glob 'tests/**/*.test.ts'`），全仓 4 条命中：

| 命中 | 判定 |
|---|---|
| `atomic-fs.unit.test.ts:248/250` | 就是本轮这条（其事后注释自述），**已处置** |
| `e2e-client/anthropic-sdk.it.test.ts:246`「A refusal is NOT guaranteed to be followed by a terminator」 | **假阳性**——那句描述的是**上游动机**，用例用 `refusalTurn(false)` 把该条件**构造死**了，断言是确定性的 `stop_reason === "end_turn"`。无缺陷 |
| `e2e/copilot-api.e2e.test.ts:355`「Model may or may not call the tool」 | 在 `.e2e.test.ts` 里，**不属后端档**，与 T0.0f 无关；真实模型不确定性，另案 |

**结论：按扩大后的口径，后端档里没有第二条同族存活**（S1 口径下）。这是一个**交付了的否定结果**，不是「我觉得应该没有了」——但按 `criteria-list-grows`，S1–S3 不保证完备，第四类仍可能存在；下一次撞到时应当把新形态补进这张表，而不是重写它。

## 6. `Edit` 吞标题第六次 —— 现有固定动作**方向对但范围太窄**

现有动作是编辑后 `rg "^### "` 核标题；这次确实**当场抓到了**，说明它有效。但六次复发说明的是**范围**问题，不是有没有的问题：

- 它只看**标题**。而本轮第一回合就有一次吞掉的是**一张表格**（「方向一」那张），标题检查对它完全无感——同一族缺陷、不同载体。
- 真正的不变量在 user-rule 62 已经写死了：**把 `old_string` 与 `new_string` 各自按行拆开，只有「本次有意删除」和「本次有意新增」的行允许出现在差集里**。标题只是差集里最显眼的一类行。

**建议的形状（不是再加一条同类检查，而是换一层）**：把主检查换成**内容无关**的——**编辑后、提交前，读一遍该文件 `git diff` 的所有 `-` 行，逐条确认每一处删除都是本次有意为之**。它不需要新工具，覆盖任意载体（标题、表格、列表行、代码块），而且判据是机械的（「这一行我打算删吗？」）。原来的 `rg "^### "` 保留为**廉价绊线**——它更快、能在 diff 之前就报警，但不再是唯一防线。

**为什么不建议继续加「检查表格」「检查列表项」**：那是按已知形态打补丁，六次里每次的载体都不同，第七次大概率还是一个没被列进清单的载体。**按差集判、不按载体判**，才是收敛的形状。

## 第六轮 verdict

**可以合并。blocker 0；major 1；minor 1。**

- **[major] 覆盖表里 `:227` 那一格是错的**：实测 8 次（两种 pass-through 形状各 8 次）它红 7/8，不是「未抓到」。结论来自单次采样——**与本轮要修的病同型，只是犯在 mutation 对照上**。主结论（`:197` 8/8 红、核心不变量确定性守住）不受影响，但那一格必须改成「约 7/8 会红，是有鉴别力但会抖的对照」，并带上采样次数与口径。
- **[minor] 用例名里的 `(regression guard)` 过度声称**：实测它对 helper 退化 0/8 命中。改名并把「它守什么」写成可证伪的句子。
- 修法 (a) **确实严格更强**（通过集从 `{0,1}` 收到 `{0}`、去掉全部定时器、加了反空洞中间断言），且**没有引入新的时序假设**——写序由 `await` 与闸门的 happens-before 构造，不由调度器决定。
- **(c) 我的意见：保留，不退役**，但必须改名。理由是「要退役它的前提（它会 false-red）已被这次修复消灭」，而它现在成本 11ms、是该文件里最不直观那件事的可执行文档；`never-drop-a-right-thing` 与 `red-tests-may-be-guarding-something` 都指向保留。**它没有独有鉴别力这一点我已实测确认并写清**——保留的依据是文档价值，不是假装它是 guard。
- 扫描口径**确实太窄**，扩大后的口径见上（S1/S2/S3 + 「这个值由谁决定」兜底）。**S1 我真跑了**：后端档无第二条同族存活（1 条已处置、1 条假阳性、1 条在 e2e 档外）。
- `Edit` 吞内容：现有 `rg "^### "` 有效但只覆盖标题；主检查应换成**内容无关**的「读 `git diff` 的每一条 `-` 行」，标题检查降为廉价绊线。

**T0.0f**：本轮改动只碰一个测试文件与一份记录，**不改变我第五轮的表态**——可以继续跑。补一句依据：这次门在第 6 轮抓到了枚举 5 次没抓到的东西，**这恰好是我第三轮给「直接跑门、别再枚举」那条建议的正面验证**（门是最便宜的采样器，而且失败会点名具体文件）。同理，若后续再红，**继续把红当证据往下走**，不要退回去攒绿跑。
