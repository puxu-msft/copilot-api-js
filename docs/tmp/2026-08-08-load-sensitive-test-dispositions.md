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

