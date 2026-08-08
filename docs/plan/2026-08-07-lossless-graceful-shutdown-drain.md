# 首信号无损排空实施计划

> **状态：已执行完毕（2026-08-08）。** 四个任务与评审整改全部落地，三路独立评审 0 blocker／0 major。终态记录见本文末「实施结果」与 [docs/tmp/2026-08-08-lossless-shutdown-review.md](../tmp/2026-08-08-lossless-shutdown-review.md)。下方任务描述保留原始执行指令形态，仅作历史留档，**不要再按它派活**。
>
> **执行者要求（历史）：** 按任务顺序执行；每个任务使用 TDD，先红后绿；每个任务独立提交。实现时使用 `superpowers:test-driven-development`，收尾前使用 `superpowers:verification-before-completion`。

**目标：** 首个终止信号只封闭 ingress 并等待所有已接纳 operation 自行终态，不再由 shutdown deadline 或资源拆除制造请求失败；第二信号继续立即强退。

**架构：** `RequestContextManager.getTrackedOperations()` 与 lightweight operation in-flight registry 共同构成 shutdown drain oracle，drain 使用无 deadline 的 condition wait。首信号只停止 listener 和后台维护 producer；rate limiter、token runtime、上游 transport、History、Telemetry、Diagnostic 与观察者资源全部保留到 generation 和 lightweight 两个 registry 均清零。旧 process-global shutdown abort、529 改写、`aborting`／`forcing` 阶段和两个 shutdown 时间旋钮随契约一起删除。

**技术栈：** TypeScript、Bun、Hono、Zod、Bun test、现有 observability bus 与 RequestContextManager operation registry。

## 全局约束

- 首个 `SIGINT`、`SIGTERM`、`SIGUSR2` 不得主动中止已接纳 operation。
- “已接纳”以 `RequestContextManager.getTrackedOperations()` 与 lightweight operation in-flight registry 的并集为机械边界。
- 请求级 `request_deadline`、stream idle、response header timeout、客户端取消和正常协议错误保持原语义。
- 第二信号在任何非 `stopped` 状态立即退出；SIGINT=130，SIGTERM=143。
- `waitForShutdown()` 只在 durability barrier 全部成功并进入 `stopped` 后 resolve。
- 不停止、不重启、不修改用户的 4141 主服务器。
- 不引入新的第三方依赖。

---

### Task 1：把 shutdown 核心改成无损 drain

**文件：**
- 修改：`src/lib/shutdown.ts`
- 修改：`tests/shutdown/shutdown.unit.test.ts`
- 修改：`tests/shutdown/shutdown-h2-pool-drain.it.test.ts`
- 修改：`tests/shutdown/rate-limiter-shutdown.unit.test.ts`

**接口：**
- 改签名：`drainActiveRequests(timeoutMs, tracker, opts)` → `drainActiveRequests(tracker, opts)`；保留轮询职责，移除 shutdown deadline，完成时 resolve `void`。
- 保留：`gracefulShutdown(signal, deps)`、`handleShutdownSignal()`、`waitForShutdown()` 公共入口。
- 调整：`ShutdownDeps` 的 token seam 改为可 await 的资源关闭函数，并增加必要的 transport close seam，使测试可断言顺序而不触碰真实全局池。

- [x] **Step 1：写首信号无损 drain 红测试**

在 `tests/shutdown/shutdown.unit.test.ts` 增加以下行为测试：

```ts
test("first signal waits past the legacy graceful boundary without aborting or closing request dependencies", async () => {
  const tracker = createMockTracker([{ status: "streaming" }])
  const order: Array<string> = []
  const shutdown = gracefulShutdown("SIGTERM", createNoopDeps({
    tracker,
    closeTokenRuntimeFn: async () => void order.push("token"),
    closeUpstreamTransportsFn: () => void order.push("transport"),
  }))

  await Bun.sleep(150)
  expect(order).toEqual([])
  expect(getShutdownPhase()).toBe("draining")

  tracker._clearRequests()
  await shutdown
  expect(order).toEqual(["token", "transport"])
})
```

同时新增：

- `server.close(false)` 在首信号调用，`server.close(true)` 永不由首信号调用；
- rate limiter 队列在 operation drain 前不调用 `rejectQueued()`；
- token、upstream WS／h2 close seam 在 drain 前不调用，drain 后按顺序调用；
- `request_deadline` 已存在的独立测试保持绿色。

- [x] **Step 2：运行红测试**

运行：

```bash
bun test tests/shutdown/shutdown.unit.test.ts tests/shutdown/shutdown-h2-pool-drain.it.test.ts tests/shutdown/rate-limiter-shutdown.unit.test.ts
```

预期：新测试因旧实现 100ms 后进入 Step 3、触发 abort／resource close 或 force close 而失败；既有测试仍说明旧契约当前可达。

- [x] **Step 3：实现无 deadline drain**

在 `src/lib/shutdown.ts`：

1. 将 drain loop 改为条件等待：只要 `tracker.getActive().length > 0` 就按 `DRAIN_POLL_INTERVAL_MS` 轮询并定期打印进度；不计算 deadline，不接受 shutdown abort signal。
2. Step 1 仅执行：同步 lifecycle 认领、`stopReaper()`、History／Telemetry 后台维护停止、`notifyStopping()`、handoff 专属 freeze、`server.close(false)`。
3. 从 Step 1 删除 token runtime `dispose()`、upstream WS `stopNew()` 和 rate limiter `rejectQueued()`。
4. 删除自动 Step 3 和 Step 4。operation registry 清零后直接进入 `finalize()`。
5. `finalize()` 先 join model-operation finalizer failure registry，再 await token runtime dispose，再关闭 upstream WS／h2，随后依次关闭 History、Telemetry、Diagnostic、发布 finalized、关闭 observer WS。
6. 不再调用 `server.close(true)`；listener close promise继续 best-effort，不阻塞 operation drain。

核心形状：

```ts
setPhaseFireAndForget("draining")
await drainActiveRequests(tracker, drainOpts)
await finalize({
  closeTokenRuntime,
  closeUpstreamTransports,
  drainModelOperationFinalizations,
  closeHistory,
  closeTelemetry,
  closeDiagnostics,
  publishStopped,
  closeWsClients,
  getWsClientCount,
})
```

- [x] **Step 4：运行定向测试并修正旧断言**

删除或重写只守护旧自动 abort／force-close 契约的测试；保留两信号、persistence failure、completion latch 和 observer notification 测试。运行 Task 1 的三个测试文件，预期全部通过。

- [x] **Step 5：提交**

```bash
git add -- src/lib/shutdown.ts tests/shutdown/shutdown.unit.test.ts tests/shutdown/shutdown-h2-pool-drain.it.test.ts tests/shutdown/rate-limiter-shutdown.unit.test.ts
git commit -m "fix: drain accepted requests losslessly on shutdown"
```

---

### Task 2：删除 process-global shutdown abort 与 529 改写

**文件：**
- 修改：`packages/foundation/src/stream.ts`
- 修改：`src/lib/anthropic/client.ts`
- 修改：`src/lib/anthropic/stream.ts`
- 修改：`src/lib/error/forward.ts`
- 修改：`src/lib/openai/embeddings.ts`
- 修改：`src/lib/openai/upstream-ws-attempt.ts`
- 修改：`src/lib/transport/http-transport.ts`
- 修改：`src/lib/transport/responses-transport.ts`
- 修改：`src/lib/transport/send.ts`
- 修改：`src/routes/messages/post-commit-error.ts`
- 修改或删除：`tests/shutdown/shutdown-abort-flow.unit.test.ts`
- 修改或删除：`tests/shutdown/shutdown-mid-stream.http.test.ts`
- 修改：`tests/streaming/stream-shutdown-race.it.test.ts`
- 修改：`tests/streaming/stream-guard.unit.test.ts`
- 修改：`tests/streaming/stream-settle.unit.test.ts`
- 修改：`tests/anthropic/error-shaping.unit.test.ts`
- 修改：`tests/anthropic/anthropic-client.it.test.ts`
- 修改：`tests/transport/http-transport.it.test.ts`
- 修改：`tests/tui/terminal-restore.unit.test.ts`

**接口：**
- 删除：`getShutdownSignal()`、`isShutdownCausedAbort()`、`SHUTDOWN_ABORT_MESSAGE`、`StreamShutdownError`、`StreamErrorKind` 的 `shutdown` 分支、`PostCommitAbortKind` 的 `shutdown` 分支、`rewriteShutdownAbort`。
- 保留：`guardSseIterable` 对 client、request lifecycle、dispatch 和 idle timeout 的取消处理。

- [x] **Step 1：先改测试声明新契约**

新增／改写测试以证明：

- `guardSseIterable` 不再接受或监听 `shutdownSignal`；client、reaper、request deadline、dispatch cancellation 仍各自保持原分类；
- `sendUpstreamHttp` 只组合 header timeout、client、request lifecycle、dispatch signals；不存在 shutdown 529 分支；
- post-commit classifier 不再返回 `shutdown`；
- 首信号后 mid-stream 请求继续等待 source 正常完成，而非得到 synthetic error frame。

删除纯粹验证旧 Phase 3 abort 能穿透每条 handler 的测试，因为该行为已被规格禁止。

- [x] **Step 2：运行测试确认编译或断言为红**

运行：

```bash
bun test tests/streaming/stream-guard.unit.test.ts tests/streaming/stream-shutdown-race.it.test.ts tests/streaming/stream-settle.unit.test.ts tests/anthropic/error-shaping.unit.test.ts tests/anthropic/anthropic-client.it.test.ts tests/transport/http-transport.it.test.ts tests/shutdown/shutdown-mid-stream.http.test.ts tests/shutdown/shutdown-abort-flow.unit.test.ts
```

预期：旧 API／旧 shutdown error 分类仍存在，导致类型或断言失败。

- [x] **Step 3：删除生产接线**

逐文件完成：

1. `shutdown.ts` 删除 eager abort controller、reason identity 和测试 reset。
2. `packages/foundation/src/stream.ts` 删除 `StreamShutdownError`、`StreamErrorKind.shutdown`、message table shutdown 行和 `guardSseIterable.shutdownSignal`；保留其他 signal 的显式 listener cleanup。
3. transport 只组合 request-owned signals，不再读取 process-global shutdown signal。
4. Anthropic direct client 不再把 shutdown signal折入 fetch，也不再将 abort 改写成 529。
5. `forwardError` 与 post-commit classifier 删除 shutdown arm；`pool-closed` 若在 operation registry 清零前出现即为真实 teardown bug，不再被包装成正常 shutdown。
6. 删除过时注释和测试 helper，保证 `rg 'getShutdownSignal|isShutdownCausedAbort|SHUTDOWN_ABORT_MESSAGE|StreamShutdownError|rewriteShutdownAbort' src packages tests` 只剩历史文档引用或为空。

- [x] **Step 4：运行定向测试、typecheck 和结构搜索**

```bash
bun test tests/streaming/stream-guard.unit.test.ts tests/streaming/stream-shutdown-race.it.test.ts tests/streaming/stream-settle.unit.test.ts tests/anthropic/error-shaping.unit.test.ts tests/anthropic/anthropic-client.it.test.ts tests/transport/http-transport.it.test.ts
bun run typecheck
rg -n 'getShutdownSignal|isShutdownCausedAbort|SHUTDOWN_ABORT_MESSAGE|StreamShutdownError|rewriteShutdownAbort' src packages tests
```

预期：测试和 typecheck 通过；`rg` 无生产／测试命中。

- [x] **Step 5：提交**

```bash
git add -- packages/foundation/src/stream.ts src/lib/anthropic src/lib/error/forward.ts src/lib/openai src/lib/transport src/routes/messages/post-commit-error.ts tests/anthropic tests/shutdown tests/streaming tests/transport tests/tui/terminal-restore.unit.test.ts
git commit -m "refactor: remove shutdown-owned request cancellation"
```

---

### Task 3：删除失效的 shutdown 时间配置与阶段

**文件：**
- 修改：`packages/foundation/src/state-defaults.ts`
- 修改：`packages/foundation/src/state.ts`
- 修改：`src/lib/config/config.ts`
- 修改：`src/lib/config/schema.ts`
- 修改：`src/lib/observability/events.ts`
- 修改：`src/lib/shutdown.ts`
- 修改：`src/routes/status/route.ts`
- 修改：`config.yaml`
- 生成：`config.schema.json`
- 修改：`tests/config/config-hot-reload.it.test.ts`
- 修改：`tests/config/config-yaml-routes.http.test.ts`
- 修改：`tests/infra/api-endpoints-smoke.http.test.ts`
- 修改：`tests/e2e/handover.e2e.test.ts`

**接口：**
- 删除 state 字段：`shutdownGracefulWait`、`shutdownAbortWait`。
- 删除 config section：`shutdown`。
- `ProcessLifecycleState` 收敛为 `idle | stopping | draining | finalizing | notifying | stopped | failed`。
- `ShutdownPhase` 收敛为 `draining | finalized`。

- [x] **Step 1：先改配置与状态测试为红**

从 config fixture 删除 `shutdown` section；将断言改为：

- config schema 拒绝未知 `shutdown` section；
- `/api/status` 不再暴露两个 state timing 字段；
- handover e2e 不再写 shutdown deadline 配置；
- observability phase 不再接受 `aborting`。

- [x] **Step 2：运行红测试**

```bash
bun test tests/config/config-hot-reload.it.test.ts tests/config/config-yaml-routes.http.test.ts tests/infra/api-endpoints-smoke.http.test.ts tests/shutdown/shutdown.unit.test.ts
```

预期：旧 schema、state 和 status 字段仍存在，相关负断言失败。

- [x] **Step 3：删除配置与类型表面**

1. 删除 foundation 默认值、readonly 字段、setter、reset snapshots 中的两个字段。
2. 删除 `ShutdownConfigSchema`、顶层 `shutdown` 字段、推导类型和 config apply 分支。
3. 删除 `config.yaml` 的 `shutdown` section。
4. 运行 `bun run generate:config-schema` 重建 `config.schema.json`。
5. 删除 `aborting`／`forcing` 状态映射；draining 只发布一次，finalized 仍在 durability 之后发布。
6. 更新 status schema／payload 和测试 fixture。

- [x] **Step 4：运行配置测试、typecheck 与全仓搜索**

```bash
bun test tests/config/config-hot-reload.it.test.ts tests/config/config-yaml-routes.http.test.ts tests/infra/api-endpoints-smoke.http.test.ts tests/shutdown/shutdown.unit.test.ts
bun run typecheck
rg -n 'shutdownGracefulWait|shutdownAbortWait|graceful_wait|abort_wait|"aborting"|"forcing"' packages src tests config.yaml config.schema.json
```

预期：测试、typecheck 通过；搜索无活代码／配置命中。

- [x] **Step 5：提交**

```bash
git add -- packages/foundation/src/state-defaults.ts packages/foundation/src/state.ts src/lib/config/config.ts src/lib/config/schema.ts src/lib/observability/events.ts src/lib/shutdown.ts src/routes/status/route.ts config.yaml config.schema.json tests/config tests/infra/api-endpoints-smoke.http.test.ts tests/e2e/handover.e2e.test.ts tests/shutdown/shutdown.unit.test.ts
git commit -m "refactor: remove obsolete shutdown deadlines"
```

---

### Task 4：同步 live docs、运维样例并完成验证

**文件：**
- 修改：`docs/lifecycle.md`
- 修改：`docs/DESIGN.md`
- 修改：`docs/spec/2026-08-07-lossless-graceful-shutdown-drain.md`
- 修改：`contrib/pm2/ecosystem.config.cjs`
- 修改：`contrib/pm2/README.md`
- 修改：`contrib/systemd/copilot-api@.service`
- 本计划：`docs/plan/2026-08-07-lossless-graceful-shutdown-drain.md`

- [x] **Step 1：更新生命周期与架构文档**

`docs/lifecycle.md` 改为三段：

1. stop ingress／后台维护；
2. lossless drain，等待 operation registry 自行清零；
3. durability finalize／resource close。

删除旧 Step 3 abort、Step 4 force-close、稳定 shutdown signal、两个 timeout 和“4-phase”措辞。保留第二信号立即强退与 persistence ordering。

`docs/DESIGN.md` 删除两个 state/config 行并更新 lifecycle 指针。

- [x] **Step 2：更新 supervisor 样例**

- systemd 单元使用 `TimeoutStopSec=infinity`；部署脚本的 3600 秒轮询上限只停止换代并保留双槽，不向旧槽发送额外终止信号。
- pm2 的 `kill_timeout=1300s` 是 supervisor 无法取消的运维强退上限，不构成严格无损保证；README 要求等待旧槽正常 exit 0 后再 delete，并以 `stop_exit_codes:[0]` 防止 clean handoff exit 被 autorestart。
- 不新增应用内替代 shutdown timeout；真正立即放弃仍由第二终止信号／人工强退表达。

- [x] **Step 3：将规格状态改为已实施并完整通读所有文档**

规格头改为“已实施”，正文不得保留“待实施”。逐个完整读取本任务修改的 Markdown／样例文件，检查重复、矛盾、旧 4-phase 引用和错误行号。

- [x] **Step 4：运行定向验证**

```bash
bun test tests/shutdown tests/streaming/stream-guard.unit.test.ts tests/streaming/stream-shutdown-race.it.test.ts tests/streaming/stream-settle.unit.test.ts tests/anthropic/error-shaping.unit.test.ts tests/anthropic/anthropic-client.it.test.ts tests/transport/http-transport.it.test.ts tests/config/config-hot-reload.it.test.ts tests/config/config-yaml-routes.http.test.ts tests/infra/api-endpoints-smoke.http.test.ts
bun run typecheck
bun run lint:all
bun test tests/architecture/package-boundaries.unit.test.ts tests/architecture/circular-deps-ratchet.unit.test.ts tests/infra/test-discovery-matrix.unit.test.ts
```

预期：全部通过。

- [x] **Step 5：运行完整后端验证**

```bash
bun run test:backend
```

预期：全部 unit、it、http 测试通过；native history-search 缺失时只允许项目约定的显式 skip。

- [x] **Step 6：结构怪味与替代方案复盘**

记录：

- 扫描范围：shutdown lifecycle、request cancellation、config/state、supervisor samples。
- 判据：重复 cancellation owner、职责错位、死配置、双份错误分类、资源关闭早于 operation quiesce。
- 每个发现给出 `file:line`、怪味类型和本轮修复／backlog 处置。
- 比较内部替代、判据判别力、成熟第三方方案；本问题属于进程内 lifecycle ownership，无第三方库能替代项目 operation registry。

- [x] **Step 7：提交文档与运维样例**

```bash
git add -- docs/lifecycle.md docs/DESIGN.md docs/spec/2026-08-07-lossless-graceful-shutdown-drain.md docs/plan/2026-08-07-lossless-graceful-shutdown-drain.md contrib/pm2/ecosystem.config.cjs contrib/pm2/README.md contrib/systemd/copilot-api@.service
git commit -m "docs: document lossless shutdown lifecycle"
```

- [x] **Step 8：最终状态核验**

```bash
git status --short --branch
git log --oneline --decorate -5
```

预期：worktree 干净，包含规格、核心实现、abort 删除、配置收敛和文档同步的细粒度本地提交；不 push。


## 实施结果

- Task 1：提交 `04e6ecb1`，首信号改为无 deadline operation drain；token／WS／h2 延后关闭。
- Task 2：提交 `d254d8ae`，删除 process-global shutdown cancellation、stream shutdown kind 和 529 改写。
- Task 3：提交 `c6a5f72c`，删除两个 shutdown deadline 配置、state 字段与阶段类型。
- Task 4：live docs、instruction skill 与 supervisor 样例已同步，提交 `4c555ef9` 及其之前的 Task 4 提交序列。
- Review 整改：`77d6d479` 补齐 count_tokens／embeddings lightweight in-flight registry、真实 `/v1/messages` 长流／token refresh／pre-content recovery shutdown 交叉测试、systemd／PM2 handoff、旧 Vue 配置表面与 entry-evidence discovery baseline；`f1cb3cc5` 落评审处置记录；`954a1bff` 修复合并态发现的 lightweight pre-terminal capture 未释放 History reservation；`a6be256a` 给 entry evidence validator 设文件级超时预算。
- 最终验证（整改 worktree `6adf2e56`，已合入 `master@d47492a6`，2026-08-08）：`bun run test:backend` 为 16 shards、6384 tests、6384 pass、0 fail（7287 executed、30 skipped）；本任务自有测试 12 文件 98 pass、0 fail；root `bun run typecheck`、`bun run lint:all`、架构／discovery guards 34/34 均通过。合入 master 前在 `master@d59a622c` 基线上另有 backend 6641 pass、fast 3180 pass、PTY 19/19、旧 Vue Bun 249/249、Vitest 78/78、vue-tsc 与 Vite build 全通过的快照；用例总数变化来自 peer 的 header-deadline 批次，非本任务删减。先前记录的 `lint:all` 红来自尚未合并的并发分支 `worktree-nghttp2-header-deadline`，该分支已自行合入 master（`0732fc76`／`a0ad0f1a`／`bae83f01`）后此项转绿。完整评审记录见 [docs/tmp/2026-08-08-lossless-shutdown-review.md](../tmp/2026-08-08-lossless-shutdown-review.md)，逐条处置与正控 patch 见 [docs/tmp/2026-08-08-lossless-shutdown-review-dispositions.md](../tmp/2026-08-08-lossless-shutdown-review-dispositions.md)。
