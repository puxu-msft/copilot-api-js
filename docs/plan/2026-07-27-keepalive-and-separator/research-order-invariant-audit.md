# 顺序／位置／装配不变量专项审计

- 仓库：`/home/xp/src/copilot-api-js`
- 日期：2026-07-27
- 范围：`src/`、`tests/`、`docs/`，重点覆盖 sanitize、codec、pipeline、retry strategies、middleware／routes、listener／shutdown、双写／镜像。
- 排除：用户给出的已知样板 `src/lib/anthropic/sanitize/index.ts:154`，仅把它用作检索正样本，不重复计入发现。
- 方法：先用已知样板校验检索式确实命中，再广搜注释／文档中的顺序措辞；随后精读装配点和候选测试，逐项判断测试、类型或运行时断言是否会因顺序被改而转红。

## 检索正样本与工具说明

运行：

```sh
rg -n -i 'TERMINAL pass|must be (the )?(last|terminal)|must run last' /home/xp/src/copilot-api-js/src/lib/anthropic/sanitize/index.ts /home/xp/src/copilot-api-js/src/lib/anthropic/sanitize
```

输出摘要：命中 `/home/xp/src/copilot-api-js/src/lib/anthropic/sanitize/index.ts:154` 的 `// TERMINAL pass ...`，证明用于后续否定性搜索的核心检索式能触达已知样板。扩展的中英文祈使／顺序检索覆盖 `src/`、`tests/`、`docs/`，产生 4555 条宽候选，后续按目标子系统收窄并精读。

文件名工具说明：环境没有 `fd`（`/bin/bash: fd: command not found`），依照运行时事实改用只读 `find`；未因此缩小目录范围。

## 已核验但不计入缺陷的顺序契约

以下候选虽然依赖顺序，但已有会因顺序破坏而转红的机器守卫，因此不计入最终缺陷数：

1. **Reactive retry first-match 顺序。** 生产执行点 `/home/xp/src/copilot-api-js/src/lib/pipeline/driver.ts:541-545` 使用 `.find(candidate.canHandle)`，注册表 `/home/xp/src/copilot-api-js/src/lib/request/retry-registry.ts:132-149,155-300,322-338` 以数值 `order` 排序。`tool-field < body-field < cache-control` 原文位于 `/home/xp/src/copilot-api-js/src/lib/request/strategies/tool-field-rejection-retry.ts:43-46`。守卫 `/home/xp/src/copilot-api-js/tests/request/retry-registry.unit.test.ts:86-94` 会在 order 碰撞或三者相对次序反转时转红；`:98-121` 与 `/home/xp/src/copilot-api-js/tests/pipeline/retry-strategy-assembly.golden.it.test.ts:61-119` 还钉住各腿完整名称序列。因此这不是“只靠注释”的场景。
2. **Response rewrite 顺序与 flush cascade。** 原文 `/home/xp/src/copilot-api-js/src/lib/pipeline/rewrite-registry.ts:147-177` 明确 recover／decode／filter／refusal 次序；执行点 `/home/xp/src/copilot-api-js/src/lib/pipeline/stream/response-processor.ts:253-287` 是 forward-only `passThrough` 和升序 `flushChain`。守卫 `/home/xp/src/copilot-api-js/tests/pipeline/response-rewrite-contract.unit.test.ts:148-181,330-390` 直接断言排序、cascade、关键相对次序和“后续合成 error 不回流到早期 reshaper”，且含错误次序正样本（`:387-390`）。
3. **Shutdown persistence 与 force-close 次序。** 原文 `/home/xp/src/copilot-api-js/src/lib/shutdown.ts:551-555,596-650`。守卫 `/home/xp/src/copilot-api-js/tests/shutdown/shutdown.unit.test.ts:160-270` 逐步阻塞各 barrier 并断言 generation→History→telemetry→diagnostics→notification→observer close 的全序；`:953-991` 直接记录调用顺序并断言 upstream WS close 先于 downstream force close。
4. **OpenAPI 在 management routers 后注册。** 原文 `/home/xp/src/copilot-api-js/src/routes/openapi.ts:48-52`，装配点 `/home/xp/src/copilot-api-js/src/server.ts:155-161`。守卫 `/home/xp/src/copilot-api-js/tests/infra/openapi-spec.http.test.ts:62-83` 请求真实 `/openapi.json` 并将运行时路由面与 spec paths 对账；若提前注册导致 management definitions 缺失，`missing` 非空而转红。
5. **Config legacy path 先删后写新路径。** 原文 `/home/xp/src/copilot-api-js/src/routes/config/route.ts:398-408`，装配点 `:151-152`。守卫 `/home/xp/src/copilot-api-js/tests/config/config-yaml-routes.http.test.ts:1095-1203,1314-1364` 通过真实 PUT 后检查旧键删除、新键与 sibling 保留；顺序反转导致同路径／祖先 pruning 覆盖新值时会转红。

核验命令摘要：`rg -n '(assembleRetryStrategies|first match|order)' src tests` 定位 first-match 与 registry tests；`rg -n '(RESPONSE_REWRITE_ORDER|registration order)' src tests` 定位真实 order 常量及 contract suite；`rg -n '(closeAll|server.close|callOrder)' tests/shutdown` 找到精确调用序断言；`rg -n '(openapi|undocumented routes)' tests/infra/openapi-spec.http.test.ts` 找到运行时对账；`rg -n '(legacyPathsRemoved|migrat|prune)' tests/config/config-yaml-routes.http.test.ts` 找到行为回归。

## 发现 1：Responses WebSocket 的 terminal `error` 分支只“装配了 commit 条件”，未装配对应的终态处理

- **严重级别：CRITICAL**
- **不变量原文：** `/home/xp/src/copilot-api-js/src/routes/responses/ws.ts:394-398`：`H2 — a terminal upstream error frame ... Committing it ... lets the handler fail via the REAL acc.streamError below, mirroring the HTTP handler.`
- **实际装配事实：** 同文件 `/home/xp/src/copilot-api-js/src/routes/responses/ws.ts:467-478` 在 `outcome.kind === "complete"` 后直接做 session registration，再进入 `acc.status === ""` truncation gate；全文件没有 `if (acc.streamError)`。对照 HTTP 镜像 `/home/xp/src/copilot-api-js/src/routes/responses/handler-v4.ts:451-467`，HTTP 确有必须先于 truncation gate 的 `acc.streamError` 分支。
- **谁能破坏它：** 这不是纯潜在改动，而是当前镜像已经漂移。任何让 WS 收到 terminal `type:"error"` 帧的上游响应都会触发；未来维护者只更新 HTTP H2 分支或继续相信 WS 注释里的“below”，都会维持／扩大漂移。
- **可观测后果：** 真实 error 帧先被 terminal-only buffer commit 到客户端，随后因为 `acc.status` 仍为空，WS 把它误判为 truncation，再发送第二个 synthetic error 并 1011 close；History failure reason 被改写成“truncated”，真实 upstream error code/message 丢失。属于双终止 + 错误归因，且普通成功／truncation 测试均可绿。
- **现有守卫：没有找到会因这个分支缺失而转红的机器守卫。** 搜索 `rg -n 'acc\.streamError' src/routes/responses/ws.ts src/routes/responses/handler-v4.ts` 的摘要是 HTTP 有完整 H2 分支，WS 只有注释一处。搜索 `rg -n '(terminal upstream.*error|upstream error frame|server_error|type.:.error)' tests/responses/{ws-buffered.it.test.ts,responses-ws.http.test.ts,ws-buffered-close-timing.it.test.ts` 未找到 terminal upstream Responses error 的 WS 行为用例；命中的 `server_error` 是 shutdown abort，不是 clean-drain in-band `type:"error"`。
- **建议守卫形态：** 增加真实 WS endpoint 集成测试，mock 上游发送 `response.created` 后发送 terminal `type:"error"` 并 clean EOF；断言客户端只收到一个真实 error、无“truncated”二次帧、close code／History reason 保留真实 code/message。再加 HTTP/WS terminal decision 的共享纯函数或穷尽 discriminated union，消除双份 if 链。

## 发现 2：`inspectRequest` 声称逐字镜像 `runRequest` S1–S3，但漏掉 `client.inbound` 装配点

- **严重级别：MED**
- **不变量原文：** `/home/xp/src/copilot-api-js/src/lib/pipeline/driver.ts:399-403`：`Mirrors runRequest's S1-S3 verbatim (same codec calls + runRewriteIn logic)`；真实请求的顺序说明在 `:316-329`：parse → `client.inbound` → `translateInbound`。
- **实际装配事实：** `/home/xp/src/copilot-api-js/src/lib/pipeline/driver.ts:405-416` 的 inspector 是 parse 后直接 `translateInbound(parsed)`，没有读取／调用 `getUpstreamHook()?.client?.inbound`，也没有真实路径的 defensive clone／undefined-return 语义。
- **谁能破坏它：** 当前已漂移。只要配置了 `client.inbound` hook，真实请求 wire 会被 hook 改写，而 `/api/debug/pipeline` 的 inspect 结果仍展示未改写 body。未来给真实 S1a→S1b 再加装配步骤而只维护 `runRequest`，同样不会被 inspector 自动继承。
- **可观测后果：** dry-run／诊断端点静默撒谎：操作员会据其判断 hook 未生效、sanitize 输入不同或 route decision 不同，可能误诊生产请求；不直接破坏主请求。
- **现有守卫：没有找到能因该漂移转红的守卫。** `/home/xp/src/copilot-api-js/tests/pipeline/hooks/client-inbound.unit.test.ts:44-105` 只测 `runRequest`；`/home/xp/src/copilot-api-js/tests/pipeline/inspect-request.unit.test.ts:72-148` 与 `/home/xp/src/copilot-api-js/tests/infra/debug-dry-run-pipeline.http.test.ts:178-...` 测 inspector stages，但检索 `client.inbound|hook` 未见 inspector 场景。命令：`rg -n '(inspectRequest|client\.inbound|Mirrors.*runRequest)' src/lib/pipeline/driver.ts tests/pipeline tests/infra/debug-dry-run-pipeline.http.test.ts`。
- **建议守卫形态：** 抽出共享的 S1a→S3 stage runner，让 run／inspect 以 observer 模式消费同一装配；至少增加挂载 `client.inbound` 的 inspector 测试，断言 parse snapshot 保持原始而 translate-inbound／后续 stage 看到 immutable-return 改写，并覆盖 in-place+undefined 被丢弃的语义。

## 发现 3：delayed-commit SSE 的 abort listener 必须先于 immediate ping，但只有注释／设计文档守着

- **严重级别：HIGH**
- **不变量原文：** `/home/xp/src/copilot-api-js/src/routes/messages/handler-v4.ts:633`：`stream.onAbort(() => clientAbort.abort()) // register BEFORE the first ping (round-B L1)`；设计 `/home/xp/src/copilot-api-js/docs/spec/pre-response-abort-handling.md:342-343` 也明确“先注册再写首 ping”。立即首 ping 在生产代码 `:647-654`。
- **谁能破坏它：** 把 `stream.onAbort` 移到 `await sink.writeKeepalive(...)` 后，或在二者之间加入任何可 await 的写／初始化；commit 瞬间客户端断开就可能发生在 listener 尚未安装的窗口。
- **可观测后果：** disconnect 漏失，`clientAbort` 不触发，已经无人消费的长上游请求继续持有 upstream connection、SSE accumulator 与 forwarded buffer，直至上游自然结束；隐蔽表现是资源／内存滞留而非即时错误。该项目另一 WS 路径的相同漏 abort 风险曾被注释归因于 4GB OOM（`/home/xp/src/copilot-api-js/src/routes/responses/ws.ts:192-200`），说明后果类别现实。
- **现有守卫：未找到。** `rg -n '(register BEFORE the first ping|stream\.onAbort|first ping)' src tests docs` 只命中生产两处 `stream.onAbort`、设计／plan 和 `/home/xp/src/copilot-api-js/tests/anthropic/stream-immediate-keepalive.http.test.ts:228-264` 的“立即首 ping／history 采样”测试；该测试不制造 commit-window client abort，也不观测 listener 是否已注册。全 tests 中没有 `stream.onAbort` 断言。
- **建议守卫形态：** 抽成 `attachAbortThenEmitInitialKeepalive` 原子 helper，测试用可控 stream 在第一次 write 同步触发 abort，断言 `clientAbort.signal.aborted === true` 且上游取消；或给 stream adapter 暴露注册状态并做结构顺序测试。运行时可在 initial write 前断言 abort listener 已 armed。

## 发现 4：Responses WS abort controller 必须在首个 `await` 前注册，但生产接线被明确留作“correct-by-inspection”

- **严重级别：CRITICAL**
- **不变量原文：** `/home/xp/src/copilot-api-js/src/routes/responses/ws.ts:226-236`：`Create + register the abort controller BEFORE any await ... a late registration would let an inbound disconnect slip past unobserved (the exact OOM-vector this PR is closing)`；后果原文在 `:192-200`，明确 abandoned response 会持有 connection／accumulator／buffer，且对应野外 4GB OOM。
- **谁能破坏它：** 在 `wsClientAborts.set(ws, clientAbort)` 前加入任何 async validation、config reload、model resolution 或 `await`；或把 controller 创建下移到 `handleResponseCreateV4`。disconnect 若恰好发生在该窗口，`onClose`／`onError` 的 `wsClientAborts.get(ws)?.abort()` 读不到 controller。
- **可观测后果：** 客户端已断开但上游请求继续执行，长期占用 upstream connection、SSE accumulation 与 forwarded event buffer，表现为慢性 heap／连接泄漏，最终可 OOM；没有即时异常提示顺序被破坏。
- **现有守卫：没有。** `/home/xp/src/copilot-api-js/tests/responses/responses-ws.http.test.ts:587-599` 明写真实 `ws.close() → onClose → wsClientAborts.abort()` 在 bare-Hono harness 不传播，并把 glue 称为“~2-line correct-by-inspection wiring”；该测试从 transport boundary 注入 abort，只锁 terminal divergence，不触达 registry 接线。检索 `rg -n '(registerClientAbort|wsClientAborts|onClose→abort glue|correct-by-inspection)' src/routes/responses/ws.ts tests` 没找到接线测试或运行时断言。
- **建议守卫形态：** 将 per-socket registry 抽成可注入／可测试的小对象；用受控 handler 测试让 `handleResponseCreateV4` 第一同步步就触发 `onClose`，断言 signal 已 aborted。更强的结构守卫可 AST 检查 `wsClientAborts.set` 位于函数中第一个 `await` 之前；运行时开发断言可在进入任何 async work 前验证 registry 中 controller 身份。

## 发现 5：`createFullTestApp` 宣称镜像生产 server，但装配面没有同源或 parity 守卫

- **严重级别：MED**
- **不变量原文：** `/home/xp/src/copilot-api-js/tests/helpers/test-app.ts:13-16`：`Mirror src/server.ts`；`:39-44`：`Mirrors src/server.ts:137 — the production observability safety-net`。
- **实际双份：** 生产 `/home/xp/src/copilot-api-js/src/server.ts:93-161` 另行装配 browser probes、三态 notFound、liveness、config/token middleware、observability、unknownEndpointFinalizer、CORS、trimTrailingSlash、routes、OpenAPI；test app `/home/xp/src/copilot-api-js/tests/helpers/test-app.ts:11-47` 只复制其中一部分，notFound 也已是不同语义，且没有 config/token、unknown finalizer、CORS、trimTrailingSlash。
- **谁能破坏它：** 在 production `createServer` 增加／重排全局 middleware 或基础路由，却不手改 `createFullTestApp`；大量 `.http.test.ts` 继续走 test app 并给出假绿。历史注释本身承认该镜像曾缺 observability 而导致 test-only under-finalization（`:39-43`）。
- **可观测后果：** 测试环境与生产在 finalization、headers、404/405、redirect、config hot reload、token refresh 等方面静默分叉；功能测试可能只在 production 失败，或 production-only middleware 回归只有少数专测能看到。
- **现有守卫：部分行为各自有测试，但没有装配 parity 守卫。** `rg -n '(createServer|createFullTestApp)' tests/infra tests/helpers` 显示 infra 大多只用 `createFullTestApp`；`/home/xp/src/copilot-api-js/tests/observability/unknown-endpoint-server.it.test.ts:1-5` 是明确为 production middleware 另写的真实 `createServer` 专测，恰恰证明通用 test app 不等价。未找到比较两者 route／middleware 顺序或要求共享 builder 的测试。
- **建议守卫形态：** 抽取共享 `configureBaseApp(app, deps)`，production 与 tests 只注入外部依赖；若暂不抽取，增加 AST／结构守卫对两者的基础 route + middleware 注册序列做声明式对账，并为允许差异维护显式 allowlist 与理由。

## 发现 6：production liveness 必须挂在 config/token middleware 之前，但现有“缺 token 仍 200”测试走的是无该 middleware 的 test app

- **严重级别：HIGH**
- **不变量原文：** `/home/xp/src/copilot-api-js/src/server.ts:119-125`：`Registered BEFORE the config/token middleware below so it never touches upstream ... liveness check must stay 200 even when ... token is stale or upstream is down`。
- **谁能破坏它：** 把 `/health/liveness` 注册移到全局 `server.use` 后，或把 config/token middleware 提到它之前；此类“整理所有 routes 到 registerHttpRoutes”／“统一全局 middleware”改动很现实。
- **可观测后果：** liveness 开始等待／调用 `ensureValidCopilotToken()`，token refresh 或 config reload 失败时返回 500／超时；Kubernetes 将把上游故障误判成进程死亡并重启健康代理，形成重启循环。错误只在 stale/missing token 或上游故障时出现。
- **现有守卫：表面有测试，实际不触达该顺序。** `/home/xp/src/copilot-api-js/tests/infra/basic-routes.http.test.ts:144-164` 断言缺 token 仍 200，但该文件 `:54` 使用 `createFullTestApp()`；test app `/home/xp/src/copilot-api-js/tests/helpers/test-app.ts:32-47` 根本没有 production config/token middleware。因此即使把 production liveness 移到 middleware 后，这些测试仍绿。搜索 `rg -n 'health/liveness' tests` 未找到通过 `createServer()` 驱动 liveness 的测试；真实 `createServer` suite `/home/xp/src/copilot-api-js/tests/observability/unknown-endpoint-server.it.test.ts` 没覆盖 liveness。
- **建议守卫形态：** 用真实 `createServer()`，安装一个 `ensureValidCopilotToken()` 会 throw／永不 resolve 的 token runtime，断言 `/health/liveness` 立即 200 且 mock 调用次数为 0；这是该注册顺序的直接行为守卫。也可把 liveness 放进显式 pre-middleware sub-app，并对装配层级做结构测试。

## 双写／镜像审计中确认已有守卫的项目

- `/home/xp/src/copilot-api-js/src/lib/history/types.ts:238-244` 与 `/home/xp/src/copilot-api-js/src/lib/context/types.ts:73-95` 的 `UsageData`／`ResponseData.usage` 双份 literal 虽由注释要求同 commit 镜像，但 `/home/xp/src/copilot-api-js/tests/usage-data-shape.unit.test.ts:6-24` 做双向赋值，任一侧增加 required 字段或改变可选性／类型都会 typecheck 红，因此不计缺陷。
- `/home/xp/src/copilot-api-js/src/lib/config/compat.ts:166-176,462-487` 的 top-down migration registry 有链式迁移行为守卫：`/home/xp/src/copilot-api-js/tests/config/config-compat.unit.test.ts:68-84` 要求同一 pass 先 rename section 再 rename leaf；反转条目会使 `server.responses_ws.keep_open` 断言失败。
- `/home/xp/src/copilot-api-js/src/lib/openai/upstream-ws.ts:399-438` 与 `/home/xp/src/copilot-api-js/src/lib/transport/http2-client.ts:731-784` 的 config listener “never throw，否则跳过后续 listener”契约有直接守卫：`/home/xp/src/copilot-api-js/tests/responses/upstream-ws.unit.test.ts:1121-1204` 注入 throwing reconcile 并断言 later listener 仍运行；h2 timer snapshot 次序由 `/home/xp/src/copilot-api-js/tests/transport/http2-generation-reconcile.it.test.ts:294-316` 断言每 entry 每次只 reschedule 一次。
- `/home/xp/src/copilot-api-js/src/lib/context/finalization-coordinator.ts:8-10,53-76` 的 register-before-seal 契约已升级为运行时 throw，且 `/home/xp/src/copilot-api-js/tests/context/finalization-coordinator.unit.test.ts:42-45` 直接钉住，不计缺陷。
- `/home/xp/src/copilot-api-js/src/lib/pipeline/driver.ts:237-244` 的 response pump 在 handler continuation 前注册，已有 `/home/xp/src/copilot-api-js/tests/pipeline/response-pump-operation.unit.test.ts:23-57` 以真实 driver 证明 pump 未完成时 canonical terminal 仍为空，pump 完成后才 finalize，不计缺陷。

## 总结

| 级别 | 数量 | 发现 |
|---|---:|---|
| CRITICAL | 2 | Responses WS terminal error 分支镜像缺失；Responses WS abort controller 首 await 前注册无守卫 |
| HIGH | 2 | delayed-commit abort listener 先于 first ping 无守卫；production liveness 先于 config/token middleware 的测试是假守卫 |
| MED | 2 | `inspectRequest` 漏 `client.inbound`；`createFullTestApp` 与 production server 装配双份漂移 |
| LOW | 0 | — |
| **合计** | **6** | 已排除用户给出的 sanitize terminal-pass 样板 |

## 实际搜索范围与命令摘要

搜索范围：`/home/xp/src/copilot-api-js/src`、`/home/xp/src/copilot-api-js/tests`、`/home/xp/src/copilot-api-js/docs`；重点精读 `src/lib/anthropic/sanitize/`、`src/lib/codec/`、`src/lib/pipeline/`、`src/lib/request/strategies/`、`src/lib/request/retry-registry.ts`、`src/lib/shutdown.ts`、`src/server.ts`、`src/routes/`、`tests/helpers/test-app.ts`。没有把 `.worktrees/`、`refs/` 中的副本作为当前主树事实。

代表性命令与输出摘要：

```sh
# 正样本：1 个已知位置命中（命令因同时传文件和目录而显示同一路径两次）
rg -n -i 'TERMINAL pass|must be (the )?(last|terminal)|must run last' src/lib/anthropic/sanitize/index.ts src/lib/anthropic/sanitize
# => src/lib/anthropic/sanitize/index.ts:154

# 宽搜中英文祈使／顺序线索
rg -n -i --glob '*.ts' --glob '*.tsx' --glob '*.md' '(MUST|must|必须|不得|务必|only|先|后|之前|之后|before|after|last|terminal|first)...' src tests docs
# => 4555 条宽候选；写入 /tmp/order-imperative-hits.txt 后按目标子系统收窄精读

# first-match 与 retry order
rg -n '(assembleRetryStrategies|tool-field-rejection|body-field-rejection|first match|registration order|priority|order)' tests src
# => driver.ts:544 的 .find；retry-registry order；retry-registry.unit 的唯一性、相对次序、完整名称序列守卫

# response rewrite order
rg -n '(RESPONSE_REWRITE_ORDER|registration order|recover-tool-call|server-tool-filter)' src tests
# => rewrite-registry.ts 契约；response-rewrite-contract.unit.test.ts 的相对次序、forward-only 与错误顺序正样本

# lifecycle／middleware
rg -n -i '(shutdown|force-close|server.close|broadcast|observer|drain|history|telemetry)' tests | rg '(shutdown|lifecycle|restart)'
rg -n -i '(unknownEndpointFinalizer|trimTrailingSlash|openapi|liveness|registration order)' tests src/server.ts src/routes/openapi.ts
# => shutdown 全序测试与 production unknown-endpoint 专测；liveness 仅由 createFullTestApp 测

# 双写／镜像
rg -n -i --glob '*.ts' '(MUST be mirrored|lockstep owner|same commit|not linked by a shared|correct-by-inspection|Mirror src/server)' src tests
# => UsageData 双份有 type-level parity test；WS abort glue 明示 correct-by-inspection；test-app 明示 Mirror src/server

# 两项关键否定性核验
rg -n 'acc\.streamError' src/routes/responses/ws.ts src/routes/responses/handler-v4.ts
# => HTTP 有处理分支；WS 只有“below”注释，无处理分支
rg -n '(terminal upstream.*error|upstream error frame|type.:.error)' tests/responses/{ws-buffered.it.test.ts,responses-ws.http.test.ts,ws-buffered-close-timing.it.test.ts
# => 无 WS clean-drain terminal type:error 行为测试
rg -n '(registerClientAbort|wsClientAborts|correct-by-inspection)' src/routes/responses/ws.ts tests
# => 生产 registry 接线 + tests 中明确承认真实 onClose→abort glue 未被 harness 触达
```

环境说明：`fd` 不可用（`/bin/bash: fd: command not found`），文件名搜索改用只读 `find`；不影响内容检索范围。全程未启动、重启或触碰 4141 服务器。
