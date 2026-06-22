# RFC：上游流截断检测与处理（stream completeness detection）

状态：Phase 0–2 已落地（4 条流式格式：Anthropic/CC/Responses/Gemini），Phase 3 实证确认无需代码，Phase 4 doc-sync 进行中｜作者：调试 req_1782109585894_535 触发｜关联：[[methodology-persistence-swallow-plus-lossy-fallback-loses-data]]、`docs/rfc/response-pipeline/`（Stage B owns-sink，已全部落地）

## 1. 背景与症状

Claude Code 报 `API Error: Stream ended without receiving any events`，但 proxy 端日志一片正常（`[ OK ]`）、history 记为成功——客户端报错、代理却"无任何异常输出"的悖论。

实测裁决（从运行中 proxy `/history/api/entries/req_1782109585894_535` 拉真实数据）：

- 请求：`claude-opus-4.8` 流式、107 tools、`/v1/messages`。
- 上游 14 帧：`message_start` → `content_block_start`(tool_use `Agent`) → 12 个 `input_json_delta`，累积出**无效 JSON**：`{"description": "对抗review:正确性/竞态视角", "subagent_type": "general-purpose"`（缺 `prompt` 字段、缺闭合 `}`）。
- 末帧 `offsetMs=502`，但 attempt `durationMs=11179`——上游发完残缺 tool_use 后**静默约 10.6s**，然后**干净 EOF**（非 RST：若 RST 会 throw 进 catch → `stream-error`，而本案 outcome 是 `complete`）。
- **缺失**：`content_block_stop`、`message_delta`（含 stop_reason）、`message_stop`。即上游**未发送 Anthropic 协议终止序列**。
- history 累积出的 response tool_use 自带 `_parseError: true`——proxy 自己也解析不了这段残缺 JSON。

对照组：正常流末帧序列 `content_block_stop → message_delta → message_stop`（实测 req_1782111018205_713，73 帧）。截断签名 = 末帧非协议终止符。

这是上游 GHC mid-stream 截断（记忆已记过这类上游 RST/cutoff），**不是本代理的传输 bug**。本代理的 bug 是**对截断零检测、把它误判成成功**。

## 2. 根因（逐处对照代码确认）

- [driver.ts](../../src/lib/pipeline/driver.ts) `runResponseSink`：14 帧逐帧写进 sink（全成功无 reject），上游干净 EOF → `for await` 正常结束 → `flushChain`（空）→ 返回 `{kind:"complete"}`。driver 是**格式无关**的，不知道 Anthropic 需要 `message_stop`，"干净 EOF" 对它就是 `complete`。`ResponseOutcome` 只载控制信号（complete/stream-error/settled-abort），**不载 accumulator**（types.ts 文档明确）——故"区分完整 complete vs 截断 complete"只能由 handler 凭自家 accumulator 判，driver 无需改、也无遗漏的 outcome 形态。
- [handler-v4.ts:622-628](../../src/routes/messages/handler-v4.ts)：`acc.streamError` 未置位（无 error 事件）→ 落入 `else` → **`ctx.complete(...)`**。
- [stream-accumulator.ts:156-159 / 374](../../src/lib/anthropic/stream-accumulator.ts)：`message_stop` 事件 case 是 no-op（不追踪）；`acc.stopReason` 仅在 `message_delta` 时置位。截断流二者皆无 → accumulator **没有任何"消息是否真正收尾"的概念**。

**Stage B 现状（review 实测修正）**：五条流式路径（Anthropic / CC / Responses-HTTP / Responses-WS / Gemini）**已全部切 owns-sink `runResponseSink`**，generator `runResponse` 仅剩 dry-run 消费。故四格式截断检测是**统一形态**："`complete` outcome + accumulator/meta 缺协议终止符"，**无格式走旁路 generator**（`docs/rfc/response-pipeline/stage-b-plan.md` 的"当前位置"标注已陈旧，待 doc-sync 修）。

四格式同构（都在 `outcome.kind==="complete"` 时无条件 `ctx.complete`，无完整性校验）：

| 格式 | 完成判定点 | 协议终止符 | 正确截断判据（review 修正后） |
|---|---|---|---|
| Anthropic | handler-v4.ts:628 | `message_stop` | accumulator 加 `sawMessageStop`；`started && !sawMessageStop` |
| CC | chat-completions/handler-v4.ts:375 | 任一 choice `finish_reason` 置位 | accumulator sticky `sawFinishReason`（**非**"末 choice"——见 P-CC） |
| Responses | responses/handler-v4.ts:333 | `response.completed/incomplete/failed` | `acc.status === ""`（**非**"非 completed"——见 P-Resp） |
| Gemini | gemini/handler-v4.ts:308 | `meta.finishReason ≠ UNSPECIFIED` | `getStreamMeta().finishReason === FINISH_REASON_UNSPECIFIED`（**注意 flush 顺序**——见 P-Gem） |

**S4 重试环看不到流截断**（实测确认）：[driver.ts:228-316](../../src/lib/pipeline/driver.ts) `runExchange` 在 `transport.send` 返回 upstream（拿到 200+未消费流对象）的瞬间即 return 退出。流截断在 S5 `runResponseSink` 的 `for await` 消费帧时才暴露，**远在重试环之外**，且 S5 无任何重入重试环的路径。

## 3. 设计

### 3.1 完整性检测原语（所有选项的共同基础）

每格式 handler 在消费 `outcome==="complete"` 后、`ctx.complete` 前插完整性校验，读自家 accumulator/meta：

- **Anthropic**：accumulator 加 `sawMessageStop: boolean`（`message_stop` case 置 `true`）。截断 = 已 `message_start` 但 `!sawMessageStop`。边界：纯 `message_start`+`message_stop` 空消息算完整（终止符在）；完全空响应（连 message_start 都没有就 EOF）算截断。
- **CC**（P-CC，review 修正）：判据是 accumulator 级 **sticky `sawFinishReason`**（"是否曾见任一 finish_reason"），**不是**"末 choice 有 finish_reason"——因 `include_usage` 下 finish_reason 帧后会再来一个 `choices:[]` 纯 usage 末帧，"读末 choice" 会瞎。**已知盲区**：accumulator 只读 `choices[0]`（stream-accumulator.ts:54），多 choice（n>1）时 choice[1..] 截断看不到——GHC 是否支持 n>1 待实证（OQ5），当前判据对单 choice 正确。
- **Responses**（P-Resp，review 修正）：判据是 `acc.status === ""`（什么终止符都没见）。`response.completed`/`response.incomplete`（max_tokens 等合法截断）/`response.failed`（上游声明失败）**都是合法终止符**，都置 `acc.status`（responses-stream-accumulator.ts:67-83）——把"非 completed"判截断会**误伤合法的 incomplete/failed**。
- **Gemini**（P-Gem，review 修正）：判据 `getStreamMeta().finishReason === FINISH_REASON_UNSPECIFIED`。**顺序隐患**：`convert-stream.ts` 的 `flush()` 在 complete 分支**无条件**产出一个 `finishReason: FINISH_REASON_UNSPECIFIED` 的合成 terminal 帧并写给客户端（gemini/handler-v4.ts:303-305），**先于**检测有机会插 error 帧。实现须把"检测截断"提到 flush-terminal 写出**之前**，否则客户端先收到一个看似"正常结束但无原因"的 UNSPECIFIED terminal、再收 error，顺序矛盾。

判定放 **handler**（driver 格式无关）。`settled-abort`/`stream-error` 路径不变（已是失败）。

### 3.2 失败分类 + 客户端错误帧

检测到截断（`complete` 但缺终止符）时，handler：

1. **失败分类**：改判 `ctx.fail(...)` 而非 `ctx.complete`。→ console 打 `[FAIL]` + 明确原因（如 `upstream stream truncated: no message_stop`）、history 记失败。修掉"proxy 零诊断"症状。
   - **下游影响（review 实测，正向）**：history reaper 把条目从 success 桶（limit 50）迁到 failure 桶（limit 200，保留更久）——利于诊断；lineage 只消费 request 侧、与 response status 正交、不受影响；dry-run 流式回放读 raw `sseEvents`（截断条目完整保留）、不受影响。
   - **content 投影取舍（review P1，必须显式声明）**：现 `ctx.fail` 硬置 `_response.content = null`（request.ts:417），`PartialResponseInfo` 无 content 通道。直接改判会让 `outboundResponse.content` 从"残缺内容投影"变 null。按 **richest-data-flow（后端存储必须完整）**：残缺内容是可观测诊断数据，应保留。**设计决定：扩展 `fail()` / `PartialResponseInfo` 增加可选 `content` 通道**，截断 fail 时传入 `buildAnthropicResponseData(acc,...)` 的累积内容，使失败条目仍在 outboundResponse 保留残缺投影。raw `sseEvents` 轨本就是 SSOT、始终完整。
2. **客户端错误帧**：在 **complete-but-truncated 分支新增** 一条 `sink.writeSynthetic(...)`（**注意 review S3**：截断是 clean drain、走 `outcome==="complete"` 分支，与 H2 同分支；**不是**复用 stream-error 分支 handler-v4.ts:613 的 H3 调用——那在 throw 路径）。`writeSynthetic` 非采样（不污染 forwarded 轨），语义与 H3 一致。
   - **终止符形态需实测裁决（review P4 / OQ3，spec 内部不能写死）**：客户端此刻已收到 `content_block_start`+12 个 delta、正等 `content_block_stop`，突然收到 `event:"error"`——Anthropic SDK 是否接受 open-block 中途的 error、是否触发干净重试，**未经验证**。按 [[feedback-self-consistent-needs-independent-oracle]] 须用真实 Claude Code 实测裁决，不能假设。候选：(a) 直接插 `event:"error"`；(b) 先补 `content_block_stop` 关闭开放块再插 error。本项目 `no-auto-server` 禁止自起服务器，故此项须**用户协助实测**（起服务器 + 触发截断观察客户端行为）后定夺，Phase 1 先实现可切换的终止符形态。

**不合成"成功终止符"**：用 `message_delta{stop_reason}`+`message_stop` 把残缺消息补成"完整"是错的——残缺 tool_use 是无效 JSON，补全会把截断伪装成"合法但损坏"的成功响应。

### 3.3 透明重试：可行性天花板（实测裁决）

用户期望"proxy 检测到截断后透明重试、对客户端无感"。**实测架构裁决**：

**流式 post-content 截断无法透明重试**（airtight，2 轮 review + 探针实证）：重试环 S4 在拿到流对象时即退出，截断在 S5 消费帧时暴露、且帧已转发——架构隔离、无重入路径、已发字节无法收回。唯一能给流式"部分重试"的是 first-content-gate（缓冲到首内容帧再转发），但它**只覆盖极早期截断、覆盖不了本案**（截断在 content_block_start+12 帧后）。**暂缓理由是能力上限（cover 不了 post-content 截断），不是成本/架构冲突**（review S1 修正：owns-sink 的 sink 串行链本就是缓冲点、加薄 gate 不冲突；真正问题是 gate 对本案无用 = 对未证实存在的"极早期截断"场景做投机表面，违反 YAGNI）。→ **流式截断的正确处理 = §3.2 的 clean error 帧 → 客户端自行重试**（Claude Code 收 error 会重试整请求）。

**非流式**（review P2 实测修正，RFC v1 把两类混为一谈）：

| 上游截断形态 | `response.json()`（send.ts:147） | 当前结局 |
|---|---|---|
| clean-EOF mid-body（非法 JSON）/ h2 RST backstop | throw SyntaxError/Error | → `runExchange` catch → classifyError=`bad_request` → **无 strategy 匹配 → 已是 FAIL**（非静默） |
| 合法完整 JSON 但语义残缺（content 空 / stop_reason 缺） | resolve | **静默 complete（真漏洞）** |

故非流式：解析失败**当前已是 FAIL**（不是静默成功，RFC v1 错判）——若要它**重试**（而非仅 fail），需新增"截断态 bad_request → 重试"的 strategy，是独立设计点。语义残缺态才是非流式真漏洞，但**罕见且需逐格式语义校验**（stop_reason/finish_reason 缺失），优先级低。

结论：所谓"透明重试"实际收敛为——流式不可透明、靠 clean error + 客户端重试；非流式解析失败已 FAIL、语义残缺态待补检测。**不构建架构上不成立的流式透明重试**。

### 3.4 web_search 双跳旁路缺口（两 reviewer 共同发现，须文档化）

web_search 双跳（`web-search-handler.ts:236`）也用 `createAnthropicStreamAccumulator` + 走 legacy 路径（**不经** driver/runResponseSink），同样从 GHC 收上游、同样会截断、同样走 `buildAnthropicResponseData`→complete。Phase 1 把检测放 handler-v4 的 complete 分支，**旁路收不到**。双跳的**合成流**（synthesize.ts 主动发 message_stop）不会误判，但**第一/二跳真实上游流**仍可能截断而裸奔。与 DESIGN.md 既定 "web_search 双跳 P2.6-D1 暂缓" 对齐，本 RFC **文档化此缺口**、不在 Phase 1-2 覆盖（待双跳迁 driver 时收敛）。

## 4. Phase 拆分与 commit invariants

每个中间 commit 都不让系统半坏：

- **Phase 0（地基）✅ 已落地**：扩展 `fail()`/`PartialResponseInfo` 增 content 通道（§3.2.1）。invariant：现有 fail 调用方行为不变（content 缺省仍 null）。
- **Phase 1（Anthropic 检测+fail+error-frame）✅ 已落地**（commit 533cf84）：accumulator 加 `sawMessageStop`；handler complete 分支前插完整性校验 → 截断走 fail（带 content）+ 新增 `writeSynthetic` error 帧（`type:"api_error"`，形态待 §5.1 实测微调）。完整流逐字节不变（golden 锁），仅截断流从 `[OK]`→`[FAIL]`+error 帧。s4 recover golden 的 fixture 本就无 message_stop，现正确追加 error 帧（recover/decode flush 字节仍锁）。
- **Phase 2（CC/Responses/Gemini 检测+fail+error-frame）✅ 已落地**：各格式复用既有终止符字段——CC `acc.finishReason===""`、Responses `acc.status===""`（viaFallback drain 后检测）、Gemini `getStreamMeta().finishReason===FINISH_REASON_UNSPECIFIED`（flush 前检测，跳过误导终止帧）。各格式完整流 golden 不变；三格式各一条 http 截断测试。
- **Phase 3（非流式）✅ 实证确认无需代码**：探针 + 代码核验确认非流式上游截断**当前已正确处理**——解析失败（残缺/非法 JSON、h2 "closed before end"）归 `bad_request`、无 strategy 匹配 → **FAIL**（非静默）；socket 级错误（ECONNRESET 等）归 `network_error` → 重试（非流式无已转发字节，可安全重试）。唯一漏洞是**合法但语义残缺 JSON**（HTTP 200 + 完整 JSON 但 content 空/stop_reason 缺）→ 静默 complete，但**罕见且需逐格式语义校验**（YAGNI，暂缓；要做则各 codec 的 `renderResponseNonStreaming` 后加语义完整性断言）。
- **Phase 4（doc-sync）进行中**：DESIGN.md "活的架构现状" 表 + 本 RFC 状态回填 + memory 提炼。无 config 开关（截断检测硬连线为正确行为，非偏好），故运行时选项表无新增。

first-content-gate 透明重试（§3.3）+ web_search 旁路检测（§3.4）+ 非流式语义残缺检测（Phase 3）**均不进当前实现**——暂缓项，文档化于此。

## 5. Open questions（实现前需实证/定夺）

1. **error 帧终止符形态（§3.2.2，最关键）**：真实 Claude Code 对"open content_block 中途 error 事件"的行为——接受/报 parse error/是否重试？须用户起服务器实测裁决 `event:"error"` vs 先补 `content_block_stop`。决定 Phase 1 终止符默认形态。
2. **error.type 取值**：`api_error` / 自定义 `upstream_truncated` 哪个最贴合客户端 SDK 重试判断（依赖 OQ1 同次实测）。
3. **非流式语义残缺检测优先级（§3.3）**：是否值得为罕见的"合法 JSON 但 stop_reason 缺"做逐格式语义校验，还是仅文档化。
4. **截断是否需 config 开关**：默认应硬连线为"截断→fail+error 帧"（正确性非偏好）。倾向无开关；若需"宽松透传残缺帧"逃生阀再加。
5. **CC 多 choice（n>1）**：GHC 是否支持、若支持 choice[1..] 截断当前判据盲区是否需补。

## 6. 测试策略

- **golden fixture 预捕获**（[[methodology-golden-fixture-pre-capture]]）：本案 14 帧截断序列存 fixture，先在改动前代码上跑通"完整流不变"golden，再加"截断流→fail+error 帧"断言。
- **完整流 golden 必须覆盖合法边界（review Q3）**，否则锁不住误伤面：
  - Anthropic：末三帧 `content_block_stop`/`message_delta{stop_reason}`/`message_stop` 序列。
  - CC：finish_reason 帧 + `include_usage` 的 `choices:[]` usage-only 末帧 + handler 合成的单个 `[DONE]`（须区分 driver 剥的上游 `[DONE]` vs handler 合成的）。
  - Responses：`acc.status` 三态——**必须含 `incomplete`/`failed` 用例**（锁住"合法 incomplete 不被判截断"）+ WS 路径 `stopAfterFrame` 早停点。
  - Gemini：flush 合成 terminal 帧（P-Gem 的 UNSPECIFIED 顺序）。
- 截断流单测：四格式各喂无终止符序列 → 断言 `ctx.fail` 被调、forwarded 末尾是 error 帧、history 记失败、outboundResponse 保留残缺 content。
- 隔离：DI/fetch-mock，不碰真实 env（项目铁律）。

## 7. 不变量（编码进实现，防未来回归）

- **WS `onRenderedFrame` 先于 `stopAfterFrame`**（driver.ts:447-453）：terminal 帧先被 accumulate 置 `acc.status` 再 break；截断流（无 terminal）stopAfterFrame 永不触发、自然 drain 到 EOF→complete、`acc.status` 留 `""`。检测依赖此顺序——调换会破，须在实现处注释锁定。
- **Gemini 检测先于 flush-terminal 写出**（§3.1 P-Gem）。
- **error 帧在 complete-but-truncated 分支、非 H3 throw 分支**（§3.2.2 / review S3）。
