# Spec: 上游错误 → 客户端可处理形态整形（error client-shaping）

- **状态**：草案 v2.1（两轮对抗评审全闭合 + TCP-reset 补测 + B-1 定案；待用户审 → planning）
- **日期**：2026-07-13
- **调研底座（先读）**：[exp/cc-error-retry-surface/FINDINGS.md](../../exp/cc-error-retry-surface/FINDINGS.md)（CC 客户端错误行为四层机制源码穷举）、[exp/cc-error-retry-surface/REPORT.md](../../exp/cc-error-retry-surface/REPORT.md)（真 CC 2.1.207 × fake server 实测，含 sig-conv 自愈委派 + TCP-reset 补测，supersede 冲突结论）。三 agent 源码穷举 + 真 CC 实测 + 对抗评审三方收敛。
- **相关**：[forward.ts](../../src/lib/error/forward.ts)、[classify.ts](../../src/lib/error/classify.ts)、[post-commit-error.ts](../../src/routes/messages/post-commit-error.ts)、[handler-v4.ts](../../src/routes/messages/handler-v4.ts)、[streaming-pump.ts](../../src/routes/messages/streaming-pump.ts)、[keepalive-anchor.ts](../../src/lib/anthropic/keepalive-anchor.ts)、`src/lib/request/strategies/`（反应式 retry 策略，自愈委派的重叠面）、spec [2026-07-13-refusal-recovery-text-configurable.md](2026-07-13-refusal-recovery-text-configurable.md)（已实现，同源独立）、spec `2026-07-11-block-level-buffered-retry.md`（buffered-retry 基建）、ADR [richest-data-flow](../decisions/2026-07-05-richest-data-flow.md)。

> 术语：**commit** = 代理向客户端发 HTTP `200` 头并开始 SSE 流。**pre-commit** / **post-commit** = 200 是否已发。**块完成** = 客户端视角已见过至少一个 `content_block_stop`——**含代理注入的合成 keepalive anchor 的 stop，CC 按 wire 上的 stop 计数、不辨来源**（实测：连空 text 块的 stop 也置 CC 的「真实内容」标志 `_i`、关闭重试窗口）。

## 背景与问题

上游（GHC/Anthropic）报错时，代理当前把错误整形成**普通 error 帧 / 结构化 error 响应**（[forward.ts](../../src/lib/error/forward.ts) + [post-commit-error.ts](../../src/routes/messages/post-commit-error.ts) + [streaming-pump.ts](../../src/routes/messages/streaming-pump.ts) 终端分支）。对 Claude Code 客户端，这在很多情形下让 **turn 直接停下报错**——即便错误本可重试、或本可让用户决策。用户诉求：别拼凑「普通 text 响应」，而是拼凑客户端会按情况妥当处理的形态。

调研（见底座）确证 CC 有四层、两套互不相交的错误机制，**能否触发客户端重试完全由 commit 阶段决定、无单一万能手段**：

- **pre-commit**（真实非-200 status）走 `lvo`+`x6_`：真实 status（408/409/429/5xx）/ `x-should-retry:true` 头 / `retry-after` 秒可靠触发原生重试（默认 ≤10 次退避）。SDK 层重试 dead（`maxRetries:0`），重试全在 `lvo`。
- **post-commit**（流内 `event:error`，`li.status=undefined`）走独立 mid-stream catch，**不经 `x6_`**：
  - **块完成前**：`overloaded_error` 帧可让 CC 重发流式（前台、≤3）；连接错误/RST 也重发。
  - **块完成后**（含合成 anchor 的空 text 块 stop）：**无干净客户端重试**——error 帧只得 `API Error: … mid-response` partial-text 注记（要避免的行为）或硬停；连接错误/RST 同样不重试（实测 TCP-reset：完成块后 conns=1）。
- **`api_error` 不触发任何客户端重试**（实测证伪「降级非流式」推断）。
- **onError 请求变异自愈腿**（FINDINGS §1c）：pre-commit 400 若 message 匹配特定腿，CC 剥掉请求里的冒犯内容后**立即重发**（实测：thinking-type conns=2；sig-conv 端到端 conns=3、6-7ms 立即重发 + body 变小）。与本项目反应式 retry 策略语义重叠。

**关键取舍结论（B-1，实测定案）**：默认 `streamKeepaliveMode="empty_text"` 会在 commit 后注入空 text anchor 块；错误处理里 [closeAnchorIfOpen](../../src/lib/anthropic/keepalive-anchor.ts#L113) 在写 error 帧前先发该块的 `content_block_stop` → 制造「已完成块」→ 关闭重试窗口。实测确认：此后无论发 `overloaded_error` 帧还是 TCP-reset，CC 都 **conns=1 不重试**。TCP-reset 仅在「块开着」时才重试（conns=7），但那需下游留未闭合块 + 特判不关 anchor。**故 post-commit 块完成后不试图触发客户端重试，一律交 proxy buffered-retry（缓冲重放）**——这是唯一干净、无 wire-hack、无未闭合块的路径。

## 目标

1. 上游错误按 `ApiError` 分类 × **commit 阶段** × **是否已发 client-visible `content_block_stop`**，整形成 CC 会妥当处理的形态，而非一律普通 error 帧。**仅 Anthropic Messages 路径**。
2. **可重试错误分治**：pre-commit 用 status/`x-should-retry` 触发原生重试（主力）；post-commit 交 proxy buffered-retry（不试图推客户端）。
3. **可重试错误尽量停在 pre-commit 解决**：buffered-retry 与延迟提交（`streamCommitAfterSec`）联动，上游报错前尽量不早 commit。
4. **不可重试 + 用户可动作**（content_filtered / 部分 auth）→ 可选合成 AskUserQuestion（config 门控默认关，仅交互式）。
5. **自愈委派可配置**：语义匹配 CC 自愈腿的上游 400，可配置「proxy 反应式策略自修 vs 透传委派 CC 自愈」，**键 = 反应式策略名**。

## 非目标

- 不改 OpenAI / Gemini / Azure 客户端路径错误形态（保持现有 status-based）。
- 不改 refusal-recovery（[2026-07-13-refusal-recovery-text-configurable.md](2026-07-13-refusal-recovery-text-configurable.md)）三模式门控。
- 不改 history 保真：上游原始错误始终记真实值；本 spec 只碰 forwarded/客户端可见轨。
- **`aborted`（客户端 cancel / header-timeout）不在本 spec 范围**——由 handler 既有 abort 路径处理（[forward.ts](../../src/lib/error/forward.ts) isAbortError 分支 + post-commit `classifyPostCommitAbort`），error-shaping 不介入。显式记录以对齐 no-silently-cut。
- **不试图在 post-commit 块完成后触发客户端重试**（实测不可靠，见 B-1）；不引入 TCP-reset 收尾（留未闭合块、须特判，判为不值）。

## 核心设计：commit 阶段分治 + 正交呈现

### A. 可重试错误（network / server_error 5xx / upstream_rate_limited 503 / rate_limited 429 / h2-REFUSED_STREAM）

| 阶段 | 手段 | 说明 |
|---|---|---|
| **pre-commit** | 返回对应真实 status（或 `x-should-retry:true` 头）+ `retry-after` 秒 | **主力**。CC 原生重试（`x6_`，≤10）。代理场景 `Bo()`=false，`x-should-retry` 门开。 |
| **post-commit**（块完成前或后） | **proxy buffered-retry 缓冲重放**（[block-level-buffered-retry](2026-07-11-block-level-buffered-retry.md) 基建） | 客户端侧无可靠干净重试；**绝不**发 `overloaded_error`/`api_error` 去试图推客户端（会落 partial-text）。 |

> **402（quota_exceeded）不归 A**：CC `shouldRetry`（`app.pretty.js:12394`）与 `x6_`（`370703+`）均**不重试 402**；且语义上配额耗尽，即时重放（CC 原生或 proxy buffered）都不会恢复配额——归 B（见下，用户可动作：等待/换账号/换模型）。retry_after 仅供人读（且当前放在 body 而非 CC 会读的 `retry-after` 头，见 [forward.ts:103-113](../../src/lib/error/forward.ts#L103)——即便可重试也不驱动 CC 退避）。

**延迟提交联动（主线）**：把「尽量在 pre-commit 解决可重试错误」作为一等目标。可重试错误到达时若尚在 `streamCommitAfterSec` 延迟提交窗口内，优先让 buffered-retry 在 pre-commit 段重放；仅延迟窗口耗尽被迫 commit 后才落 post-commit。

**buffered-retry 默认态（planning 需拍板的独立决策）**：`protectStreamingGeneration` 默认 `false`（buffered OFF）。**buffered OFF 时，post-commit 块完成后的可重试错误保持 canonical error 帧（现状行为）**——本 spec 不承诺「块完成后绝不 partial-text」在 buffered OFF 下成立。**净效果提醒（对齐「完整 > 最小可交付」）**：默认 buffered OFF 下，post-commit 可重试错误对用户诉求「别让 turn 停下报错」**零改善**——仅 pre-commit 段（延迟窗口内）受益。故 planning **应显式权衡「是否让本特性把 buffered 默认打开」**（换取 post-commit 可重试错误的无缝重放，代价是缓冲全响应的内存/延迟 + buffered-on-by-default 影响 PoC），而非默认沿用 OFF 让特性对最常见的 post-commit 场景开箱基本不生效。

### B. 不可重试 + 用户可动作（content_filtered / quota_exceeded 402 / auth 403-permission）

可选（config 门控默认关、仅交互式）合成一个「成功的 AskUserQuestion tool_use 轮次」：
- 复用带 `event:` 行的 SSE 帧构造（[recover-refusal.ts](../../src/lib/anthropic/recover-refusal.ts) 的 `buildSyntheticTextFrames` 同款）+ `renderRefusalTemplate`（已实现）：发 `content_block_start{tool_use, id, name:"AskUserQuestion"}` → `input_json_delta` → `content_block_stop` → `message_delta{stop_reason:"tool_use"}` → `message_stop`。pre-commit 合成整段。
- input：`{questions:[{question, header, multiSelect:false, options:[…]}]}`。**纯信息展示**——proxy 不拦截后续 tool_result。
- 仅交互式有效（headless/`-p`/子 agent 无用户可问会挂起）→ config 默认关；未开或 headless 时回落 C（canonical 帧）。
- **quota_exceeded(402)**：非重试、但用户可动作（等待配额重置 / 换账号 / 换模型）；AUQ 选项据此设计，`retry_after` 供人读。
- **auth（401/403）**：`classifyError` 把二者都归 `auth_expired`（[classify.ts:193-201](../../src/lib/error/classify.ts#L193)），故**按 `ApiError.status` 分流**（非按 type 一刀切）：401（expiry）先走既有 `token-refresh` 策略、不弹问；AUQ-on-auth **仅** 403（permission_error）或 token-refresh 耗尽时。

### C. 不可重试 + 用户不可交互修（token_limit / payload_too_large 413 / bad_request 400 其它 / 未分类）

保持 canonical error 帧（现状），保留 `error.type` 正确 + token 数。CC 终端渲染器对已知形态本就给恢复提示（`Run /rewind` / plan 提示 / 压缩提示）。

**分类覆盖完整性**（对齐 [classify.ts](../../src/lib/error/classify.ts) 全 11 型）：`network_error`/`server_error`/`upstream_rate_limited`/`rate_limited`→A；`content_filtered`/`quota_exceeded`(402)/`auth_expired`(403 腿)→B；`token_limit`/`payload_too_large`/`bad_request`/`auth_expired`(401 走 token-refresh)→C 或既有腿；`aborted`→非目标（既有路径）。**注**：`auth_expired` 单一 type 覆盖 401/403，须按 `ApiError.status` 分流（401→token-refresh、403→B），别按 type 一刀切（与 D 委派须按策略名同类隐患）。

### D. 自愈委派（可配置，正交增强）

对语义匹配 CC 自愈腿的上游 **pre-commit 400**，提供「proxy 反应式策略自修 vs 透传委派 CC 自愈」的**按策略名**开关。委派 = proxy 关掉对应**反应式策略**的 `canHandle`、透传该 400，CC 收到后剥冒犯内容并立即重发（自愈腿要求请求含可剥内容——委派流里内容必在，因 proxy 没剥）。

| CC 自愈腿（FINDINGS §1c） | 对应 proxy 反应式策略（`src/lib/request/strategies/`） | 委派实测 |
|---|---|---|
| `retry:thinking-signature-strip` | `adaptive-thinking-rejection-retry` / `legacy-thinking-retry` | ✅ sig-conv 端到端（conns=3） |
| `retry:thinking-type` | 同上 | ✅ conns=2 |
| `retry:mid-conv-system` | `system-reject-retry` | 源码确证（需请求含 system role） |
| `retry:cache-diagnosis-beta` / `prompt-caching-evict-beta` | `unsupported-beta-retry` | 源码确证 |
| `retry:foundry-capability-strip` / `server-fallback-strip` | `structured-outputs-rejection-retry` / `tool-field-rejection-retry` | 源码确证 |
| `retry:media-strip` | **无对应 proxy 策略** → **仅 delegate 一条路**（无 proxy 自修选项） | 源码确证 |

**边界（M-1，重要）**：委派**只作用于反应式策略**。thinking-signature 的 proxy 侧还有一条 **always-on 预飞 sanitize（quarantine，S3）**——它在发上游**之前**就剥 signature，故上游多数根本不报 signature 400、委派对 thinking-signature 多为 no-op。委派**不影响 always-on quarantine**（否则 poison signature 会先被 quarantine 拦下）。委派的真实价值 = 让 CC 的更新更快跟进上游变化、减少 proxy 维护反应式正则的负担；默认应保持 proxy 自修（更可控），委派 opt-in。

## 配置面（`anthropic.*`，对齐配置哲学：警告并继续、热重载）

| 键 | 默认 | 作用 |
|---|---|---|
| `error_shaping_enabled` | `true` | 总开关（关则逐字节回退现状 forward.ts + post-commit-error.ts + pump 终端行为） |
| `error_ask_user_question` | `false` | B：content_filtered / 403-permission 合成 AskUserQuestion（仅交互式部署应开） |
| `error_auq_template` | 内置默认 | AUQ 文案模板（占位符 `{model}`/`{request_id}`/`{error_type}`/`{status}`，复用 `renderRefusalTemplate`） |
| `error_selfheal_delegate` | `{}`（全 proxy 自修） | D：**键 = 反应式策略名**（如 `"adaptive-thinking-rejection"`/`"tool-field-rejection"`），值 `"proxy"`/`"delegate"`；未列 = proxy |

- **无 `error_post_commit_overloaded_relabel` 键**（v1 曾有，B-1 定案删除：post-commit 不做客户端重试 relabel）。
- 延迟提交联动复用已有 `streamCommitAfterSec`，不新增窗口键。buffered 默认态见 §A（独立决策，planning 定）。
- 配置哲学：新增键、无迁移负担；加载遇类型不符默认警告并继续；运行时热重载。

## 实现塑形（改动点，how 细节留给 plan）

- **新纯模块** [src/lib/anthropic/error-shaping.ts](../../src/lib/anthropic/error-shaping.ts)（`lib` 不依赖 `routes`）：输入 `classifyError()` 的 `ApiError` + config + `commitPhase`（pre-commit / post-commit）+ **`clientVisibleStopEmitted: boolean`**（CC 视角是否已见任一 `content_block_stop`，含合成 anchor——由调用点各自计算后喂入，纯模块不假设状态来源），输出 decision：`retry-signal{status,headers}`（pre-commit A）/ `buffered-retry`（post-commit A，路由到 buffered 基建）/ `ask-user{frames}`（B）/ `error-frame{frames}`（C）。**`delegate` 不是本模块输出**——它是请求预处理/策略装配期的过滤决策（见下）。
- **接线（post-commit 有两个错误终点，H-1）**：
  - pre-commit：[forward.ts](../../src/lib/error/forward.ts)（status/header 决策）。
  - post-commit **终点①** pre-pump `await p` catch（[handler-v4.ts:544-580](../../src/routes/messages/handler-v4.ts#L544)）——此处 pump 未跑、真实块未完成，`clientVisibleStopEmitted` 由 handler 持有的 `anchorState`（anchor 是否已 close）计算。
  - post-commit **终点②** pump 内终端分支（[streaming-pump.ts](../../src/routes/messages/streaming-pump.ts) H3/H2/truncation，现硬编码 `anthropicStreamErrorType`：shutdown→overloaded_error / idle→timeout_error / 其余→api_error）——此处块可能已完成，`clientVisibleStopEmitted` 由 `streamState`/`acc` 计算。error-shaping 须覆盖二者；buffered OFF 时二者保持现状 canonical 帧。
  - 仅 Anthropic 路径接线。
- **buffered-retry 联动**：driver 层，post-commit 可重试错误路由到 buffered-retry（[resolveBufferedAndHeartbeat](../../src/routes/messages/handler-v4.ts)）而非 relabel（plan 定交接 + buffered 默认态）。
- **自愈委派**：请求预处理/策略装配层，per-策略名若配 `delegate`，跳过该反应式策略的 `canHandle`（不影响 always-on quarantine）。

## 历史 / 可观测性（ADR richest-data-flow）

- history **永远记真实上游错误**（原始 status/type/body 进 `attempts[].upstreamResponse`）；AUQ / buffered 重放 / 自愈委派透传都是 forwarded 轨合成物 → 打 `SseEventRecord.synthetic` 标记。
- `ctx.fail()` 归属不变（仍记 failed）——两正交轴：`upstreamResponse.success=false` vs 客户端可见形态。
- 新增遥测（可选，plan 定）：每类错误走了哪条整形分支（retry-signal / buffered / auq / error-frame）+ 委派命中计数。

## 测试

- **单元**：决策矩阵真值表（`ApiError.type` × `commitPhase` × `clientVisibleStopEmitted` × config → 正确 decision，覆盖全 11 型）；AUQ 帧合成（`event:` 行、`stop_reason:tool_use`、schema 对齐 CC）；委派键=策略名的解析。
- **golden 字节锁（三终点，建议）**：`error_shaping_enabled=false` 下 **pre-commit forward.ts + pre-pump catch + pump 内 H3/H2/truncation 三处**均与现状逐字节等价（回归护栏）。
- **oracle（复用 exp/ harness）**：[fake-anthropic-server.ts](../../exp/cc-error-retry-surface/fake-anthropic-server.ts) / rst-fake-server 作真 CC 端到端 oracle——验证 pre-commit status→CC 原生重试、post-commit 可重试→buffered 重放（无 proxy 注入 partial-text，buffered ON 时）、自愈委派剥块重发（sig-conv）。oracle 须覆盖 `empty_text` 与 `ping` 两种 keepalive 模式（避免只测一种假绿）。
- **热重载**：config 键运行时生效。

## 验收标准

1. pre-commit 可重试错误（network/5xx/503/429）→ 真 CC 原生重试（fake server 回真 status，观测 CC 重发）。**402 不在此列**（CC 不重试 402；归 B）。
2. post-commit 可重试错误 + **buffered ON** → proxy 缓冲重放，客户端见无缝重试或干净结果、**不见 proxy 注入的 partial-text**；**buffered OFF** → 保持 canonical error 帧（现状，本 spec 明确不试图客户端重试）。
3. `error_ask_user_question=true` + 交互式 → content_filtered / 403-permission 呈现为 AskUserQuestion；headless 下不合成（不挂起）；401-expiry 先走 token-refresh 而非 AUQ。
4. `error_selfheal_delegate["<策略名>"]="delegate"` → 对应上游 400 透传、CC 自剥重发（sig-conv oracle，含 always-on quarantine 不受影响的核实）；默认 `proxy` → 走现状反应式策略。
5. `error_shaping_enabled=false` → 三终点逐字节回退现状。
6. history 始终记真实上游错误；所有合成物打 synthetic 标记。

## 待实测 / 风险（依赖实现期 PoC，见 REPORT §未测项）

- **buffered-on-by-default 的影响**（内存/延迟/正确性）——若 planning 决定本特性默认开 buffered，须补 PoC。
- **交互式（非 headless）模式**下 querySource 是否改变行为 / AUQ UI 呈现——本轮 PoC 是 headless。
- **buffered-retry 与延迟提交的交接**细节（窗口时长、重放语义）——plan 阶段 PoC。
- 自愈委派 per-腿在「请求含可剥内容」外的边界（剥完仍 400 的责任归属、always-on quarantine 对 thinking-signature 委派的实际 no-op 比例）——实现期逐腿 e2e。

## 评审处置（record-not-adopted）

**第一轮**（1 BLOCK + 4 HIGH + 3 MEDIUM + 2 LOW + 2 建议）全部采纳，无「未采纳」项：B-1 采 option 1（纯 buffered-retry，删 overloaded relabel 键）；H-1 明确两终点；H-2 委派键改策略名 + 澄清是预处理决策非 error-shaping 输出；H-3 明确 buffered OFF 行为；H-4 补 402/aborted 归属；M-1 委派不碰 always-on quarantine；M-2 auth 先 token-refresh；M-3 验收 #2 重述；L-1 media 仅 delegate；L-2 术语含合成 anchor stop；建议采 `clientVisibleStopEmitted` 输入模型 + 三终点 golden。

**第二轮**（复核 v2）：9 条确认闭合；**N-1 返修**——H-4 第一轮把 402 归 A（可重试）是三选一里唯一被底座证伪的（`shouldRetry`/`x6_` 均不重试 402、语义上配额即时重放无效），已改归 B（用户可动作，按 `ApiError.status` 分流）+ 删验收 #1「含 402」。两条 LOW（auth 401/403 须 key on `.status`、buffered-OFF-default 使 post-commit 零改善）已分别落进 §B/§分类覆盖 与 §A buffered 默认态提醒。
