# Spec: 有状态 client.outbound + 重复输出截断（stateful client.outbound + repetition truncation）

状态：**草案（2026-07-22）** · 设计阶段两轮 + spec 草稿再审两轮异模型对抗审查（GPT + Claude opus，独立收敛，0 blocker）已消化 · 待用户批准 · 归属：`docs/spec/`

关联：
- 上位 RFC [docs/rfc/2026-07-14-symmetric-four-point-hooks.md](../rfc/2026-07-14-symmetric-four-point-hooks.md)（§9 sink-egress 统一化本在其 deferred 范围；本 spec 实现 §9a+§9b）。
- ADR 待建 `docs/decisions/2026-07-22-stateful-client-outbound.md`（决策级：client.outbound 有状态化 + sink-egress 统一 + 破坏用户 hook 单帧契约）。
- [docs/spec/2026-07-11-block-level-buffered-retry.md](2026-07-11-block-level-buffered-retry.md)（commit-boundary 抽象、双缓冲交互面、M-2 keepalive 实证门）。
- ADR [decisions/2026-07-05-richest-data-flow.md](../decisions/2026-07-05-richest-data-flow.md)（forwarded 轨整形不碰 upstream-original 轨；合成帧必打可辨识标记）。
- [docs/streaming.md](../streaming.md)（活文档，须同步）、[docs/DESIGN.md](../DESIGN.md)「活的架构现状」client.outbound 行、[docs/todo/deferred-backlog.md](../todo/deferred-backlog.md)（§9 现状条 + 新增 Gemini 排除条）。

> 本 spec 描述**目标态与为何**，不是实施步骤（plan 职责）。审查采纳/未采纳记录见 §14。

---

## 1. 背景与问题（Why）

### 1.1 实证故障

`req_1784742426806_1482`（`claude-opus-4.8`，`/v1/messages` 流式）：一个 `text` 块在正常散文（前 572 字，讨论 UI 设计）后**退化成死循环**——`card\n\n（专注。）\n\n` 连续重复 **204 次**（约 2652 字），随后模型自愈、发出 `AskUserQuestion` 工具调用并以 `stop_reason: tool_use` 干净收尾。代理把这 204 份**逐字节原样转发**给客户端（`clientResponse.sseEvents` 与上游帧一致）。这段垃圾文本会连同 tool_use 一起进入客户端对话历史、污染下一轮上下文。

### 1.2 现状：检测器只观察、不修复

`src/lib/repetition-detector.ts` 的 `createStreamRepetitionChecker`（`:175`）用 KMP prefix-function 判周期，命中时 `consola.warn`、返回 boolean。但唯一消费者 [streaming-pump.ts:120](../../src/routes/messages/streaming-pump.ts) 调 `checkRepetition(delta.text)` **丢弃返回值**（接口类型 `:55` 就是 `(text) => void`）。全仓无第二消费者、无 `abortOnRepetition` 开关、`src/lib/config` 无 repetition 配置。检测器**只接在 Anthropic 路径**、读的是 upstream-original 帧（诊断上游真实行为）。

**结论**：检测触发但不修复响应是当前设计的必然——它是「接了灯没接喷淋」的烟雾报警器。本 spec 补上喷淋。

### 1.3 为何挂在 client.outbound 而非 codec rewrite

截断是**vendor 中立的「客户端可见输出整形」**关注点。四点 hook 架构（RFC 2026-07-14）里 `client.outbound`（`hooks/types.ts:46`）正是「每个已渲染 client 帧、sink write 前」的出口整形挂载点。把它埋进某个 codec 的 S5 rewrite 链（`response-rewrite-adapters.ts` 旁）会：(a) 按 `targetEndpoint` 分门注册、translate 腿众多导致 N 处注册；(b) 语义错位（出口关注点塞进上游 wire 处理层）。用截断作 §9 sink-egress 统一化的首个消费者，符合 long-termism。

**诚实记录（审查 #8）**：post-render 帧是 per-client-format 的（Anthropic `text_delta` / CC `choices[].delta.content` / Responses `output_text.delta`），故无论挂哪层都需 per-format 文本抽取+重发，「一挂载覆盖多端」的收益被部分抵消。真正卖点是**vendor 中立客户端层 + 推动 §9 roadmap**，不是省事。

---

## 2. 目标与非目标

**目标：**
- G1 **§9a**：把 `client.outbound` leaf 从单帧 `(frame,env)=>ClientFrame|undefined` 升级为**有状态转换器**（`createState(env)` + `transform→FrameAction`(buffer/emit-多帧/drop) + `flush`），与 `ResponseRewrite` 同契约。per-request 状态隔离（现为单模块 singleton、无隔离）。
- G2 **C1 idle 保活**：eager 转发 `content_block_start`、只缓冲 `text_delta`、block-aware keepalive 发能重置客户端 300s 死线的空 delta。
- G3 **§9b**：把 client-egress 挂载点从 candidate-local `postRender` 下沉到候选仲裁**之后**的 `delivery/session.ts` 串行写 choke point，覆盖全量 client 字节（渲染帧 + sink 合成/心跳/anchor 帧）+ 统一 forwarded-轨 provenance 标记。
- G4 **重复截断特性**：作为首个 first-party 有状态 client.outbound 消费者，把退化重复折叠到 `keep_copies` 份（默认 1）+ 可配置可见 marker。
- G5 覆盖 Anthropic `/v1/messages` + Chat Completions + Responses（HTTP+WS），流式 + 非流式。
- G6 vendor 中立配置 + 可观测性（history + telemetry）+ `/api/hooks` 内建 hook 可见性。

**非目标：**
- N1 **不含 Gemini**（`/v1beta/.../generateContent`，第 4 客户端格式）——见 §8.4 + backlog。
- N2 不做上游断点续传/续写（沿用无状态整请求重试语义）。
- N3 不改 upstream-original 轨（截断只作用 forwarded 轨；richest-data-flow）。
- N4 不移除现有 Anthropic upstream-轨 warn 报警（与整形正交，保留）。
- N5 不改非重复类错误的既有分类/重试。

---

## 3. 核心机制 A：client.outbound 有状态化（§9a）

### 3.1 契约升级（破坏性，审查 HIGH-2）

现 leaf（`hooks/types.ts:46`）：
```ts
outbound?: (frame: ClientFrame, env) => ClientFrame | undefined
```
升级为与 `ResponseRewrite` 同构：
```ts
outbound?: {
  createState(env): S
  transform(frame: ClientFrame, state: S): FrameAction   // buffer | emit(frames) | drop
  flush(state: S, reason: FlushReason): Array<ClientFrame>
}
```

**这是破坏性 API 变更，显式承认**（本项目无向后兼容负担，强制迁移可接受）。影响面须全部处理（行号进 plan 时以真实站点为准——现 hook 实读于候选层 `candidate-response-session.ts:114` postRender，§9b 迁移后集成点本就位移到 delivery 层，plan 须重列）：
- driver 的三条渲染路径调用点（`runResponseSink` / `runResponseBufferedSink`（byte-critical 缓冲重试）/ `runResponseWhole`（非流式））。
- 已文档化的用户 hook 契约（`hooks/types.ts:46` + DESIGN.md client.outbound 行 + hook-author README）。
- `/api/hooks` 的 `exports` 语义（`routes/hooks/route.ts` 读 `st.exports`）。
- **决策（§14 采纳 HIGH-2）**：采「**统一 stateful**」——用户 hook 也迁到有状态契约（不做「用户单帧 / 内建有状态」双档，避免两套 leaf 语义）。单帧用户 hook 迁移路径：`transform` 返回 `emit([f])` 即等价旧的单帧改写、`drop` 等价返回 undefined、不实现 `flush`/`createState` 即无状态直通。

### 3.2 C1：eager-start idle 保活（审查 CRITICAL-1，load-bearing）

**问题**：要「精确折叠到 keep_copies 份」必须持有整块 text_delta 到 commit 边界。若把 `content_block_start` 也缓冲，则缓冲期 wire 上零转发帧；delivery/sink 的 open-block ledger 只从**实际写出的帧**派生（`delivery/session.ts:132-156` `applyWireFrame`；旧 `client-sink.ts:250-263` `noteBlockState`），无写出=无 open block→block-aware keepalive provider 收到 `openBlock=undefined`、退化为裸 `event: ping`（`client-sink.ts:404`），而裸 ping **不能**重置 Claude Code 的 300s no-real-content 死线（`client-sink.ts:44-54` OpenBlock doc 明载空 delta 才重置死线，`exp/cc-idle-280s` 实证）。

**为何 anchor scaffold 救不了（审查复核纠正）**：default `streamKeepaliveMode="empty_text"`（`state.ts:1767`），live 流式 Anthropic 走 `makeAnchoredSseSink`（`handler-v4.ts:509/581`）**确有** anchor 注入器（`session.ts:115` `injectScaffold`）——故「live 路径无 anchor 注入器」是**错误论证**（原 `client-sink.ts:88` 那句「Registered ONLY on buffered path」属已被 `makeDeliverySseSink` 取代的旧 `makeSseSink`）。真因：anchor 注入器被 `everOpenedRealBlock`/`scaffoldAttempted` latch **门控到「首个真实块之前」窗口**（`client-sink.ts:417` / `session.ts:115`：仅当 `openBlocks.length===0 && !scaffoldAttempted` 才注入），故**一旦块已开、正缓冲其 delta，scaffold 不再触发**，无法覆盖块内中途 idle 缺口——这才是 eager-start 必需的正确理由。

**机制**：截断 hook 对一个 text 块——
1. **eager 转发** `content_block_start`（立即 emit，保持 wire 上块 open，delivery ledger 派生出 open block）；
2. **只缓冲** `text_delta`（`transform` 返回 buffer），同时喂共享核检测；
3. 缓冲期若 block-aware keepalive 触发，它据 open block 类型发空 `text_delta@index`（能重置 300s 死线）；
4. 到 `content_block_stop`（该块 commit 边界）`flush`：未命中→原样吐全部缓冲 delta（字节等价）；命中→吐 `keep_copies 份 + marker delta`，丢弃其余；随后放行 `content_block_stop`。

thinking / tool_use / 心跳 / anchor 帧一律不缓冲、直通。

### 3.3 hook 状态生命周期（审查 CRITICAL-2）

**跨 attempt 污染在选定层结构性不存在（审查复核纠正）**：§9b 把 transform 挂在 `delivery/session.ts`——该层 identity/ledger「outlive every upstream round」、round 通知是 no-op（`session.ts:6/51`；`noteUpstreamRoundStarted/Ended` 经 grep 确认是**生产死代码**、仅测试调用）。retry 发生在 delivery 的**上游**（candidate/probe 层，每 attempt 新 candidate session、`createState` 天然 per-attempt）；失败 attempt 的半缓冲帧**从不调用 `sink.write`**（`runResponseBufferedSink` 的 `buffer` 是 attempt-local、retry 时 `continue` 丢弃），`committedAny` 一旦真则 retry 窗口永久关闭；hedge 只有 winner 帧到达 delivery。故 delivery 层**每块 open/close 各一次**，跨 attempt 污染无从发生——原 `onAttemptReset` 语义是针对旧 postRender/per-candidate 布局的**表述残留**，不适用本层（且当前也无信号通道传达「新 attempt」给 delivery）。

hook 缓冲状态生命周期就本层（唯一存活流内）定义：
- **createState 时机**：每 client 请求一次（§9b 下 = delivery 层 per-request）。per-block 累加器于每个 `content_block_stop` 自然归零（无需显式 attempt-reset）。
- **abort（client 断连，`delivery/session.ts` terminate）**：`flush(state, "client-aborted")` **丢弃**缓冲（客户端已走，合理），不写已关闭 sink。
- **上游截断（无 message_stop）**：`flush(state, "upstream-truncated")` 按 block-level spec §5.2 partial-degrade——已发帧收不回；仍在缓冲的 delta 若命中则尽力吐折叠+marker、否则原样吐（never 静默丢）。
- **never-throw**：flush/transform 是 fire-and-forget never-throw（见 skill `persistence-async-invariants`）。

---

## 4. 核心机制 B：sink-egress 统一化（§9b，byte-critical）

### 4.1 挂载点下沉

现 `client.outbound` 挂在 candidate-local `postRender`（`candidate-response-session.ts:142` `onRenderedFrame`），且**同位置**还耦合：`boundary.observe(...)`（喂 hedge/candidate-race，`candidate-race.ts` 依赖）+ 诊断 capture（`captureGenerationDispatchFrameTransform`）。

**§9b 迁移是「拆分 postRender 职责」，非「移一行」（审查 CRITICAL-3）**：
- **boundary-classifier + 诊断 capture 留在 postRender**（candidate-local，hedge 竞速核心依据，绝不能动）。
- **有状态 client.outbound 转换器下沉到 `delivery/session.ts` 串行写 choke point**（候选仲裁**之后**，只有 winner 帧流经、per-request 状态语义正确；WS 经 `makeDeliveryWsSink` 归一到此）。

### 4.2 覆盖与 provenance

sink 层挂载后 hook 见**全量 client 字节**：渲染帧 + sink 合成/心跳/anchor 帧。sink-origin 帧标记为 sink-origin，有状态 hook **可选择不缓冲**（截断器不缓冲心跳/anchor，保其准时）。

**心跳归属（审查复核纠正）**：`makeDeliverySseSink` 已把 heartbeat 从 raw `makeSseSink` 剥离（`client-sink.ts:468`），生产 delivery 路径**只有 delivery 心跳**（`delivery/session.ts:107` `tickHeartbeat`）运行、raw sink 的 `tick` 在此路径不武装。故只需确认 delivery 心跳的 open-block 派生：截断缓冲不得破坏它（C1 的 eager-start 保证 open block 存活于 `session.ts` 的 `openBlocks` ledger）。

### 4.3 byte-critical 风险与 phase 隔离（审查建议采纳）

§9b 影响面 = 全部端点全部 client 字节。**§9a 与 §9b 拆成可独立验收的两 phase**（风险隔离，非砍范围）：§9a 失败模式=「截断逻辑本身错」；§9b 失败模式=「全端点帧顺序/provenance 变」，性质不同、需独立 golden-fixture 回归窗口。§9b 的 commit invariant：**truncation disabled 时 delivery 输出与迁移前逐字节等价**（含 Gemini `flushResponse` 帧、Anthropic timer heartbeat 帧、anchor start/stop 帧的相对顺序），用真实渲染 golden（非 identity codec）锁四格式。

---

## 5. 特性层：重复截断

### 5.1 共享核（审查 HIGH-1：新建，非复用）

现 `repetition-detector.ts` 只返回 boolean、用有损滑窗（`:62-63` `slice(-maxBufferSize)`，默认 5000）、分析窗再 cap 2000（`:107`）、只给 period 数值。204× 块超窗口 → **产不出** `{collapsedText, truncatedCount}`。

新建 `src/lib/text-repetition/`（借鉴 KMP 思路，**非复用**）：
- 输入：一段**完整累积**文本（非滑窗尾部）。
- 输出：`{ collapsed: string, truncatedCount: number, unitLength: number }`。
- 定义超大块行为：whole-text 累积（有界上限可配，超限退化为「保留原文 + 仅告警不折叠」，never 丢内容）。
- 观察-only detector（`repetition-detector.ts`）**保留原样**（滑窗告警足够）——两套并存。

### 5.2 截断阈值与告警阈值解耦（审查 MEDIUM-1）

修改客户端输出的阈值**绝不能**沿用告警默认（`minPatternLength:10, minRepetitions:3`）——合法三次重复（诗歌 refrain / Markdown 表格 / 模板代码 / 重复免责声明）会被误折叠。新增独立 `truncation_min_repetitions`（默认显著更高，建议 ≥8）+ 保持较大 `min_pattern_length`。事故是 204×，与合法 3× 差两个数量级，高阈值安全。spec 须附正样本（真实「请重复三遍」合法场景）验证不误伤。

### 5.3 per-format 文本抽取

hook 见 client-format 帧，按格式抽取/重发文本段：
- Anthropic：`content_block_delta(text_delta)`/块，边界 `content_block_stop`。
- Chat Completions：`choices[].delta.content`，边界=终止（`cc-commit-boundaries.ts:3`，仅上游 error+finishReason；terminal-only=整段缓冲）。
- Responses（HTTP）：`output_text.delta`/item，边界 `output_item.done`（`openai-responses/commit-boundaries.ts`）。
- Responses（WS）：`ws.ts:376` commitBoundaries 故意省略=纯终态提交（§8.3）。

### 5.4 非流式（审查 MEDIUM-3：独立第二挂载点）

非流式走 `runResponseWhole`→`ResponseRewrite.transformWhole`（`driver.ts` 约 :1350），**不经** client.outbound。故非流式折叠是**独立的第二挂载点**：新增一个 `transformWhole` 分支（Anthropic/CC/Responses 各一），**共享 §5.1 同一纯核**。spec 明确「两个 client-egress 挂载点（流式 sink-egress + whole-response），共享核」，不把 client.outbound 说成覆盖一切。

### 5.5 provenance 标记（审查 MEDIUM-2；richest-data-flow 硬规则）

marker 帧是注入 forwarded 轨的合成帧，**必须带可辨识标记**。

**注入通道决策（审查复核纠正）**：§4.1 把挂载点定在 `delivery/session.ts`，故 marker 经该层落盘。按 `frame-origin.ts` 模块 doc「keepalive/anchor 等经 dedicated write 方法标记、非 frame tag」，marker 应走 delivery 的 dedicated write（`session.ts:249-271` `writeToSink` switch），标记归 **`DeliverySyntheticKind`**（`delivery/types.ts:5`，现 `"keepalive"|"anchor"|"synthetic-message-start"|"synthetic"`）而非 frame-tag 族 `SyntheticOriginKind`。

**「新顶层字段多站点必改」全清单**（对齐记忆 `methodology-full-primitive-not-partial-else-silent-field-drop`，选完整版非小版）：新增 `DeliverySyntheticKind` 值 `"repetition-truncated"` + `session.ts:250` `writeToSink` switch 分支 + `session.ts:273` `syntheticKind()` 映射 + 该 kind 到 history/telemetry 的 `OperationSyntheticKind`（`context/model-operation-record`，即 `SseEventRecord["synthetic"]` 的真实来源）投影。**核对项**：若首版退化为复用现有 `"synthetic"` 走 `writeSynthetic` 亦可（marker 仍可辨识），但须显式记录该退化、勿静默丢新 kind。

被 drop 的 203 份**不进** forwarded 轨（upstream-original 轨经 `response-processor.ts:149-155` pre-render 采样保全全部 204 份）；保留的 keep_copies 份是真实帧、不打标；仅 marker 帧打新 kind。

### 5.6 与 block-level-buffered-retry 双缓冲（审查 HIGH-3）

block-level-buffered-retry 已 landed。Responses buffered-merge 在 flush 时**从累加器重渲染** item（`responses/candidate-response-session.ts:151`）——若折叠发生在其**之前**会被重渲染覆盖。**决策**：折叠放在**最靠 wire 的 §9b sink-egress 层**（buffered-merge 之后），避免被吃掉。spec 须画 CC/Responses（buffered ON + truncation ON）完整帧流水线时序图，并标明「客户端要等多久见首字节」。

---

## 6. 端点分档（M-2 实证门）

「精确一份 + eager-start」在 Anthropic 上无 idle 风险可默认启用；CC/Responses/WS 的 forced-keepalive「确能重置该消费者 idle 死线」在 block-level-buffered-retry spec §7.1-7.3 是**未实证 M-2 门**。

| 端点 | 首版语义 | 默认 | 升级条件 |
|---|---|---|---|
| Anthropic `/v1/messages` | 精确一份 + eager-start | 随 `enabled` | — |
| Chat Completions | **不缓冲**：实时转发 + 命中即停 + 末补 marker（近似，零 idle 风险） | 随 `enabled` | 过 CC M-2 门后升级为精确一份 |
| Responses HTTP | 同上近似 | 随 `enabled` | 过 Responses M-2 门后升级 |
| Responses WS | 同上近似 | 随 `enabled` | 过 WS M-2 门后升级 |

即：**Anthropic 精确一份为主目标；其余端点先交付零 idle 风险的近似版，各自过 M-2 实测门后再升级为精确一份**——每端取当下可安全交付的最强语义，不默认铺未验证 idle 风险（对齐 empirical-verification）。

**`truncatedCount` / `<num>` 跨端点不可比（审查复核）**：精确档（Anthropic）marker 报「被截全部份数」（本例 203）；近似档（CC/Responses/WS）需先流 ~`truncation_min_repetitions` 份才触发命中即停，客户端已收 ~8 份、marker 报较小数。故 `<num>` 与 history `pipelineInfo.repetitionTruncation.truncatedCount`（§9）**per-endpoint 语义、不可跨端点聚合比较**——§9 记录须并存 `forwardedBeforeDetection` 份数以消歧。`keep_copies` 键**仅精确档有意义**；近似档实际保留份数 = `truncation_min_repetitions`（见 §7 适用范围注）。

---

## 7. 配置

顶层 vendor 中立段 `repetition_truncation`：

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `false` | 总开关（opt-in，不擅改既有响应形态） |
| `min_pattern_length` | 10 | 触发折叠的最小模式字符数 |
| `truncation_min_repetitions` | 8 | **截断**触发阈值（与告警 `minRepetitions:3` 解耦，§5.2；默认值待 §13 Q1 实测校准） |
| `keep_copies` | 1 | 保留份数——**仅精确档（Anthropic）有意义**；近似档实际保留 ~`truncation_min_repetitions` 份（§6） |
| `marker_template` | `(<num> duplicated outputs truncated)` | 可见 marker 模板，`<num>`=被截份数（per-endpoint 语义，§6） |

经 `applyConfigToState`（`src/lib/state.ts`）传播、热重载（配置不因重命名杀进程，见记忆 `config-philosophy-separate`）。

**开启后行为变更表**（`enabled:true` 时每端点客户端可观测差异；`enabled:false` 全端零变更、字节等价）：

| 端点 | 首字节时延 | 客户端看到的重复 | marker `<num>` 语义 |
|---|---|---|---|
| Anthropic `/v1/messages` | text 块首字节延到该块 `content_block_stop`（块内缓冲；其他块/心跳不延） | 恰好 `keep_copies`（默认 1）份 | 被截全部份数（本例 203） |
| Chat Completions | 无额外延迟（不缓冲、实时转发） | ~`truncation_min_repetitions`（默认 8）份 | 命中后被截份数（<全部） |
| Responses HTTP | 同 CC | 同 CC | 同 CC |
| Responses WS | 同 CC | 同 CC | 同 CC |
| Gemini | 不在范围（§8.4），零变更 | — | — |

过对应 M-2 实证门后，CC/Responses/WS 升级为 Anthropic 同款「精确一份 + 块内缓冲」语义（届时首字节时延/保留份数对齐 Anthropic 行）。

---

## 8. 边界与排除

### 8.1 abort/cancel — 见 §3.3。
### 8.2 上游截断 partial-degrade — 见 §3.3。
### 8.3 Responses WS — commitBoundaries 故意省略（`ws.ts:376`），首版近似语义（命中即停），过 WS M-2 门后评估精确一份对 Codex WS 体验影响。
### 8.4 Gemini 排除（审查 LOW；no-silently-cut-but-defer）
不含 Gemini。根因：Gemini 整流翻译器结构不兼容（`flushResponse` 在 driver 循环外产 tool_call 帧），与 block-level-buffered-retry §7.4 同源排除。写入 `docs/todo/deferred-backlog.md`（根因/当前行为/理想架构/为何暂缓/若做需改什么）。

---

## 9. 可观测性

- history `pipelineInfo.repetitionTruncation`：每段 `{ blockIndex, truncatedCount, forwardedBeforeDetection, unitLength }`（与 `sanitization` 计数同构，落 `pipelineInfo` 唯一诊断通道，见记忆 `plan-verify-interface-location`）。`truncatedCount` **per-endpoint 语义、不可跨端点聚合**（§6）——精确档=被截全部份数、近似档=命中后被截份数；`forwardedBeforeDetection` 记已转发份数（精确档=0、近似档≈`truncation_min_repetitions`）以消歧。
- telemetry：vendor 维度 counter（截断次数 / 截断总字节），沿 telemetry registry 开放 counters bag（skill `telemetry-architecture`）。
- `/api/hooks`（审查 MEDIUM-4）：新增 `builtinHooks: string[]` 字段暴露内建 hook（如 `repetition-truncation`）及其挂载点，避免 chain 化掩盖「哪个 hook 在哪个挂载点」诊断需求。

---

## 10. 分阶段（含 commit invariants）

每阶段终态不变量、中间态绝不半坏（skill `large-refactor`）。

- **P0 地基**（默认关、字节等价）：`text-repetition/` 纯核 + 配置键 + `repetitionTruncation` provenance kind（全 union 站点）+ telemetry 维度 + golden 预捕（四格式真实渲染）。不动挂载点。
- **P1 §9a 有状态契约**：leaf 升级为 stateful，迁移 driver 三调用点 + 用户 hook 契约 + `/api/hooks`。默认无消费者→字节等价。commit invariant：无内建 hook 时 leaf 行为与旧单帧等价。
- **P2 C1 eager-start idle 保活**：Anthropic 截断 hook（eager content_block_start + 缓冲 delta + block-aware keepalive）。TDD：造 204× 重复流断言精确一份 + marker；造长非重复块断言不 idle-out（PTY/客户端 e2e）。
- **P3 §9b sink-egress 下沉**（byte-critical）：挂载点迁 `delivery/session.ts`，拆 postRender 职责（classifier 留），统一 provenance。commit invariant：truncation disabled 时 delivery 逐字节等价（含 Gemini/heartbeat/anchor 帧序）。
- **P4 三端 + 非流式**：CC/Responses 近似语义（§6）+ 三端 `transformWhole` 非流式折叠。双缓冲时序图 + 交互验证。
- **P5 M-2 实证门 + 默认收尾**：CC/Responses/WS keepalive 实证 harness；过门端升级精确一份；doc-sync（DESIGN.md 活架构行 + streaming.md 行为表 + backlog Gemini 条）。

---

## 11. 测试策略

- 单元：`text-repetition/` 纯核（含超大块退化、合法 3× 不误伤正样本、keep_copies 边界）。
- 集成/e2e：`client-proxy-e2e-testing`（真 SDK 收折叠帧）+ 造 204× 重复上游（`upstream-hook-mocking`）。
- idle 回归：PTY / 客户端连接 e2e 断言长非重复块不触发 300s 断连（skill `debugging-claude-client-connection`）。
- golden 字节等价：P0/P3 disabled 路径四格式真实渲染 golden。
- 真相域按 skill `choosing-test-type` 归位（wire 正确性用 producer oracle）。

---

## 12. 风险登记

- R1（byte-critical）§9b 迁移改变帧序/provenance → golden 预捕 + disabled 逐字节等价 invariant。
- R2 hook 状态跨 attempt 污染 / abort 丢内容 → §3.3 生命周期契约 + never-throw。
- R3 合法重复误伤 → §5.2 高阈值解耦 + 正样本验证。
- R4 CC/Responses/WS idle 未证 → §6 分档，近似版先行、M-2 门后升级。
- R5 双缓冲覆盖 → §5.6 折叠置 sink 层（buffered-merge 后）。

---

## 13. 未决问题（进 plan 前须闭合）

- Q1 `truncation_min_repetitions` 默认精确值（8？10？）——需正样本实测校准。
- Q2 §9a 用户 hook 统一迁移的具体过渡（是否留一版 shim）。
- Q3 P3 golden 四格式基线捕获的具体 fixture 集。

---

## 14. 审查采纳记录

**设计阶段**两轮异模型对抗审查（GPT-souls reviewer + Claude opus reviewer，独立收敛）。判据轴：长远正确 + 完整（非 ROI/YAGNI）。

**采纳（全部）**：
- CRITICAL-1 缓冲饿死 idle → §3.2 eager-start。
- CRITICAL-2 hook 状态生命周期 → §3.3。
- CRITICAL-3 postRender 职责耦合 → §4.1 拆分（核实 `candidate-response-session.ts:114`）。
- HIGH-1 detector 非复用 → §5.1 新建。
- HIGH-2 破坏性 API → §3.1 显式承认 + 统一迁移。
- HIGH-3 双缓冲覆盖 → §5.6 sink 层折叠。
- MEDIUM-1..4 → §5.2 / §5.5 / §5.4 / §9。
- LOW Gemini/WS → §8.4 / §8.3。
- 建议 §9a/§9b phase 拆分 → §4.3 / §10。

**spec 草稿再审**（同两 reviewer，独立收敛，0 blocker）——采纳的修正：
- §3.2 anchor 论证纠正：原「live 路径无 anchor 注入器」被代码证伪（default `empty_text` 下 live 确有 `injectScaffold`）；真因是 anchor 被 latch 门控到「首个真实块之前」窗口、覆盖不了块内中途 idle → 已改写 §3.2。
- §3.3 attempt-reset 消解：delivery 层 attempt-agnostic（`noteUpstreamRound*` 生产死代码、失败 attempt 半缓冲从不到达该层），原 `onAttemptReset` 属旧布局残留 → 已删该条、改为「per-block 累加器于 `content_block_stop` 自然归零」。
- §5.5 provenance 通道纠正：挂载在 delivery 层，marker 归 `DeliverySyntheticKind`（`delivery/types.ts:5`）+ `writeToSink` switch，非 frame-tag `SyntheticOriginKind`；补全多站点清单。
- §6/§9 `truncatedCount` 跨端点不可比 → 补 `forwardedBeforeDetection` 消歧 + `keep_copies` 仅精确档适用注。
- §7 悬空「行为变更表」→ 已落地为实际表格。
- §3.1 集成点行号 / §4.2 双心跳表述 → 按真实代码刷新（delivery 独占心跳）。

**用户裁决（2026-07-22，AskUserQuestion）**：
- 截断语义 = 精确一份 + eager-start（Anthropic 默认，其余 M-2 门后升级）。
- Gemini = 排除（→ backlog）。

**未采纳**：无（方向性建议全部采纳；纯排期建议转入 §10 phasing）。

---

## 15. 术语

- **§9a / §9b**：RFC 2026-07-14 §9 sink-egress 统一化的两半——§9a=有状态化（cardinality），§9b=全覆盖（挂载点迁 sink choke point）。
- **eager-start**：先转发 `content_block_start` 保持 wire 块 open，只缓冲 delta，使 block-aware keepalive 可发重置死线的空 delta。
- **M-2 门**：block-level-buffered-retry spec 定义的「forced-keepalive 确能重置某消费者 idle 死线」的实证门。
- **commit 边界**：某格式「块完成、可安全 flush」的渲染帧（Anthropic `content_block_stop` / Responses `output_item.done` / CC 终止）。
