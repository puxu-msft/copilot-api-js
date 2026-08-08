# 首信号无损排空评审处置

> 状态：三路复评均已 PASS。**整改尚未合回 master，仍待合并**——本分支 `worktree-fix-shutdown-review-findings` 已把 `master@d47492a6` 合入自身（`85642352`），但反方向没做；判定命令 `git branch -a --contains 954a1bff` 只输出本分支即为未合并，`git show master:src/lib/shutdown.ts | grep -n getActive` 仍为单 registry 亦可佐证。首轮评审范围为 `14974488..4c555ef9`（该段已随 peer 的 `0732fc76` 进入 master）；合并态 admission capture finding 在 `954a1bff` 修复。本文件记录评审发现、裁定级别、处置与复评结果；最终事实以当前代码、冻结规格 `docs/spec/2026-08-07-lossless-graceful-shutdown-drain.md` 和本文件列出的实测为准。

## 首轮发现

| ID | 原严重级别 | 级别 | 处置 | 证据／理由 |
|---|---|---|---|---|
| F1 | BLOCKER | C | 采纳，已修 | `tests/infra/entry-test-discovery-baseline.json` 已按 `scripts/capture-entry-evidence.ts` 的 `unit/it/http` Glob 口径重冻结，纳入新增 shutdown 测试并移除两个退役测试。 |
| F2 | BLOCKER | C | 采纳，已修 | `contrib/systemd/copilot-api-deploy.sh` 在 SIGUSR2 后轮询旧槽自行退出，不再发送会成为第二终止信号的 `systemctl stop`；超时／failed 时保留双槽并退出失败。 |
| F3 | MAJOR | C | 采纳，已修 | PM2 两槽均配置 `stop_exit_codes: [0]`，对应动态配置测试防止 clean handoff exit 被 autorestart。 |
| F4 | MAJOR | C | 采纳，已修 | 删除旧 Vue 的 shutdown 类型、normalizer、控件与中文 README 条目；legacy runtime 输入不会被编辑器重新序列化。 |
| F5 | MAJOR | C | 采纳，已修 | 新增真实 `/v1/messages` 长流、已建 context 的 401 token-refresh retry、pre-content recovery shutdown 交叉测试；History 均为 completed，资源只在 terminal publish 后关闭。 |
| F6 | MAJOR | B | 采纳，已修，待未卷入第三方复评 | `process-lifecycle-shutdown` skill 只声称已有直接证据的范围，明确新 upstream WS 尚未由 shutdown 交叉测试证明；测试列表与两个 registry 边界已同步。 |
| F7 | MAJOR | C | 采纳，已修 | count_tokens／embeddings 进入 lightweight in-flight registry，terminal publish 后注销；production drain oracle 取 generation 与 lightweight 两 registry 并集。 |
| F8 | MAJOR | C | 部分采纳后闭合，待原 reviewer 复评 | 已补 token refresh、真实 generation、pre-content recovery 与 durability 顺序；新 h2 acquisition 原测试已满足冻结规格 §6.1 的“WS 或 HTTP/2 connection”。未新增 upstream WS 专测，因为该项不是在已满足“或”契约之外追加第二个强制验收；skill 仍诚实列为未直接覆盖，未扩大证据。 |

## 判据正控

两份冻结 patch 已随本目录归档，未来评审者可直接复跑：[2026-08-08-lossless-shutdown-mutation-drop-generation.patch](2026-08-08-lossless-shutdown-mutation-drop-generation.patch)、[2026-08-08-lossless-shutdown-mutation-drop-lightweight.patch](2026-08-08-lossless-shutdown-mutation-drop-lightweight.patch)。复跑方式：`git apply <patch>` 注入变异 → 跑对应测试确认变红 → `git apply --reverse --check <patch>` → `git apply --reverse <patch>` 复绿。

- generation tracker mutation：冻结 exact patch，将 production `getActive()` 改为仅 lightweight registry。`shutdown-messages-lossless.http` 三类 generation 用例在一个事件循环 tick 内观察到 `stopped` 而非 `draining`，确定性变红；反向 apply 后复绿。
- lightweight tracker mutation：冻结 exact patch，将 production `getActive()` 改为仅 `RequestContextManager.getTrackedOperations()`。count_tokens 与 embeddings 用例均观察到 token／History／Telemetry／Diagnostic 在请求 terminal 前提前关闭，确定性变红；反向 apply 后复绿。
- mutation 恢复后，源码再次机械确认 production tracker 同时包含两个 registry，目标测试复绿，`git diff --check` 通过。

## 既有测试 guard 处置记录

### `tests/pipeline/driver.unit.test.ts` 的全局零 timer 断言

- **守护的不变量：** 四个 408 负样本不得被 production Responses strategy stack 重试；只有同时匹配 `error.code=user_request_timeout` 与 `error.message` 前缀的结构化 GHC request-body timeout 才能进入 network retry。
- **依据：** `packages/foundation/src/error/classify.ts` 的 `isRequestBodyReadTimeout()` 双条件，及同文件正负分类测试；driver 级 oracle 应观察分类、dispatch 次数、`recordAttemptFailure` 与原错误传播。
- **现象：** 单文件 55/55 通过；在 `anthropic-models.http` 的 `useIsolatedRuntime()` 之后，同一负样本仍满足 `classifyError(error).type === "bad_request"`、`attempts === 1`、`recordAttemptFailure === []`，但 `FakeClock.liveTimerDelaysMs` 捕获 fixture 异步注册的无关 1000ms 全局 timer，产生 false-red。
- **处置（C，暂定，须由独立 reviewer 裁决）：** 删除“全进程不存在任何 timer”这一非归属 oracle，保留并加强为四项直接 oracle：HTTPError constructor identity、`classifyError` 结果、attempt 数、retry record 与原错误 rejection。该变化不允许目标机制错误通过，只移除对其它模块 timer 的耦合。

## 结构怪味扫描

| file:line | 怪味类型 | 处置 |
|---|---|---|
| `src/lib/shutdown.ts:294` | 职责错位 + 开放集合手工枚举：shutdown 协调器知道所有 operation producer，容易在第三类旁路出现时再次漏接。 | 本轮以两个 registry union + 真实 HTTP + 双 omission mutation 修正确性；统一 accepted-operation registry 属跨 manager/bootstrap 的独立重构，已记 `docs/todo/deferred-backlog.md`，触发条件为新增第三类旁路或再次修改 `ShutdownActiveOperation`。 |
| `tests/pipeline/driver.unit.test.ts:471-506` | 抽象泄漏：用全局 timer 集合替代 driver retry 决策 oracle，导致 fixture timer 制造 false-red。 | 本轮修：改为 constructor identity + classification + attempt 数 + retry record + 原错误传播五项直接 oracle。 |
| `tests/token/copilot-token-manager-dispose.it.test.ts:43` | 测试职责遗漏：真实 manager 初始化写 token store，却只恢复 fetch，跨文件污染后继。 | 本轮修：加入 `autoRestoreState()`，复现污染对由红转绿，完整 backend 复绿。 |
| `src/lib/context/lightweight-model-operation.ts:30,194,366` | 状态源分裂风险：terminal registry 与 in-flight registry 同模块但职责不同，若 terminal finalize 多次并发会重复提交／提前注销。 | 本轮修：单一 `terminalPromise` 串行 terminal publish，注销只在该 promise 的 `finally`；unit + HTTP + omission mutation 覆盖。 |

## 每轮方案反思

1. **更好的内部替代方案：** 长期更优的是统一 accepted-operation registry，而不是在 shutdown 再追加 producer spread；它能让第三类旁路无需修改 shutdown。但当前只有两类 producer，且统一会重塑 manager 所有权与 test bootstrap，故按“不静默丢弃”记入 backlog，不在 review 整改中夹带架构重写。
2. **判据判别力：** 当前 generation 与 lightweight omission mutation 分别证明两类 registry 缺失会红；真实长流、token refresh、recovery 与 bypass HTTP 测试覆盖客户端／History／资源顺序。未做 process-global abort、529 与 upstream WS early-teardown exact mutation，因此 skill 明确不声称这些已被同一门完整覆盖。
3. **成熟第三方方案：** 进程内 accepted-operation ownership 没有可直接替代项目 registry 的成熟库；systemd 与 PM2 已分别复用其原生 lifecycle/restart 能力，不自研 supervisor。引入通用 graceful-shutdown 库反而无法表达 canonical terminal／History durability 边界。
4. **未采纳方案：** 不把并发 `worktree-nghttp2-header-deadline` 的 140 文件 lint／header-deadline 提交链 cherry-pick 进本任务；它包含独立功能并正在另一 worktree 完成。当时 master 的 `lint:all` 红如实保留，所有本轮改动 TypeScript 走定向 ESLint，全 backend／fast／typecheck／架构／PTY／旧 Vue 门均独立通过。**收尾复测（2026-08-08）：** 该 peer 分支的改动已自行进入 master（`0732fc76` 把 shutdown 基线 `44457047` 与 peer lint 提交 `bae83f01` 一并合入 master，另有 `a0ad0f1a`），把 `master@d47492a6` 合入本分支后 `bun run lint:all` 通过——不 cherry-pick 的判断成立，阻塞由其自身合并消解。

## 复评状态

- 测试／文档 reviewer：固定 `901ef7d6` 逐条复核 F1～F6，判定全部 FIXED，0 blocker／0 major，PASS。
- 未卷入 instruction reviewer：固定 `901ef7d6` 逐条核验 C1～C7，判定 skill、证据边界、driver guard 与 F8 裁定一致，0 blocker／0 major，PASS。
- 代码 reviewer：固定 `901ef7d6` 复核原两条 MAJOR，确认 registry union、真实 HTTP／h2／token refresh／recovery 与 admission shutdown 顺序已修；另发现 lightweight terminal 在 `responseEnvelope` 等 pre-terminal capture 抛错时未释放 History reservation，形成 1 条新 MAJOR。
- 新 MAJOR 修复：`954a1bff` 把 `failBeforeTerminal()` 的 catch 扩到从 response capture 到 terminal publication 的整个区间；新增真实 reservation + `Response.clone().text()` 故障注入，红样本为 `reserved=1/preTerminalFailures=0`，修后为 `reserved=0/preTerminalFailures=1` 且 `waitForQuiescence()` 完成。
- 代码 reviewer 最终复评：固定 `954a1bff` 判定该 catch 已覆盖 `responseEnvelope`／`registerPayload`／`recordEgress`／`commitTerminal`／`publishTerminal` 全区间、`finally` 始终注销 in-flight，测试真实注入且断言完整；0 blocker／0 major，PASS，可合并。

## 既有测试 guard 第二处处置：entry evidence validator 的默认 5 秒超时

- **守护的不变量：** validator 的 provenance／dependency-integrity fail-closed——任一 runtime 依赖被改被删、SAX 包图或 manifest 不符时必须 rc=7 且不发布 receipt。
- **依据：** 该文件 43 个用例几乎每条都 fork 真实 validator 跑真实 git fixture，单文件独跑 45.395 秒、最慢用例 4.562 秒。Bun 默认 5 秒是 wall-clock 预算，不属于该文件任何判据。
- **现象：** 16-shard 下每轮会有 1～2 条随机越过 5 秒被判超时，而单文件 43/43 全绿——典型 false-red，且逐条加 timeout 是打地鼠。有原始输出的两次分别是 7369.01ms 与 7355.61ms，**落在不同用例上**，原始输出归档在 [2026-08-08-validate-entry-evidence-shard-timeouts.md](2026-08-08-validate-entry-evidence-shard-timeouts.md)；会话中还观察到第三次同类超时，但其运行输出未落盘，具体数字**未交叉验证**、不作为证据引用。逐用例耗时原始数据在 [2026-08-08-validate-entry-evidence-timings.xml](2026-08-08-validate-entry-evidence-timings.xml)。
- **处置（C）：** 用 `setDefaultTimeout(30_000)` 给该文件设机制对齐的预算，断言一行未改。修后 backend 16 shards、6641 tests 全绿。

