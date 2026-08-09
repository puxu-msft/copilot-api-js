# 负载敏感测试的逐条处置记录（2026-08-08）

> 触发：entry-evidence T0.0f 门要求 `bun scripts/parallel-test.ts unit it http` 连续 15 次全绿。16 核机器 load 18–31（多个并发 agent 会话各跑各的套件），一轮出现 4 条失败，**4 条隔离单跑全绿**。原始输出：`/home/xp/.claude/jobs/046d7295/tmp/entry-evidence-3a9daecf/run-02.log`。
>
> 用户裁决：「退役相关测试，这种无效测试似乎不是我们的目标」。按**目标**执行而非逐字：**消灭以 wall-clock 当判据的无效断言，但不得删掉仍有鉴别力的机制覆盖**。因此逐条分类，不一刀切。
>
> 分类口径：
> - **A 类** —— 断言主体本身就是 wall-clock 竞态窗口。首选把时间判据换成因果/机制判据；只有去掉时间判据后该用例已无鉴别力时才退役。
> - **B 类** —— 机制有效，只是被 wall-clock 预算饿死。**绝不放宽断言本身**，只按 peer 先例把**文件级**预算放宽（`setDefaultTimeout`）。
>
> peer 先例：commit `a6be256a`（`tests/infra/validate-entry-evidence.unit.test.ts`）—— `import { setDefaultTimeout } from "bun:test"` + `setDefaultTimeout(30_000)`，配注释说明「wall-clock 预算不是本文件的不变量，16 分片下会把健康用例判红」。方法论权威：`docs/memory/methodology-false-red-from-process-global-quantities-not-the-mechanism.md`（判据挂在进程全局量上 → 逐条加 timeout 是打地鼠）。
>
> 基线：`git log -1` = `2a4898e8`（本 worktree 已 fast-forward 到 master）。

## 隔离基线（本会话实测，load 30–40 的机器上单文件独跑）

| 文件 | 隔离单跑 | 用例数 | 分片下的失败形态 |
|---|---|---|---|
| `tests/e2e-client/keepalive-idle-reset.it.test.ts` | 10.79s | 3 | **断言失败**（非超时）：`:175` `elapsedMs < 4500`，实测 4583 |
| `tests/history/v3/store-performance.it.test.ts` | 7.75s（CAS 单条 5.31s） | 3 | 超时：18026ms vs 预算 15000ms |
| `tests/responses/upstream-ws-crash-safety.it.test.ts` | 1.54s | 2 | 超时：5006ms vs 默认预算 5000ms |
| `tests/pipeline/delivery-lifecycle-baseline.http.test.ts` | 1.54s | 2 | 超时：6434ms vs 默认预算 5000ms |

复现命令：`bun test <文件>`（本 worktree 根）。观测到的争用放大倍数约 4x（1.2s→6.4s、4.5s→18s）。

---

## 1. `tests/e2e-client/keepalive-idle-reset.it.test.ts` — armSilent（**A 类**）

**它守的不变量**：undici 的 `bodyTimeout` 在响应体空闲超过阈值时**会真的掐断客户端**——这是 armPing（keepalive ON 则存活）的**正样本对照**。没有它，armPing 的「存活」什么也证明不了（file header `:20-21` 明写「both load-bearing — armSilent is the positive control」）。

**依据来源**：
- 断言现场 `tests/e2e-client/keepalive-idle-reset.it.test.ts:157-176`。
- 机制说明与 300s 真实尺度实测：同文件 header `:6-18`，引 `exp/cc-keepalive-idle-oracle/REPORT.md §0`（armSilent 死于 +300.8s，armPing 活过 +320.1s）。
- 失败原文：`run-02.log:20-32` —— `expect(received).toBeLessThan(expected) / Expected: < 4500 / Received: 4583`，报错位置 `keepalive-idle-reset.it.test.ts:175:23`。

**判为 A 类的理由**：失败的是 `:175` `expect(elapsedMs).toBeLessThan(SILENCE_MS)`，而 `:165-170` 的 `result.ok === false` + `error.code === "UND_ERR_BODY_TIMEOUT"` + message 含 "Body Timeout" **全部通过**——机制本身完全正确，只有这一条时间断言红了。

该断言的注释写「must NOT survive to see the tail」，但**「没看到 tail」已经被 `result.ok === false` 证明**：tail 只在 `SILENCE_MS` 之后才发出，客户端若看到 tail 就会干净结束、`result.ok` 为 true。所以 `:175` 是**冗余的**。

它同时是**错帧比较**：`elapsedMs` 从 `request()` 发出前起算，含代理接请求、解析模型、调上游 mock、开流的全部前置耗时；而 `SILENCE_MS` 是**上游 mock 的流开始之后**才起算的。争用下前置耗时被拉长，`elapsedMs` 越过 4500 只说明前置慢，与「是否活到 tail」无关。实测 4583ms 正是这个形态——客户端确实死于 body timeout（error code 已断言），只是总耗时超了。

**处置**：把 `:175` 从判据降为**只抓粗大 outlier 的上界**，注释改写为「这是 outlier 兜底，不是判据；判据在上面的 error code」。**保留 `:174` 的下界** `elapsedMs >= BODY_TIMEOUT_MS - 200`——它是单侧的，负载只会让 elapsed 变大、不会让计时器提前触发，因此争用下不可能 false-red，同时仍排除「因无关原因瞬间失败」。

上界取值 `25_000`：观测到的最坏争用放大约 4x（本例 base ≈ 2.5s + 前置，实测 4.8s），25s 留出约 5x 余量；而真实回归形态是「`bodyTimeout` 根本没被压缩」→ 要到 ~300s 才死（header `:11-12` 的实测尺度），25s 远在其下。**诚实标注**：该上界的鉴别力很薄——文件级预算（下条）本身也会拦住 300s 形态，所以它主要是意图文档而非独立门；真正的鉴别力全在 `:165-170` 的 error code。

**同族复查（同一把尺子扫全文件）**：
- `:174` `elapsedMs >= BODY_TIMEOUT_MS - 200` —— 单侧下界，负载单调安全，**保留**。
- `:198` armPing `elapsedMs >= SILENCE_MS - 200` —— 同样是单侧下界，负载单调安全，**保留**。其因果内容已被 `:186-194`（`result.ok === true` + 收到 tail 的 `message_stop`/`"done"`/keepalive 的空 `text_delta`）覆盖。
- 三条 `test(..., 15_000)` 的**per-test 预算** —— armPing 基线实耗 ≈ 4.5s 真实等待，4x 争用下逼近 15s，属于「wall-clock 预算不是本文件不变量」的同一形态。按 peer 先例改为文件级 `setDefaultTimeout(30_000)` 并删掉三处 per-test 字面量（逐条加 timeout 是打地鼠——红在哪条只取决于该轮调度）。

**这一条现在由谁守**：`result.ok === false` + `error.code === "UND_ERR_BODY_TIMEOUT"`（`:165-170`），因果判据，不随负载漂移。

### 验收证据

所有命令在本 worktree 根 `/home/xp/src/copilot-api-js/.claude/worktrees/agent-a915058689631f211` 执行。

**方向一：正确状态不被误拒**

| 条件 | 命令 | 结果 |
|---|---|---|
| 隔离单跑（改前） | `bun test tests/e2e-client/keepalive-idle-reset.it.test.ts` | 3 pass / 0 fail，10.79s |
| 隔离单跑（改后） | 同上 | **3 pass / 0 fail，10.82s** |
| 16 spinner 争用 | `bash /tmp/contend-run.sh tests/e2e-client/keepalive-idle-reset.it.test.ts /tmp/ka1-contend.log 16` | **3 pass / 0 fail，13.65s**（起跑 loadavg 10.80 → 结束 16.00） |
| 32 spinner 争用 | 同上，末位参数 32 | **3 pass / 0 fail，17.08s**（loadavg 16.07 → 26.81） |

争用制造方式：`/tmp/contend-run.sh` 起 N 个 `timeout 300 bash -c 'while :; do :; done'` 占核，记录 PID，`trap cleanup EXIT` 按精确 PID `kill`（绝不 `pkill`/`killall`），并由 `timeout 300` 硬兜底防止 spinner 活过脚本。

**方向二：错误状态仍被拦住（mutation）**

mutation 打在**生产代码**上（不是翻测试状态）：让 live 路径的 keepalive **无法被关闭**。

- 冻结件：`/tmp/mut-item1-keepalive-cannot-be-disabled.patch`，改 `src/routes/messages/handler-v4.ts:1635`
  `const heartbeatSec = buffered ? forcedHeartbeatSec : state.streamKeepalivePingSec`
  → `... : state.streamKeepalivePingSec || 0.5`
- 注入：`git apply --check <patch> && git apply <patch>` → `MUTATION APPLIED`，`git diff --stat` 确认只动 1 文件 1 行。
- 结果：`bun test tests/e2e-client/keepalive-idle-reset.it.test.ts` → **2 pass / 1 fail**，失败点
  `keepalive-idle-reset.it.test.ts:183` `expect(result.ok).toBe(false)` / `Expected: false / Received: true`。
  **失败落在目标机制上**（因果判据 `result.ok`），不是落在 outlier 上界，也不是超时——正是想要的形状。armPing 与 MUTATION control 两条保持绿，说明 mutation 精确命中被退役断言所在的那条腿。
- 恢复：`git apply --reverse --check <patch> && git apply --reverse <patch>` → `MUTATION REVERSED`；`git status --short` 只剩本任务两个文件。**全程未用整文件 `git checkout`/`git restore`。**

**未能复现的部分（诚实标注，不得当作已验证）**

我**没有**用 spinner 争用复现出原始的 false-red。把被退役的旧断言 `expect(elapsedMs).toBeLessThan(SILENCE_MS)` 用 patch（`/tmp/reverse-control-item1-old-criterion.patch`）临时加回去，在 32 与 64 个 spinner 下各跑一次：

| spinner 数 | 起跑 loadavg | 文件耗时 | 旧断言 |
|---|---|---|---|
| 32 | 20.80 | 15.33s | **仍然绿** |
| 64 | 34.29 | 21.57s | **仍然绿** |

结论口径：纯 CPU spinner **不是**原始故障的等价复现——原始 false-red 出在 16 分片 runner 里，那时同时还有 15 个 bun worker 在做模块加载、SQLite 与磁盘 I/O，拉长的是代理的**前置阶段**而非纯计算。因此这两次运行只能支持「64 spinner 下不产生 false-red」，**不能**支持「旧断言在此条件下会红」。旧断言会红的唯一直接证据仍是 `run-02.log:20-32` 那一次真实分片运行。faithful 复现（并发跑 `bun scripts/parallel-test.ts unit it http`）留到 4 条全部改完后统一做一轮，见本文末的收口验收节。

（该 reverse-control patch 已 `git apply --reverse` 撤回，`git diff --stat` 确认工作树只含本任务改动。）

---

## B 类预算的取值规则（一次定死，后面三条都按它）

预算不是「刚够本次」，而是**只有真的退化了才会撞上**。两条下界同时满足，取较大者再向上取整到 30/60 秒档：

1. ≥ **10x** 该文件最慢用例的隔离实测耗时；
2. ≥ **3x** 该用例在真实分片下**已被观测到**的最坏耗时。

第 2 条是必需的：peer 先例文件最慢用例 4.56s、`30_000` 给了 6.5x，但那个文件没有 18s 级的观测样本；本文件有，只按第 1 条会得出一个已被实测逼近的数字。

**已实测确认 `setDefaultTimeout` 是文件作用域、不跨文件泄漏**（协调方实测：`scripts/parallel-test.ts:156` 用 `Bun.spawn(["bun","test",...bucket])` 且**不带** `--isolate`，同分片多文件共进程；设置文件旁放一个睡 6s 的兄弟文件，兄弟仍在 5000ms 超时）。因此文件级预算不会把宽松度漏给同分片的其它文件。

---

## 2. `tests/history/v3/store-performance.it.test.ts` — CAS bytes（**B 类**）

**它守的不变量**：History V3 的**内容寻址（CAS）去重**真的省下了数量级的物理字节——相对「退役的 V2 写形状」（每个 operation 一份未压缩 JSON 全量副本、跨 operation 不去重）至少 **10x**。两个方向各断一次：`physicalRatio`（SQLite `page_count × page_size` 的实际增量）与 `liveRatio`（各表 blob 长度求和）。

**依据来源**：
- 断言现场 `tests/history/v3/store-performance.it.test.ts:136-167`，阈值在 `:165-166`。
- V2 基线口径的推导写在同文件 `:74-84` 的 docstring（V2 的 `sqlite/serialize.ts` 随 V2 写链在 History V2 移除 Phase 3 一并删除，故用「投影后 entry 的未压缩 JSON 字节数」作等价的朴素序列化估计）。
- 用例名本身就是不变量陈述：`CAS live physical bytes are at least 10x smaller than the real compressed V2 write shape`。
- 失败原文：`run-02.log:579-581` —— `(fail) ... [18026.86ms]` / `^ this test timed out after 15000ms.`

**判为 B 类的理由**：失败形态是**超时**，不是断言不成立。该用例的判据是**字节比值**，与耗时毫无关系：本会话隔离实测 `physicalRatio = 111.99`、`liveRatio = 218.81`，对 10x 的阈值有 11x / 22x 的余量。也就是说被测机制**完全健康**，只是被一个与机制无关的 wall-clock 预算饿死。按用户裁决，这类**不得删除**——它守的是真实不变量。

耗时来源是真实 CPU 工作（48 个 operation × 212 条 8KB 消息的 sha256 噪声、CAS 哈希、zstd、SQLite 写入），隔离下 CAS 单条约 4.5s（文件 wall 5.31s，含 bun 启动）。16 分片下被拉到 18.03s，约 4x 放大。

**处置**：**断言一个字不动**（阈值 10 保持、两个方向都保留），只按上面的规则放宽**文件级**预算：删掉 `:167` 的 per-test 字面量 `15_000`，加 `setDefaultTimeout(60_000)`，并在文件头写明「本文件的耗时不是判据，预算只为吸收并发争用」。

取值 `60_000` 的算术：规则 1 给 4.5s × 10 = 45s；规则 2 给 18.03s × 3 = 54s；取较大者向上到 **60s**。这里**不用 30_000**——它对已被观测到的 18.03s 只有 1.7x 余量，正是「刚够本次」的那种数字。

**同族复查（同一把尺子扫全文件）**：
- `:132-133` `prepareRatio < 3` / `commitRatio < 5` —— **比值型 outlier 判据，正确形状，数值不动**。它们守的是「prepare/commit 的成本不随既有 session 历史长度增长」，属于真实的复杂度不变量。
- 但记一笔**潜在敏感点（本轮未红，不处置）**：`timedPrepare`（`:90-98`）取 5 次的中位数，而 `timedCommit`（`:100-105`）只取**单次**样本。单次 wall-clock 采样在争用下方差很大，`commitRatio` 有 false-red 的余地。**不改的理由是机械的**：`timedCommit` 若照搬中位数写法，同一 record 重复 commit 会命中 CAS 去重，第 2–5 次样本天然更快，中位数测的就不再是同一件事；要正确修必须为每个样本造不同的 `operationId`，那会改变被测量的量。**这属于「改法本身有风险」而非「不值得做」**，登记在文末「未处置」节，交由协调方裁决，不在本轮静默处理。
- `:207` `retainedGrowth < max(rssGrowth * 8, logicalBytes * 32)` —— 同样是比值型 outlier 兜底，注释（`:205-206`）已自陈是 coarse leak tripwire、精确界是 `pendingBytes`。**不动。**

**这一条现在由谁守**：仍然由它自己守——`physicalRatio >= 10` 与 `liveRatio >= 10`（`:165-166`）一字未改。本次只移走了那个会替它误判的 wall-clock 预算。

### 验收证据

所有命令在本 worktree 根执行。争用脚本同第 1 条（`/tmp/contend-run.sh`，精确 PID kill + `timeout 300` 兜底）。

**方向一：正确状态不被误拒**

| 条件 | 结果 |
|---|---|
| 隔离单跑（改前） | 3 pass / 0 fail，7.75s（CAS 单条文件 wall 5.31s） |
| 隔离单跑（改后） | **3 pass / 0 fail，6.33s**，`physicalRatio 112.17` / `liveRatio 218.79` |
| 32 spinner 争用（改后） | **3 pass / 0 fail，24.64s**（loadavg 13.92 → 29.71），比值不变：`112.0` / `218.7` |

注意 24.64s 这个数字本身就证明了 `30_000` 是不够的量级：该文件三条用例里 CAS 一条就吃掉大部分，若沿用 30s 预算在更重的争用下仍会顶穿。

**方向一的反向对照（这次复现成功了）**

把 per-test 预算 `, 15_000` 临时加回 `:167`，在同样的 32 spinner 下重跑：

```
=== loadavg with 32 extra spinners: 23.20 19.56 20.52
  ^ this test timed out after 15000ms.
 2 pass / 1 fail   Ran 3 tests across 1 file. [31.04s]
```

**这与 `run-02.log:580-581` 的原始失败形态逐字一致**（`this test timed out after 15000ms`）。所以对本条而言，「旧预算会误杀、新预算不会」是**直接实测**的，不是推断。（与第 1 条不同——那条的 spinner 复现没成功，已如实标注。差别在于本条的瓶颈是纯 CPU，spinner 恰好是等价压力源。）该临时改动随后已改回。

**方向二：错误状态仍被拦住（mutation）**

mutation 打在**生产代码**上：**取消跨 operation 的 CAS 去重**——给每个 prepared operation 的所有 CAS digest 加一个递增 salt，于是不同 operation 里内容完全相同的对象也会散列到不同 hash。这精确对应「CAS 不去重」，而不是去动压缩或存储层。

- 冻结件：`/tmp/mut-item2-cas-no-cross-operation-dedup.patch`，两个 hunk，均在 `src/lib/history/v3/store.ts`：
  `:345` `digestBytesAt` 的 digest 前缀加入 `:${mutationCasSalt}`；`:518` `prepareModelOperation` 开头 `mutationCasSalt++`。
  （该 patch 由「在 pristine 的 store.ts 上做完编辑后 `git diff -- <该文件>`」冻结，并逐 hunk 核对过只含这两处；注入前 `git status --short -- src/lib/history/v3/store.ts` 为空，确认恢复基线里含真实实现。）
- 结果：**2 pass / 1 fail**，失败点 `store-performance.it.test.ts:176` `expect(physicalRatio).toBeGreaterThanOrEqual(10)` / `Expected: >= 10 / Received: 9.102519829711994`。
  **失败落在目标机制上**（字节比值），不是超时。
- 恢复：`git apply --reverse --check` 通过后 `git apply --reverse`；`git status --short` 只剩本任务两个文件。**全程未用整文件 `git checkout`。**

**mutation 顺带查出的一件事（值得记，但本轮不改）**

两个方向的鉴别力**并不对等**：

| 指标 | 健康值 | 去重被破坏后 | 阈值 10 |
|---|---|---|---|
| `physicalRatio`（page 增量） | 111.99 | **9.10** | **红** |
| `liveRatio`（blob 长度和） | 218.75 | **10.54** | 仍绿 |

也就是说，**只有 `physicalRatio` 咬住了这次的 mutation，`liveRatio` 单独会 false-green**（10.54 险险过关）。这不是本轮引入的问题，两条断言也都该保留（它们量的是不同的东西：物理页 vs 逻辑字节）。但「`liveRatio >= 10` 对去重丢失几乎没有鉴别力」是一条应当被记下来的事实——登记在文末「未处置」节。

---

## 3. `tests/responses/upstream-ws-crash-safety.it.test.ts` — guarded 腿（**B 类**）

**它守的不变量**：`createUpstreamWsConnection` 的生命周期回调（`onClose`）抛出时，必须被**吸收**，**不得**升级成 `uncaughtException` 从而被 main.ts 的崩溃策略变成 `process.exit(1)`。吸收实际有**两层**（本节的 Mutation A/B 实测确认）：第一层是 `notifyClosed` 自己的 try/catch（`upstream-ws-connection.ts:164-173`，测试匹配的 WARN 出自这层），第二层才是包住 `handleClose` 的 `guardCallback`。

这条只能用子进程证：抛出的 WHATWG `EventTarget` 监听器**不会**从 `dispatchEvent` 同步抛出，而是**异步**逃逸成 `uncaughtException`——落在进程内 `expect(...).not.toThrow()` 通过之后。同文件 header `:8-17` 与 fixture `tests/responses/fixtures/ws-crash-probe.ts:1-17` 都把这个理由写死了。

**依据来源**：
- 断言现场 `tests/responses/upstream-ws-crash-safety.it.test.ts:52-60`（`exitCode === 0` + stderr 匹配 `/\[upstream-ws\] onClose callback threw .*onClose-boom/`）。
- 为什么 exit 0 不够：同文件 `:22-26` 明写「exit 0 alone is vacuity-prone（一次让回调未绑定的重构同样会 exit 0）」，所以加 stderr 断言证明 guard **真被走到**。
- 正样本对照在 `:45-50`（`raw-control` 腿必须 exit 42），证明这套 harness 真的检测得到崩溃。
- 失败原文：`run-02.log:1115-1117` —— `(fail) ... [5006.47ms]` / `^ this test timed out after 5000ms.`（其上 `:1113` 还有一行 `killed 1 dangling process`，即预算到点时子进程仍在跑、被 bun 收尾杀掉。）

**先做「只是慢 vs 真的挂住」的分型（不能用放宽预算盖过真缺陷）**

| 探针 | 观测 |
|---|---|
| 子进程直接跑 `bun tests/responses/fixtures/ws-crash-probe.ts guarded` | wall **0.53s**，rc=0，stderr 出现目标 WARN |
| 同上 `raw-control` | wall **0.03s**，rc=**42** |
| 隔离 + **收紧**预算 `bun test --timeout 700 <file>` | **2 pass / 0 fail**，文件 920ms → 最慢用例 **< 700ms**，稳定 |
| 48 spinner 争用 + 宽预算 `--timeout 120000` | **2 pass / 0 fail**，文件 **4.12s** —— 完成，未卡住 |
| 64 spinner 争用 + 宽预算 | **2 pass / 0 fail**，文件 **3.90s** —— 完成，未卡住 |

结论：**争用下是「变慢但完成」，不是「卡在某一步不动」**。放大倍数约 4–5x，与耗时构成也吻合——该用例的成本几乎全是 `Bun.spawn` 一个新 bun 进程（模块解析 + 转译），正是 CPU 饥饿最敏感的那类工作；子进程自身的 250ms `setTimeout` 窗口在拿不到 CPU 时同样被拉长。分片日志里 `killed 1 dangling process` 也指向同一解释：预算到点时子进程只是还没跑完，而不是死锁。**判为 B 类成立。**

**处置**：**断言一个字不动**（`exitCode`、stderr 正则、raw-control 正样本对照全部保留），只加文件级 `setDefaultTimeout(30_000)` + 注释。

取值 `30_000` 的算术：规则 1 给 0.7s × 10 = 7s；规则 2 给 5.006s × 3 = 15.0s（分片下那次是**被截断的观测**——只知道它需要 >5.006s，因为 5000ms 到点就被杀了，所以这是下界）；取较大者 15s，向上到档位 **30s**，相当于隔离最慢的 43x、被截断观测的 6x。**这里恰好落回 `30_000`，而第 2 条落在 `60_000`——数字是算出来的，不是套的。**

**同族复查（同一把尺子扫全文件）**：全文件**没有**任何 wall-clock 或单次耗时断言。两条用例的判据分别是 `exitCode`（42 / 0）与 stderr 文本匹配，都是因果事实。无需处置。

**这一条现在由谁守**：仍然由它自己守——`:49` `expect(exitCode).toBe(42)`、`:56` `expect(exitCode).toBe(0)`、`:59` stderr 正则，全部未改。

### 验收证据

**方向一：正确状态不被误拒**

| 条件 | 结果 |
|---|---|
| 隔离单跑（改前） | 2 pass / 0 fail，1.54s |
| 隔离单跑（改后） | **2 pass / 0 fail，984ms** |
| 48 spinner 争用（宽预算） | **2 pass / 0 fail，4.12s** |
| 64 spinner 争用（宽预算） | **2 pass / 0 fail，3.90s** |
| 隔离 + **收紧**到 `--timeout 700` | **2 pass / 0 fail** —— 反向证明最慢用例真的 < 700ms，不是「勉强压线」 |

**方向二：错误状态仍被拦住（mutation）**

这条用例的 oracle 有**两半**（`:56` exit code + `:59` stderr 匹配），所以做了**两次**递进 mutation，分别证明两半都咬得住。

**先记一次「mutation 没生效」的失败尝试**——按 [[methodology-verify-the-mutation-actually-applied]]，「没变红」有两解，必须分清：

- 第一次 mutation 打在 `src/lib/transport/crash-safety.ts:114` 的 `guardCallback`（加 `throw error`）。结果 **2 pass / 0 fail —— 没变红**。
- 直接跑子进程 `bun tests/responses/fixtures/ws-crash-probe.ts guarded` → rc **0**，确认**不是测试假绿，是 mutation 根本没打到被走到的那条路径**。
- 根因：`opts.onClose()` 的第一层吸收器**不是** `guardCallback`，而是 `src/lib/openai/upstream-ws-connection.ts:164-173` `notifyClosed` **自己的 try/catch**；测试断言的那条 WARN 正来自 `:169`。该 mutation 已 `git apply --reverse` 撤回。

**Mutation A —— 拆掉第一层吸收器**（冻结件 `/tmp/mut-item3-onclose-not-absorbed.patch`，删 `notifyClosed` 的 `catch` 块）：

- 子进程直跑：rc **0**，但 WARN 变成 `[upstream-ws] callback threw; failing request + dropping connection` —— 说明外层 `guardCallback` 兜住了（**防御纵深**）。
- 测试：**1 pass / 1 fail**，红在 `:70` `expect(stderr).toMatch(/\[upstream-ws\] onClose callback threw .*onClose-boom/)`，`Received: "[warn] [upstream-ws] callback threw; failing request + dropping connection (model=gpt-5.5): onClose-boom\n"`。
- 即：**stderr 那一半（反空洞的那一半）有真实鉴别力**——它确实分得清「哪一层吸收的」，不是随便什么 WARN 都算数。

**Mutation B —— 在 A 之上再拆掉第二层**（叠加 `/tmp/mut-item3-guard-does-not-absorb.patch`）：

- 子进程直跑：rc **42**（崩溃）。
- 测试：**1 pass / 1 fail**，红在 `:67` `expect(exitCode).toBe(0)`，`Expected: 0 / Received: 42`。
- 即：**exit code 那一半也有真实鉴别力**。

恢复：两个 patch 按相反顺序 `git apply --reverse --check` + `git apply --reverse`；`git status --short -- src/` 为空，确认 `src/` 完全干净。**全程未用整文件 `git checkout`。** 恢复后重跑 `2 pass / 0 fail`，`bun run typecheck` 绿，`eslint` 该文件无问题。

**mutation 顺带查出的第二件事（本轮不改，待裁决）**

测试文件 header `:52-54` 写的是「A real `createUpstreamWsConnection` onClose callback throws; **`guardCallback` must absorb it**」，fixture header `tests/responses/fixtures/ws-crash-probe.ts:15-17` 同样写「**`guardCallback` must absorb it**」。上面的 Mutation A 证明这**与代码不符**：第一层吸收器是 `notifyClosed` 的 try/catch（`upstream-ws-connection.ts:164-173`），`guardCallback` 是**第二层**；测试断言的 WARN 文本也来自第一层。用例内注释 `:57-58` 用的措辞（"the current onClose ownership-boundary WARN"）反而是准确的。

这是注释层的 doc-vs-code 漂移，不影响断言正确性（无论哪层吸收，「不崩溃且 guard 被走到」都成立），但会误导下一个读者。**不在本轮静默改**——它是对生产行为的事实性更正（「防御纵深两层」这个描述本身需要复核），登记在「未处置」节交裁决。

> **裁决结果（协调方，本轮内）**：修，且必须写成**两层防御纵深**（不得把单层叙述换成另一个单层叙述），并把 Mutation A / B 各自打红了哪条断言写进注释——那是这段注释唯一不会再腐烂的部分。另需 `rg` 扫全仓的同一单层复述一并更正。已作为独立 commit 执行。
>
> **实际更正的四处**（`rg guardCallback` 全仓扫描后逐条判定）：
> 1. `tests/responses/upstream-ws-crash-safety.it.test.ts` 用例内注释 —— 改写为两层，并写明「删第一层 → stderr 断言红；两层都删 → exit code 红成 42」。
> 2. 同文件 header 的 `0 = clean survival (guard absorbed the throw)` —— 改为 `the absorbing layers held` + 指向用例内的两层说明。
> 3. `tests/responses/fixtures/ws-crash-probe.ts:15-17` 的 mode 说明 —— 改为两层，并加一句「不要再复述成一层」。
> 4. `tests/responses/fixtures/ws-crash-probe.ts:69-71` 的 `onClose` 行内注释 —— 原写「inside guardCallback」，改为「through notifyClosed，其 try/catch 先吸收；guardCallback 是第二层」。
>
> **扫描到但判定不改的**：`upstream-ws-crash-safety.it.test.ts` 的 raw-control 注释（"without guardCallback…"，那条腿确实完全没有 guard，陈述准确）；`src/lib/transport/crash-safety.ts` 的 docstring（讲 `guardCallback` 自身契约，不涉及 onClose 归属）；`tests/transport/crash-safety.unit.test.ts`（同上）；`docs/spec/2026-07-09-codex-responses-tier1-hardening.md`（历史 spec，陈述的是该原语的引入理由）；`docs/DESIGN.md:82`（陈述本身不假，但它引用的「子进程 fault-injection 证明」值得补一笔「两层」——超出本轮范围，登记在「未处置」第 4 条）。
> 本文档自身第 3 节开头原本也复述了单层说法，已一并更正——**改了内容不改指向它的东西，正是这类修复最常见的漏法**。

---

## 4. `tests/pipeline/delivery-lifecycle-baseline.http.test.ts` — 418 post-commit 腿（**B 类**）

**它守的不变量**：非重试型的 **post-commit** 上游失败（HTTP 418）必须在已经吐给客户端的合成 scaffold 之上**收支平衡**——补 `content_block_stop` 关掉开着的 block，再发 `event: error` 终结；**并且终态之后，推进假时钟也不得再追加任何心跳帧**。逐字节期望 wire 是**手写**的（file header `:1-8` 明写 "Expected SSE is hand-authored, not decoded/rebuilt by production helpers"），所以它是一条独立 oracle，不会跟着生产 helper 一起错。

**依据来源**：
- 断言现场 `tests/pipeline/delivery-lifecycle-baseline.http.test.ts:156-186`。核心三段：`:171` 整串 wire 逐字节相等；`:177` canonical client 帧的 `detail` 序列恰为 `["keepalive","synthetic-message-start","anchor","keepalive","anchor","synthetic"]`；`:183-185` 推进 20s 假时间后帧集合**不变**。
- 用例名本身即不变量陈述：`... balances scaffold close → terminal, then fake time cannot append heartbeat`。
- 失败原文：`run-02.log:1854-1856` —— `(fail) ... [6434.26ms]` / `^ this test timed out after 5000ms.`

**先做「只是慢 vs 真的挂住」的分型**

这一条尤其需要分型：它用 `FakeClock` 驱动时间，**本身不做任何真实等待**，还夹着 `await drain()`（连推 120 个微任务）与真实 HTTP 入口 `createFullTestApp().request(...)`；如果某个 promise 在调度抖动下永不 resolve，表现就会是「挂住」而不是「慢」。

| 探针 | 观测 |
|---|---|
| 隔离 + **收紧**预算 `bun test --timeout 1000 <file>` | **2 pass / 0 fail**，文件 1295ms → 最慢用例 **< 1000ms**，稳定 |
| 48 spinner 争用 + 宽预算 `--timeout 120000` | **2 pass / 0 fail**，文件 **8.24s** —— 完成，未卡住 |
| 64 spinner 争用 + 宽预算 | **2 pass / 0 fail**，文件 **7.12s** —— 完成，未卡住 |

结论：**「变慢但完成」，不是「卡在某一步不动」**。放大倍数约 6x，是四条里最高的——与它的构成相符：真实 Hono 应用装配 + 完整 route→driver→sink 管线 + 两次 120 步微任务 drain，全部是纯 CPU 且**没有**任何可以「等」出来的真实 I/O，因此 CPU 饥饿几乎按比例吃掉全部耗时。**判为 B 类成立。**

**处置**：**断言一个字不动**（逐字节 wire、`detail` 序列、终态后帧集合不变，全部保留），只加文件级 `setDefaultTimeout(30_000)` + 注释。

取值 `30_000` 的算术：规则 1 给 1.0s × 10 = 10s；规则 2 给两个候选——分片下观测 6.434s × 3 = 19.3s，以及本会话 64/48 spinner 下单用例约 7s × 3 = 21s；取最大者 21s，向上到档位 **30s**，相当于隔离最慢的 30x、已观测最坏的 3.6x。

**同族复查（同一把尺子扫全文件）**：全文件**没有**任何 wall-clock 断言——时间全部由 `FakeClock` 驱动，`clock.advance(n)` 是逻辑时间不是墙钟。无 wall-clock 判据需处置。

但记一笔**邻近形态的潜在敏感点（本轮未红，不处置）**：`:181`/`:184`/`:207`/`:209` 的 `clock.liveTimerDelaysMs.every((delay) => delay > 2_000)`，判据挂在「安装期间注册的定时器集合」这个**准全局量**上，与 `docs/memory/methodology-false-red-from-process-global-quantities-not-the-mechanism.md` 记的 `tests/pipeline/driver.unit.test.ts` 是同族。**严重度低于那一例**：那一例断言集合**为空**，而这里有 `> 2_000` 的过滤，`fake-clock.ts:52-53` 的 docstring 正说明该过滤就是用来「把泄漏的短周期心跳和无关的长周期运行时定时器区分开」的。残余风险只剩「无关代码在窗口内注册了 ≤2000ms 的定时器」。**不改**：收紧或改写既有 guard 属于 guard 重塑，须独立裁决，且本轮它没红、也不在用户裁决的范围内。登记在「未处置」节。

**这一条现在由谁守**：仍然由它自己守——`:171` 逐字节 wire 相等、`:177` `detail` 序列、`:185` 终态后帧集合不变，全部未改。

### 验收证据

**方向一：正确状态不被误拒**

| 条件 | 结果 |
|---|---|
| 隔离单跑（改前） | 2 pass / 0 fail，1.54s |
| 隔离单跑（改后） | **2 pass / 0 fail，1193ms** |
| 隔离 + **收紧**到 `--timeout 1000` | **2 pass / 0 fail** —— 反向证明最慢用例真的 < 1s |
| 48 spinner 争用（宽预算） | **2 pass / 0 fail，8.24s** |
| 64 spinner 争用（宽预算） | **2 pass / 0 fail，7.12s** |

**方向二：错误状态仍被拦住（mutation）**

**先记三次「mutation 没生效」的失败尝试**——这一条的过程比结论更重要，三次都打在「终态后不得再追加心跳」这个子命题上：

| # | mutation | 结果 |
|---|---|---|
| 1 | `client-sink.ts:394` `freezeHeartbeat` 变 no-op | **2 pass / 0 fail** |
| 2 | `client-sink.ts:375` `close` 保留 `stopped = true` 但不 `clearTimeout` | **2 pass / 0 fail** |
| 3 | `close` **完全**变 no-op（既不置 `stopped` 也不 disarm 定时器） | **2 pass / 0 fail** |

三次都不红，按 [[methodology-verify-the-mutation-actually-applied]] 不能停在「测试很稳」——于是**插探针直接观测**（临时在用例里 `console.log(clock.liveTimerDelaysMs)`，跑完即撤）：

```
PROBE after-terminal liveTimerDelaysMs = [] frames = 6
PROBE after-20s    liveTimerDelaysMs = [] frames = 6
```

**根因：该数组在那一刻是空的**，而 `[].every(...)` 恒为 `true`。也就是 `:181`/`:184`（以及 client-abort 用例的 `:207`/`:209`）的
`expect(clock.liveTimerDelaysMs.every((delay) => delay > 2_000)).toBe(true)`
在本次运行中是**真空通过（vacuously true）**，因此**这三次 mutation 不可能由它们来染红**——这解释了我为什么白试三次。

> **更正（协调方指出，2026-08-08 当轮）**：本节最初写的是「鉴别力为零」，**那是过头的断言，已撤回**。「真空通过」只说明该断言守的不变量在当前基线下成立，**不等于**它抓不到目标缺陷——心跳若真泄漏，数组非空且延迟很短，`.every()` 就会为 false。「这条断言抓不到东西」是否定性结论、不自证，必须用「注入真实泄漏后它是否变红」来判。待验证项 V1/V2 见文末「未处置」第 3 条。（本节对应的 commit `48a6c246` 的 message 里也写了 "discriminate nothing"，同属过头表述；提交历史不改写，以本处更正为准。）

它既不是被我改坏的，也不是本轮引入的，是既有状态。这条发现登记在「未处置」节交独立裁决（放宽/收紧既有 guard 不由实施者自判）。

**注意这不改变第 4 条的 B 类定性**：该用例真正承重的 oracle 是逐字节 wire 与 `detail` 序列，它们与耗时无关且**确实咬得住**（见下）。

**Mutation（有效的那次）—— 终态不再关闭 anchor block**

- 冻结件：`/tmp/mut-item4-no-terminal-anchor-close.patch`，`src/routes/messages/handler-v4.ts:1504` 后加一行
  `if (mode === "terminal") return undefined`（`closeAnchorViaOwner` 在终态直接返回，不再发 stop 帧）。
- 结果：**1 pass / 1 fail**，红在 `:182` 的逐字节 wire 比较，diff 精确指出少了：
  ```
  - event: content_block_stop
  - data: {"type":"content_block_stop","index":0}
  ```
  **失败落在目标机制上**（「balances scaffold close → terminal」的 close 那一半），不是超时。
- 恢复：`git apply --reverse --check` + `git apply --reverse`；`git status --short -- src/` 为空。**全程未用整文件 `git checkout`。**

恢复后重跑 **2 pass / 0 fail**，`bun run typecheck` 绿，`eslint` 该文件无问题。

---

## 未处置清单（登记，不在本轮改，交独立裁决）

> **「撤下」与「裁决通过」是两回事，别混。** 一条登记项被划掉可能出于两种完全不同的原因：
> - **裁决通过** —— 前提成立、确实存在取舍，由未卷入的一方作出选择。走流程。
> - **撤下（前提不成立）** —— 登记时依据的那个二选一/约束**经实测根本不存在**，于是没有什么可裁的。此时正确动作是**撤下并写明前提为何不成立**，而不是走一遍流程再盖章通过——后者会把一个错误前提追认成「已裁决的事实」，下一个人会以为那个取舍真的存在过。
> 本清单第 5 条属于**后者**（见 M2）。

按 user-rule `63-engineering-practice` 的 `red-tests-may-be-guarding-something`：删除或放宽既有 guard、以及重塑判据，合并前必须交独立 reviewer 或用户裁决，不得由实施者自判放行。以下四条都属此类，本轮**只记录不动手**。

1. **`store-performance.it.test.ts:166` `liveRatio >= 10` 对「去重丢失」几乎没有鉴别力。** 实测：破坏跨 operation CAS 去重时 `physicalRatio` 掉到 9.10（红），`liveRatio` 只掉到 10.54（**仍绿**）。两条断言量的是不同的东西，都该留；但若将来只保留 `liveRatio`，这条 guard 就是假绿。证据见本文第 2 节。
2. **`store-performance.it.test.ts:100-105` `timedCommit` 单次采样。** 同文件的 `timedPrepare` 取 5 次中位数，`timedCommit` 只取单次，`commitRatio < 5` 因此比 `prepareRatio < 3` 更易受争用方差影响。**不改的理由是机械的**：同一 record 重复 commit 会命中 CAS 去重，第 2–5 次样本天然更快，照搬中位数写法会改变被测量的量；要正确修必须为每个样本造不同 `operationId`。
3. **`delivery-lifecycle-baseline.http.test.ts:181/184/207/209` 的 `liveTimerDelaysMs.every(...)` 在当前基线下以真空方式通过——鉴别力尚未验证。**
   探针实测：断言点该数组为 `[]`，故 `[].every(...)` 恒 `true`，这四条**在本次运行中**没有对任何东西施加约束。
   **但「真空通过」不等于「抓不到目标缺陷」**——这是一个否定性结论，不自证。该断言守的是「终态 / client-abort 之后不得有短周期心跳存活」（用例名即 "...stops heartbeat"，`tests/helpers/fake-clock.ts:52-53` 的 docstring 明写该 getter 是为了「把泄漏的短周期心跳与无关的长生命期运行时定时器区分开」）。若心跳真的泄漏，数组就非空、且该项剩余延迟很短 → `.every()` 为 false → 红。所以我观测到 `[]`，只能说明**它守的不变量在当前基线下成立**，即这是一次通过，不是空转。
   **待验证（本轮未做）**：
   - **V1** 注入一个「终态后心跳定时器不被 clear」的真实泄漏（打生产代码，不翻测试状态），跑该文件，记录这四条是红是绿。红 → 有鉴别力，本条从未处置清单撤下；绿 → 才成立「盲」。
   - **V2** 仅在 V1 为绿时才需要：查 `2_000` 阈值与该测试里 keepalive 实际周期的关系——若被泄漏的定时器剩余延迟本来就 > 2000，`.every()` 照样为真，那才是真的盲。阈值与周期都要给实测值。

   ### V1 执行结果（2026-08-08 当轮补做）：**未能判定，不是「有鉴别力」也不是「盲」**

   先说**已经确证**的两件事（这两条本身就推进了问题）：

   - **该心跳定时器对 FakeClock 是可见的，剩余延迟就是 `2000`**。在用例内插探针实测（跑完即撤）：
     ```
     PROBE A (after commit, before tail advance) timers = [2000]
     PROBE B (after 2.5s advance, stream still open)  timers = [2000]
     ```
     配置是 `streamKeepalivePingSec: 2` → 周期 2000ms。**这直接回答了 V2 关心的阈值关系**：判据是 `delay > 2_000`，而心跳定时器的剩余延迟恰好是 `2000`，`2000 > 2000` 为 **false**——**只要它在断言点还活着，这四条就会红**。所以谓词的形状是对的，不存在「阈值定得太松、泄漏也照过」的问题。
   - **但在断言点它是 `[]`**：`PROBE C (at assertion point, post-terminal) timers = []`。

   于是问题收敛成一个具体的技术障碍：**我造不出「终态后仍有活心跳定时器」的状态**。逐级加码试了三种真实泄漏，全部仍 `[]`、四条断言全绿：

   | 尝试 | 打在哪 | 断言点 timers | 结果 |
   |---|---|---|---|
   | `stop()` 不 clear 定时器 | `client-sink.ts:611-615`（`startFixedForwardIdleHeartbeat`） | — | 2 pass |
   | tick 在 stopped 时**仍自我重排**（该 helper docstring 明写 `stop` 就是为防这个） | 同上 `:595` | — | 2 pass |
   | **inline** heartbeat 的 tick 在 stopped/suspended 时仍自我重排 | `client-sink.ts:436` | `[]` | 1 pass |
   | 上一条 **叠加** `close()` 完全不置 `stopped`、不 clear | 再叠 `:375` | `[]` | 1 pass |

   前两次说明**这个用例根本没走 `startFixedForwardIdleHeartbeat`**（那是另一个 builder）——这本身是一次「mutation 没打到被走到的路径」，与第 3、4 条同型。后两次说明：即使 inline 心跳无限自我重排、且 `close` 完全失效，定时器在断言点仍然不在 FakeClock 的表里。**也就是说还有第三条路径在终态前后让它消失（或让该 sink 实例整个脱钩），我没定位到。**

   **结论（严格按证据写）**：V1 **inconclusive**。不能说「已验证有效」，也**不能**升级成「已验证是盲的」——后者需要「存在真实泄漏而断言不红」，而我没能造出真实泄漏的**可观测状态**。目前唯一确定的是：谓词阈值与心跳周期的关系是**正确**的（2000 不 > 2000），若泄漏可见就会红。
   **交给裁决方的下一步**（我没做，也不该由我自决）：定位终态路径上第三个让该定时器消失的地方（建议从 `createDownstreamDeliverySession` / 终态 finalize 一侧查，而不是继续在 `client-sink.ts` 里加码），在那里注入泄漏后重跑本判据；或改用一个不依赖 FakeClock 定时器表的 oracle。

   **无论 V1/V2 结果如何，都不由实施者修改这四条断言**——删或放宽既有 guard 按 user-rule `63-engineering-practice` 的 `red-tests-may-be-guarding-something` 必须交独立裁决；实施者只负责把证据备齐。
   同族背景（**背景，不是本条的结论**）：`docs/memory/methodology-false-red-from-process-global-quantities-not-the-mechanism.md` 记的 `driver.unit.test.ts` 那一例断言的是集合**为空**、且被无关模块的定时器染红；这里有 `> 2_000` 的过滤，形态并不相同。
4. **`docs/DESIGN.md:82` 对 `guardCallback` 的描述。** 它写「所有上游-WS lifecycle 回调……包 `guardCallback`……（子进程 fault-injection 证明）」——**该陈述本身不假**（`handleClose` 确实被包），但它引用的「子进程 fault-injection 证明」正是本轮第 3 条那个测试，而该测试实际先被 `notifyClosed` 自己的 try/catch 吸收。是否要在 DESIGN.md 补上「两层」这一笔，超出本轮范围，交裁决。
5. ~~**`bus.unit.test.ts` 的 `expect(elapsed).toBeLessThan(DEADLINE_MS * 4)` 能否放宽。**~~ **已由 M2 关闭，不再需要裁决。** 原登记的前提（「要么保覆盖、要么降敏感，二选一」）是错的：那个二选一只在 `DEADLINE_MS` 钉死为 50 时成立。M2 保持上界的相对形状 `DEADLINE_MS * 4` 不变、把 fixture 的 deadline 放大到 500，鉴别力与绝对余量同时拿到（实测三行见 M2 节）。**不涉及放宽既有 guard。**
6. **`scripts/parallel-test.ts` 汇总行的 `N tests` 字段不稳定。** 同一份代码多次 `test:backend` 报 4856 / 5396 / 6394 / 4639 / 4900 / 6744 / 4849 / 4943，而 `executed` 恒为 **7297**（`skipped` 在 baseline 刷新前恒 31、之后恒 35）。成因未定位。影响面超出本轮：**任何引用该字段的历史数字都可能是错的**。建议单独派一次排查。
7. **`store-performance.it.test.ts` 的「commit 成本不随历史长度增长」判据对该缺陷类鉴别力弱。** 实测：注入「按 hash 点查退化为全表扫描 + 逐行解压」后，**改前写法 ratio 3.37、改后写法 ratio 4.62，双双低于阈值 5，都不红**。根因是 ratio 的自归一化——该缺陷让冷热两端一起变慢。这是**既有局限**（改前改后同样存在，已用并跑对照钉死），不是 M1 引入的。收紧阈值或换判据形状都属于改既有 guard，须独立裁决。
8. **`tests/transport/http2-generation-reconcile.it.test.ts:377` 是套件里的又一条 flaky。** 「row 1 — pre-header req.error」在一次合并态 `test:backend` 里报 `test setup: server stream/session missing`，同 HEAD 隔离单跑该文件 11 pass。与本轮改动无关（本轮只碰 `store-performance.it.test.ts`）。**它会和 M1 一样打掉 T0.0f 的 15 连跑**，建议单独派修。

## 本轮的分类判断被实测推翻过几次

**8 条表面症状相同的测试，底下是 4 种不同的鉴别力结构；靠类比推进必然出错。** 下面每一条都是「先有一个看起来合理的分类判断，再被一次实跑推翻」的记录——列出来不是自我检讨，是给下一个想「统一处理这一类测试」的人一面墙。

| # | 原判断（谁提出） | 实测结果 | 推翻它的那次观测 |
|---|---|---|---|
| 1 | 第二批 4 条「都是过分敏感的 outlier 兜底，放宽即可」（协调方派活前提） | **第 8 条不成立**，它的 `200` 是承重的 | 放宽到 2000 后 Mutation F（deadline 实际时长 6x）**抓不到**；改回 4x 才红（303ms） |
| 2 | 第 6 条「可能与第 5 条同型」（协调方 + 我的初始倾向） | **不同型** | 同一个 Mutation B，第 5 条旧写法全绿、第 6 条旧写法红（`lowerBound:false`） |
| 3 | 第 7 条「同文件，大概率同前两条之一」 | **第三种结构** | 它开着 `idleTimeoutMs`，因果判据更强（reject vs sentinel），但**仍对 Mutation B 全盲** |
| 4 | 第 8 条「`done === 0` 大概已蕴含上界」 | **两条都不蕴含，且两条一起还漏一整类** | Mutation E（deadline 被完全忽略）下旧写法 `{"upperBound":true,"doneIsZero":true}` 全绿 |
| 5 | 我写的「那四条 `liveTimerDelaysMs` 断言鉴别力为零」 | **过头断言，已撤回** | 「真空通过」只证明不变量成立；否定性结论不自证。V1 实测后仍 **inconclusive** |
| 6 | 第 3 条注释声称「`guardCallback` 吸收 onClose 异常」 | **实为两层**，第一层是 `notifyClosed` 自己的 try/catch | 第一次 mutation 打在 `guardCallback` 上**没变红**，子进程直跑 rc=0 |
| 7 | 第 4 条「mutation 打在 `freezeHeartbeat`/`close` 上就能证伪」 | **三次都没打到被走到的路径** | 三次全绿后插探针才发现断言点 `timers = []` |
| 8 | V1「造个心跳泄漏就能定这四条有没有鉴别力」 | **造不出可观测的泄漏状态**，V1 未判定 | 四级加码（含无限自我重排 + `close` 完全失效）断言点仍 `[]` |

**可复用的判据**（这才是这张表的价值）：

- **「同形」只是症状层面的相似**。判鉴别力结构要问的是：**去掉这条断言后，哪些退化还会被抓住？** 这个问题只能靠**对每条候选 mutation 实跑**回答，读代码读不出来——本轮 8 次里有 5 次我的读码判断被实跑推翻。
- **「mutation 没变红」永远有两解**：测试没咬住 vs mutation 没打到被走到的路径。本轮命中后者 **3 次**（第 3、4 条与 V1）。分辨方法是**独立观测被测机制本身**（子进程直跑 rc、插探针打印状态），不是再读一遍代码。
- **否定性结论（「这条断言抓不到东西」）不自证**，需要「注入真实缺陷而它不红」的正面证据；拿不到就老实写 inconclusive，别升级成「盲」。

### 同一个错误在本轮复发三次：把「我的判据证明了什么」写宽一档

这三次不是各自独立的口误，是**同一个形态**，值得单独拎出来：

| 次序 | 我写下的命题 | 实际证明的 | 差在哪 |
|---|---|---|---|
| 1 | 那四条 `liveTimerDelaysMs` 断言「鉴别力为零」 | 只观测到「当前基线下真空通过」 | 把「这次没约束到东西」写成了「永远抓不到东西」 |
| 2 | 探针证明「BEFORE the abort, nothing may settle」 | 只证明「这一瞬间未 settle」 | 把一个瞬间写成了整段窗口 |
| 3 | 修正版说「within one microtask tick」 | 连 1 个 tick 都不覆盖（实测：1/2/3 tick 与 `setTimeout(0)` 全判 pending） | **修正它的那次修正本身又宽了一档** |

第 3 次尤其要记：它是**在修第 2 次的过程中**犯的，而且**写进了会长期留在仓库的测试注释**——比写在临时文档里危险得多。

**可执行的自查动作**（在写下任何「这条判据证明了 X」之前做，包括写在注释里的）：

> **举一个刚好不满足 X、却能通过这条判据的输入。举不出来才可以写 X；举得出来，就把 X 缩小到那个输入之外。**

对照上面三次：第 2 次只要问「有没有一个晚一点 settle 的 promise 能通过？」——`Promise.resolve().then(...)` 就是，20 秒就能证否。第 3 次同理，我却把范围从「窗口」缩到「一个 tick」就停手了，**没有再问一遍**。**缩小范围之后要重新跑一次这个自查**，因为新范围是一个新命题。

第 1 次的形态略有不同（否定性断言），自查动作是上一节最后那条：**要主张「抓不到」，得拿出「注入真实缺陷而它不红」的正面证据**。

### 附带：`Edit` 之后立刻验标题（本轮踩中四次）

本轮用 `Edit` 插入新章节时，`old_string` 拿小节标题当锚点、`new_string` 忘了写回去，**静默删标题**——**发生了四次**（第 7 条残留复核段一次、M1 一次、M2 一次、本节一次），全部在通读或即时检查时发现并补回。四次都不报错，因为 `Edit` 只校验 `old_string` 唯一命中。

**固定动作**：每次用 `Edit` 插入或替换跨小节的内容后，**立刻**跑一次 `rg -n "^## " <文件>` 或 grep 被当作锚点的那一行，确认它还在。这比「下次仔细些」有用，因为它是一条命令而不是一个意愿。

## 工具性教训：`Edit` 的替换覆盖面（本轮踩中一次，写成机械判据）

本轮在插入第 7 条的残留复核段时，`Edit` 的 `old_string` 圈进了「方向一」那张表，却没在 `new_string` 里写回去，**静默删掉了它**（通读时才发现并补回）。`Edit` 只校验 `old_string` 唯一命中，**不会**因为你漏写了打算保留的内容而报错。

**机械判据（比记住这次有用）**：把 `old_string` 与 `new_string` 各自**按行拆开**，只有「本次有意删除」和「本次有意新增」的行允许出现在差集里。差集里出现任何你说不出意图的行，就落在这两个方向之一：

- **新串多、旧串少 → 重复**：`new_string` 里「顺手带上」了 `old_string` 没圈进来的邻近内容，那段会留一份再插一份。
- **旧串多、新串少 → 静默删除**（本轮这次）：拿一段上下文当锚点圈进 `old_string`，却忘了写回 `new_string`。

**表头、小节标题、列表行首最危险**——它们看起来像定位符、不像内容。


## 评审 major 处置

评审报告：`docs/tmp/2026-08-08-load-sensitive-test-dispositions-review.md`（blocker 0 / major 4）。基线已换到集成分支 `command-algebra-entry-gate-fix`，本 worktree 已 fast-forward 到 `aa79ad57`。

### M1 · `store-performance.it.test.ts` 的 `commitRatio < 5`（已处置）

**为什么必须现在修（不是「以后再说」）**：三次合并态全量运行 —— `405d459c` 56.80s 绿 / `aa79ad57` 99.02s **红 8.295** / `aa79ad57` 132.61s 绿，**失败率 ≈ 1/3**。T0.0f 要求连续 15 次全绿，按此比率通过概率 ≈ (2/3)^15 ≈ **0.2%**。它是事实上的阻塞项。注意耗时与是否变红**不单调**（56.8 绿 / 99.0 红 / 132.6 绿），所以「多跑几次都绿」不构成收口，必须给机制层面的论据。

**先复核评审给的机制归因——它对了一半，另一半我实测证否**：

- ✅ 评审说对的：`:134`/`:138` 的调用点**本来就**在给冷热两次采样造不同的 `operationId`（`target-cold` / `target-hot`）。所以我在未处置#2 写的「要正确修必须为每个样本造不同的 operationId」指错了一层——真正的去重键是**内容哈希**，不是 operationId。
- ❌ 评审据此建议「样本用形状相同、内容不同的 fixture（`highBranchFixture` 已按 name 取种子）」——**这个前提不成立**。`tests/history/v3/performance-fixtures.ts:64-101` 里 `highBranchFixture` 的载荷文本全部来自**常量种子**：`deterministicText(1, branchBytes)`、`deterministicText(index + 10, …)`、`deterministicText(index + 100, 2_048)`，**与 `id` 无关**；`id` 只进 `beginRecord(id)`。也就是说**不同 name 造出的 fixture 内容逐字节相同**，照它的建议做，样本 2..N 仍会命中既有 CAS 对象（`insertObject` 在 `:651` 命中已有 hash 即早返回），中位数量到的是去重查表而不是插入。

**处置**（形状由我定，理由如下）：

1. `timedCommit` 改为与 `timedPrepare` 同构的 **5 样本中位数**。
2. 每个样本用 `saltedSample()` 给每个 payload 注入 `__sample` salt —— **形状与体积不变、内容不同**，保证每次都是真实插入。这是上面那条证否的直接后果：光换 `operationId` 不够。
3. 判据从 `commitRatio < 5` 改为 `hotCommitMs < max(coldCommitMs * 5, 60ms)`。**5x 的语义一字未改**，只是分母不再能塌到噪声量级。

`60ms` 的推导：分片下**健康**的 hot commit 已被观测到 23.6ms（就是那次 false-red 的现场值），60ms 给约 2.5x 余量；隔离下 hot 实测 1.65–2.00ms，余量约 30x。

**方向一：正确状态不被误拒**

隔离连跑 5 次（同一 HEAD）：`hotCommitMs` = 1.90 / 1.84 / 1.91 / 1.65 / 2.00 ms，`commitRatio` = 0.70 / 0.36 / 0.65 / 0.66 / 0.88 —— 对比改前同一份代码在 0.617 与 8.295 之间摆动 13 倍。

真实并发（`bun run test:backend` = `parallel-test.ts` 16 分片，**不是 spinner**）三次：

| 运行 | 耗时 | store-performance | 结果 |
|---|---|---|---|
| 1 | 92.29s | 绿 | 0 fail |
| 2 | 95.52s | **绿** | 1 fail —— **但失败的是另一条测试**，见下 |
| 3 | 106.23s | 绿 | 0 fail |

**机制层面的论据**（这才是收口依据，不是「跑了三次绿」）：改前判据 = `单次 2.8ms 级采样` 做分母，分母的相对标准差直接乘进比值；改后 = 5 样本中位数 **且** 分母有 60ms 地板，**比值不再可能被单次毫秒级采样支配**——分母低于 12ms 时判据完全脱离比值、退化成一条固定的 60ms 预算。

**方向二：错误状态仍被拦住——这里有一个必须点名的否定结果**

注入真实的「commit 成本随历史长度增长」缺陷（冻结件 `/tmp/mut-m1-commit-cost-grows-with-history.patch`：`store.ts:651` 的按 hash 点查退化为**全表扫描 + 逐行解压**）：

| 形态 | coldCommitMs | hotCommitMs | ratio | 判定 |
|---|---|---|---|---|
| 改后（本次） | 51.39 | 237.61 | 4.62 | **仍绿**（budget 256.9） |
| **改前的单次采样写法**（临时并跑，跑完即撤） | 12.12 | 40.79 | 3.37 | **仍绿**（`wouldPass: true`） |

**两种写法都抓不住它。** 根因是 ratio 判据的自归一化：该缺陷让**冷热两端一起**变慢（冷端此时已有前几次采样写入的对象），比值因此被吸收。**这是既有局限，不是本次改动引入的**——上表第二行就是为了把这一点钉死才跑的。

因此我**没有**为 M1 交出「注入缺陷即变红」的证据，也**不会**为了凑这个证据去收紧阈值（那是放宽/收紧既有 guard，须独立裁决）。作为新发现登记进未处置清单第 7 条。

**顺带发现（不在本轮范围，但会同样打掉 T0.0f）**：run 2 的那次 `1 fail` **不是** store-performance，而是 `tests/transport/http2-generation-reconcile.it.test.ts:377`「row 1 — pre-header req.error」，错误文本 `test setup: server stream/session missing`。同 HEAD 隔离单跑该文件 **11 pass / 0 fail**。本轮改动只碰了 `tests/history/v3/store-performance.it.test.ts` 一个文件（`git diff --stat HEAD` 可证），与它无关。**这是套件里的又一条同族 flaky**，登记进未处置第 8 条。

### M2 · `bus.unit.test.ts` 的 `DEADLINE_MS` 与上界（已处置）

**评审指出我的约束是假的，这一条我判它成立。** 我原先写的「放宽上界就失去覆盖」是**真的**，但它**只在把 `DEADLINE_MS` 钉死在 50 时成立**——而 50 本身不承重（fixture 的 deadline 取多少，与「deadline 被尊重」这条不变量无关）。上界的鉴别力挂在**相对形状 `DEADLINE_MS * 4`** 上，不挂在绝对毫秒上；把 fixture 按比例放大，鉴别力不变而绝对余量变宽。

**三行对照全部自己复跑过**（不是采信评审转述），mutation 为「deadline 腿的实际时长 = 请求值的 6 倍」（`/tmp/mut-item8-wrong-deadline-duration.patch`）：

| 配置 | Mutation F | 健康 |
|---|---|---|
| `DEADLINE_MS=50`，上界 200（改前） | **红 301** | 绿 |
| `DEADLINE_MS=50`，上界 2000 | **绿 —— 失去覆盖** | 绿 |
| `DEADLINE_MS=500`，上界 `DEADLINE_MS*4`=2000（本次） | **红 3008** | **绿，11 pass** |

第三行是本轮实测的：健康 `11 pass / 0 fail`，注入 mutation 后 `Expected: < 2000 / Received: 3008`。

**处置**：`DEADLINE_MS` 50 → 500，上界保持相对形状 `DEADLINE_MS * 4` 不动（自动从 200 变 2000）。**生产代码零改动**，断言的相对形状零改动。

- 绝对余量：150ms → **约 1500ms**（健康 elapsed ≈ deadline ≈ 500ms，上界 2000ms）。
- 代价：约 450ms 墙钟（文件 0.60s → 1.09s）。gate 化的 handler 意味着这 450ms 是**唯一**新增等待，收尾仍是开闸即返回。
- 争用验证：64 spinner（loadavg 31→37）下 **11 pass / 0 fail，2.77s**。

**未处置清单第 5 条据此撤下**——那条登记的是「放宽上界须裁决」，现在的答案是**不放宽上界**，改放大 fixture，两个目标同时达成，不构成放宽既有 guard。

## 第二批收口验收（第 5–8 条全部落地后）



`bun run typecheck` —— 绿。源码残留核验：`git --no-optional-locks diff --stat -- src/ packages/ native/ scripts/` 行数 **0**。

`bun run test:backend`（= `bun scripts/parallel-test.ts unit it http`，16 分片）连跑两次：

```
[parallel-test] 16 shards · 5396 tests · 5396 pass · 0 fail · 7297 executed · 31 skipped · 66.26s
[parallel-test] 16 shards · 6394 tests · 6394 pass · 0 fail · 7297 executed · 31 skipped · 59.39s
```

**必须点名的一件事：这个 runner 的 `N tests` 字段在同一份代码上不稳定。** 本会话三次 `test:backend` 分别报 **4856 / 5396 / 6394**，而 `executed = 7297`、`skipped = 31`、`fail = 0` **三次完全一致**。三次之间的代码差异只有第 5–8 条的测试体改写（用例数没变：`stream-shutdown-race` 恒 25 条、`bus.unit` 恒 11 条），**解释不了 +1538 的漂移**。

因此：

- **可引用的口径是 `executed` / `skipped` / `fail`**（稳定，三次一致）；
- **`N tests` 不可作为交付数字引用**，任何「本仓库有 N 条测试」的断言若取自这一行，都应视为未经交叉验证；
- 成因**未定位**（不在本轮范围）。已作为一条独立发现登记进「未处置」清单第 6 条。

这条正是 `cross-check-with-two-methods` 的一次实际命中：若只跑一次并把 `5396 tests` 写进交付物，它看起来完全正常，也没有任何信号提示它是错的。

## 收口验收（四条全部落地后）

`bun run typecheck` —— 绿（`tsc`，无输出即无错）。

`bun run test:backend`（= `bun scripts/parallel-test.ts unit it http`，16 分片），在本 worktree 根、HEAD = `1de883cf`：

```
[parallel-test] 16 shards · 4856 tests · 4856 pass · 0 fail · 7297 executed · 31 skipped · 89.83s
```

**口径说明**：`4856 tests` 是用例数、`7297 executed` 是含参数化展开后的执行数、`31 skipped` 主要是 `history-search` 的 native 产物缺失时按 `describe.skipIf(!isNativeHistorySearchAvailable())` 显式跳过（本 worktree 未 `bun run build:history-search`，属预期行为，见 CLAUDE.md「测试分档」）。该数字**未**交叉验证，是 runner 自报的单一来源。

**本轮没有跑 T0.0f 的 15 连跑。** 那才是 faithful 的分片复现，也正是该门本身要做的事；本文件只负责把四条从「会被争用误杀」变成「不会」。四条里只有第 2 条（`store-performance`）在本会话用 spinner 直接复现出了原始失败形态并验证修复，第 1、3、4 条的复现依据分别是：第 1 条真实分片日志 `run-02.log:20-32`（spinner 复现失败，已标注）、第 3、4 条真实分片日志 + 「宽预算下完成、收紧预算下仍绿」的双向分型。

## 第二批：4 条同形但**本轮没红**的 wall-clock 上界

> **与第一批的关键差别，必须先声明**：这 4 条**没有**在 `run-02.log` 里红过，因此**没有实测失败可引**。下面每条只写「余量是多少、已观测到的放大倍数是多少」，**不写「它会红」**——那是未经证实的断言。
>
> 第一批第 1 条的结论**不可照抄**：那条的 `elapsed < SILENCE_MS` 经验证是**冗余**的（因果判据完全覆盖它），这 4 条要各自读代码判一遍「同处的因果判据是否真的蕴含该时间性质」。不蕴含的，处置是**换成能表达该性质的因果判据**，而不是简单放宽数值。
>
> 一个对我们有利的事实：这 4 处的原注释本来就写着 "not hang" / "deadline fired well before handler finished"——**作者的意图本就是 outlier 兜底**，只是数值取得过紧。所以本批不是推翻作者意图，而是让数值与实现符合作者已写下的意图。

## 5. `tests/streaming/stream-shutdown-race.it.test.ts` — `returns STREAM_ABORTED when signal fires during blocked next()`

**它守的不变量**：`raceIteratorNext` 在底层 `iterator.next()` **永不 resolve** 时，必须能被 abort 信号**打断**并返回 `STREAM_ABORTED`，而不是一直挂着等一个永远不来的 SSE 事件。这正是文件 header `:1-8` 声明的整体目的。

**依据来源**：
- 用例 `:148-165`。`stalledIterator`（`:97-103`）的 `next()` 返回 `new Promise(() => {})`，**永不 resolve**；`idleTimeoutMs: 0` 关掉了空闲超时腿。
- 因果判据 `:162` `expect(result).toBe(STREAM_ABORTED)`。
- 被测实现 `packages/foundation/src/stream.ts:241-282`：`Promise.race([promise, ...])`，abort 腿是 `abortSignal.addEventListener("abort", () => resolve(STREAM_ABORTED), { once: true })`——**事件驱动，没有轮询**。

**逐条判定：`:164` 的 `elapsed < 200` 是不是冗余？——结论：不是纯冗余，但它表达该性质的方式是错的。**

- `expect(result).toBe(STREAM_ABORTED)` **不蕴含**「及时返回」。设想一个**轮询式**的 abort 实现（每 1s 检查一次 `signal.aborted`）：它照样返回 `STREAM_ABORTED`，只是慢——因果判据全绿，`elapsed < 200` 才会红。所以这条上界**确实覆盖了一个因果判据覆盖不到的退化形态**，不能照第 1 条那样简单降级删掉。
- 但另一头也要说清：**「彻底挂住」并不由它守**。若 abort 腿根本没接（`stream.ts:268` 那个分支被删），`Promise.race` 只剩永不 resolve 的那条，用例会一直挂到 per-test 预算超时而红——那是**预算**在守，不是这条断言。
- 它当前的取值为什么紧：abort 在 `:153` 由 `setTimeout(..., 50)` 触发，`elapsed` 从 `:155` 起算，于是 200ms 的预算里只有 **150ms** 是留给「`setTimeout(50)` 实际什么时候被调度 + 事件派发 + 微任务」的。**争用下最先被拉长的恰恰是那个 `setTimeout(50)` 本身**，而它属于测试脚手架、不属于被测机制——这与第一批第 1 条的「错帧比较」是同一个毛病：计时窗口里混进了与被测机制无关的成分。

**处置（不是放宽数值，是换判据 + 修帧）**：

1. **新增一条时间无关的因果判据**：abort 之前，用一个**微任务探针**证明该 race **仍处于 pending**——`Promise.race([racePromise, Promise.resolve(PENDING)])` 必须得到 `PENDING`。这直接钉住「不是别的东西把它 resolve 掉的」，是 `elapsed < 200` **从来没有提供过**的信息（原写法在 abort 已经排定之后才开始 await，根本区分不了「abort 促成的」与「本来就会 resolve 的」）。该探针不读任何时钟。
2. **把 abort 从 `setTimeout(50)` 改为显式调用**，并把计时窗口的起点挪到 `controller.abort()` **之前一行**。这样窗口里只剩「abort 事件派发 → race resolve」这一段被测机制，脚手架调度不再计入。
3. 保留一条上界，但降为**只抓粗大 outlier 的兜底**，取 `5_000`——它仍能打到「轮询式 abort」这类退化（合理的轮询周期 1s 量级会被打到），同时对争用免疫（窗口内只剩事件派发与微任务，没有可被拉长的定时器）。

**净效果是严格增强，不是放宽**：原来只有一条紧的、错帧的上界；现在是「时间无关的因果 pending 探针」+「正确帧的宽松 outlier 兜底」，且原有的 `:162` 因果判据一字未动。

上界取 `1_000` 而非更大：**必须小于 per-test 预算（默认 5000ms）才可能被求值**——否则退化会先撞超时，这条断言等于不存在（第一批第 1 条也有同样的结构关系，那里靠文件级 30s 预算 > 25s 上界解决）。1000ms 同时满足两头：足以打到 ~1s 量级的轮询式退化，而对争用免疫（理由见下面实测）。

### 验收证据

**方向二：错误状态仍被拦住（mutation）——两半各证一次**

**Mutation B —— 「已中止」快路径对一个尚未中止的信号误触发**（冻结件 `/tmp/mut-item5-fastpath-misfires.patch`）：
`packages/foundation/src/stream.ts:248` `if (abortSignal?.aborted)` → `if (abortSignal)`。

- 结果：**0 pass / 1 fail**，红在新增的 pending 探针 `:164`，`Expected: Symbol(still-pending) / Received: Symbol(STREAM_ABORTED)`。
- **关键对照：旧写法对这个退化是假绿的。** 把改前的用例体逐字放回、与新写法在同一次运行里并跑（临时 patch，跑完即撤）：
  ```
  REVERSE CONTROL legacy form PASSED under mutation, elapsed = 0
  ```
  旧的两条断言（`result === STREAM_ABORTED`、`elapsed < 200`）**全部通过**——因为快路径误触发时它立刻返回 `STREAM_ABORTED`，`elapsed` 就是 0。
  **所以本次改动不只是「降低负载敏感度」，而是补上了一个旧判据完全看不见的缺陷类别。** 这也正是「这条断言是多余的」属否定性结论的实例：读起来 `result === STREAM_ABORTED` 像是覆盖了一切，实测才发现它连「是不是 abort 促成的」都分不出来。

**Mutation A —— abort 被观测到但惰性处理**（冻结件 `/tmp/mut-item5-lazy-abort.patch`）：
`stream.ts:272` `onAbort = () => resolve(STREAM_ABORTED)` → `onAbort = () => setTimeout(() => resolve(STREAM_ABORTED), 3_000)`（即「轮询式/延迟式 abort」的最小形态）。

- 结果：**0 pass / 1 fail**，红在 outlier 上界 `:181`，`Expected: < 1000 / Received: 3006`。**失败落在该断言上，不是超时**（3s < 5s 默认预算，用例跑完了）。
- 这证明降级后的上界**仍然保有作者原注释 "not hang" 想要的那份鉴别力**。

两个 patch 均 `git apply --reverse --check` 后反向恢复；`git status --short -- packages/ src/` 为空。**全程未用整文件 `git checkout`。**

**方向一：正确状态不被误拒（本批最重要的一半——这批本来就没红过）**

| 条件 | 结果 |
|---|---|
| 隔离单跑（改后，全文件） | **25 pass / 0 fail，1.03s** |
| 64 spinner 争用（全文件） | **25 pass / 0 fail，2.76s** |

并且**直接量了两种取帧方式的余量**（临时探针，64 spinner 争用下，跑完即撤）：

```
PROBE windows: new(abort→resolve) = 0 ms ; legacy(start→resolve, includes setTimeout(50)) = 57 ms
```

- **旧帧**：57ms / 200ms 上界 → 只剩约 **3.5x** 余量，而窗口里那 50ms 是个**真实定时器**，正是争用下最先被拉长的东西。
- **新帧**：0ms / 1000ms 上界 → 窗口在毫秒分辨率下**根本不显示**，因为里面没有任何定时器，只有同步事件派发 + 一个微任务。

**诚实边界**：本条**从未在 `run-02.log` 里红过**，上面也没有「它会红」的断言——只有「旧帧余量 3.5x、新帧余量在毫秒分辨率下不可测」这两个实测数字，以及本会话在其它文件上观测到的 4–6x 争用放大。旧写法在更重争用下是否真的会红，**未验证**。

> **注释精度更正（两轮，第二轮才对）**：
>
> 第一版写「BEFORE the abort, nothing may settle this race」——过头。
> 第二版改成「within one microtask tick」——**仍然过头，只是少了一档**。
> **实测才定下第三版**（探针 `/tmp/m3-race-probe.ts`，bun 1.3.14，本轮亲自复跑而非采信转述）：
>
> | `p` 的形态 | `Promise.race([p, Promise.resolve(S)])` 判定 |
> |---|---|
> | 构造时**已 settled** | **SETTLED** |
> | 1 个微任务后 settle | 判 PENDING |
> | 2 个微任务后 settle | 判 PENDING |
> | 3 个微任务后 settle | 判 PENDING |
> | `setTimeout(0)` 后 settle | 判 PENDING |
> | 永不 settle | 判 PENDING |
> | （sentinel 放第一个参数位）1 微任务后 settle | 判 PENDING —— 参数顺序不改变结论 |
>
> 真命题是：**「在这一行执行的那一瞬间尚未 settle」**——既不是「一个 tick 内」，也不是「永不」。它连一个 tick 都覆盖不了。三条用例的注释与本记录已全部按这一版改写。

### M3 · 三处微任务探针的命题强度（已处置）

**处置 1：措辞。** 第 5、7 条的注释与上面的 §5 更正块，全部改成「at the instant this line ran」，并把「它连一个 tick 都不覆盖」这条限制**写进注释本身**（不只是写进本文档）——因为注释才是下一个读者会看到的东西。第 6 条原注释写的是 "not immediately, and not across a real stall"，**本来就是准确的**，未改。

**处置 2：第 7 条补第二探针——补，理由是实测的假绿，不是类比。**

评审构造的假绿场景：`idleTimeoutMs > 0` 时，race 在构造后**晚一个微任务**自发 resolve 成 `STREAM_ABORTED`（与 abort 无关）。我把它做成 mutation 实跑（`/tmp/mut-m3-spontaneous-resolve-one-tick.patch`，在 `stream.ts:251` 处 `if (idleTimeoutMs > 0) racers.push(Promise.resolve().then(() => STREAM_ABORTED))`）：

| 第 7 条的形态 | 该 mutation 下 |
|---|---|
| **只有第一探针**（本轮此前的状态） | **1 pass —— 假绿确认成立** |
| **补上第二探针后**（本次） | **0 pass / 1 fail**，红在第二探针 `:733`，`Expected: Symbol(still-pending) / Received: Symbol(STREAM_ABORTED)` |

所以这个假绿是**真实可达**的，不是理论担忧，第 7 条必须补。形状照第 6 条：真实 `setTimeout(50)` stall + 第二次探针。为什么 stall 有效：睡眠会把微任务队列排空，此后**已 settled 的 `p` 确实会赢** race（上表第一行），于是自发 resolve 暴露出来。50ms 远低于该用例的 `idleTimeoutMs = 5000`，不干扰它要测的「abort 赢过空闲超时」。单侧安全——睡得更久只让「仍 pending」更成立。

**为什么第 6 条不需要再补**：它本来就有 stall-后探针，且其 `idleTimeoutMs = 0`（该 mutation 按 `idleTimeoutMs > 0` 触发，对它不适用）。评审复核也确认第 6 条成立。

改后：全文件 **25 pass / 0 fail**，typecheck、eslint 绿，`git diff -- src/ packages/` = 0。


## 6. `tests/streaming/stream-shutdown-race.it.test.ts` — `raceIteratorNext resolves STREAM_ABORTED when signal fires during stall`

**它守的不变量**：与第 5 条同一条底层性质，但**用例意图不同**——这条在 `describe("shutdown signal interrupts stalled stream (the core bug fix)")` 之下，doc 注释 `:630-638` 明写它复现的是 bug 报告里的确切场景（上游收了 2 个事件后停发但连接不断，`await iterator.next()` 永久阻塞），断言注释写的是 "not hang **until TCP timeout**"。

**依据来源**：用例 `:640-658`；因果判据 `:654` `expect(result).toBe(STREAM_ABORTED)`；**另有一条第 5 条所没有的** `:657` `expect(elapsed).toBeGreaterThanOrEqual(40) // Sanity: waited for the setTimeout`。

**逐条判定（重新判过，没有套用第 5 条）：**

- **`:656` 的 `< 200` 不是冗余**，理由与第 5 条同：轮询式 abort 实现照样返回 `STREAM_ABORTED`，`:654` 不蕴含及时性。
- **但这条用例的结构与第 5 条并不相同**：它有 `:657` 的 `>= 40` 下界。该下界是单侧的（争用只会让 elapsed 变大），**且它在守一件第 5 条无人守的事**——「实现没有在 abort 到来之前就自行 resolve」。事实上第 5 条那个把 `elapsed=0` 判绿的 Mutation B（已中止快路径误触发），在**这条**用例上会被 `>= 40` 抓住。**所以第 5 条「旧判据对 Mutation B 假绿」的结论不能搬到这里**，这也是「同文件不等于同结构」的实例。
- 于是处置不能照抄第 5 条：若只把 `setTimeout(50)` 改成显式 abort，`>= 40` 就失去意义而必须删掉——那会**丢掉**它守的那段「0→50ms 之间不得自行 resolve」的窗口，属于净减弱。第 5 条的单个微任务探针只覆盖「创建后那一个 tick」，**覆盖不了整段 50ms 窗口**。

**处置（保留原窗口 + 把间接推断换成直接观测 + 修上界取帧）**：

1. 保留一段**真实的 50ms stall**，但把「stall 期间不得 resolve」从 `elapsed >= 40` 的**间接推断**换成**直接观测**：stall 前后各放一次微任务 pending 探针。第二次探针（睡满 50ms 之后）**直接断言**了 `>= 40` 原本只能间接暗示的性质，而且是单侧安全的——睡得更久只会让「仍 pending」更成立。
2. abort 改为显式调用，上界的计时窗口起点挪到 `abort()` 前一行（窗口内不含任何定时器）。
3. 上界 `200` → `1_000`，降为 outlier 兜底，理由与第 5 条相同（须小于 5s 默认预算才可能被求值）。

**净效果同样是严格增强**：`>= 40` 覆盖的窗口被一条更强的直接断言取代，`< 200` 的取帧被修正，`:654` 的因果判据一字未动。

### 验收证据

**方向二：错误状态仍被拦住（三次 mutation，全部针对本条用例实跑，没有引用第 5 条的结果）**

| mutation | 打在哪 | 结果 | 红在哪条 |
|---|---|---|---|
| **C** 中途自行 resolve（spurious mid-stall） | `stream.ts:251` 后插入一个 20ms 后 resolve 的 racer | 0 pass / 1 fail | **第二个** pending 探针 `:655` |
| **B** 已中止快路径对活信号误触发 | `stream.ts:248` `abortSignal?.aborted` → `abortSignal` | 0 pass / 1 fail | **第一个** pending 探针 `:653` |
| **A** abort 惰性处理（3s） | `stream.ts:272` `resolve(...)` → `setTimeout(resolve(...), 3_000)` | 0 pass / 1 fail | outlier 上界，`Expected: < 1000 / Received: 3007`，落在断言上不是超时 |

C 与 B 分别打红**不同**的探针，正说明两个探针各自覆盖不同窗口、不是重复。

**「没有丢掉 `>= 40` 的覆盖」——这条是实测的，不是推断的**

把改前的用例体逐字放回并跑（临时块，跑完即撤），在 C 与 B 两个 mutation 下分别读旧三条断言的真值：

```
（B 快路径误触发）REVERSE CONTROL legacy elapsed = 0  verdict = {"result":true,"upperBound":true,"lowerBound":false}
（C 中途自行 resolve）REVERSE CONTROL legacy elapsed = 24 verdict = {"result":true,"upperBound":true,"lowerBound":false}
```

两次都是 `lowerBound: false` —— 即**旧的 `>= 40` 确实抓住了这两类退化**（而 `result` 与 `upperBound` 都被骗过）。新写法在同样两个 mutation 下分别红在第一、第二个探针。**所以覆盖是被接住了，不是被丢掉了。**

> 这也是与第 5 条的**实测差异**：同一个 Mutation B，第 5 条的旧写法**全绿**（`elapsed = 0` 通过了它仅有的上界），第 6 条的旧写法**变红**（被 `>= 40` 抓住）。两条在同一文件、看起来同型，实际鉴别力结构不同——**「同文件不等于同结构」这句话在本条上有了具体证据**，而不是一句谨慎的姿态。

三个 patch 均 `git apply --reverse --check` 后反向恢复；`git status --short -- packages/ src/` 为空。**全程未用整文件 `git checkout`。**

**方向一：正确状态不被误拒**

| 条件 | 结果 |
|---|---|
| 隔离单跑（改后，全文件） | **25 pass / 0 fail，0.87s** |
| 64 spinner 争用（全文件） | **25 pass / 0 fail，3.39s** |

**诚实边界**：本条同样**从未红过**，没有「它会红」的断言。旧上界的余量与第 5 条同源（窗口里含那个 50ms 定时器，实测 57ms/200ms ≈ 3.5x）；新上界的窗口内无定时器。旧写法在更重争用下是否真会红，**未验证**。

## 7. `tests/streaming/stream-shutdown-race.it.test.ts` — `raceIteratorNext: abort signal wins over idle timeout when it fires first`

**它守的不变量**：当 abort 信号与空闲超时**同时在场**且 abort 先到时，abort 必须**赢**——返回 `STREAM_ABORTED`，而不是等到空闲超时并 reject。这是三条里唯一**开着** `idleTimeoutMs`（5000）的一条。

**依据来源**：用例 `:710-727`；因果判据 `:724` `expect(result).toBe(STREAM_ABORTED)`；上界 `:726` `expect(elapsed).toBeLessThan(200)`；**没有**第 6 条那样的下界。

**逐条判定（第三次重新判型，仍未套用前两条）：**

先说与前两条都不同的结构：这里有一条**竞争的 racer**——空闲超时腿会 **reject**（`StreamIdleTimeoutError`）。因此 `result === STREAM_ABORTED` 已经蕴含「空闲超时没赢」（它若赢，`await` 会抛而不是返回 sentinel）。所以本条的因果判据比前两条**更强**。

但**上界仍然不是冗余**，而且这次是**实测**的，不是推的。在**未经修改**的当前用例上跑两个候选 mutation：

| mutation | 当前用例的结果 | 说明 |
|---|---|---|
| **A** abort 惰性处理 3s（`stream.ts:272`） | **0 pass / 1 fail**，红在 `:726`，`Expected: < 200 / Received: 3039` | 3s 仍早于 5000ms 空闲超时，故 `result` 照样是 `STREAM_ABORTED`、`:724` 全绿；**只有上界抓住它**。上界确实在干实事。 |
| **B** 已中止快路径对活信号误触发（`stream.ts:248`） | **1 pass / 0 fail —— 全绿** | 当前用例对这类退化**是盲的**（`elapsed=0` 通过上界、`result` 通过因果判据）。 |

所以本条的结构判定是：**与第 6 条不同**（没有下界、因此没有「不得提前 resolve」的覆盖，B 盲），**与第 5 条同侧**（B 盲），但**因果判据比第 5 条强**（多蕴含了「空闲超时没赢」）。三条各不相同，逐条实测才看得出来。

**处置**：

1. 补上当前缺失的那一类覆盖：加一次微任务 pending 探针（直接把 B 这类「未 abort 却自行 resolve」纳入）。**不加**第 6 条那样的 stall-后第二探针——第 6 条加它是为了接住 `>= 40` 原有的窗口覆盖，本条没有下界、没有对应窗口要接，为此多睡 50ms 属于无据加码。
2. abort 改显式调用，上界取帧起点移到 `abort()` 前一行（窗口内不含定时器）。
3. 上界 `200` → `1_000`。**注意本条这个数值有额外约束**：必须**明显小于 `idleTimeoutMs` 的 5000**，否则「abort 赢过空闲超时」这件事就退化成由空闲超时自己兜底了。1000 同时满足「远小于 5000」「远大于无定时器窗口」「小于 5s 默认预算」。

`:724` 的因果判据一字未动。

### 验收证据

**方向二：错误状态仍被拦住（三次 mutation，全部针对本条实跑）**

| mutation | 结果 | 红在哪条 |
|---|---|---|
| **B** 已中止快路径误触发 | 0 pass / 1 fail | 新增的 pending 探针 `:722`（**改前对它全绿**——见上表） |
| **A** abort 惰性处理 3s | 0 pass / 1 fail | outlier 上界 `:735`，`Expected: < 1000 / Received: 3013` |
| **D** abort 腿在 `idleTimeoutMs > 0` 时根本不注册（`stream.ts:268` 加 `&& idleTimeoutMs <= 0`） | 0 pass / 1 fail | 抛 `StreamIdleTimeoutError: Stream idle timeout: no event received within 5s` —— 即 `:724` 拿不到 sentinel |

D 是**本条独有**的：它针对「abort 必须赢过空闲超时」这条只有本条才测的性质，证明 `:724` 的因果判据确实承载它。
**D 的口径限制（必须写明）**：D 要跑满 5s 空闲超时才会现形，超过 5s 默认 per-test 预算，因此这一次探测用 `bun test --timeout 20000` 跑；**提交进仓库的用例仍是默认预算**。也就是说 D 在默认预算下会表现为超时而非该断言失败——它证明的是「`:724` 能分辨 sentinel 与 rejection」，不是「默认预算下会红在 `:724`」。

三个 patch 均 `git apply --reverse --check` 后反向恢复；`git status --short -- packages/ src/` 为空。**全程未用整文件 `git checkout`。**

> **残留复核（会话在本条 mutation 环节被服务端错误掐断后补做）**：
> ```
> git --no-optional-locks status --short
>  M docs/tmp/2026-08-08-load-sensitive-test-dispositions.md
>  M tests/streaming/stream-shutdown-race.it.test.ts
> git --no-optional-locks diff -- src/ packages/ native/ scripts/     → 空（--stat 行数 0）
> ```
> 工作树上**只有**本任务的文档与测试文件；`src/`、`packages/`、`native/`、`scripts/` 一个字节都没变，确认第 7 条的三个 mutation（B/A/D）在中断前**已全部正确反向**，没有「已注入未反向」的残留。恢复一律走冻结 patch 的 `--reverse`，**从未**使用整文件 `git checkout`/`git restore`。
>
> **附带记一次自己的编辑事故**：插入上面这段残留复核时，`Edit` 的 `old_string` 圈进了「方向一」那张表却没在 `new_string` 里写回去，**静默删掉了它**（`replacement-must-cover-what-it-restates` 的「旧串多、新串少」方向）。是通读时发现并补回的——`Edit` 只校验 `old_string` 唯一命中，不会因为你漏写了要保留的内容而报错。

**方向一：正确状态不被误拒**

| 条件 | 结果 |
|---|---|
| 隔离单跑（改后，全文件） | **25 pass / 0 fail，0.99s** |
| 64 spinner 争用（全文件，loadavg 25→30） | **25 pass / 0 fail，4.59s** |

**诚实边界**：本条同样**从未红过**，没有「它会红」的断言。改前上界的窗口含 `setTimeout(30)`，与第 5、6 条同源；新窗口内无定时器。旧写法在更重争用下是否真会红，**未验证**。

**三条同文件用例的结构对照（全部实测，可复核）**

| | 第 5 条 `during blocked next()` | 第 6 条 `during stall` | 第 7 条 `wins over idle timeout` |
|---|---|---|---|
| 改前伴随断言 | 无 | `elapsed >= 40` | 无 |
| `idleTimeoutMs` | 0 | 0 | **5000（开着）** |
| 改前对 Mutation B | **全绿（盲）** | **变红**（`lowerBound:false`） | **全绿（盲）** |
| 改前对 Mutation A | 变红 | 变红 | 变红（`Received: 3039`） |
| 因果判据强度 | 只证「返回了 sentinel」 | 同左 | **额外蕴含「空闲超时没赢」**（该腿 reject） |
| 处置 | 探针 ×1 + 修帧上界 | 探针 ×2 夹住真实 stall + 修帧上界 | 探针 ×1 + 修帧上界（上界须 ≪ 5000） |

**三条各不相同，而且差异只有逐条实跑才看得出来**——第 6 条有下界所以不盲，第 7 条因果判据更强但仍盲。这张表是「同文件不等于同结构」的完整证据。

> **给未来想「统一这三条」的人**：上表每一格都是实跑得出的，复现方式在各条的验收证据节（mutation 冻结件路径 + 红在哪一行 + 具体数值）。**判据是「改前对 Mutation B 的反应」**：第 6 条红、第 5/7 条绿——这不是风格差异，是鉴别力结构差异。想把三条合并成一个 helper 之前，先让候选 helper 在 B/A/C/D 四个 mutation 下重跑一遍，**四条红线要一条不少**，否则合并就是净减弱。

## 8. `tests/observability/bus.unit.test.ts` — `publishAndFlush respects deadlineMs`

**它守的不变量**：`publishAndFlush(event, { deadlineMs })` 在异步 handler 迟迟不结束时，必须**按给定的 deadline 放弃等待并返回**，而不是一直等 handler。

**依据来源**：用例 `:181-197`；handler 睡 500ms（`:185`，注释 "intentionally past the deadline"）；`deadlineMs: 50`（`:191`）；`:194` `expect(elapsed).toBeLessThan(200) // deadline fired well before handler finished`；`:195` `expect(done).toBe(0) // handler still in-flight`。

**逐条判定（第四次重新判型）：**

这条的结构与前三条**都不同**，而且协调方的怀疑是对的——**上界确实承载着实质性质，不是纯兜底**：

- `done === 0` 只蕴含「返回发生在 handler 的 500ms 之前」。它**不蕴含**「按 50ms 的 deadline 返回」。
- 于是存在一个两条断言**都抓不到**的退化：deadline 被实现成别的值（比如硬编码 300ms）→ `elapsed=300` 时 `< 200` 才红；而若实现成 **完全不等待、立刻返回**（deadline 被忽略成 0）→ `elapsed≈0`、`done===0`，**两条断言全绿，是盲的**。后者与第 5、7 条的「无下界 → 对『过早 resolve』盲」是同一形态。
- 还有一条**硬结构约束**：任何 ≥ 500 的上界都比 `done === 0` 更弱（`done===0` 已经隐含 <500），因此**不能靠单纯放大数值来消除敏感性**——放大到无害就等于删掉它。这条与前三条根本不同，前三条可以把上界放到 1000 而仍有意义。

**关键发现：这条有一个完全时间无关的因果 oracle，只是原用例没用它。**

读实现 `src/lib/observability/bus.ts:168-195`：deadline 触发时会把一条 failure 推进结果里——

```ts
failures.push({ subscriber: "publishAndFlush", phase: "async-handler", eventKind: event.kind,
  error: new Error(`Observability flush deadline exceeded after ${deadlineMs}ms`) })
```

而 `publishAndFlush` **返回** `FlushResult`（`:59-62`，含 `failures?`）。也就是说「deadline 真的触发了、而且用的正是我们请求的那个值」**可以直接断言，不必读时钟**——错误消息里嵌着 `deadlineMs` 本身。原用例把返回值丢掉了（`await systemPub.publishAndFlush(...)` 未接收），所以只能退而用 elapsed 去推断。

**处置（换成因果 oracle + 消除 fixture 里的时间竞速）**：

1. **接住返回值并断言那条 deadline failure 的完整形状**（subscriber / phase / eventKind / 精确 message 含 `50ms`）。这一条同时覆盖了上界原本承载的两件事：deadline 触发了、且用的是请求值。**完全不读时钟。**
2. **把 handler 从「睡 500ms」改成「等一个手动闸门」**。原注释的意图是 "intentionally past the deadline"，闸门是这个意图的极限形态（永远不结束），因此**意图不变而更强**：
   - `done === 0` 从「跑赢一个 500ms 定时器」变成**无条件成立**（闸门不开就永远不会 ++），不再是时间竞速；
   - 顺带解除了上面那条「上界必须 < 500」的硬约束——handler 不再自行结束，任何上界都仍有信息量；
   - 收尾的 `await bus.flush()` 从「干等 500ms」变成开闸即返回，用例更快。
   - 「实现改成死等 handler」这一退化，在闸门下表现为**永不返回 → 撞 per-test 预算**（由预算守，不是由断言守，如实写明）。
3. 上界保留为**纯 outlier 兜底**，取 `2_000`——因为第 2 步解除了 <500 的约束，这个值既宽松到对争用免疫，又仍然有信息量。

`:195` 的 `done === 0` 一字未动（语义反而变强）。

### 验收证据

**方向二：错误状态仍被拦住（两次 mutation，均针对本条实跑）**

**Mutation E —— deadline 被完全忽略、立刻返回**（冻结件 `/tmp/mut-item8-deadline-ignored.patch`：`bus.ts:173` `if (pending.length > 0)` → `if (false as boolean)`）：

- 新写法：**0 pass / 1 fail**，红在 `:207` `expect(result.failures).toHaveLength(1)`（`Received value does not have a length property: undefined`）。
- **旧写法对它完全是盲的**——把改前的用例体逐字并跑（临时块，跑完即撤）：
  ```
  REVERSE CONTROL legacy elapsed = 0 verdict = {"upperBound":true,"doneIsZero":true}
  ```
  两条旧断言**全绿**。这正是协调方让我先判「`done === 0` 是否已蕴含上界」时暴露出来的第三种可能：**两条都不蕴含它，而且两条一起也漏掉了「根本没等」这一类**。

**Mutation F —— deadline 腿的实际时长是请求值的 6 倍**（冻结件 `/tmp/mut-item8-wrong-deadline-duration.patch`：`bus.ts:177` `setTimeout(..., deadlineMs)` → `setTimeout(..., deadlineMs * 6)`）：

- 这一条**改变了我的处置**，值得完整记下来。我最初把上界放宽到 `2_000`（照前三条的思路），实跑 F：**1 pass / 0 fail —— 放宽后抓不到了**。
- 原因：新增的因果 oracle 断言的是 failure 里那条 message，而**message 里嵌的是「请求值」而非「实际等待时长」**——一个「等待时长与自报值不一致」的实现照样满足它。所以因果 oracle **并不覆盖**上界原本承载的全部内容。
- 把上界改回 `DEADLINE_MS * 4`（= 200，与改前**数值相同**）后重跑 F：**0 pass / 1 fail**，红在 `:224`，`Expected: < 200 / Received: 303`。**覆盖保住了。**

两个 patch 均 `git apply --reverse --check` 后反向恢复；`git --no-optional-locks diff --stat -- src/ packages/ native/ scripts/` 行数为 **0**。**全程未用整文件 `git checkout`。**

**方向一：正确状态不被误拒**

| 条件 | 结果 |
|---|---|
| 隔离单跑（改前，全文件） | 11 pass / 0 fail，1.19s |
| 隔离单跑（改后，全文件） | **11 pass / 0 fail，0.60s**（闸门取代 500ms 睡眠，收尾不再干等） |
| 64 spinner 争用 | **11 pass / 0 fail，2.63s** |
| 96 spinner 争用（loadavg 20→28） | **11 pass / 0 fail，3.52s** |

**必须写明的诚实结论：本条的上界数值一点没放宽（仍是 200），因此这一行的负载敏感度没有改善。**

本条真正被消除的是**另一处**敏感性：`done === 0` 原本是在跟一个 500ms 定时器竞速（返回必须早于它），闸门化之后它**无条件成立**，不再是时间竞速。而上界那一行之所以不能放宽，是上面 Mutation F 实测出来的硬约束，不是我保守。

**这构成一个待裁决项（不由我自决）**：放宽该上界会交换掉「deadline 实际时长与自报值不一致」这一类覆盖，属于放宽既有 guard，按 user-rule `63-engineering-practice` 的 `red-tests-may-be-guarding-something` 须交独立裁决。已登记进「未处置」清单。若要既保覆盖又降敏感，可行方向（**均未实施、未验证**）：让 `publishAndFlush` 把**实际**等待时长也放进 failure（那样 oracle 就能覆盖时长而无需读时钟），或注入可控时钟 seam。前者要改生产代码契约，超出本轮范围。

**诚实边界**：本条同样**从未在 `run-02.log` 里红过**。上面没有「它会红」的断言；96 spinner 下四次运行全绿是目前仅有的正面数据，旧写法在更重争用下是否会红，**未验证**。









- 没有退役（删除/skip）任何一条用例——四条全部保留，用户裁决按目标而非字面执行。
- 没有放宽任何断言的**阈值或内容**：`10x` 比值、逐字节 wire、`detail` 序列、`exitCode`、stderr 正则，全部逐字未改。改的只有 per-test / 文件级**预算**，以及第 1 条那条被证明冗余且错帧的 wall-clock 上界。
- 没有碰上述 4 个测试文件与本文档之外的任何文件（第 3 条的注释更正另见下节，是协调方明确追加授权的）。
- 没有跑 T0.0f 的 15 连跑；faithful 的分片复现留给该门本身。
- 没有 push。四个 commit 都在本地隔离 worktree 分支 `worktree-agent-a915058689631f211` 上。







