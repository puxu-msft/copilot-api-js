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
