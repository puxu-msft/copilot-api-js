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

**它守的不变量**：`createUpstreamWsConnection` 的生命周期回调（`onClose`）抛出时，`guardCallback` 必须**吸收**它（warn + 标记不可用 + fail request），**不得**升级成 `uncaughtException` 从而被 main.ts 的崩溃策略变成 `process.exit(1)`。

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





