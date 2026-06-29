# 实现交接 — stale reaper 取消在飞请求（缺陷④ reaper teeth）

> **用途**：新会话零上下文接续实现「reaper 真正取消在飞请求」（缺陷④）。本文自包含——可不读历史会话直接开工。
> **设计权威**：[stale-reaper-cancellation.md](stale-reaper-cancellation.md)（读它，本文是实现态索引 + Phase 1 kick-off）。
> **背景 RFC**：[pre-response-abort-handling.md](../../spec/pre-response-abort-handling.md)（缺陷①②已落地、③待 Q2 实测、④=本文、⑤已修）。
> **写于**：2026-06-22，HEAD≈`102118b`，分支 `feat/openapi-and-dep-upgrade`。注：该分支有并发会话在做 OpenAPI 迁移，typecheck 有**与本任务无关的** OpenAPIHono 报错（`src/server.ts`/`src/start.ts`/`tests/helpers/test-app.ts`）——别去修它们，只确保你改的文件零**新增**错误。

---

## 0. 裁判轴（必读 — 本项目原则，覆盖你的默认 ROI/YAGNI 倾向）

- **architecture-health-first**：判据是"问题是否真实存在 + 哪个修复长远质量最高"，**不是**风险/工期/改动量。资源泄漏 + 可观测撒谎**必须修**，不归类为"等触发再说"。成本不是决策因素。
- **empirical-verification**：亲手实测 > 文档推断 > 单方声称。本文每个 `file:line` 锚点都已在设计会话核验，但你**改之前要再读一遍**确认没漂（并发会话在动这个分支）。flaky/时序测试连跑 10–25× 确认。
- **best-complete-solution**：修根因不修症状；命名反映职责；同模块相似逻辑写法一致；保留有意义注释。
- **completion-includes-doc-sync**：代码改完 == 收尾完成（同步 DESIGN.md + RFC + 记忆）。"代码跑通但文档没同步" = 未完成。
- **subagent-explicit-rubric**：交付前派 subagent 做对抗审查（不在主会话自审），prompt 里写明上述裁判轴。审查目标是**发现问题**（协议契约/边界/错误处理/时序），不是给修复方案。reviewer 的"无消费者""安全删除"等绝对断言要**亲自对照 file:line 复核**。

---

## 1. 这是什么 / 为什么

生产 incident（第二起，2026-06-22）：opus-4.8 流式 `/v1/messages`（L2 buffered retry 开）在 pre-response（等响应头）卡住，被 stale reaper 在 911s「force-fail」：

```
[WARN] Force-failing stale request ... state: executing, age: 911s, max: 900s
[FAIL] POST /v1/messages claude-opus-4.8 911.3s ↑628.3KB ↓5.1KB: Request exceeded maximum age of 900s
```

**根因**：reaper 的 `runReaperOnce`（`src/lib/context/manager.ts:200`）只调 `ctx.fail(...)`，而 `RequestContext.fail()`（`request.ts:428`）只记终态/写 history/移出 active map——**不取消在飞上游 fetch、不中止 handler 协程**（RequestContext 无 AbortController）。后果两条，按裁判轴都是"必须修"：

1. **资源泄漏**：force-fail 后上游 h2 流 + handler 协程 + 628KB 对象图继续活到 `response_header` 超时（1200s）才真了结。
2. **可观测撒谎**：`[FAIL] ... 911s ... exceeded maximum age` 宣称请求结束了，但它还在跑。

**修复 = 给 reaper 装牙齿**：RequestContext 加生命周期 AbortController，reaper force-fail 时 abort 它，取消在飞 fetch。

---

## 2. 关键洞察（决定为何拆两 Phase）

reaper 砍请求时该请求处于两态之一，修复难度天差地别：

| 状态 | guard 在跑? | 修法 | Phase |
|---|---|---|---|
| `executing`（pre-response，**911s incident 的实际形态**） | 否 | 折进 fetch 信号即可，**不触发 P1** | **Phase 1（小、完整）** |
| `streaming`（mid-stream） | 是 | 折进 guard clientSignal 会**误判成客户端断开**（subagent P1 CRITICAL：静默断流 + 错记终态）→ 需新 provenance | **Phase 2（大）** |

**你这次做 Phase 1。** Phase 2 设计已在 RFC §4 写好，但依赖 Phase 1，单独排期。

---

## 3. Phase 1 实现步骤（pre-response reaper teeth）

### 步骤 A — RequestContext 加 cancel 能力

- `src/lib/context/request.ts` `createRequestContext`：加 `const lifecycleAbort = new AbortController()`（放在其它 mutable state 旁，`let settled = false` 附近）。在返回对象里加：
  - `get cancelSignal() { return lifecycleAbort.signal }`（或 `cancelSignal: lifecycleAbort.signal`，跟该文件既有 readonly 暴露风格一致——读现有 `id`/`startTime` 怎么暴露的）。
  - `cancel() { if (!lifecycleAbort.signal.aborted) lifecycleAbort.abort() }`（幂等）。
- `src/lib/context/types.ts:231` `RequestContext` 接口：加 `readonly cancelSignal: AbortSignal` + `cancel(): void`，带 JSDoc（说明这是生命周期取消、reaper/shutdown 用）。
- **不登记 RESETTERS**：per-ctx、非 module-global，L1 守卫 `resetters-complete.unit.test.ts` 不涉及。

### 步骤 B — transport 折入（两处，都已收 `env`）

把 `env.ctx.cancelSignal` 折进**上游 fetch 信号**，**不碰 guard 的 clientSignal**：

- `src/lib/transport/http-transport.ts` `send`（`:66`）：传给 `sendUpstreamHttp` 的 `clientAbortSignal`（`:80` 附近）从 `deps.clientAbortSignal` 改为 `combineAbortSignals(deps.clientAbortSignal, env.ctx.cancelSignal)`（import 自 `~/lib/stream`）。**`guardSseIterable` 的 `clientSignal`（`:102`）保持 `deps.clientAbortSignal` 不动。**
- `src/lib/transport/responses-transport.ts` `send`（`:71`）：同样改 `sendUpstreamHttp` 的 `clientAbortSignal`；guard 的 `clientSignal`（`:137`）不动。
- 注意 `sendUpstreamHttp`（`src/lib/transport/send.ts`）内部已对 `clientAbortSignal` 做 `combineAbortSignals(createFetchSignal(), ..., clientAbortSignal)`（`:99`）——你传进去的 combined 信号会被再折一层，没问题（`combineAbortSignals` 幂等接受已合并信号）。

### 步骤 C — reaper fail-then-cancel

- `src/lib/context/manager.ts:200`：在 `ctx.fail(...)` 之后加一行 `ctx.cancel()`。
- **次序硬约束**：先 fail（同步设 `settled=true`，`request.ts:430` 无 await → 同步坐实 `failed`）→ 再 cancel。保证 handler 因 abort 走的任何后续 settle 都被 `settled` guard 兜成 no-op、终态确定 `failed`。

### 为什么 Phase 1 不触发 P1（务必理解）

pre-response 时 `guardSseIterable` 还没迭代第一帧。cancel 经 fetch 信号 → `http2Fetch.onPreResponseAbort`（`http2-client.ts:148`）reject → handler 的 `await driver.runRequest`（`handler-v4.ts:323`）catch 接住。catch 判别用 handler **自己的** `clientAbort.signal.aborted`（`:349`），而 reaper 用的是 `ctx.cancelSignal`（不同 controller）→ `clientAbort` 没翻转 → 落 `ctx.fail`（已 settled → no-op）→ rethrow → `forwardError` 出 504（`forward.ts:457` 超时分支）。**终态 failed + 504 正确**（reaper 砍的是"上游太慢"）。**且崩溃安全**：cancel 触发的 fetch reject 即使碰巧孤儿，缺陷⑤ 的 `withRejectionObserver`（commit `c824df4`）已兜住不崩。

---

## 4. 测试（Phase 1，全用 `useIsolatedRuntime` / 不碰真实 env）

1. `tests/context/`（新 `.it`）：`ctx.cancel()` → `ctx.cancelSignal.aborted === true`；二次 `cancel()` 幂等不抛。
2. `tests/transport/http-transport.it.test.ts`（扩）：注入 mock fetch，`env.ctx.cancel()` → 断言传给 fetch 的 signal 已 abort。
3. `tests/context/`（reaper `.it`）：mock `durationMs > maxAge` 的活跃 ctx，跑 `runReaperOnce` → 断言 `cancelSignal.aborted === true` **且** `ctx.state === "failed"`（锁 fail-then-cancel 次序）。
4. **回归门（必绿）**：`tests/anthropic/streaming-l2-baseline.http.test.ts`（逐字节）+ `tests/anthropic/pre-response-abort.http.test.ts`。多折一个永不触发的信号 → 逐字节/状态码不变。

---

## 5. Commit 计划（fine-grained，conventional，无 Claude 署名；用 pathspec 暂存）

> 本仓库有并发会话同时提交，HEAD 会移动。用 `git commit -m "..." -- <精确路径>`（只提目标）+ `git show --stat HEAD` 复核（[[git-concurrent-sessions-pathspec-commit]]）。**绝不** `git add -A`/`commit -am`/reset/rebase/amend。lint-staged 跑后用 `git show HEAD:<file> | grep` 确认提交的 blob 真含你的代码（[[lint-staged-rollback-behavior]]）。

1. `feat(context): RequestContext 生命周期 AbortController（cancelSignal + cancel()）` — 步骤 A，死代码无消费者、系统行为零变化。
2. `fix(context): stale reaper 取消在飞上游 fetch（pre-response teeth）` — 步骤 B+C，pre-response 超龄请求的 fetch 真被取消、不再滞留 1200s。`streaming-l2-baseline` 逐字节绿。
3. `test: reaper cancel 传播 + 终态 failed 覆盖` — §4 测试。
4. `docs: reaper Phase 1 取消在飞 fetch（DESIGN/RFC/memory）` — §6 doc-sync。

每个 commit 自洽不半坏（commit-invariants，详 RFC §3.5）。

---

## 6. doc-sync（Phase 1 完成时，completion-includes-doc-sync）

- `docs/DESIGN.md` `staleRequestMaxAge` 行：把"**注**：reaper 当前只调 ctx.fail()，不取消在飞上游 fetch……缺陷④ 实现"改为"reaper force-fail 取消在飞上游 fetch（Phase 1 pre-response；mid-stream error 帧 Phase 2 待做）"。
- `docs/rfc/stale-reaper-cancellation.md`：Phase 1 commit invariants 表标 ✅ 已落地 + commit hash。
- `docs/spec/pre-response-abort-handling.md` 缺陷④：标 Phase 1 已实现、指向本 RFC。
- 记忆 `docs/memory/project-pre-response-abort-rfc.md` 的 ④ 状态 + `docs/memory/MEMORY.md` 索引钩子更新。
  - **注意**：`docs/memory/` 有并发会话在做 frontmatter 迁移，多文件 `M`/`??`。只改你这两个文件的内容、用 pathspec 提交，别裹入别人的迁移（[[sed-touched-files-bundle-inflight-work]]）。

---

## 7. 交付前（subagent-explicit-rubric）

派 ≥1 个对抗 subagent（全量工具权限，[[feedback-subagents-full-tool-access]]），prompt 里写明 §0 裁判轴 + 让它对抗审查：
- cancelSignal 折入是否真不碰 guard（确认 P1 不被触发）；
- reaper fail-then-cancel 次序是否真同步无竞态（读 `request.ts` 的 `settled` 处理）；
- pre-response catch 的 504 分流是否正确（reaper cancel ≠ client disconnect）；
- 是否有 Phase 1 漏掉的 pre-response cancel 路径（非流式？embeddings？——RFC §5 已界定范围，核对）。
逐条复核 subagent 引用的 file:line，吸收客观事实、按本项目原则取舍结论。

---

## 8. Phase 2 预告（**本次不做**，RFC §4）

mid-stream（`state: streaming`）的 reaper 砍需引入独立 `StreamReaperCancelError` + `StreamErrorKind="reaper-cancel"`，让 `guardSseIterable` 与 client-abort 区分（优先级 shutdown>client>reaper-cancel），driver 映射成 `stream-error` → 5 格式经既有 H3 路径发协议 error 帧（handler 侧改动≈0）。详见 RFC §4。**先合 Phase 1，观察生产是否还有 mid-stream 形态的 force-fail，再排 Phase 2。**
