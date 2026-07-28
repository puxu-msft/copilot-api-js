# 合并态评审：commit window 180s、ingress deadline 与 Q1 文档

- 评审基线：`35a0f96e2f16ba98cf824c49b892230ec3f928d6`
- 方法：从 Git 对象提取 `/tmp/copilot-api-js-review-35a0f96e` 独立快照；只读代码、文档与原始实验 JSON；测试与 mutation 均在 `/tmp` 快照执行，不监听端口。
- 状态：逐项核验进行中；本文件按检查项即时追加，最终 verdict 见文末。

## 检查项 1：ingress deadline 与既有时间语义

### 结论

`RequestContext` 的 `startedAt` 仍在 handler 内 `codec.parse()` 时创建，而 `ingressAtMs` 在 config/token middleware 的 await 之前创建；因此 ingress-relative deadline 不改变 `timing.client.*` 的既定 entry-relative 语义。`streamOpenMs` 仍由真实 commit instant 减 `RequestContext.startTime` 得到，`firstRealMs`、`bufferHoldStartMs` 同基；遥测与 `MetaSegment` 用这些量作差仍自洽。forwarded `clientResponse.sseEvents[].offsetMs` 仍以 commit 附近的 `streamStartMs` 为原点。

但合并态仍有两处消费者违反这个双原点契约，默认窗口从 20s 提到 180s 后把诊断误差放大到分钟级：

1. **[major] `/tmp/copilot-api-js-review-35a0f96e/ui-v4/src/components/detail/segments/SseEventsSegment.tsx:33` — forwarded/upstream SSE 帧的绝对钟点被错误显示为 `entry.startedAt + offsetMs`。** 生产者在 `/tmp/copilot-api-js-review-35a0f96e/src/routes/messages/handler-v4.ts:621-628` 于 commit 时捕获 `commitInstant`/`streamStartMs`，sink 在 `/tmp/copilot-api-js-review-35a0f96e/src/lib/pipeline/client-sink.ts:215-217` 写 `Date.now() - streamStartMs`；冻结 spec 也在 `/tmp/copilot-api-js-review-35a0f96e/docs/spec/2026-07-14-request-timing-instrumentation.md:85-87` 明确要求混排时换算或分轴。当前 UI 却把两条轨都传 `entry.startedAt`（`:71`、`:80`），导致 delayed-commit forwarded 帧显示提前约 `timing.client.streamOpenMs`；默认 180s 时通常接近 3 分钟。修复建议：`FrameList` 显式接收时间基；forwarded 轨用 `entry.startedAt + (entry.timing?.client?.streamOpenMs ?? 0)`，upstream 轨必须使用其真实 attempt/collector 原点，若持久化记录没有可证明的原点则只显示 elapsed 或“绝对时间不可用”，不可继续伪造绝对钟点。建议由 `gpt-souls:implementer` 修代码并补一个 `streamOpenMs=180000, offsetMs=20000` 的 UI 回归测试。

2. **[minor] `/tmp/copilot-api-js-review-35a0f96e/.claude/skills/debugging-claude-client-connection/SKILL.md:47` — 收尾提交仍把 forwarded offset 的换算写成 `entry.startedAt + streamCommitAfterSec + offsetMs`。** ingress-relative 改动后，pre-handler 已耗时会从窗口扣除；而 `entry.startedAt` 是 handler 内创建 ctx 的时刻（`/tmp/copilot-api-js-review-35a0f96e/src/lib/context/request.ts:220-254`），不是 ingress stamp。因此固定加配置值会把 pre-handler 耗时重复算入，且 settled-within-window、立即 commit、clamp/热重载均不能由固定默认值重建。修复建议：新行优先使用持久化的 `entry.timing.client.streamOpenMs`，即 `entry.startedAt + streamOpenMs + offsetMs`；旧行没有 `streamOpenMs` 时只允许标注估算及其前提，不应给出精确公式。建议由 `gpt-souls:instruction-smith` 修 skill。

### 已核证据

- `rg -n "setClientTimingEpoch\(\"streamOpen\"|streamStartMs|offsetMs"` 覆盖 `handler-v4.ts`、`client-sink.ts`、`context/request.ts`，正样本命中 `handler-v4.ts:545-546,621-628` 与 `client-sink.ts:216`。
- `rg -n "startedAt \+ f\.offsetMs|startedAt.*offsetMs"` 覆盖 `ui-v4/`、`src/`、`docs/`，唯一代码消费者正样本为 `SseEventsSegment.tsx:33`。
- `MetaSegment.tsx:31-39` 使用 `firstRealMs - streamOpenMs`、`firstRealMs - bufferHoldStartMs`，未混入 SSE offset；`observability/sinks/telemetry.ts:80-82` 消费 entry-relative client timing，未发现固定加 180 的逻辑。


## 检查项 2：默认 180s 与其它超时、窗口的相对关系

### 结论

未发现 `180s` 引入运行时次序颠倒。逐项时钟如下：

- delayed commit：从 ingress 起 `180s`，上限 `240s`（`src/lib/state-defaults.ts:83`、`src/lib/config/config.ts:220-254`、`src/routes/messages/handler-v4.ts:575-608`）。
- 冷启动 ping：commit callback 内立即写，之后 cadence 为 `20s`；buffered fallback 为 `15s`（`handler-v4.ts:621-666`、`state-defaults.ts:80,85`）。两者都在 commit **之后**启动。
- content escalation：`streamKeepaliveEscalateSec=200` 传入 delivery session（`handler-v4.ts:1071-1123`），session 在构造时把 `lastContentDeltaAtMonotonic` 初始化为当前 commit 后时刻（`src/lib/pipeline/delivery/session.ts:52-64`），到 `now-lastContentDelta>=200s` 才升级（`:116-143`）。所以它不是 ingress 后 200s、不会在 180s commit 之前触发；默认纯静默路径的首次升级约在 ingress 后 `180+200=380s`。这符合“post-commit content escalation”的设计。
- shipped `config.yaml` 的 app guards 为 `response_header=600`、`stream_idle=600`、`stale_request_max_age=1200`、`request_deadline=1200`（`config.yaml:227-261`）；都晚于 180s commit。上游 response-header guard 会在 commit 后继续等待至其自身 attempt deadline，stream-idle 只在拿到响应 body 后生效；request deadline/reaper 是请求总生命周期上限。
- reaper scan cadence 由 `staleRequestMaxAge/3` 得出并 clamp（`src/lib/context/manager.ts:225-238`），但 `request_deadline` 是精确 per-request timer（`:405-425`），不存在 scan 周期早于 commit 而误杀默认请求的情况。
- rate-limit queue wait 计入 `driver.runRequest()` 的未 settle 时间，因而会消耗 ingress commit budget；这是 deadline 语义的自然结果，不是另一个更早 timeout。`request_deadline=1200` 才是其总生命周期硬上限。

### 文档性关联问题

`180 < 200` 单看数字容易误判 escalation 在 commit 后 20s 触发；实现证明两个常量原点不同。当前 `docs/DESIGN.md:305-307` 已分别描述 commit 与 pre-content escalation，但建议未来在 `streamKeepaliveEscalateSec` 行明确写“阈值从 delivery session/stream open 起锚”，防止再次把两者放在同一 ingress 轴比较。此项是主观建议，不影响正确性。

### 检索证据

检索范围为 `src/`、`packages/`、`config.yaml`、`config.schema.json`、`docs/`、`.claude/skills/`；表达式覆盖 `streamKeepalivePingSec|streamKeepaliveEscalateSec|responseHeaderTimeout|streamIdleTimeout|request_deadline|staleRequestMaxAge|reaper|queue.*wait|heartbeat`。正样本命中 `config.yaml:230,238,255,261,341,747,751,754`，证明检索触达全部指定 knob。


## 检查项 3：`ingressAtMs` 接线完整性与 fallback

### 结论

当前生产 HTTP 接线完整：`registerHttpRoutes()` 把 `/v1/messages` 与 `/anthropic/v1/messages` 都挂到同一个 `messagesRoutes`（`src/routes/index.ts:63-65`），两者都在 `createServer()` 的全局 config/token middleware 之后（`src/server.ts:127-163`），因此均先盖 `ingressAtMs` 再进入 `handleMessagesV4`。WebSocket、debug dry-run、反向 outbound `/v1/messages` leg 不调用这个 HTTP handler 的 delayed-commit 分支，不属于遗漏入口。全仓检索 `get("ingressAtMs")|set("ingressAtMs")` 的正样本为生产 producer `server.ts:138`、handler consumer `handler-v4.ts:588`、测试 producer `commit-window-ingress-deadline.http.test.ts:57`，未发现第二个生产 consumer 或旁路 producer。

fallback `ingressAtMs===undefined ? elapsed=0` 在测试 app、直接 `registerHttpRoutes(new Hono())` 及潜在未来内部入口上保持旧 handler-local 行为，不会崩溃；但它完全静默，不记录 feature/warning。结合该字段跨 middleware/handler 的承重性，这形成两个集成问题：

1. **[major] `/tmp/copilot-api-js-review-35a0f96e/tests/anthropic/commit-window-ingress-deadline.http.test.ts:54-62` — 新测试复制 producer，而没有验证生产 `createServer()` producer 接线。** 我在精确快照删除 `/tmp/copilot-api-js-review-35a0f96e/src/server.ts:138` 的唯一生产 `set("ingressAtMs", ...)` 后，三条新增 deadline 测试仍 `3 pass / 0 fail`；再跑 `tests/infra/{basic-routes,api-endpoints-smoke}.http.test.ts` 仍 `27 pass / 0 fail`。原因是目标测试自己的 `preMiddleware` 在 `:57` 重新盖章，证明 handler 算术而非生产 wiring。这样一次未来重构删掉/后移生产 stamp 会全绿，核心 240s 余量保证却失效。修复建议：抽一个生产拥有的 `stampRequestIngress` middleware primitive，由 `createServer` 与测试 app 同源复用；至少增加基于 `createServer().request()` 的 wiring 测试，注入 slow token/config seam 后断言剩余窗口。不要继续在测试内手写同名字串。建议由 `gpt-souls:implementer` 修复。

2. **[minor] `/tmp/copilot-api-js-review-35a0f96e/src/routes/messages/handler-v4.ts:588-590` — 缺 stamp 时静默回退，无可观测信号。** `docs/DESIGN.md:304` 已把“生产 stamp 顺序”写成架构契约，但代码无法区分合法测试旁路与生产接线回归。修复建议：把 stamp 纳入 typed Hono Env，并在 delayed streaming request 缺值时记录一次结构化 feature/warning（测试可显式声明 legacy fallback），或将 handler API 改为必须接收已解析的 ingress epoch；长远优先消除字符串 ctx key + optional cast。

### 已验证的旁路

- `src/routes/debug/dry-run-pipeline.ts:239-256` 只调用 `driver.inspectRequest`，不执行 `handleMessagesV4`/stream commit。
- `tests/e2e-client/harness/serve-in-process.ts:20-23` 使用 `createFullTestApp()`，因此测试服务器确实走 fallback，但其现有场景是快速流；若将来用它验证长 pre-header 行为，必须显式装生产同源 middleware。
- 全仓 `handleMessagesV4(` 只有 `src/routes/messages/route.ts:11` 一个调用站点；正样本证明检索触达目标。


## 检查项 4 与 6：文档、配置、schema、Q1 证据的合并态一致性

### Q1 权威声明

Q1 的核心结论有独立 ground truth 支撑，未发现代码常量与 FINDINGS 冲突：

- 原始 `firstfail.observations.json` 四次 abort 为 `299667/300268/300280/300256ms`；`barefetch.client.json` 为 `300986ms` 且 cause code=`UND_ERR_HEADERS_TIMEOUT`；`rawsocket` 对照与 FINDINGS 的作用域限定排除了服务端 300s。
- `env-force-idle-0.observations.json` 只有 1 attempt、`answeredAfterMs=600001`，client JSON `exitCode=0/is_error=false`；并发 unset 对照在约 300s abort。Claude Code 2.1.207 打包源码正样本 `/home/xp/.claude/refs/claude-code-2.1.207/app.pretty.js:52923` 显示 `API_FORCE_IDLE_TIMEOUT` 参与 `{timeout:false}`，`:88111` 把该 fetchOptions 交给 Anthropic client。故“CC 暴露该 env 开关、实测 600s 成功”的窄结论成立；FINDINGS 也正确限定 600s 不是新上限、代理不能替客户端设置。
- `src/lib/config/config.ts:220-231` 将 `COMMIT_WINDOW_MAX_SEC=240` 明确建立在约 300s 默认之下；`config.yaml:745-747`、`src/lib/state-defaults.ts:83`、`docs/DESIGN.md:304` 均为默认 180/ceiling 240。

### schema 复核

收尾声称“`config.schema.json` 无需重新生成，因为 `stream_commit_after_sec` 节点既无 description 也无 default”在本次改动上成立，但其一般形式需要精确限定：

- generator 是 `/tmp/copilot-api-js-review-35a0f96e/scripts/generate-config-json-schema.ts:19-43`：导入 `ConfigSchema`，调用 `z.toJSONSchema(..., {io:"input"})` 后写 JSON；`package.json:45` 只包装该脚本。
- `stream_commit_after_sec` 在 `src/lib/config/schema.ts:694-703` 只有普通 TSDoc + `nullableNonnegativeInt()`，没有 Zod `.describe()`、`.default()` 或约束变化；生成节点确实只有 nullable integer/min/max（`config.schema.json:1225-1235`）。TypeScript/TSDoc 注释不进入运行时 Zod schema，所以本轮只改 TSDoc 不影响 JSON。
- 一般形式不是“schema 注释永远不影响 JSON”：Zod `.describe()` 会进入 JSON。正样本是 `schema.ts:224,236` 两个 `.describe()`，对应 `config.schema.json:1424,1470,...` 的 description。`.default()`、enum、min/max、nullable、transform input shape 等运行时 Zod 变化也会影响 JSON。
- 我在 35a0f96e 快照运行 generator，并与 `git show 35a0f96e:config.schema.json` 逐字节 `cmp`，结果 exact match。因此无需提交 schema 变更的结论已独立验证。

### 事实性发现

1. **[major] `/tmp/copilot-api-js-review-35a0f96e/docs/DESIGN.md:307` — 架构 SSOT 仍保留收尾提交刚从 skill 修掉的两条错误。** 该行仍写 CC watchdog“有两层”以及 300s 层“只有真实 `content_block_delta` 重置”；修正后的 skill `/.claude/skills/debugging-claude-client-connection/SKILL.md:14-27` 与同一计划研究 `docs/plan/2026-07-27-keepalive-and-separator/research-keepalive-options.md:13,72-78` 已证明应是三层，post-header 300s 的判据是任何 non-ping event。`DESIGN.md` 是项目声明的架构单一事实源，这种跨文档矛盾会让后续 keepalive 方案按错误 oracle 设计。修复建议：把 DESIGN 同步为三层，并将该行的 reset predicate 改为“SDK 吐给 CC 的任何 non-ping event”；保留“空 content delta 是低副作用可重置载体”，不要把载体选择误写成唯一判据。建议由 `gpt-souls:doc-writer` 做 doc↔code/skill 对账。

2. **[major] `/tmp/copilot-api-js-review-35a0f96e/.claude/skills/debugging-claude-client-connection/SKILL.md:40-45` 与 `/tmp/copilot-api-js-review-35a0f96e/docs/DESIGN.md:328-329,357` — 运维文档把内建 fallback 300/600 当成真实 shipped 默认，已与 `config.yaml` 漂移。** 实际随包读取的 canonical bundled config 是 `response_header=600`、`stream_idle=600`、`stale_request_max_age=1200`、`request_deadline=1200`（`config.yaml:227-261`；`loadBundledDefaultConfig()` 直接读取也输出这四值），而 `CONFIG_MANAGED_DEFAULTS` 才是 300/300/600/0（`state-defaults.ts:206-217`）。每个真实 run 先合并 bundled config，故 skill 用“duration≈300/600”判 header-timeout vs reaper 会把当前默认部署的 600/1200 秒事件错分；DESIGN 的默认列也没有标明“无 bundled config 时 fallback”。修复建议：统一明确两层：shipped effective default 与 code fallback；诊断 skill 应首先读取该 entry 的 `pipelineInfo`/运行时 effective config，缺失时才按版本化 shipped 值估算，不能把 300/600 当普适判据。`request_deadline` 还可能先于 periodic reaper，归因必须读 attribution/code。

3. **[minor] `/tmp/copilot-api-js-review-35a0f96e/docs/DESIGN.md:304` — “opus pre-response thinking，实测 ≤~13s 偶超”与同一行后面的 deferred-header 事故证据、spec 的 47-231s 成功样本冲突。** 这句显然是旧分布残留；本轮默认 180 的依据正是合法/事故 pre-header 可达分钟级。修复建议：删除该上界式措辞，改为“常见短、但 deferred-header 实测成功样本达 47-231s，事故 RST 126-206s”。

4. **[minor] `/tmp/copilot-api-js-review-35a0f96e/docs/memory/project-upstream-silence-commit-timing-spec.md:17` — “事故 RST 126-206s 整段落在窗口内，故 B1 抬默认窗口即可覆盖事故形态”未同步最终 180 取值。** 同段后部虽说 master 默认 180，但 180 并不覆盖 180-206；live DESIGN/plan 已正确写“只覆盖前半段”。作为 memory 引用层，这会向新会话注入错误摘要。修复建议：改为“整段落在可配置 240 ceiling 内；默认 180 只覆盖 126-180，余段仍归 B2”。

### 未发现的指定项

- `docs/API.md` 不承载 config 默认值，检索无 `stream_commit_after_sec` 命中；按项目路由，配置行为由 DESIGN/config/schema 承载，不构成缺失。
- spec 中 `streamCommitAfterSec=20` 的命中位于事故历史叙述，live 机制段已在 `docs/spec/2026-07-23-upstream-silence-commit-timing.md:57,214` 明示默认 180/ceiling 240；不是应机械替换的 stale value。


## 检查项 5：新增测试的真实裁决力与 mutation

### 实跑结果

在精确 `35a0f96e` 快照直接运行：

```text
bun test tests/anthropic/commit-window-ingress-deadline.http.test.ts tests/config/buffered-retry-keys.unit.test.ts tests/config/bundled-config.unit.test.ts
34 pass / 0 fail / 3 files / 1.77s
```

独立 positive controls：

- 把 handler 的三行 ingress 扣减替换回 `remainingWindowMs = streamCommitAfterSec*1000`：deadline 文件 `1 pass / 2 fail`。这复现提交声称的 mutation，证明“全耗尽”和“部分耗尽”两条会咬 handler-local timer。
- 把 shipped `config.yaml` 的 `stream_commit_after_sec:180` 改回 20：bundled-config 文件 `4 pass / 1 fail`，失败正是“shipped commit window matches code default”。
- 删除生产 `server.ts` 唯一 stamp：deadline + 两个 route smoke 文件合计 `30 pass / 0 fail`。这是新增测试未想到的绕过，也是检查项 3 的 major finding。

### 各测试评价

- `commit-window-ingress-deadline.http.test.ts` 对**handler 算法**有裁决力：部分预算用例是关键，unstamped 对照也防止“缺 stamp 被当作零窗口”。但它对**生产 wiring**假绿，因为 producer 由测试复制。
- `buffered-retry-keys.unit.test.ts:103-140` 锁住 clamp 的入口独立性、常量 240/40、code default 180 与相对不等式。其绕过面是数字同源不足：测试把 `MEASURED_PRE_HEADER_ABORT_SEC=300` 本地硬编码，不能侦测 FINDINGS/客户端版本更新；这属于标定更新流程问题，不是当前回归缺陷。更实质的是 `expect(default).toBeLessThan(max)` 不锁预期余量 60，默认误改成 239 仍全绿；不过 bundled config 会随 code default 同步时也绿。建议补显式产品 contract `default=180` 和 `max-default>=60`，或将选择写成命名常量/决策测试。
- `bundled-config.unit.test.ts:43-48` 有效防 `config.yaml` 与 `CONFIG_MANAGED_DEFAULTS` 漂移，但只覆盖 commit window；本次审计实际发现其它 timeout 的 shipped effective defaults 与 docs/code fallback 混淆，说明“匹配 code fallback”并非所有配置的通用正确不变量。不要照抄此测试到 response_header 等字段，除非先决定 bundled 与 fallback 必须相同。

### 事实性发现汇总

测试层新增 1 个 major（生产 stamp 接线未覆盖，详见检查项 3）；其余 mutation 结论成立。未发现测试会访问 4141 或启动监听服务，本次也未启动任何 server。


## 总体 verdict

- 评审范围：`35a0f96e` 合并态，覆盖 ingress deadline、History/遥测/UI 时间基、180s 与其它超时/keepalive 次序、`ingressAtMs` 全入口接线、配置/schema/spec/plan/skill/memory 对账、Q1 原始证据、三组新增测试与 mutation。
- verdict：**修复 major 后可进入下一阶段**。
- blocker：**0**。
- 发现计数：**major 4、minor 4、主观建议 1**。

### 事实性发现索引（按严重度）

1. **[major]** `ui-v4/src/components/detail/segments/SseEventsSegment.tsx:33` — 把 commit-relative SSE offset 当 entry-relative，绝对时钟点提前约 180s；见检查项 1。
2. **[major]** `tests/anthropic/commit-window-ingress-deadline.http.test.ts:54-62` — 复制测试 producer，删除生产 `server.ts:138` stamp 后目标测试与 route smoke 仍全绿；见检查项 3/5。
3. **[major]** `docs/DESIGN.md:307` — 架构 SSOT 仍写“两层 watchdog/只有 content_block_delta 重置”，与已修 skill 和源码读证矛盾；见检查项 4/6。
4. **[major]** `.claude/skills/debugging-claude-client-connection/SKILL.md:40-45`、`docs/DESIGN.md:328-329,357` — 把 code fallback 300/600 写成 shipped 默认，实际 bundled effective 值为 600/1200，诊断会错分；见检查项 4/6。
5. **[minor]** `.claude/skills/debugging-claude-client-connection/SKILL.md:47` — ingress-relative 后仍用固定 `streamCommitAfterSec` 换算 offset；应读 `timing.client.streamOpenMs`；见检查项 1。
6. **[minor]** `src/routes/messages/handler-v4.ts:588-590` — 缺 ingress stamp 静默回退，无 warning/feature/type contract；见检查项 3。
7. **[minor]** `docs/DESIGN.md:304` — “pre-response thinking 实测 ≤~13s 偶超”与 47-231s deferred-header 成功样本冲突；见检查项 4/6。
8. **[minor]** `docs/memory/project-upstream-silence-commit-timing-spec.md:17` — 摘要称默认窗口覆盖 126-206s 整段，实际 180 只覆盖 126-180；见检查项 4/6。

### 主观建议

- **[建议]** `docs/DESIGN.md:305-307` — 明确 `streamKeepaliveEscalateSec` 从 delivery session/stream open 起锚，而非 ingress；预期影响是避免未来把 180 与 200 错放在同一时间轴比较。

### 已确认成立的关键结论

- `streamKeepaliveEscalateSec=200` 是 post-commit content-idle 阈值；默认 180s commit 后约再等 200s，不存在 200 在 commit 前触发的次序颠倒。
- Q1 的约 300s、undici `headersTimeout` 归因及 `API_FORCE_IDLE_TIMEOUT=0` 的 600s 成功臂有原始 JSON与打包源码支撑，且作用域限制写得诚实。
- `config.schema.json` 在 35a0f96e 与 generator 输出逐字节一致；本轮只改普通 TSDoc，不影响 Zod runtime schema。一般规则是普通 TSDoc 不影响，但 `.describe()`/`.default()`/约束与 input shape 会影响。
- handler-local timer mutation 确实使 deadline 测试 2/3 失败；bundled config 改回 20 确实使对应测试失败。

### 推荐修复路由

- 代码与测试接线：`gpt-souls:implementer`。
- DESIGN、memory 与 skill 对账：项目文档由 `gpt-souls:doc-writer`，skill 指令文本由 `gpt-souls:instruction-smith`；修后建议复用本报告的检索式做一次 merged-state 复审。
