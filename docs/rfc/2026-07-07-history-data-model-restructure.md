# RFC: History 数据模型重构 —— client/upstream 双腿 + 逐 attempt 上游轨

- 状态：DRAFT v3（R1 架构 + R2 接地 + R3 集成保真 + R4 换新视角 四轮对抗 review 全并入，发现逐条独立核验——fail()/abort 生产者不对称、Gemini env.body=CC、wire 腿 messages 投影损失均亲手复核属实。命名已定稿。零 FAIL/WARN 后转 writing-plans。）
- 日期：2026-07-07
- 关联：ADR [richest-data-flow](../decisions/2026-07-05-richest-data-flow.md)、ADR [internal-tool-security-posture](../decisions/2026-07-05-internal-tool-security-posture.md)、skill `telemetry-architecture`、skill `history-sqlite-schema`、skill `persistence-async-invariants`、[DESIGN.md](../DESIGN.md)「类型架构」节
- 触发：现有 history leg 命名（`inbound*`/`outbound*`/`wire*`/`effective*`）坐标系错误——`inbound`/`outbound` 混「对端」与「流向」、`wire`==`outbound(Request)` 一物两名、顶层 leg 是 final-attempt 隐式投影。

---

## 0. 对抗 review 并入记录（R1-R4）

四轮对抗 subagent 审查（裁判轴：长远正确 + 完整，非 ROI/YAGNI）均确认**方向正确**（两条正交轴自洽、clientResponse 一等化是最强部分），无一挑战方向。以下发现**已逐条独立核验并并入**：

| 来源 | 发现 | 核验 | 处置 |
|---|---|---|---|
| R1-F1 | `success` 无归属 | 属实 | §3 `upstreamResponse.success` |
| R1-F2 | `currentStrategy` 未映射 | 属实 | §4 派生 `attempts.at(-1).strategy` |
| R1-W1/W2 | §6 低估写路径耦合 | 亲手复核属实 | §6 重框 + 消费者扩清单 |
| R1-W3/W4 | trailers/rawBody 合并丢语义 | 属实 | §3 独立槽 |
| R1-W5 / R2-F1 | 上游 wire 无 `format` | 属实 | §3 每腿 `format?` |
| R1-W7 | effectiveSource opaque body 断结构化消费 | 属实 | §3 保 effectiveSource 结构化投影 |
| R1-W8 | effectiveMessageCount + attempt truncation/sanitization 未映射 | 属实 | §4 映射 |
| R2-F1 | §2.3「env.body 恒原生」对 Gemini 为假 | **亲手复核**（[openai-gemini/codec.ts:224,238](../../src/lib/codec/openai-gemini/codec.ts#L224)） | §2.3/§2.4 修正 |
| **R4-FAIL-A** | **`upstreamRequest` 丢 messages 投影 → `rewrites-req` 搜索 facet 静默失效**（R1-W7 只修 effectiveSource 一侧、漏 wire 腿同构损失；`buildRewritesReq` 读 wire 腿 messages） | **亲手复核**（[search-index-write.ts:139](../../src/lib/history/sqlite/search-index-write.ts#L139) 读 `outboundRequest?.messages`） | §3 `upstreamRequest` 补结构化投影 + §7 登记 search-index + golden 锁 rewrites-req |
| **R3-WARN-1/2** | **fail()/abort 只写顶层裁决、不写 final attempt（与 complete 不对称）→ C2.5 顺序倒置 + responseSuccess 派生退化** | **亲手复核**（[request.ts:515](../../src/lib/context/request.ts#L515) complete 调 setAttemptResponse；[:541-559](../../src/lib/context/request.ts#L541)/[:602-609](../../src/lib/context/request.ts#L602) fail/abort 不调） | §6 生产者对齐前置 + §3 注「settled attempt 恒载 upstreamResponse」 |
| R4-WARN-B | `success` 无权威判据 + `status` 语义变 | 属实（[context/types.ts:69](../../src/lib/context/types.ts#L69) status「only on error」） | §3 定 success 判据 + 合法组合矩阵 + `status?` |
| R4-WARN-C | `clientResponse.status` aspirational 却必填 | 属实（[context/types.ts:156-165](../../src/lib/context/types.ts#L156) ForwardedResponse 无 status） | §3 `status?` + 数据源 + legacy 回填 |
| R4-WARN-D | `model.capabilities` shape 未定 | 属实（原始 blob vs 派生判定，无当前生产者） | **从核心结构撤下**（避免 aspirational 空槽），列 §5 future enrichment |
| R4-WARN-E | `_index` 派生子集缺重算不变量 | 属实（记忆明训：新派生字段三处同步） | §3 拆 `_index.derived`（recompute-only）/`_index.aux` |
| R3-NIT-8 | `model` 「上游实报」无忠实来源（存归一 resolved） | **亲手复核**（[request.ts:512](../../src/lib/context/request.ts#L512) `normalizeModelId`） | 去误导标签；raw upstream model 列 §5 future enrichment |
| R3-NIT-1/3/4/5 | 迁移表缺 startedAt/waitMs/attemptCount/顶层 truncation | 属实 | §4 补行（新捕获标注） |
| R2-W2 | §Q2「内容寻址」措辞不准 | 属实 | §7-Q2 校正 |

**未采纳/未挑战**：四位审查者均**未主张**回退两轴或 clientResponse 一等化——保留。无需驳回的对抗意见。

---

## 1. 问题陈述（带 file:line 证据）

### 1.1 命名坐标系三宗罪

| # | 缺陷 | 证据 |
|---|---|---|
| N1 | `inbound`/`outbound` 实指「哪条腿」非「流向」——`inboundResponse` 流出给客户端、`outboundResponse` 从上游流入 | [types.ts:279-296](../../src/lib/history/types.ts#L279-L296) |
| N2 | `wire`==`outbound(Request)` 一物两名 | [serialize.ts:350-351](../../src/lib/history/sqlite/serialize.ts#L350-L351)、[context/request.ts:87](../../src/lib/context/request.ts#L87) |
| N3 | 顶层 leg 是 final-attempt 隐式投影，制造「顶层==成功」误导 | [serialize.ts:364-377](../../src/lib/history/sqlite/serialize.ts#L364-L377) |

### 1.2 leg 语义割裂

| # | 缺陷 | 证据 |
|---|---|---|
| S1 | 上游帧割成顶层 sseEvents + attempts[].sseEvents 两处 | [serialize.ts:339-344](../../src/lib/history/sqlite/serialize.ts#L339-L344) |
| S2 | effective/wire 真实区别被命名掩盖 | [context/types.ts:37-52](../../src/lib/context/types.ts#L37-L52) |
| S3 | 响应富字段无清晰「响应腿」归属 | [context/types.ts:53-79](../../src/lib/context/types.ts#L53-L79) |

### 1.3「顶层 leg == 客户端结局」错误建模

非报错 upstreamResponse 不一定成为 clientResponse（§2.1）。混淆两条正交轴——**attempt 成败** vs **entry 客户端结局**（`state`）。二者可背离，当前无处安放。

---

## 2. 设计决策

### 2.1 clientResponse 是一等公民，非 attempts[final] 投影

非报错 2xx upstreamResponse ≥5 种去向，只有第 1 种约等于客户端所见（R2 逐条核验属实）：① 顺利转发（rewrite 后 body/sseEvents 仍 ≠ 上游，含合成 keepalive，[types.ts:149-165](../../src/lib/history/types.ts#L149-L165)、[:138-146](../../src/lib/history/types.ts#L138-L146)）；② 流式截断（200 无终止符→L2 buffered-retry，[driver.ts:510-519](../../src/lib/pipeline/driver.ts#L510-L519)）；③ 客户端 abort；④ buffered-retry 丢弃；⑤ reaper 取消。**结论**：clientResponse 独立投影，必须一等建模。红利：解决零-attempt 结局落点（§7-Q1 已实测零例）。

### 2.2 attempts[] 是纯 proxy↔upstream 轨，逐次保留

~13 重试策略各产生独立上游往返，per-attempt 体各不同。常见长度=1、优雅退化。

### 2.3 effectiveSource = env.body 本尊 + 本轮中间状态（不新增中立 IR）

`effectiveSource.body` = **`env.body` 本尊**、逐字保留、不归一 IR。

**语义修正（R2-F1，亲手复核）**：`env.body` 是**本轮 pipeline 工作格式**，≠ 总是客户端端点格式——anthropic/openai-cc/openai-responses 停在客户端格式（翻译在 prepareWire）；**Gemini 在 route/parse 就 Gemini→CC**（[openai-gemini/codec.ts:224,238](../../src/lib/codec/openai-gemini/codec.ts#L224)），`env.body` 已是 CC，原始 Gemini 体只在 `clientRequest.body`。CC 是 Gemini 路径**既有** pivot（非为 history 发明），不改「不新增全局 IR」决策（§5）。每腿带 `format?` 让消费端判定实际格式。

**投影 vs body 的 SoT（R3-NIT-2）**：`effectiveSource` 的结构化投影（`model?/messageCount?/messages?/system?`）是 `body` 的**非权威索引**（供 search-index 等结构化消费）；`body`（env.body 本尊）是 SoT。禁止消费者独立改投影使其与 body 漂移。

### 2.4 三层内容视图（翻译边界因端点而异）

```
clientRequest.body  →[内容筛选;Gemini 格式翻译在此(parse)]→  effectiveSource.body  →[末端 wire 准备;非 Gemini 格式翻译在此(prepareWire)+B1-B12+headers]→  upstreamRequest
```

格式翻译边界因端点而异（Gemini 在前、其余在后）。per-leg `format` 是判定实际格式的唯一可靠信号——不能假设 `body` 格式 == `entry.endpoint`。

### 2.5 `model` parent key；派生字段分层

- `model:` 归拢 `requested`/`resolved`/`multiplier`，保住遥测「成功=规范名/失败=别名」拆分（R2 核实可重建）。
- 派生字段分两类（R4-WARN-E）：`_index.derived`（派生自 attempts，**recompute-only**）与 `_index.aux`（自由投影）。

---

## 3. 架构：收敛后的完整结构

```
entry:
  # 身份/归属（entry 级）
  id; sessionId?; agentId?; endpoint; rawPath?; process
  # 生命周期/计时（客户端结局轴）
  state; active; pinned; startedAt; endedAt?; lastUpdatedAt?; queueWaitMs; durationMs
  # 模型/计费（parent key）
  model: { requested; resolved; multiplier? }
  # 客户端腿（proxy ↔ client），per-entry
  clientRequest:  { method?; path?; format?; headers; body; stream }
  clientResponse: { status?; headers; body?; sseEvents? }   # status? 新捕获(R4-C)；结局看 entry.state
  preprocessing?                                            # 一次性入站变换（非逐轮）
  # 上游腿（proxy ↔ upstream），per-attempt
  attempts[]:
    index; strategy?; transport; startedAt?; durationMs; waitMs?
    effectiveSource:
      format?; model?; messageCount?; messages?; system?    # 结构化投影=body 非权威索引（§2.3）
      body                                                  # env.body 本尊（SoT）
      pipeline?                                             # 本轮 truncation/sanitization/messageMapping
    upstreamRequest:
      format?; model?; messages?; system?                   # 补投影（R4-FAIL-A：rewrites-req 读 wire 腿 messages）
      headers; body
    upstreamResponse?:                                      # 见下「存在性」
      success; status?; headers; trailers?                  # success 判据见下；status? R4-B
      body?; rawBody?; sseEvents?
      usage?; stopReason?; model?; responseId?; copilotAnnotations?; toolSearchRequests?
    error?
  # 派生投影层
  _index:
    derived: { responseSuccess?; currentStrategy?; failureReason?; attemptCount? }   # recompute-only，三处同步
    aux:     { requestBytes?; responseBytes?; previewText?; warningMessages?; ... }  # 自由演进
```

**`upstreamResponse` 存在性（R3-WARN-2 reconcile）**：每个**已 settled 的 attempt**（成功或失败）**恒载** `upstreamResponse`——成功=真实响应；失败=合成裁决（fail/abort 经生产者对齐写入，§6 C2.5）；mid-retry 失败 attempt 经 `synthesizeAttemptErrorResponse`（[request.ts:720](../../src/lib/context/request.ts#L720)）。仅**未 settled**（in-flight/interrupted）attempt 可缺——对应 interrupted 条目（进程中途死）。故终态条目的 final attempt 恒有 upstreamResponse，`_index.derived.responseSuccess` 派生不退化。

**`upstreamResponse.success` 权威判据 + 合法组合（R4-WARN-B）**：`success` = 上游返回完整 2xx 且协议正常终止。合法组合：
- `{success:true, status:200?, error:absent}` —— 上游成功（**注**：整个 entry 仍可能 `state=failed`——proxy 引入的 post-200 失败经 `failureReason` 裁决，honest 腿 [request.ts:535-548](../../src/lib/context/request.ts#L535)；此时 attempt 的 upstream 腿诚实记 success:true）。
- `{success:false, status:>=400, error:present}` —— 上游 HTTP 错误。
- `{success:false, status:absent, error:present}` —— 网络错误（无 HTTP 响应）。

两轴分离：attempt 成败在 `upstreamResponse.success/.error`；客户端结局在 `entry.state`。`_index.derived` 全部 = `attempts` 重算投影。

---

## 4. 逐字段迁移映射（旧 → 新）

| 旧字段 | 新归属 | 备注 |
|---|---|---|
| `inboundRequest.*` / `httpHeaders.inboundRequest` / `.stream` | `clientRequest.{body,headers,stream}` | + `method`/`path`/`format` |
| `inboundResponse.{content,sseEvents}` / `httpHeaders.inboundResponse` | `clientResponse.{body,sseEvents,headers}` | |
| （新捕获） | `clientResponse.status?` | R4-C：transport `c.res.status`；legacy 行反序列化缺省 undefined |
| `effectiveRequest`/`outboundRequest`/`outboundResponse`（顶层投影） | 删除 | 读 `attempts[final].*`；连带重指 buildHeadRow/deriveBytes/toHistoryEntry（§6） |
| `attempts[].effectiveRequest.{messages,model,system,payload}` | `attempts[].effectiveSource.{messages,model,system,body}` | + `.format`/`.pipeline` |
| `attempts[].effectiveMessageCount` | `effectiveSource.messageCount`（messages 在则派生 `.length`，否则用存值） | R1-W8/R3-NIT-1 |
| `attempts[].wireRequest` | `attempts[].upstreamRequest.{headers,body}` + `.format`/`.model`/`.messages`/`.system` | **补 messages 投影**（R4-FAIL-A） |
| `attempts[].response.*` | `attempts[].upstreamResponse.*` | + `success`/`rawBody`/`trailers`/usage/stopReason/responseId/annotations/toolSearchRequests |
| `attempts[].{truncation,sanitization}` | `attempts[].effectiveSource.pipeline` | R1-W8 |
| 顶层 `sseEvents` + `attempts[].sseEvents` | `attempts[i].upstreamResponse.sseEvents` | 统一（消除 §S1）；生产者对齐见 §6 |
| `attempts[].responseHeaders` | `attempts[].upstreamResponse.headers` | |
| `httpHeaders.outbound*`/`outboundResponseTrailers` | `attempts[final].upstreamRequest.headers` / `upstreamResponse.headers` / `.trailers` | trailers 不并入 headers |
| （新捕获） | `attempts[].startedAt?`/`waitMs?` | R3-NIT-3：现 `waitMs` 仅作参数（[request.ts:773](../../src/lib/context/request.ts#L773)）未落库；新捕获，需生产者 |
| `outboundResponse.success` / `EntrySummary.responseSuccess` | `attempts[].upstreamResponse.success` + `_index.derived.responseSuccess`（recompute `at(-1)`） | R1-F1/R3-WARN-2 |
| `currentStrategy` / `attemptCount` | `attempts.at(-1).strategy` / `attempts.length` + `_index.derived.{currentStrategy,attemptCount}` | R3-NIT-4 |
| `pipelineInfo.preprocessing` | entry `preprocessing?` | 一次性 |
| `pipelineInfo.{truncation,messageMapping}`（顶层聚合）/ `entry.truncation` | `attempts[final].effectiveSource.pipeline`（聚合去顶层化） | R3-NIT-5 |
| `multiplier` | `model.multiplier` | |
| `inboundRequest.model`/`requestModel` | `model.requested` | |
| `outboundResponse.model` | `model.resolved`（= 归一 resolved，[request.ts:512](../../src/lib/context/request.ts#L512)）+ per-attempt `upstreamResponse.model` | **去「上游实报」标签**（R3-NIT-8：当前无 raw upstream 来源，二者同值）；raw upstream model 列 §5 future enrichment |
| `requestBytes`/`responseBytes`/`previewText`/`warningMessages` | `_index.aux.*` | 自由投影 |
| `failureReason` | `_index.derived.failureReason`（recompute） | |
| entry 级 id/session/agent/endpoint/rawPath/process/state/active/pinned/时间戳/queueWaitMs/durationMs/transport | 同名 | 不变 |

**判定（v3）：全部生效字段有唯一归属。新捕获字段（clientResponse.status / startedAt / waitMs）均标注需生产者、可选、legacy 回填规则。**

---

## 5. Rejected alternatives / future enrichment

**Rejected**：
- **全局中立 IR** —— 否决（管线不操作统一 IR；CC 是 Gemini 局部既有 pivot，非全局 IR）。跨端点统一由末端读时派生视图满足。
- **clientResponse = attempts[final] 指针** —— 否决（§2.1）。
- **单一 `entry.model` 字符串** —— 否决。
- **派生字段全部读时派生** —— 否决（列表/搜索解压 blob 变慢）。
- **success 派生（`status<400 && !error`）不设显式字段** —— 否决（R1-F1，richest-data-flow 不逼消费端重推）。

**Future enrichment（当前无生产者，避免 aspirational 空槽，暂不入核心结构；接线时再加）**：
- `model.capabilities`（R4-WARN-D）：原始 `Model.capabilities` blob 可从 model id 重建、派生判定集需新生产者——两者 shape/语义差异大，写码前若要加须先定 shape + 建生产者。
- `upstreamResponse.model` 的 raw upstream 值（R3-NIT-8）：当前存归一 resolved；捕获上游原始 model 是 richest-data-flow 正向增强，需新生产者。

---

## 6. Cutover 计划（commit invariants，含生产者对齐前置）

**根因（R3-WARN-1/2，亲手复核）**：`complete()` 调 `setAttemptResponse`（[request.ts:515](../../src/lib/context/request.ts#L515)）写 final attempt；`fail()`/`abort()` 只写顶层 `_response`、**不写 final attempt**（[request.ts:541-559](../../src/lib/context/request.ts#L541)/[602-609](../../src/lib/context/request.ts#L602)）。故「重指向 attempts[final]」在生产者对齐前，对失败/中止条目的 live 对象无裁决可读——read-side 反投影（[serialize.ts:508-518](../../src/lib/history/sqlite/serialize.ts#L508-L518)）跑在序列化后，救不了序列化前的 `buildHeadRow`。

**写路径耦合（R1-W1）**：`buildHeadRow` 从 `entry.outboundResponse?.{usage,model,stop_reason,error}` 派生索引列（[serialize.ts:215-240](../../src/lib/history/sqlite/serialize.ts#L215-L240)）；`deriveBytes` 读 `entry.outboundRequest?.payload`/`entry.sseEvents`/`outboundResponse.rawBody`（[serialize.ts:173-194](../../src/lib/history/sqlite/serialize.ts#L173-L194)）。

**Commit 序（生产者对齐前置）**：
- **C1**：新增 type，与旧字段并存（旧 deprecated 别名，反序列化双填）。
- **C2**：serialize/assemble 新 stage 语义（上游帧统一进 attempt、clientResponse 独立 stage、success/trailers/rawBody/format/messages 投影落 stage）。
- **C2.5（生产者对齐，前置——R3-WARN-1 核心）**：`fail()`/`abort()` 调 `setAttemptResponse`（与 complete 对称），使 **final settled attempt 恒载裁决**；成功流顶层 `sseEvents` 归入 `attempts[final].upstreamResponse.sseEvents`。**这是 C2.6 的前提。** golden：live `toHistoryEntry()` 输出的 attempts[final] 含裁决。
- **C2.6（consumer re-point）**：`buildHeadRow`/`deriveBytes`/`toHistoryEntry` 重指向 `attempts[final]`。golden 锁 `EntryRow` 序列化前后逐列等价。
- **C3**：`clientResponse.status`/`body` 显式捕获（transport 层）。
- **C4**：迁移全部消费者（§7 完整清单，**含 `search-index-write.ts` rewrites-req**），删旧顶层字段与投影逻辑。
- **C5**：doc-sync（DESIGN.md 类型架构 + history.md + skill history-sqlite-schema）+ golden 回归。

**Commit 级不变量**：① 每 commit typecheck + `bun test` 全绿；② `EntryRow` 序列化前后逐列等价（**依赖 C2.5 前置**，否则失败/中止条目破）；③ 反序列化对 legacy 单-blob 与新 stage 行输出等价；④ `_index.derived` 派生子集**只重算不独立写**，三处同步（`toHistoryEntry` + `onTerminal` 投影 + `updateEntry` allowlist，记忆明训 [settle 冻结快照](../memory/reference-settle-freezes-history-entry-record-before-fail.md)）。

golden-fixture 预捕获：改动前锁 `tests/history/*` assembleFullEntry 输出 + `EntryRow` 结构快照 + `rewrites-req` 索引，改后须等价。

---

## 7. Open questions（给用户 / 待实测）

1. **零-attempt 结局 —— 已实测（2026-07-07）**：只读查 `~/.local/share/copilot-api/history.db`（701 行）。164 failed + 29 aborted **全部有 `outbound_response` 阶段行**；5 interrupted 无 outbound_response 但**全部有 `outbound_request`**（wire 已发=≥1 attempt）。**零个「零-attempt 终态」**。处置：clientResponse 承载兜底理论零-attempt，不补合成占位 attempt；未来若现队列拒绝/建请求前失败，由 `clientResponse.{status,body}` 承载、`attempts=[]`。
2. **去重存储**：`request_group` 是 **zstd 共享帧压缩去重**（R2-W2 校正：非按 hash 内容寻址；[serialize.ts:443-452](../../src/lib/history/sqlite/serialize.ts#L443-L452)）。新结构维持即可，倾向不改。
3. **preprocessing 落点**：定 entry 级（PipelineInfo 里单值证一次性）。
4. **消费者迁移清单（C4 前必须完整）**：R2 grep 实测 **62 非测试文件**。**补全正则须含 `inboundRequest|wireRequest|sseEvents`**（原正则漏三 token）。承重写/读点：`observability/sinks/history.ts`（写入方）、`serialize.ts`（buildHeadRow+deriveBytes）、**`search-index-write.ts`（rewrites-req 读 wire 腿 messages，R4-FAIL-A）**、`history/{queries,stats,in-flight,entries}.ts`、`sqlite/sessions-agg.ts`、`telemetry-dimensions.ts`、`pipeline/driver.ts`、`request/response.ts`、`transport/{http,responses}-transport.ts`、10 route handler、ui/ ~8 composables、ui-v4/ detail segments、`~backend/*`。
5. **命名 —— 已定稿（2026-07-07 用户全采纳）**：`clientRequest`/`clientResponse`/`effectiveSource`/`upstreamRequest`/`upstreamResponse`/`model{}`。

---

## 8. 验证

- 类型：typecheck 绿；`bun run build:ui`（`~backend/*` 纯度）。
- 反序列化等价：legacy 单-blob + 新 stage 行 assembleFullEntry 输出结构快照 golden。
- **生产者对齐（C2.5）**：live `toHistoryEntry()` 对 failed/aborted 条目，`attempts[final].upstreamResponse` 含裁决（success:false/error/model/usage）。
- **索引列等价（C2.6）**：同一 entry 序列化前后 `EntryRow`（model/tokens/stop_reason/error/bytes/preview）逐列等价——证 re-point 无回归。
- **成败轴（R1-F1/R3-WARN-2）**：`_index.derived.responseSuccess` = `attempts.at(-1).upstreamResponse.success`，终态条目不退化；stats/queries/in-flight 消费不回归。
- **rewrites-req（R4-FAIL-A）**：golden 锁 search 索引——`buildRewritesReq` 从 `upstreamRequest.messages` 抽取，与旧 `outboundRequest.messages` 结果等价。
- 遥测拆分：`model.requested`/`model.resolved` + per-attempt `upstreamResponse.model` 重建成功=规范名/失败=别名。
- Gemini 格式标签：Gemini 请求 `effectiveSource.format` 标 `cc`（非 gemini）。
