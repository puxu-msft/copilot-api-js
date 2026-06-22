# RFC: 流式响应的事务化缓冲重试 — 保护大 Write/Edit 生成不被上游 mid-stream RST 砍断

**Status:** 设计稿待评审（2026-06-22）
**Scope:** Anthropic 流式路径（`/v1/messages` streaming）的 mid-stream 上游 RST 保护
**关联:** 补充 `upstream-stream-truncation-detection.md`（截断检测）+ `upstream-http2-transport.md`（http2-client RST 暴露路径）；与 pre-response 静默保活（另文）正交

---

## 1. 背景与问题（已实测，非推断）

opus-4.8 在超大上下文（150K–200K token）上生成一个**大 Write/Edit 工具调用**（写大文件/文档）时，上游 GitHub Copilot 在**活跃流中途**发 `RST_STREAM(NGHTTP2_CANCEL)` 把流砍断。已观测四次，签名一致：

| 时刻 | elapsed | silence | stuck-block | input tok | 砍断时在生成 |
|---|---|---|---|---|---|
| 02:31 | 140s | 139ms | tool_use | 196665 | — |
| 02:55 | 87s | 70ms | tool_use | 142015 | — |
| 06:42 | 148s | 123ms | tool_use(Write) | 167131 | 一篇 ~11KB+ RFC markdown（无重复/loop，合法大生成） |

关键判别（已逐条证伪其它假设）：
- **非 idle 超时**：`silence` 仅几十~百 ms，流一直在喷 `content_block_delta`。
- **非固定时长墙**：四次 60/87/140/148s 各不同；同库实证 287s 请求能正常完成。
- **非 keepalive 失效**：`ss` 实证上游 socket 带 `timer:(keepalive,…)`；且活跃流不空闲，keepalive 不参与。
- **非 loop/runaway**：尸检 tool_use 的 `input_json` 无任何重复，是模型在写真实大文档。
- **结论**：GHC 对**大生成的请求级中止**——请求/时刻/负载相关，本地超时/keepalive 都治不了。

### 1.1 两个官方客户端都不保护这种情况（已读源码核验）

| 客户端 | mid-stream 上游 RST 的处理 | 证据 |
|---|---|---|
| GHC 官方扩展 | 整请求重试**仅限** `NetworkError`；把 `Premature close`/`ERR_STREAM_PREMATURE_CLOSE`（上游 RST 常见形态）**刻意归 `Canceled` 不重试** | `chatMLFetcher.ts:575`、`:1973-1983`（注释 `/* to be extra sure */`） |
| Claude Code（Anthropic SDK） | 标准 SDK 重试（408/409/429/5xx/overloaded/连接错误，`maxRetries≈2`+退避）**只覆盖请求建立阶段，不覆盖流已开始后的中途断** | 二进制 grep：`retryable`/`status>=500`/`overloaded_error`/`x-should-retry` 在，无 mid-stream 重试路径 |

官方客户端因为**分不清"客户端取消"vs"上游故障"**，保守地把 premature-close 当取消、不重试。

### 1.2 代理的独有优势

copilot-api 夹在 Claude Code 与 GHC 之间，靠 `abort-bridge`（client abort → 上游 AbortSignal）能**确定性区分**：
- 客户端主动取消 → `StreamClientAbortError`（不该重试）
- 服务器关闭 → `StreamShutdownError`（不该重试）
- 上游主动 RST → `transport-close`（`classifyStreamError` 归 `"other"`，**正是可安全重试的目标**）

这个判别能力就是保护的钥匙——**做官方客户端做不到、且放弃了的事**。

---

## 2. 目标与非目标

**目标**：当流式 Anthropic 响应在**收齐前**因上游 RST（`transport-close`）断裂时，对客户端**透明地重试整请求**，最终把**一次完整生成**的响应交付客户端，而非把半截流 + 错误帧抛给客户端。

**非目标**：
- 不保证成功——若 GHC 对某请求**持续**无法完成（而非偶发负载），重试也会再 RST；L2 提高成功率，不消灭失败（§8 诚实评估）。
- 不做断点续传/续写（Anthropic 协议不支持 resume 半截 tool_use；只做**无状态整请求重发**，靠 prompt cache 降成本）。
- 不动非流式路径（`renderNonStreamingV4` 本就缓冲整响应，且 S4 重试已覆盖其失败）。
- 不默认开启 auto_truncate（用户明确否决）。

---

## 3. 核心机制：事务化缓冲重试（transactional buffered retry）

把"逐帧 live 转发"改为"**缓冲整响应、成功才 commit**"，从而让"重试"在 mid-stream 失败后变得可能：

```
loop attempt = 1..N:
  onAttemptReset()                         # 重置全部 handler 侧累积态 + driver S5 链 state(见 §4 修订)
  upstream = runExchange(env)              # 拿一条全新上游流（S4，复用既有重试循环处理 pre-stream 错误）
  buffer = []                              # 本次尝试的渲染后帧缓冲
  try:
    for frame in runResponse(upstream,env):# S5 改写链逐帧（recover/decode/filter…）
      buffer.push(frame)                   # 不写 sink,只缓冲
      onUpstreamFrame(rawFrame)            # 仍喂 history 累加器(本次尝试,已重置)
    # 循环正常结束 ≠ 完整！Bun 下 clean RST 被当正常 end(rstCode=0,不可检测,
    # 见 http2-client.ts:169-175)。commit 条件必须额外门控 acc.sawMessageStop:
    if acc.sawMessageStop:
      for frame in buffer: sink.write(frame) # COMMIT:一次性 flush 完整响应
      return complete
    else:                                  # complete-but-truncated = 半截,等价 transport-close
      if attempt < N: record truncated attempt; continue   # 丢弃 buffer 重来
      return stream-error(truncationError) # 重试耗尽 → 维持现状(报错帧)
  catch error:
    cls = classifyStreamError(error)
    if cls == client-abort: return settled-abort      # 客户端走了,不重试不转发
    if cls == shutdown:     return shutdown            # 服务器关,不重试
    if cls == transport-close 且 attempt < N:          # 上游 RST → 丢弃 buffer,重来
      record failed attempt; (可选)escalate; continue
    return stream-error(error)             # 重试耗尽/不可重试 → 维持现状(报错帧)
```

**关键不变量——全有或全无（all-or-nothing）**：缓冲**整个**响应、只在**确认 `acc.sawMessageStop`** 后 commit（**不是**"循环结束"——Bun 下 clean RST 砍断的半截流也会让循环正常结束，见上方门控）。**绝不**部分 commit 再重试——否则会把"第 1 次生成的前半"与"第 2 次生成的后半"拼接，产出一个跨两次生成、自相矛盾的响应。一次交付 = 一次生成 = 见过 `message_stop` 的一次。

---

## 4. 架构集成（落在 driver，handler 只换调用）

当前（`pumpAnthropicStreamingV4`）：`driver.runRequest`(S1-S4) → `makeSseSink` → `driver.runResponseSink`(S5 逐帧 live 写)。

L2 新增 driver 编排 **`runResponseBufferedSink`**，与 `runResponseSink` 平行：

```ts
runResponseBufferedSink(
  env: RequestEnvelope,
  sink: ClientSink,
  reExchange: () => Promise<UpstreamStream>,   // 重试时取全新上游流(driver 内部 = runExchange(env))
  opts: RunBufferedOpts,                        // onUpstreamFrame / onAttemptReset / retryCap / …
): Promise<ResponseOutcome>
```

- **谁拥有 re-exchange**：S5 mid-stream 重试必须回到 S4 拿全新上游流。driver 内部本就有 `runExchange`；L2 方法内部循环调它。故 L2 **必须在 driver**（拥有 S4），不能只在 handler。
- **handler 改动最小**：把 `runResponseSink(upstream,env,sink,…)` 换成 `runResponseBufferedSink(env,sink,…)`（upstream 改由 driver 内部按尝试重取；handler 不再先 `runRequest` 拿 upstream，而是 driver 一并管 S4+S5 的重试）。具体接线见 §11 phases。
- **S5 改写链每尝试重置**：`recover-tool-call`（CANDIDATE/COMMIT 跨帧状态）、`tool-input-decode`（buffer/flush）、`server-tool-filter`（index densify map）都是 **stateful per-response**。每次重试是一次全新生成 → 必须 `onAttemptReset` 重建改写链 + 重置 history 累加器（`createAnthropicStreamAccumulator`）+ 清空 `forwardedSseEvents`。否则上次尝试的残留状态会污染本次。
- **complete 后才 flush**：`message_stop` 到达 → buffer 是一次完整生成 → 逐帧 `sink.write` flush（此时 `onForwarded` 采样 forwarded track）。flush 期间不再有上游，纯本地写客户端，极快。

---

## 5. 客户端保活（缓冲窗口期）

缓冲整响应意味着客户端在生成的整个 148s 里**收不到任何真实帧**——会触发 Claude Code（~258s）等客户端的超时断开。**复用既有 `makeSseSink` 的 forward-idle heartbeat**（`anthropicFakeSseHeartbeat`）：

- L2 引擎启用时，**强制开启 heartbeat**（即使用户没配 `fake_sse_heartbeat`，L2 也注入一个保守默认，如 15s），让客户端在缓冲期持续收到 `event: ping`。
- heartbeat ping 是代理自发的、采样进 forwarded track、不污染上游原始 `sseEvents`（既有契约，§client-sink）。
- **关键约束**：缓冲 + 重试的总时长必须 < 客户端超时。N 次重试 × 单次最长 ~150s 可能逼近甚至超过 258s → §7 retry cap 必须保守（建议 N=1，即"原始 + 1 次重试"），且 heartbeat 必须在两次尝试之间不中断。

---

## 6. 重试分类（只重 transport-close）

复用 `classifyStreamError`（`src/lib/stream.ts`）：

| 分类 | 来源 | L2 动作 |
|---|---|---|
| `client-abort` | `StreamClientAbortError`（abort-bridge） | **不重试** → `settled-abort` |
| `shutdown` | `StreamShutdownError` | **不重试** → 维持 shutdown 处理 |
| `idle-timeout` | `StreamIdleTimeoutError`（`timeouts.stream_idle`） | **可选**重试（上游静默死也许偶发；默认**不**重，避免与真正卡死的上游纠缠——开放问题 Q3） |
| `other`(transport-close) | http2-client `controller.error`（NGHTTP2_CANCEL/ECONNRESET/closed-before-end） | **重试**（目标场景） |
| H2（上游终止 `error` 帧） | `acc.streamError`（如 `overloaded_error`），clean drain 无 message_stop | **不重试 → commit**（终止上游决策，非 truncation；缓冲的 error 帧 flush 给客户端、handler 经 `acc.streamError` 失败，镜像 live）。经 `RunBufferedOpts.sawUpstreamError` 与 RST-truncation 区分——首轮审遗漏此分类（§14 addendum），实现期补 |

判别正确性是 L2 的安全基石：**绝不**对 client-abort 重试（客户端已走，重试纯浪费 + 可能违背用户意图取消）。**H2 与 truncation 同形**（都是 clean drain 无 message_stop），但 H2 是上游终止决策不该重试——commit 门控用 `sawMessageStop() || sawUpstreamError()` 两信号区分（仅 `sawMessageStop` 会把 H2 误当 truncation 反复重试、且耗尽时把原始 error 语义改写成 "truncated"）。

---

## 7. 重试边界与成本

- **retry cap**：配置项，默认保守 **1**（原始 + 最多 1 次重试）。理由：单次大生成 ~150s，N≥2 会逼近客户端超时；且若 GHC 持续无法完成，多重试只是线性浪费。
- **prompt cache 降成本**：重发是无状态整请求重发，但输入侧靠 `cache_control`（≤4 breakpoint，已实现）近乎免费——重试的增量成本主要是**输出重新生成**（GHC 计费 + 时延），不是输入。
- **buffer 内存**：缓冲渲染后帧。典型（thinking + text + 11KB tool_use）几十 KB,可控；但需 **buffer 上限守卫**（如 16MB），超限放弃缓冲、退回 live 转发（避免病态超大响应 OOM）。超限是 §12 暂缓项之一。
- **失败兜底**：重试耗尽仍 RST → 退回**现状**（`stream-error` → handler 写 H3 合成 error 帧 + `ctx.fail`）。客户端体验不比今天差，只是多花了重试时间。

---

## 8. 诚实的有效性评估（评审必读）

L2 的价值**取决于 RST 是偶发还是必然**：
- **偶发/负载相关**（四次时刻 60-148s 离散 → 倾向此）：重试在不同负载时刻有真实成功机会，L2 提高成功率。
- **该请求对 GHC 必然超预算**（大输出 × 超大上下文本质太慢）：重试会**再次 RST**，L2 只是多烧一次 150s 仍失败。

**缓解（可选 escalation）**：重试时**收紧** `context_management`（GHC 原生 `clear_tool_uses` trigger 调低 / keep 调小，**非** auto_truncate）压上下文 → 生成更快 → 更可能在 RST 窗口前完成。把 L1（治根：让生成 fit 进 GHC 预算）与 L2（重试）结合，是提高 L2 命中率的正交手段。默认关闭（改变语义），作为 opt-in。

→ **评审决策点**：L2 是否值得做，取决于团队对"RST 偏偶发"的判断。若实测重试命中率低，应优先 L1（context_management 治根）而非 L2（重试治标）。建议 L2 落地后**先采集重试命中率遥测**再决定默认是否开启。

---

## 9. 配置

| 配置键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `anthropic.protect_streaming_generation` | `false \| "on" \| "tool_use_only"` | `false` | L2 总开关。`on`=所有流式响应缓冲重试；`tool_use_only`=仅当请求带 tools（大 Write/Edit 场景）才缓冲，纯文本对话仍 live 流式（省时延）。默认关。 |
| `anthropic.protect_streaming_max_retries` | number | `3` | mid-stream RST 的重试上限（§7；默认 `3` per §15 D2——loop/成本闸非超时闸）。 |
| `anthropic.protect_streaming_escalate_context` | boolean | `false` | 重试时是否收紧 `context_management` 压上下文（§8）。**[已落地]** 每次重试 FORCE 渐进激进的原生 `clear_tool_uses`（trigger 每轮减半至 4096 floor、keep -1 至 1），独立于 `context_editing`、尊重模型支持（不支持则安全降级 no-op、不 400）、不 override 客户端自带 `context_management`。 |
| `anthropic.protect_streaming_heartbeat` | number | `15` | 缓冲期强制 heartbeat 间隔秒（§5）；L2 启用时即使全局 `fake_sse_heartbeat=0` 也注入。 |
| `anthropic.protect_streaming_buffer_cap_bytes` | number | `16777216` | buffer 上限（16MiB），超限 ABANDON 缓冲、退回 live 写穿（§7；该响应失去 L2 保护、不重试）。`0`=无限。 |

热重载语义同其它 `anthropic.*`（`applyConfigToState`）。

---

## 10. 可观测性 / History

- **每次尝试都是一条 attempt**：复用 driver 既有 per-attempt 记录（`beginAttempt` / S4 retry 已有的 attempt 模型）。失败的 mid-stream 尝试记 `attempts[].error`（含 `transport-close` + elapsed/frames/bytes 诊断，复用 `logUpstreamStreamError` 的信号）；最终成功尝试产 `outboundResponse`。
- **诊断日志**：每次 RST 重试打一行 `[RETRY-stream-n] … transport-close … (buffered retry)`，与既有 `[RETRY-n]` 风格一致，operator 能看到"这个大生成重试了几次"。
- **forwarded track**：只在最终 commit flush 时采样（客户端实收的是完整响应）；中途失败尝试的帧**不**进 forwarded（客户端从没收到它们）。上游原始 `sseEvents` 仍按尝试记（richest-data-flow：每次尝试的上游原貌都留痕，便于分析为何 RST）。
- **遥测**：`history.protect_streaming_retry{outcome:success|exhausted}` 计数,支撑 §8 的"重试命中率"决策。

---

## 11. 实现 phases（commit invariants：每个中间 commit 不让系统半坏）

- **Phase 0 — golden 基线**：在改前锁住现有 live-streaming 路径的字节 golden（复用 `response-rewrite-golden.http.test.ts` 范式）+ 一个 mid-stream RST 失败的现状测试（注入 http2 stream error → 现状 `stream-error` → H3 error 帧）。证明改动前后 live 路径字节等价。
- **Phase 1 — driver `runResponseBufferedSink`（默认不接线）**：新增 driver 方法 + per-attempt 重置 + buffer/flush + re-exchange 循环，但 handler **不调用**（`protect_streaming_generation` 默认 false → 仍走 `runResponseSink`）。单测覆盖：注入"前 2 次 transport-close、第 3 次完整"的上游 → 断言客户端只收到第 3 次的完整响应 + 前两次记为 attempts。此 commit 系统行为零变化（新方法是死代码待激活）。
- **Phase 2 — handler 接线 + 配置门控**：`pumpAnthropicStreamingV4` 按 `protect_streaming_generation` 选 `runResponseSink`(live) vs `runResponseBufferedSink`(buffered)。默认 false → 行为不变。开启后 e2e 测：mock 上游前 N 次 RST、第 N+1 次完整 → 客户端透明拿到完整 Write。**[已落地 2026-06-22]** commits `caa0af7`（fixture 修复）/`6c8095a`（handler 接线 + 配置三键 + 强制 heartbeat + acc 全量重置）/`cedaa42`（per-attempt sseEvents 持久化 D1）/`c239e1f`（焦点审修复：H2 区分 + final 尝试不重复 sseEvents）。heartbeat 强制与接线**同 commit**（§14 红线）。**注**：buffer cap 留 Phase 3。
- **Phase 3 — heartbeat 强制 + escalation + buffer cap**：缓冲期强制 heartbeat、可选 context escalation、buffer 上限退回 live。**[已落地 2026-06-22]** heartbeat 强制随 Phase 2（`6c8095a`）；buffer cap `98d7f7c`；escalation `bebf595`（+ `7cdc92d` 补 force-inject 的 context-management beta header）。
- **Phase 4 — 遥测 + 文档**：重试命中率计数 + DESIGN/history.md/config 文档同步。**[已落地 2026-06-22]** 遥测 `65d1896`（`protect-streaming-stats` 计数器 + `/api/status.protect_streaming` + ctx feature tag）；heartbeat=0 跨字段告警 `cab8364`；文档同步本次。

每个 commit：`bun run test:backend` + `typecheck` 绿；live 路径 golden 不变（确认未误伤默认路径）。

---

## 12. 暂缓项 / 开放问题（评审定夺）

- **Q1**：retry cap 默认 1 vs 2？取决于客户端超时余量 + 单次生成时长分布。建议先遥测单次时长 p50/p95 再定。
- **Q2**：`tool_use_only` 门控如何判定"带 tools"？请求 `tools` 非空即可，还是需更精细（仅 Write/Edit 类）？倾向前者（简单、覆盖目标场景）。
- **Q3**：`idle-timeout` 是否纳入重试？上游静默死与 transport RST 不同；默认不重，避免与真卡死上游纠缠。
- **Q4**：buffer 上限超限退回 live 转发后，该响应**失去 L2 保护**（live 流一旦 RST 仍失败）。可接受（病态超大响应罕见），但需文档化。**[已落地+文档化]** `protect_streaming_buffer_cap_bytes` 默认 16MiB；retreat 后不重试（帧已转发）。
- **Q5**：escalation 收紧 context_management 改变了请求语义（丢更多旧上下文）——是否应在响应里给客户端某种"本响应经过上下文压缩"的提示？倾向否（透明即可），记此问题。**[决议]** 不提示（透明）；**额外决定**：escalation 不 override 客户端**自带**的 `context_management`（尊重其显式上下文策略，见 `request-preparation.ts` 注释）。**勘误**：早先误以为 opus-4.8 不在 `modelSupportsContextEditing`——核对官方 GHC 源（catch-all `startsWith('claude-opus-4')` → opus-4.8 = true）后确认本项目逐版本白名单漏了 4-8，已补（`features.ts`），escalation 现对 opus-4.8（L2 目标模型）正常生效。
- **Q6**：与 web_search 双跳 `[bypass]`（不进 driver）的交互——双跳路径不享 L2，需在双跳迁 driver 时收敛（与既有 `[bypass]` 暂缓项一致）。
- **Q8 — L2 是否推广到非 Anthropic 格式？决议：暂不，保持 Anthropic-only（2026-06-22 判断，用户确认记录）**。
  - **漏洞本身格式无关**：CC / Responses-HTTP / Responses-WS / Gemini 全走同一 `runResponseSink` + http2-client（`chat-completions/handler-v4.ts:345`、`responses/handler-v4.ts:292`、`responses/ws.ts:330`、`gemini/handler-v4.ts:272`），**同样会被 GHC mid-stream RST/截断**——不是 Anthropic 专属弱点。
  - **但只在 Anthropic 被观测到，非巧合**：触发条件是 Claude Code 在超大上下文（150-200K）上做大 Write/Edit、opus-4.8、~150s 生成——是 **Claude Code→Anthropic 的工作负载特征**。非 Anthropic 客户端（Codex→Responses、OpenAI SDK→CC、Gemini）不一定跑同样的"巨上下文+巨输出"模式。给**未观测到的问题**建 premium 保护 = 投机性表面（违反 YAGNI）。
  - **L1 已覆盖全部 4 格式作地板**：非 Anthropic 真截断 → clean error 帧 + 客户端自重试，且会记 `[FAIL] ... truncated`（日志 + history）。**故扩展的触发器明确**：等某格式在截断日志里真冒头，再针对**那一个**格式做，不盲飞。
  - **扩展的主要 per-format 成本 = 缓冲期保活帧**（非 driver 层）：L2 缓冲窗口 ~150s，无保活客户端 idle 断。**Anthropic 有原生 `event:"ping"`，但 CC/Responses/Gemini 均无 heartbeat**（代码明确：`chat-completions/handler-v4.ts:286` "no fake-SSE heartbeat (Anthropic-only)"、`responses/handler-v4.ts:247` "no heartbeat"、`gemini/handler-v4.ts:252` "no heartbeat"）。逐格式要造客户端能容忍的 keepalive（CC/Responses 候选 SSE 注释行 `:keepalive` / 空 delta chunk；Gemini 待定）+ 实测各客户端流中途收到它不报错——这才是工作量，且依赖客户端行为实测。又一"先证据再做"的理由。
  - **架构已就绪**：`runResponseBufferedSink` 格式无关（收 `ClientSink`/`ResponseOutcome`），driver 层后续推广近乎零成本；门控/重置/保活接线是逐格式的少量增量。**结论**：保持 Anthropic-only，以 L1 截断日志为扩展触发器，符合本 RFC §8「先采集遥测再决定」哲学。

---

## 13. 与既有机制的关系

- **不替代** `recover-tool-call`（重建降级 tool-call 文本）——那是另一类上游怪癖（文本降级），L2 是流断裂保护，正交共存（L2 缓冲的帧本就经过 recover 改写）。
- **不替代** `anthropicFakeSseHeartbeat`——L2 **复用**它做缓冲期保活。
- **超越官方**：GHC 客户端对自己做"回滚 partial + 重发"（`clearToPreviousToolInvocation`），但对 premature-close 放弃；L2 替 Claude Code 做这件官方放弃的事，且靠代理的 abort 判别优势安全地只重 transport-close。
- **持久化**：本 session 已修的持久化韧性（失败 entry 无损落盘 + 诊断）让 L2 的"重试命中率"可被事后从 history 验证——两项工作互补。

---

## 14. 评审发现与修订（2026-06-22 对抗审，已读真实代码核验）

第一轮对抗审判定**设计理念正确、值得做、driver/sink/runExchange 集成点真实可行、不需返工**，但发现动手前必须补的缺陷。已修与待定：

### 已修入设计
- **[CRITICAL] commit 条件漏 `sawMessageStop`**（§3 已修）：Bun 下 clean 服务器 RST（`stream.close(code)`）被当正常 `end`、rstCode=0、不可检测（`http2-client.ts:169-175`）→ `runResponse` 正常收尾 → `complete`。原伪码把"循环结束"当 commit 条件，会把 clean-RST 砍断的**半截响应误 commit 给客户端**——恰在最该重试时不触发。修复：commit 条件 = `complete && acc.sawMessageStop`；`complete && !sawMessageStop`（truncation）当**可重试**信号（等价 transport-close）。复用 handler-v4.ts:627 既有 `!acc.sawMessageStop` 防线。
- **每尝试重置必须覆盖全部 handler 侧累积态**（§4 强化）：`acc`/`sseEvents`(local)/`forwardedSseEvents`/`streamState`(bytesIn/eventsIn)/`checkRepetition` 全是 handler 闭包局部（handler-v4.ts:528-538），S5 链 state 在 driver 内部。重置劈两半：driver 每尝试重建 S5 链（`assembleResponseRewrites`+`createState`）；handler 经 `onAttemptReset` 回调重置**全部**上述态。**改造点**：`acc` 现为 `const`，须改 `let` 且 `onUpstreamFrame` 闭包读可变引用，否则失败尝试的帧叠加到上次 acc → usage/content/token 跨尝试污染翻倍。原 §4 只点了 acc+forwardedSseEvents，**漏了 sseEvents/streamState/checkRepetition**——必须全覆盖。
- **§4 "handler 不再先 runRequest" 自相矛盾**（修正）：S1-S3（parse/route/translate/rewrite-in）只能跑一次（建 ctx、跑请求改写、消费 betaProbe），重试只重入 **S4**。正确形状：handler 仍 `runRequest` 拿首流 + settled env → `runResponseBufferedSink(firstUpstream, env, sink, reExchange)`，`reExchange = () => runExchange(env)` 重入 S4。首次 exchange 与重试 exchange **不对称**（首次经 S1-S4，重试仅 S4）。
- **heartbeat 缓冲期保活其实成立**（§5 修正论证）：`makeSseSink` 的 heartbeat timer 构造即起（`client-sink.ts:188`，`lastRealMs` 初值 `Date.now()`），`tick` 只比 `Date.now()-lastRealMs`，**不依赖有过 write**。缓冲期（从不 write）ping 照常 fire。原 §5 把这写成"致命点"是误读自己代码——保活机制可行。
- **[HIGH] ping 跨尝试污染 forwarded**（§10 修正）：缓冲期 fire 的 ping 经 `client-sink.ts:180 sampleForwarded` 进 `forwardedSseEvents` 且已写客户端线缆。若该尝试随后失败重来，上次的 ping 已落 forwarded。故 §10"中途失败尝试的帧不进 forwarded"**字面为假**——修正为"ping 例外，跨尝试累积；内容帧仍只在最终 commit 进 forwarded"。
- **[HIGH] Phase 顺序**（§11 修正）：heartbeat 强制注入必须与 Phase 2 接线**同 commit**——否则开 L2 但没配 `stream_fake_sse_heartbeat` 的用户，缓冲期裸奔无 ping → 比现状更早 idle 断（违反 transitional-states-need-explicit-no-harm）。buffer cap 可留后。
- **配置键名**：全文 `anthropic.fake_sse_heartbeat` 应为 `anthropic.stream_fake_sse_heartbeat`（state 字段 `anthropicFakeSseHeartbeat`，handler-v4.ts:571）。`protect_streaming_heartbeat` 与既有键关系：buffered 路径**无条件**构造 heartbeat（既有键 >0 取其值，否则用 `protect_streaming_heartbeat` 兜底）。
- **其它格式非目标显式声明**（§2/§12 补）：CC / Responses-HTTP / Responses-WS / Gemini **全走 `runResponseSink` + http2-client，同样会被上游 mid-stream RST 砍断**。L2 先做 Anthropic（目标场景集中在 Claude Code→Anthropic 大 Write），但 `runResponseBufferedSink` 保持**格式无关**（收 `ClientSink`/`ResponseOutcome`）以便后续推广——避免隐性范围债。

### 待你定的决策（设计层，需输入）
- **[HIGH] D1 — 多尝试上游原貌存哪**：ctx 只有**单个** `_sseEvents` 槽，`setSseEvents` 是整体替换（request.ts:269）——**架构上存不下多尝试的上游帧**。§10 想"每尝试留上游原貌"与此直接冲突。二选一：(a) 给 ctx/attempt 加 per-attempt sseEvents API（能事后分析"为何前几次 RST"，但要动 ctx 数据模型）；(b) 放弃多尝试上游留痕，只留最终成功尝试的帧（失败尝试只留 attempts[].error 的诊断摘要）。**倾向 (a)**（§8 的"重试命中率/为何失败"诊断价值高），但要评估改 ctx 的范围。
- **D2 — retry cap N 与客户端超时性质**：N=1 时总墙钟 ~300s > Claude Code ~258s。但 heartbeat 只防 **idle** 超时，不防 **absolute** 超时。**必须先实证 Claude Code 的 258s 是 idle 还是 absolute**（empirical-verification）：若 idle，heartbeat 救得了、N=1 可行；若 absolute，N=1 已超须降级或放弃重试。建议落地前先测客户端超时性质 + 采单次生成时长 p50/p95，再定 N。
- **D3 — escalation 默认**：`protect_streaming_escalate_context` 默认关时，对"必然超预算"类请求 L2 = 烧 2×150s 仍失败（负收益）。审查认同"总开关默认关 + 落地后先采命中率遥测"策略，但默认启用的前置是 `tool_use_only` 门控 + 命中率达标。确认此策略即可。

> 后续轮次（big-feature-pipeline 要求 3+ 轮）应在 D1-D3 定案后再审一轮，重点核 per-attempt 重置的时序正确性与 ctx 数据模型改动。

---

## 15. 决策定案（D1–D3，用户 2026-06-22 拍板）

### D1 — 多尝试上游原貌：采 (a)，挂 per-attempt（动 ctx 数据模型）

放弃"单个 ctx `_sseEvents` 槽只留最后一次"，改为**每尝试各留上游原貌**：

- **ctx/attempt 模型扩展**：`Attempt` 记录新增 `sseEvents` 字段；新增 ctx API（如 `ctx.recordAttemptSseEvents(frames)` 或让 `onUpstreamFrame` 写当前 attempt 的槽）。`onUpstreamFrame` 缓冲期采的上游帧写进**当前 attempt** 的 sseEvents，而非顶层 `_sseEvents`。
- **顶层 `_sseEvents` 语义**：commit 时 = 成功那次 attempt 的 sseEvents（即 `inboundResponse.sseEvents` 仍是客户端最终对应的那次生成的上游原貌，向后兼容现有读取）。
- **History 持久化**：per-attempt sseEvents 天然落 `entry_stages`（已按 `attempt_index` 分行，schema 无需大改——`STAGE.sseEvents` + attemptIndex）。失败尝试的上游帧 → `attempts[i].sseEvents` → 事后可逐次分析"为何前几次 RST"（§8 命中率/失败诊断的关键数据）。
- **2nd review 重点**：ctx API 改动范围、`onUpstreamFrame` 写当前 attempt 的时序、读侧（history/UI）对 per-attempt sseEvents 的呈现。

### D2 — retry cap N：可配置，默认放宽到 3（loop/成本闸，非超时闸）

实证定性：客户端（Claude Code）258s 是 **idle 超时**（用户见过更久的成功生成）→ heartbeat 可无限保活缓冲期 → N **不受客户端超时约束**。N 的唯一作用是**给"对 GHC 必然超预算"的请求一个有限放弃点**（否则每轮再 RST → 无限循环烧 GHC 计费 + 占资源）。

- `anthropic.protect_streaming_max_retries`：默认 **3**（原 §7/§9 的 `1` 作废——那是超时驱动的保守值，现约束解除）。`0` = 不重试（退回现状 live 路径）。可调更大。
- 文档须讲清：这是 loop/成本闸，不是超时闸；调大只增加偶发 RST 的命中机会，对必然超预算的请求只是多烧时间。
- **可选正交闸（暂缓，§12 增补 Q7）**：总时长预算 `protect_streaming_max_total_ms`（累计超 T 放弃）——比 count 更贴合时长方差，但默认只用 count 上限，T-budget 留待遥测后按需加。

### D3 — escalation 默认关：确认

`protect_streaming_escalate_context` 默认 `false`（重试不收紧 context_management，保请求语义）。L2 总开关 `protect_streaming_generation` 也默认 `false`；默认启用的前置是 `tool_use_only` 门控 + 命中率遥测达标（§8）。

> D1-D3 已定，进 2nd 对抗审（重点：D1 的 ctx/attempt 数据模型改动 + per-attempt 重置时序 + onUpstreamFrame 写当前 attempt 的正确性），通过后进 Phase 0（golden 基线）实现。

---

## 16. 转发粒度定案：A 基线落地，B 未来探索（用户 2026-06-22）

评审中质疑"必须等 `message_stop` 吗，能否结构完成就发"，定案：

### A（本 RFC 主体）— 缓冲整条、`sawMessageStop` 后 commit —— **现在做**
- 选它的理由：对目标场景（大 tool_use 是 bulk 也是唯一风险块），缓冲早块（thinking/text 小、秒级）几乎不加延迟，而**永远保住重试退路**（什么都没发出去 → 任何时候都能整请求重发），简单稳。

### B（未来探索方向，不在本期实现范围）— 完整块 live 转发 + continuation 续写重试
- **形态**：已 `content_block_stop` 的块立即 live 转发（低延迟），只缓冲"正在生成的块"；该块 RST 时**不整请求重发**（会与已发块矛盾），而是把已完成块作 **assistant prefill** 拼回请求让 GHC **续写**（模型把 prefill 当前文 → 续出的块连贯一致）。
- **两个硬限制（决定 B 能否做）**：
  1. **continuation 只能在完整块边界续**——半截 tool_use 是残缺 JSON，不能作 prefill（Anthropic 不支持 resume 半条消息）。故那个大 Write 块**每次仍整块重生成**，B 没让最难的部分变容易。
  2. **GATING 研究项**：GHC 是否接受 prefill 含 **thinking 块（带 signature）** 的 assistant turn 再续写（thinking-prefill 可行性 / adaptive thinking 约束 / GHC 兼容）。**若不可行**：live 已发出 + RST + continuation 用不了 + 整请求重发不一致 = **彻底没退路只能报错**——这是 B 的致命风险，必须先证。
- **为何对本 case 收益小**：tool_use 占 ~148s 几乎全部生成时长，B 的"早块 live"延迟红利微小、"只重生成失败块之后"省的也主要是小前缀；复杂度（prefill 构造 + thinking signature 重放 + GHC 验证）和"没退路"风险却很大。
- **未来若探索 B**：先做 gating 研究（refs/ 核 GHC continuation 实现 + 实测 thinking-prefill 续写），可行再设计；不可行则 B 永久搁置，A 即最终形态。

> 转发粒度已定案（A 实现、B 探索）。设计层全部决策（§14 首轮审修订 + §15 D1-D3 + §16 A/B）闭合，进 2nd 对抗审 → Phase 0 实现。
