# Phase 3 执行报告：post-commit canonical 尾帧整形（S5 rewrite 拦截 + 四终点收编）

**状态**：完成。2 个提交落地 `feat/upstream-error-client-shaping`（Phase 0+1+2 之上）。

**提交**：
- `04c88acd` feat: add errorFrameCanonical S5 rewrite for upstream event:error frames (G-3)（Task 3.1）
- `140d1957` refactor: delegate post-commit terminal error frames to error-shaping builders (G-3 canonical ownership, 4 termini)（Task 3.2 + 3.3）

## 产出文件

### Task 3.1 —— S5 rewrite 拦截上游 `event:error` 帧
- `src/lib/codec/anthropic/error-frame-canonical-rewrite.ts`（新）—— `errorFrameCanonicalRewrite: ResponseRewrite`，`order=50`（最前）。`appliesTo = env.targetEndpoint === ENDPOINT.MESSAGES && state.errorShapingEnabled`（HIGH-2 两轴门控，与既有 5 条 rewrite 的 `ANTHROPIC(env)` 谓词内联同构，不新增跨文件导出）。`transform`：`frame.event !== "error"` → 原样 emit；否则 `buildCanonicalErrorFrameFromRaw(frame)` 整形后 emit。
- `src/lib/anthropic/error-shaping.ts`（改）—— 新增 `parseRawUpstreamErrorFrame(frame)`（容错抽取 `{type,message}`，优先内层 `error.{type,message}`、镜像 stream-accumulator 解析、**绝不把 `"error"` 判别符当作 taxonomy**）+ `buildCanonicalErrorFrameFromRaw(frame)`（G-3 唯一 raw-frame builder，unrecognized → `api_error`/generic message 兜底，never throw / never drop）。新增 `UpstreamFrame` type 导入。
- `src/lib/pipeline/rewrite-registry.ts`（改）—— `RESPONSE_REWRITE_ORDER` 顶部加 `errorFrameCanonical: 50`（< 既有 5 个），附排序不变量注释。
- `src/lib/codec/anthropic/response-rewrite-adapters.ts`（改）—— `ANTHROPIC_RESPONSE_REWRITES` 数组头部插入 `errorFrameCanonicalRewrite`。
- `tests/codec/anthropic/error-frame-canonical-rewrite.unit.test.ts`（新，7 test）—— golden lock（disabled → appliesTo false）、**HIGH-2 endpoint 门控回归**（CHAT_COMPLETIONS/RESPONSES/gemini 三个非-MESSAGES leg 均 appliesTo false，即便 errorShapingEnabled=true）、非-error 帧原样透传、非-canonical 上游 error 整形（保留 message）、内层 type 保留、unparseable 兜底 api_error。

### Task 3.2 —— 四终点收编到 error-shaping builder（G-3 唯一所有权）
- `src/routes/messages/error-shaping-glue.ts`（改）—— `errorShapingConfigFromState` 改为 **export**（供 3.2 复用）；新增 export `shapePostcommitErrorFrame(error, legacyFrame)`：`errorShapingEnabled` 关 → 逐字节返回 `legacyFrame`（CF-2 golden lock）；开 → `classifyError` → `decide({commitPhase:"post-commit"})` → `buildCanonicalErrorFrame(decision)`（post-commit 恒 canonical-error，防御性回退保留 legacyFrame）。
- `src/routes/messages/handler-v4.ts`（改，四处收编 + import + H2 注释）：
  - **终点① HTTPError**（改后 `handler-v4.ts:577`）：`await sink.writeSynthetic?.(shapePostcommitErrorFrame(error, anthropicHttpErrorFrame(error)))`。
  - **终点①' unknown-non-HTTP**（改后 `handler-v4.ts:578`，MEDIUM-1 新增收编）：`shapePostcommitErrorFrame(error, anthropicErrorFrame("api_error", ...))`——post-commit `network_error` 唯一产出路径，Phase 1 真值表 `network_error→canonical-error` 腿首次被端到端触达。
  - **终点② H3 stream-error**（改后 `handler-v4.ts:1233`）：手搓 JSON → `buildCanonicalErrorFrame({kind:"canonical-error", errorType, message: errorMessage})`（`errorType = anthropicStreamErrorType(error)` 保留）。
  - **终点③ truncation**（改后 `handler-v4.ts:1317`）：手搓 JSON → `buildCanonicalErrorFrame({kind:"canonical-error", errorType:"api_error", message:"Upstream stream truncated before completion (no message_stop)"})`。
  - ②③ 的 `buildCanonicalErrorFrame` 输出与原手搓字面量**逐字节相同**（字段序 `{type, error:{type, message}}` 一致、无 retry_after），故不需 enabled 门控、enabled/disabled 皆同一形态。
  - 新增 import：`buildCanonicalErrorFrame`（`~/lib/anthropic/error-shaping`）、`shapePostcommitErrorFrame`（`./error-shaping-glue`）。
- `tests/routes/messages/postcommit-error-shaping.unit.test.ts`（新，6 test）—— 纯 helper 字节级测试：CF-2 golden lock（disabled → 返回 legacyFrame，`.data` 引用相等）×2、enabled network_error/REFUSED_STREAM → api_error（证 decide() 真被触达、legacy sentinel 未返回）、402 quota → `rate_limit_error` + retry_after 携带（CF-3 wire literal）、500 → api_error。
- `tests/routes/messages/postcommit-error-shaping.it.test.ts`（新，8 test）—— 真实 Hono app + mock 上游，证四终点 wiring 真触达：① HTTPError（gated FakeClock，enabled canonical + disabled 字节 golden）、①' network_error（immediate commit + 真定时器，enabled/disabled 各一，1s 真实 network-retry backoff）、H2 non-canonical event:error 经 S5 整形（enabled 加 api_error type / disabled 逐字透传）、truncation（enabled/disabled 各一，byte-identical）。

### Task 3.3 —— H2 分支注释更新
- `src/routes/messages/handler-v4.ts:1233` 上方注释：去掉过时的 "forwarded as a content frame"，改为准确描述「errorFrameCanonical S5 rewrite 已在 forwarded 轨整形（off=逐字透传），本分支只从 upstream-original `acc.streamError` settle ctx.fail、自身不写帧」。

## 承重约束核对（逐条）

- **接线点是 S5 rewrite 链、非 H2 事后**：已确认 `driver.ts:passThrough` 对每个 UpstreamFrame（含 `event:"error"`）依次 `transform`；新 rewrite order=50 最前拦截 `frame.event==="error"`（键 SSE event 名，非 parsed type）。H2 分支不写帧、仅 settle，注释已更新。
- **HIGH-2 endpoint 门控（铁律）**：`appliesTo` 含 `targetEndpoint===MESSAGES`；unit 测试专门断言三个非-MESSAGES leg（CHAT_COMPLETIONS/RESPONSES/gemini）在 errorShapingEnabled=true 下仍 appliesTo false（缺此测试视为未完成——已落地并绿）。集成层额外证据：`tests/responses/ tests/gemini/ tests/chat-completions/` 共 1003 test 全绿（新 rewrite 进 `ALL_RESPONSE_REWRITES` 未泄漏）。
- **G-3 四终点唯一所有权**：①565→577、①'568-570→578、②H3、③truncation 四处收编（真实行号见上）；明确**排除** 3 处（reject / unrepairable-tool / 外层 catch-all）未改动，与需求单一致。
- **CF-2 golden lock**：①/①' disabled 逐字节回退（unit `.data` 引用相等 + it 字节比对 `anthropicHttpErrorFrame` 输出）；②/③ byte-identical。
- **CF-3（canonical 帧不引发非预期 CC 重试）**：按 `exp/cc-error-retry-surface/FINDINGS.md`（源码分析 + 运行时 REPORT.md 双证收敛的权威横幅）——post-commit CC 重试触发器仅为 status===529 或 message 含 `"type":"overloaded_error"` 子串；本 Phase 产出的 canonical 帧 `error.type` ∈ {rate_limit_error, api_error, invalid_request_error, authentication_error, ...} 且 status 在客户端为 undefined，均不命中 → 不重试（这正是 post-commit A 类被设计为 canonical-error 而非 retry-signal 的目的）。**未另跑真 CC live oracle**（FINDINGS 的 REPORT.md 已是运行时实测且横幅明言 `api_error` 任何位置都不触发重试；重跑 harness 价值有限），故此条依据源码/既有实测分析、未本 session 复跑 CC。
- **D-0.5 冲突缓解**：canonical 尾帧整形封装为 `buildCanonicalErrorFrame` / `shapePostcommitErrorFrame` 单一函数，handler-v4 四处只调用一行；与 block-level P1 Task 6（重构 1090-1330 truncation 分支为 replay/partial-degrade）的 rebase 冲突面收窄到「调用点一行」。handler-v4 改动确切位置（供对账）：import 两行（L66、L160 段）；终点①/①' 在 `runMessagesDriver` 的 post-commit catch（~L569-578）；终点②在 `pumpAnthropicStreamingV4` H3 分支（~L1233）；终点③在同函数 truncation 分支（~L1317）。
- **别凭猜测硬编码**：`ENDPOINT.MESSAGES`/`.RESPONSES`/`.CHAT_COMPLETIONS`、`ResponseRewrite`/`FrameAction`/`RewriteState`、`RESPONSE_REWRITE_ORDER`、`anthropicStreamErrorType`（Phase 1 re-export 确认）、`writeSynthetic`、`classifyError`、`ClientFrame`/`UpstreamFrame`（皆 = `SseFrame`，故 builder 返回 `ClientFrame` 直接兼容 `FrameAction.frames: UpstreamFrame[]`）——全部 read/grep 核实真实签名。

## 收尾验证

- `bun run typecheck` 全绿（含 e2e-ui tsconfig）。
- `bunx eslint`（无缓存，9 个改动/新增文件）：首轮 8 处均为 import 排序 / Prettier 换行（无逻辑问题），手动修正后二轮全绿。
- `git diff --stat -- src/lib/anthropic/stream-accumulator.ts` **为空**（上游轨记录逻辑零改动，确认正交轨道未受影响）。
- 未触碰 `codec/openai-cc` / `codec/openai-responses`（`git diff --stat` 为空）。
- 本 Phase 新测试 21 个（7 rewrite unit + 6 helper unit + 8 it）全绿。
- 广域回归：`tests/responses/ tests/gemini/ tests/chat-completions/ tests/pipeline/` 1003 test、`tests/anthropic/ tests/routes/ tests/codec/` 1221 test，均 0 fail。既有 H2 测试（`anthropic-v4.http.test.ts:389`，errorShapingEnabled=true 默认 + 已 canonical 的上游帧 → 我方 rewrite no-op）无回归。

## 与需求单的偏差 / 方案选择（须知会）

1. **行号漂移（按真实定位，非需求单转述）**：终点① 实际在 `handler-v4.ts:564-570`（需求单写 565）、①' 在 `572-575`（需求单写 568-570）、H3 在 `1190-1203`、truncation 在 `1299-1317`。均按真实代码定位收编，与需求单语义一致。

2. **H2 集成测试的帧形状**：需求单示例用「非-canonical event:error」驱动 S5 整形。实测发现——**若上游 error 帧缺顶层 `type:"error"`，stream-accumulator 不识别为 H2**（accumulator 键 parsed `type`，非 SSE event 名），导致 handler 走 truncation 分支、额外补一个合成 error 帧（客户端收到两帧）。这是**既有行为、非本 Phase 引入**（disabled 态同样双帧）。故集成测试改用「H2-detected（有顶层 `type:"error"`）但内层缺 `error.type`」的帧——既被 accumulator 识别为 H2（单帧路径），又能展示 S5 整形（enabled 补 `api_error` type / disabled 逐字无 type）。这是刻意的测试形状选择，避免把既有 accumulator 缺陷混入本 Phase 断言。见下 concerns。

3. **测试 helper 路径**：需求单示例的 `~~tests/support/isolated-runtime` 不存在；实际用 `tests/helpers/isolated-fixture.ts` 的 `useIsolatedRuntime()`（.it）+ `tests/helpers/state-fixture.ts` 的 `autoRestoreState()`（.unit），与 Phase 2 一致（按 `test-isolation` skill 核实后使用真实路径）。

4. **①' 集成测试不用 FakeClock**：network_error 触发 pre-commit network-retry 策略（1 次重试、真实 1000ms backoff 经 `NETWORK_RETRY_DELAY_MS`）。FakeClock 下该 backoff 不推进 → 挂 5s 超时。故 ①' 用 immediate commit（`streamCommitAfterSec:0`）+ 真定时器（实测 ~1s 完成、确定性 2 hits）；① HTTPError 仍用 FakeClock gated stall（复用 `live-post-commit-anchor-closeoff` 手法）。两个 describe 块分离。

5. **enabled 态 ① 与 legacy 的 error.type 保真度差异**（发现的既有架构面，非本 Phase bug）：`error-shaping.ts:anthropicErrorTypeForApiError`（按 `ApiErrorType` 映射）比 `post-commit-error.ts:anthropicErrorTypeForStatus`（按 HTTP status 映射）**粒度更粗**——如 403→legacy `permission_error` vs enabled `authentication_error`（auth_expired 合并 401/403）、404→legacy `not_found_error` vs enabled `api_error`（classifyError 把非特殊 4xx 归 bad_request→`invalid_request_error`）、529→legacy `overloaded_error` vs enabled `api_error`。**这是 enabled 态的刻意行为**（Phase 1 真值表基于 `ApiErrorType` 而非 status，CF-3 明确要 402→`rate_limit_error`），disabled 态逐字节保留 legacy。但若未来希望 enabled 态也保留 403/404/529 的精确 wire type，需在 error-shaping 层引入 status 维度或扩充 `ApiErrorType`。**建议记入 `docs/todo/deferred-backlog.md`**（不阻塞本 Phase；测试断言已按 enabled 真值表校准）。

## concerns

- **偏差 2（accumulator 的 H2 识别缺陷）**：`stream-accumulator.ts:accumulateAnthropicStreamEvent` 按 parsed `type` 分派，缺顶层 `type:"error"` 的上游 error 帧不被识别为 H2 → 走 truncation 双帧。本 Phase 未修（accumulator 明令零改动、且属正交轨道），但这是真实的既有缺陷：**非-canonical 上游 error 帧会让客户端收到「整形后的 error + 合成 truncation error」两帧**。S5 rewrite 现在整形了 forwarded 轨的第一帧，但第二帧（truncation）仍来自 handler。理想修法是让 accumulator 也按 SSE event 名（`frame.event==="error"`）识别 H2，与 S5 rewrite 的判据对齐。建议记入 `docs/todo/deferred-backlog.md`。
- **偏差 5（error.type 保真度差异）**：见上，建议记入 backlog。
- CF-3 依据源码 + 既有运行时实测分析、未本 session 复跑真 CC live oracle（见承重约束核对）。
- 无阻塞项。四终点收编完成、S5 rewrite 落地、HIGH-2 门控有回归测试、CF-2 golden lock 有字节锁、stream-accumulator 零改动已确认。
