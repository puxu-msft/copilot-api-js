# Plan：proxy 合成/改写帧的 forwarded 轨 & 遥测完整性（TDD 实施计划）

> 状态：**定稿（异模型对抗评审：GPT 独立复现探针 13 pass + 逐 Task 红绿核验，0 blocker，全 minor 已吸收）→ 可执行**。日期 2026-07-20。
> 派生自 spec [docs/spec/2026-07-20-synthetic-frame-forwarded-track-completeness.md](../spec/2026-07-20-synthetic-frame-forwarded-track-completeness.md)（设计定稿，两轮异模型对抗评审 0 blocker）。
> Unit 2 gatekeeper 已实测收敛（见 §0 探针结论）。

## §0 探针结论（Unit 2 gatekeeper，已实测，plan 据此收窄）

**问题**：`responseFrame` 加 `...frame` 展开后，`hook-rewrite` Symbol tag 能否存活到 Responses 的 HTTP + WS forwarded 轨？

**实测证据**（2026-07-20，`bun test tests/pipeline/hooks/driver-provenance.unit.test.ts` = 13 pass / 0 fail）：
- **正样本**（[driver-provenance.unit.test.ts:243-256](../../tests/pipeline/hooks/driver-provenance.unit.test.ts#L243)）：`onRenderedFrame` 用 `{...frame, data}` 展开 → forwarded 记录带 `synthetic:"hook-rewrite"`。**绿**。
- **负样本**（KNOWN-GAP，[:275-288](../../tests/pipeline/hooks/driver-provenance.unit.test.ts#L275)）：`onRenderedFrame` 建全新字面量 `{data}` → tag 丢失。**绿（断言丢失）**。`responseFrame` 与此 negative control 逐字同构。

**静态追踪补全端到端**（已读代码）：
- buffered-merge `transformFlush`（[buffered-merge-reducer.ts:143-191](../../src/lib/codec/openai-responses/buffered-merge-reducer.ts#L143)）：非 drop、非 terminal 帧一律 `working.push(f)` **按对象引用透传**（:147/:163）——tag 存活。
- delivery-session `writeToSink`（[delivery/session.ts:249-271](../../src/lib/pipeline/delivery/session.ts#L249)）：常规帧（provenance≠`synthetic`）走 **default 分支** `sink.write(entry.frame)`，`entry.frame` 是原帧对象引用（[:241](../../src/lib/pipeline/delivery/session.ts#L241)）。
- `makeWsSink.write`（[client-sink.ts:626-630](../../src/lib/pipeline/client-sink.ts#L626)）= `sampleForwarded(frame, readSyntheticKind(frame))`——读 tag（与 HTTP `write()`:291 对称）。

**结论**：**Unit 2 = 单点改 `responseFrame` 展开，覆盖 HTTP + WS 两 transport**。无需碰 ws.ts / delivery-session。两处**减法边界丢标记、可接受**（richest-data-flow ②b，两轨 diff 可还原）：① drop-delta 丢弃的 delta 帧（本就是订阅式丢弃）；② repair 重建的 terminal 帧被 `buffered-terminal-repair` 覆盖 hook-rewrite（罕见、且 terminal 帧非典型 hook 改写目标）。Task 2.2 加端到端测试闭合 + 文档化这两个边界。

## 全局约束 & 纪律

- **TDD**：每 Task 先写红测、再实现转绿。红→绿→（必要时）重构。
- **golden lock（CF-2）**：所有改动在 `error_shaping_enabled=false` / 无 tag 时**必须**字节等价旧行为——Symbol tag 不进 `JSON.stringify`/SSE 序列化（[client-sink.ts:182-190](../../src/lib/pipeline/client-sink.ts#L182) writeSse 只读 data/event/id/retry），已 GPT 探针实测确认零 wire 变化。
- **三单元逻辑独立**、可各自交付、可并行；仅 Unit 1↔Unit 3 改 `messages/handler-v4.ts` 不同区域（merge 卫生：行级共存 + 显式 pathspec）。
- **顺序内不变量（Unit 3）**：`writeSynthetic` 读-tag 根因修**先于** `shapeRawStreamErrorFrame` 打 tag——否则中间态标记不 surface（但不破 wire、无害）。
- **持久化不变量**：新 `recordFeature` 必在 `ctx.fail` **之前**（settle 冻结快照前 record，skill `persistence-async-invariants`）；Unit 1 的 `writeTerminalThenSettle` 须 `finally` 兜底 settle（write reject 不得跳过 fail）。
- **每 Task 后**：`bun run typecheck` 绿 + 相关测试绿；每语义单元一提交（conventional commits、显式 pathspec、无模型署名）。

## 建议执行顺序

**Unit 2（最小、已探针）→ Unit 3（含根因修，波及面已核实）→ Unit 1（catch 重排，风险最高）**。三者独立，也可并行分派到 worktree——**若并行**，Phase D 合并态审查须**逐行核对 `handler-v4.ts` 两组改动**（Unit 1 的 614-671 vs Unit 3 的 1247/1366/1502/1534 + 1338/1394/1568）无交叉污染。

---

## Phase A — Unit 2：Responses `responseFrame` 恢复 hook-rewrite 标记 + id/retry 保真

### Task A.1 — 单点展开 `responseFrame`（红→绿）

- **红**：翻转 KNOWN-GAP 测试 [driver-provenance.unit.test.ts:275-288](../../tests/pipeline/hooks/driver-provenance.unit.test.ts#L275)——它当前断言「fresh literal 丢 tag」。**不删该 test**（它记录 driver 层通用契约），改为**新增**一条 Responses-specific 测试（见 Task A.2）承接。本 Task 的红测在 A.2。
- **绿（实现）**：[candidate-response-session.ts:190-197](../../src/routes/responses/candidate-response-session.ts#L190) `responseFrame`：
  ```ts
  function responseFrame(transport, frame, event, mapper): ClientFrame {
    const data = restoreResponsesStreamFrameToolNames(frame.data ?? "", event.type, mapper)
    return transport === "ws" ? { ...frame, data } : { ...frame, event: frame.event ?? event.type, data }
  }
  ```
  - **HTTP event 回退必须显式保留**：viaFallback 腿帧 `frame.event===undefined`，纯 `{...frame, data}` 会让 [client-sink.ts:186](../../src/lib/pipeline/client-sink.ts#L186) 省略 `event:` 行破 wire。展开使 Symbol tag + id/retry 随行。
  - **WS**：`{...frame, data}`，WS wire 仅发 `frame.data`，event/id/retry 对 WS wire 无效、收益是 forwarded 轨 tag。

### Task A.2 — Responses 端到端 forwarded-tag 测试（HTTP direct + fallback + WS）

- **新增测试**（`tests/routes/responses/hook-rewrite-provenance.*.test.ts` 或就近 candidate-session 测试）：经真实 Responses candidate-session + buffered(默认 ON)路径，注入一个 `upstream.inbound` 改写 hook，断言：
  - HTTP direct：forwarded 记录带 `synthetic:"hook-rewrite"`、`event:` 回退存活、id/retry 保真。
  - HTTP viaFallback（CC→Responses）：同上，`event:` 回退存活（frame.event undefined 场景）。
  - WS：forwarded 记录带 `synthetic:"hook-rewrite"`；断言 event/id/retry **不属** WS wire（防误期望）。
  - **正样本对照**：先证一个**未改写**的真实上游帧在同轨 `synthetic===undefined`，再证改写帧 `!==`。
- **两处减法边界的文档化测试**（richest-data-flow ②b）：
  - drop-delta 丢弃的 hook-rewritten delta 帧：断言其从 forwarded 轨消失（subtractive、可两轨 diff 还原）——**不是 bug**，固化为 characterization。
  - repair 重建 terminal 帧：若原 terminal 帧带 hook-rewrite，重建后标记为 `buffered-terminal-repair`（覆盖）——固化为 characterization + 注释解释。

### Task A.3 — golden 重对齐（若有）

- id/retry 保真预计零 wire 变化（真实 Responses 帧通常无 `id:`/`retry:` 行）。若 `responses-v4.http.test.ts` / `c0-ws-terminal-golden.http.test.ts` 出现 diff，按「有意的更完整转发」重对齐、commit message 记明。**若 diff 出现在 `id:`/`retry:` 行——是预期的 richest-data-flow 改进（not a regression），直接重录 golden，别自我怀疑。**
- **验收**：Phase A 全绿；`bun run typecheck` 绿。翻绿 driver-provenance 的 Responses 承接测试。

---

## Phase B — Unit 3：raw-stream canonical error 终点补 synthetic 标记 + 遥测维度

### Task B.1 — `writeSynthetic` 读 tag 根因修（红→绿，通用闭合）

- **红**：新增单元测试（`tests/pipeline/client-sink.unit.test.ts`）：构造手工打了 `hook-rewrite` tag 的 frame，直接调 `writeSynthetic`，断言 forwarded 记录带 `synthetic:"hook-rewrite"`。当前**红**（writeSynthetic 传 undefined）。
- **绿（实现）**：[client-sink.ts:302-305](../../src/lib/pipeline/client-sink.ts#L302)（SSE sink）+ [client-sink.ts:635-638](../../src/lib/pipeline/client-sink.ts#L635)（WS sink）的 `writeSynthetic`：
  ```ts
  const writeSynthetic = (frame) => { sampleForwarded(frame, readSyntheticKind(frame), "synthetic"); return writeSse(frame) }
  ```
  对齐 `write()` 的 tag 读取。第 3 参 `"synthetic"` 保留（generation 轨语义不变）。
- **不回归矩阵测试**（高优先、影响横跨 5 vendor 路由）：Anthropic / Gemini / Chat-Completions / Responses-HTTP 四路由的 `writeSynthetic` 调用点，改动前后 forwarded 记录 `synthetic` 字段**保持不变**（均 undefined→undefined，因这些帧本就未 tag——已代码级核实无「已 tag 却经 writeSynthetic」回归候选：`buffered-terminal-repair`/`refusal-recovery`/`error-shaping-auq` 走 `write()`/`writeAnchor` 不经 writeSynthetic）。
- **契约留痕**：更新 [client-sink.ts:24-29](../../src/lib/pipeline/client-sink.ts#L24) 头注释（writeSynthetic 现读 tag，forwarded 轨不再恒 undefined）；顺带核对 [frame-origin.ts](../../src/lib/pipeline/frame-origin.ts) 顶部模块注释「仅 `write()` 消费此 tag」类表述是否需补 writeSynthetic（现两者都读同一 tag 原语、语义仍成立，但措辞别误导未来读者）。

### Task B.2 — `shapeRawStreamErrorFrame` 打 canonical tag（红→绿）

- **红**：新增测试断言 `shapeRawStreamErrorFrame(...)`（enabled）返回的帧 `readSyntheticKind===`"error-shaping-canonical"`；disabled 返 legacyFrame **不打 tag**（CF-2 golden lock）。
- **绿（实现）**：[error-shaping-glue.ts:219-222](../../src/routes/messages/error-shaping-glue.ts#L219)：
  ```ts
  export function shapeRawStreamErrorFrame(errorType, message, legacyFrame): ClientFrame {
    if (!state.errorShapingEnabled) return legacyFrame
    return tagFrameSynthetic(buildCanonicalErrorFrame({ kind: "canonical-error", errorType, message }), "error-shaping-canonical")
  }
  ```
  `"error-shaping-canonical"` 已是 [client-sink.ts:194](../../src/lib/pipeline/client-sink.ts#L194) 合法 union 成员，无需扩类型。
- **对偶参照**：Responses WS 侧 error-terminal（[ws.ts:157-166](../../src/routes/responses/ws.ts#L157)）已在 record 上打此标记——本 Task 把 Anthropic messages HTTP `writeSynthetic` 侧补齐到同等水平。
- **依赖**：B.1 先落地（顺序内不变量），否则 B.2 的 tag 不 surface（但不破 wire）。

### Task B.3 — 新 FeatureKind `error-shaping-raw-canonical`（红→绿）

- **红**：新增测试断言 4 个 canonical 终点（direct/translate × H3/截断）记 `error-shaping-raw-canonical` FeatureKind、detail `{ wireErrorType, terminus, leg }` 值域正确、**在 fail snapshot 前记录**。
  - **真相域（关键、别扑空）**：`recordFeature`/`request.feature_applied` **不落 history DB**（`FeatureKind` 全仓 0 命中 `src/lib/history/**`）；消费者只有 TUI [active-request-store.ts](../../src/lib/tui/active-request-store.ts)（`ActiveRequest.tags`）+ WS 推送 [observability/sinks/ws.ts](../../src/lib/observability/sinks/ws.ts)。故验收测试断言在**事件总线**（订阅 `request.feature_applied`）或 **TUI tags**，**不是** history entry。（同 [[methodology-plan-verify-interface-location-and-wiring-channel]]「recordFeature 不落盘」。）
- **绿（实现）**：
  1. [observability/events.ts:113+](../../src/lib/observability/events.ts#L113) FeatureKind union 加 `error-shaping-raw-canonical`，detail 注释 `{ wireErrorType: string; terminus: "stream-error"|"truncation"; leg: "direct"|"translate" }`。**`wireErrorType` 独立命名**（不复用 `error-shaping-decided.errorType` 的 `ApiErrorType` 枚举——同名混值域）。
  2. 4 个调用点（[handler-v4.ts:1247](../../src/routes/messages/handler-v4.ts#L1247)/[1366](../../src/routes/messages/handler-v4.ts#L1366)/[1502](../../src/routes/messages/handler-v4.ts#L1502)/[1534](../../src/routes/messages/handler-v4.ts#L1534)）在 `writeSynthetic` 前 + `ctx.fail` 前 `recordFeature("error-shaping-raw-canonical", {...})`。
  3. 更新穷尽 switch [active-request-store.ts:188](../../src/lib/tui/active-request-store.ts#L188) `featureTag`（**注意锚点已从旧 spec 的 tui/terminal-ui.ts 迁走**）。
- **消费面**：默认仅 TUI/history 诊断（对齐 `error-shaping-decided`），不接 `/api/status` 聚合——若需接入另议。
- **范围声明测试**：非-canonical 3 处合成 error 帧（tool-input-unrepairable [~1338](../../src/routes/messages/handler-v4.ts#L1338) / direct-pump throw [~1394](../../src/routes/messages/handler-v4.ts#L1394) / translate-pump throw [~1568](../../src/routes/messages/handler-v4.ts#L1568)）断言**不**被计入 raw-canonical 维度。
- **不硬塞 `decide()`**：raw-stream 是 transport/stream lifecycle failure，无可还原 ApiError，专属维度是长远正确形状。

### Task B.4 — 4 个 canonical 终点端到端验收

- 4 终点均断言：① forwarded history 帧带 `synthetic:"error-shaping-canonical"`（正样本对照：先证真实上游 error 帧同轨 synthetic=undefined）；② 记 FeatureKind 且值域正确；③ fail snapshot 前记录。
- **验收**：Phase B 全绿；`bun run typecheck` 绿。

---

## Phase C — Unit 1：delayed-commit catch 补 error 帧 + 锚点收口帧进 forwarded 轨

### Task C.1 — `writeTerminalThenSettle` helper + finally 兜底（红→绿）

- **红**：新增测试（`createFullTestApp()` 驱动 delayed-commit——与姊妹测试 [postcommit-error-shaping.it.test.ts](../../tests/routes/messages/postcommit-error-shaping.it.test.ts) 同模式：`streamCommitAfterSec` + gated FakeClock 逼出 POST-COMMIT 窗口，**无需**真实 `createServer`/非-4141 端口——本单元只改 handler catch 内部、不碰中间件/notFound，故不触发 [[reference-server-vs-test-app-dual-notfound-mirror]] 的真-server 要求）：对 timeout / HTTPError / unknown / `!result.ok` 四腿，断言 history `clientResponse.sseEvents` 帧序 == 实际 sink 帧序（含 `anchor stop@0`（若注锚）+ error 帧）。当前**红**（error 帧在 fail 后写、不进冻结 entry）。补一条 **write-reject 下仍 settle** 的回归。
- **绿（实现）**：[handler-v4.ts:614-671](../../src/routes/messages/handler-v4.ts#L614) 抽 helper `writeTerminalThenSettle(sink, anchor, buildFrame, settle)`：best-effort `closeAnchorIfOpen → writeSynthetic(errorFrame)`（帧在 write 尝试时已同步 sample 进 `forwardedSseEvents`），无论成败在 `finally` 中 `setForwardedResponse(snapshot) → ctx.fail`。四腿改用它：`closeAnchor → writeSynthetic → setForwarded → fail`。
- **reaper-cancel 腿经 helper 幂等安全**：其 `ctx.fail`（[request.ts:1674](../../src/lib/context/request.ts#L1674) `if (settled) return`）+ `setForwardedResponse`（纯状态覆盖）对已被 reaper 预 settle 的 ctx 重复调用**无害无副作用**——helper 无需为该腿特判。
- **顶部 622 快照仅为 client-abort 腿保留**；重排 4 腿在 helper 的 `finally` 各自 snapshot（对已被 622 覆盖的 pings 是幂等超集、无害、**别删 622**）。

### Task C.2 — 分腿验收 + reaper 排除固化

- **timeout 腿**：§C.1 重排修复 → 断言 forwarded 轨含 error 帧 + stop@0。
- **reaper-cancel 腿**：断言重排**不**改其 wire（reaper 已预 settle at [request.ts:1674](../../src/lib/context/request.ts#L1674)，handler 侧 setForwarded/fail 皆 no-op）；其 history 缺口**本轮不修**（§C.4 backlog）。验收测试对 timeout / reaper-cancel **分列断言**（共用 623-639 abort 分支代码但 `classifyPostCommitAbort` 判别后走向不同）。
- **client-abort 腿**：断言零额外 wire、history 只含 pings。

### Task C.3 — golden 回归

- 重排对 wire 字节应零变化（帧顺序、内容不变，仅 history 轨新增）。若既有 wire golden 出现 diff → 是回归，须查因（非预期）。

### Task C.4 — backlog 协调（Unit 1 收尾）

- 新增 backlog 项「reaper-cancel history 两阶段协议」（spec §1.3；旧 spec 声称加但 0 命中）——含「若实施须跨模块集成测试证 reaper fail 严格先于 handler catch」。
- **验收**：Phase C 全绿；`bun run typecheck` 绿。

---

## Phase D — 收尾（三单元合并后）

- **合并态审查**：三单元落地后派 subagent 审 merged state（尤其 Unit 1↔Unit 3 同文件不同区域的集成缝、writeSynthetic 契约变更的横切影响）。
- **doc-sync**：① 关闭/更正 `deferred-backlog.md` 三条同族条目（按标题定位、非行号）；② `client-sink.ts` 头注释已在 B.1 更新；③ 视情况 DESIGN.md 活的架构现状（writeSynthetic forwarded 采样契约变更）；④ spec + plan 头部状态注解 landed。
- **记忆维护**：更新 [[project-synthetic-frame-forwarded-track-completeness-spec]] stub 为 landed。
- **提交**：每 Task 细粒度提交；Phase 边界可合并态提交。

## 风险 & 缓解

| 风险 | 缓解 |
|---|---|
| Unit 3 writeSynthetic 通用闭合意外标记某已 tag 帧（回归） | B.1 不回归矩阵测试覆盖 5 vendor；已代码级核实无候选 |
| Unit 1 write-reject 跳过 settle → 永不 settle | `writeTerminalThenSettle` finally 兜底 + 专项回归测试 |
| Unit 2 buffered drop-delta/terminal-repair 丢 tag 被误判为 bug | A.2 characterization 测试 + 注释固化为「减法可接受」 |
| delayed-commit 测试须真实 server（中间件镜像陷阱） | 本单元不碰中间件/notFound → 用 `createFullTestApp()`（姊妹测试 postcommit-error-shaping.it 同模式，FakeClock 逼 POST-COMMIT 窗口），**无需**真 `createServer`/非-4141 端口 |

## Kick-off prompt（复制启动新会话/子代理）

```
执行 docs/plan/2026-07-20-synthetic-frame-forwarded-track-completeness.md。
按 Phase A（Unit 2）→ B（Unit 3）→ C（Unit 1）顺序 TDD（每 Task 先红测再实现转绿）。
裁判轴：长远正确 + 完整（richest-data-flow）> 兼容/回归风险；修根因非症状。
硬约束：CF-2 golden lock（off/无 tag 字节等价）；新 recordFeature 在 ctx.fail 前；
writeSynthetic 读-tag 先于 shapeRaw 打 tag；delayed-commit 测试用 createFullTestApp() + FakeClock（姊妹 postcommit-error-shaping.it 同模式，不起真 server）。
每 Task 后 bun run typecheck 绿 + 相关测试绿，细粒度显式-pathspec 提交。
Unit 2 gatekeeper 已探针收敛（§0）：单点改 responseFrame 覆盖 HTTP+WS。
```
