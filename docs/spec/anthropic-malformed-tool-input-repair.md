# Anthropic 畸形 tool_use input 拦截与清洗

> 状态：spec（待 plan/impl，已过一轮对抗 subagent 审查 + 主线实测核验，见 §7）。配置键 `anthropic.tool_repair_malformed_input`。落地为既有 tool-input 解码器（`src/lib/anthropic/decode-tool-input.ts`）的能力扩展 + handler fail 信号，opt-in 默认关。

## 1. 问题（实测取证）

opus-4.8 在长程退化上下文里偶发把两套工具调用"语言"混用——Anthropic 原生 **JSON** tool_use 与注入 system prompt 里的 **antml-XML**（`<invoke><parameter>…</parameter></invoke>`）——在生成 tool_use 的 `input_json_delta` 时，把 antml 闭合标签漏进了 JSON。结果是一个**模型自认为完成**（`stop_reason:"tool_use"`、`content_block_stop` 已发、`message_stop` 干净到达）、但 `input` 累积起来是**非法 JSON** 的 tool_use 块。代理逐字节透传后，客户端（Claude Code）解析 input 失败回 `InputValidationError`，模型却把自己的错误误判为"harness mangled the input / 注入幻觉"，进而在退化上下文里滚雪球成系统性 confabulation（实测会话 session `88a29d95`，结尾 `/compact`=`req_1782745608380_1335` 把整段写成"工具输出严重幻觉"）。

实测样本 `req_1782744516921_1304`（TodoWrite）的 input 末尾原始字节（xxd 确认、上游 SHA == 转发 SHA，证明是模型产物、非代理篡改）：

```
{"todos": [ …完整合法数组… ]</parameter>\n</invoke>\n}
```

即数组闭合 `]` 与对象闭合 `}` 之间漏进 `</parameter>\n</invoke>\n`。**剥掉这两个标签后 JSON 立即合法**（601→580 字节，干净 parse）。

### 1.1 真实分布、根因细分与范围边界（关键）

扫描最近 545 条带 tool 的 anthropic 请求（467 含 tool_use，15 个非法 input），畸形分两个**本质不同**的类：

| 类 | 判别条件 | 数量 | 性质 |
|---|---|---|---|
| **A. 模型已完成但畸形** | `status=completed` + `stop_reason=tool_use` + **`content_block_stop=true`**（且 `message_stop` 到达） | 3 | 本 spec 目标，见下细分 |
| **B. 截断流** | `status=aborted/failed` + `stop_reason=null` + **`content_block_stop=false`** | 12 | **非本 spec 范围**：流被切断（client abort / 上游 RST），JSON 天然不完整，已由[流式截断检测](upstream-stream-truncation-detection.md)处理 |

A 类 3 例按**根因**进一步细分（决定哪条 Layer 修得了，实测亲验，见 §7-C2）：

| 根因 | 样本 | 表现 | Layer 1 剥标签 | Layer 2 jsonrepair（实测） |
|---|---|---|---|---|
| **antml-tag-bleed** | `req_1782744516921_1304`（TodoWrite） | `]</parameter>\n</invoke>\n}` | **修好** | **THROW**（`Colon expected at 578`）→ 不归 Layer 2 |
| **结构缺括号** | `req_1782740067043_965`（AskUserQuestion，末尾少 `]}`） | `…)"}]}`（应为 `…)"}]}]}`） | 不适用 | **正确修复**（补 `]}`，含真实中文、无字面 `\u` 残留） |
| **同类结构** | `req_1782739645128_921`（AskUserQuestion） | 同上 | 不适用 | 待逐字节亲验（结构类，预期可修） |
| **坏 Unicode 转义**（后续捕获，非原 545 扫描内；motivates `unicode` 项目） | `req_1782778207147_144`（AskUserQuestion，中文 questions） | `\u9 ed8`（空格打断 4 位 hex，应为 `默`） | 不适用 | **THROW**（`Invalid unicode character`）→ Layer 1/2 皆修不了，需独立 `unicode` 项目（§2.3） |

**既有系统已能部分检出**（修订自旧 spec "完全静默"的误述）：`decode-tool-input.ts` 默认就缓冲 `AskUserQuestion`（`backfillQuestionFromHeader` 默认开），在 `content_block_stop` 时 `JSON.parse` 失败会触发 `onDecodeFailure` 回调（`DecodeFailureInfo.reason="input-parse-failed"`，L61/167，经 `reportDecodeFailure(info, env.ctx)` 接 ctx）——所以 965/921（AskUserQuestion）**已被既有 decode 观测到**（只是不修、原样 replay）。**真正静默的是 1304（TodoWrite）**：它不在 decode 默认选中集，decode 不缓冲它，故既无观测也无修复。这正是本特性要补的洞——把检测+修复覆盖到**所有** tool_use 块。

**硬边界**：清洗**只在 `content_block_stop` 已到达**时触发。B 类截断你无法凭空补出 Write 的剩余内容，强行"修"等于伪造——清洗器绝不能碰未 stop 的块。

## 2. 设计

### 2.0 落地形态：扩展既有 tool-input 解码器，而非新增并行 rewrite

**决策（审查 H1 驱动，见 §7）**：不新增独立的并行 ResponseRewrite，而是把修复能力**折叠进既有的 tool-input 解码器** `decode-tool-input.ts`。理由：该解码器**已经**具备本特性所需的全部基建——

- 在 `content_block_stop` 缓冲某 tool_use 块的 `input_json_delta` 分片（`BufferedToolUse`，line 108-114）；
- `finalize` 时 `JSON.parse(full)`（line 163）；
- parse 失败已有 `onDecodeFailure` 回调（`DecodeFailureInfo.reason`，line 41/61，默认 sink `reportDecodeFailure(info, env.ctx)` line 97）作"完整块但 input 非法"的钩子；
- 中断流（无 stop）由 `flush` 原样吐出（emitPendingAtStreamEnd 语义）——天然实现了 §1.1 的硬边界（B 类截断不被修）。

新建并行 rewrite 会造**第二个缓冲器**，对同一 tool_use 块重复 buffer+parse，违 DRY + best-complete-solution。折叠进 decode 还**一举消解** order 级联（无需在 decode 前再插一层）、反向耦合（jsonrepair 产物 → decode 二次 backfill 的顺序问题）、以及下文 C1 的 fail 信号问题（decode 的 `onDecodeFailure` 闭包已 over `env.ctx`，是现成的 handler 接线点）。

具体：当修复项目集非空（`tool_repair_malformed_input` 非 `""`）时，

1. 解码器把**缓冲集从"配置选中工具"扩展到所有 `tool_use` 块**（`server_tool_use` 仍硬排除，line 194 的 `block.type==="tool_use"` guard 不变；其语义注释在 line 152）。纯 happy-path（input 合法）的**内容**零变化（`finalize` parse 成功即原样 replay `rawDeltas`，不重打包），但 ON 时新纳入缓冲的合法块有**有意的时序变化**（改为 stop 时整块到达，同 recover/decode 既有延迟，非"零改动"）。
2. `finalize` 的 parse-失败分支（现 `onDecodeFailure` 上报点）改为先尝试**分层修复**（§2.3）：修好 → 用修复后对象继续既有 decode/backfill 流程并 re-emit；修不好 → 触发 fail 信号（§2.4）。
3. **激活开关**：`toolRepairMalformedInput.length > 0`（landed 后由旧 `!== false` 改为项目集非空）须加进 decode rewrite 的 `appliesTo`（现 `response-rewrite-adapters.ts` L192-193 仅含 decode/backfill 条件），否则用户关掉默认 `backfillQuestionFromHeader` 后 repair 会静默失效；并把修复项目集经 cfg/opts 参数传进 `createToolInputStreamDecoder`。

> 备选（未采纳）：抽"缓冲 tool_use input 到 stop + parse"为共享 primitive 供 decode 与独立 repair-rewrite 复用。比折叠更"分离关注点"，但多一层抽象 + 仍需解决 fail 信号；当前单消费者下 YAGNI。若将来 OpenAI/Responses 也需此能力（§5 OQ-范围），再抽共享 primitive。

仅作用于 Anthropic 路径（实测唯一来源）。仅作用于**转发流**，history 的 `sseEvents` 保上游原貌；修复只体现在 `inboundResponse`（与所有改写一致）。

### 2.1 配置

`anthropic.tool_repair_malformed_input`：**逗号分隔的修复项目集**（`tags`/`unicode`/`jsonrepair` 的子集），默认 `""`（关）。

> **配置形态演进（landed）**：原始设计为 `false | "tags" | "repair"` 三档枚举（`repair` 隐含串行层 = tags+jsonrepair）。后重构为**可叠加的逗号分隔修复项目集**——每项独立可选、按固定规范顺序 `tags → unicode → jsonrepair` 级联、每项把变换叠加在前一项输出上。**干净破坏**（项目未发布，无 compat）：旧 `false`/`"tags"`/`"repair"` 三档枚举废弃，`"repair"` 现等价 `"tags,jsonrepair"`、off 用 `""`。书写顺序无关（dedup + 规范序）。`REPAIR_ITEMS` 单一源（schema 校验/级联/遥测共用），下文 §2.3 的 "Layer 1/Layer 2" 历史措辞对应项目 `tags`/`jsonrepair`。

- `""`（默认）：关，逐字节同前（golden 锁）。解码器缓冲集不扩展（维持现状）。
- `tags`：结构感知剥 antml 标签（§2.3 Layer 1）。正对 antml-bleed（1304 类）。
- `unicode`：修空白打断的 `\uXXXX` 转义（`\u9 ed8`→`默`，真实 case `req_1782778207147_144`）。保守只修「`\u` 后 4 位 hex 被空白字符打断」、去空白凑齐 4 位；合法 `\uXXXX`/紧跟空白/少位/非 hex 一律不动（误修面≈0，200k fuzz 实证）。**jsonrepair 对坏 `\u` 转义直接抛异常，故须独立项目修，不能靠 `jsonrepair`**。
- `jsonrepair`：jsonrepair 库（§2.3 Layer 2）。额外覆盖结构缺括号/trailing comma 类（965 类）。

**诚实标注覆盖率**：`tags` 只修 antml-bleed（实测 A 类 3 例中 1 例）；`unicode` 只修空白打断的转义；965/921 这类结构错只有 `jsonrepair` 能修。retain-on-absence 语义同其它 anthropic.* 标量；hot-reload 经 `applyConfigToState`。`server_tool_use` 永不受影响。

### 2.2 流式流程（复用 decode 缓冲 + finalize）

解码器现有逐帧逻辑不变，仅在 `finalize`（content_block_stop）的 parse-失败分支插入修复：

1. `content_block_start{type:tool_use}`（非 server）：开始缓冲该 index（repair 开时覆盖所有 tool_use）。start 帧立即透传。
2. `input_json_delta`：缓冲，不立即转发（decode 现有行为）。
3. `content_block_stop` → `finalize`：`JSON.parse(accumulated)`。
   - **空累积**（`accumulated === ""`，**精确空串、非 trim**）→ 即空输入对象 `{}`（Anthropic 流式协议）：SDK 累积逻辑为 `input = jsonBuf ? partialParse(jsonBuf) : {}`，空串 falsy 短路成 `{}` 而**不** parse。零参数工具（如 `EnterPlanMode`）合法只发一个空 `input_json_delta`（甚至零 delta）。在 `JSON.parse` **之前**短路成 `{}`，绝不进分层修复/fail-gate（否则 `JSON.parse("")` 抛错被误判 unrepairable，整请求 FAIL——实测 req_1782767425295_95）。decode/backfill 对 `{}` 是 no-op，故原样 replay 缓冲帧、客户端 SDK 自行从空累积重建 `{}`。**精确 `=== ""` 而非 `.trim()`**：whitespace-only 累积（`"  "`）对 SDK 是 truthy → `partialParse("  ")` 抛错（实测），故 whitespace 是真畸形、必须落到正常 parse/repair/fail 路径，绝不救成 `{}`。非流式 `tool_use.input` 落成空串 `""` 时同理短路成 `{}`（镜像守卫，同样精确 `=== ""`）。
   - **合法** → 原样 replay 缓冲 delta + stop（happy-path 零语义变化）。
   - **非法** → §2.3 分层修复 → 修好则发**一个**修复后的 `input_json_delta` + stop（复用 decode 既有 `buildInputJsonDelta` 单帧 re-emit，line 142；该 re-emit 等价性由 recover/decode 既有 golden 作 oracle 钉死，见 §5 OQ-reemit）；修不好则 §2.4。

延迟成本近零：客户端本就需完整 input 才能执行工具，input 延到 `content_block_stop` 不改变可动作时点（recover/decode 已是同款延迟，golden 锁过）。

### 2.3 分层修复（项目级联，顺序 `tags → unicode → jsonrepair`）

- **Layer 1 — 结构感知剥 antml 标签**（项目 `tags`）：**修订自旧 spec 的"位置锚定"**（审查 H2：位置窗口对单样本 1304 过拟合，对中置/多处/单层对象标签会漏修或锚点退化）。改为**结构感知**：对 input 串做轻量 JSON 词法扫描，剥离**字符串字面量之外**的 antml 标签（`</invoke>`、`</parameter>`、`<invoke …>`、`<parameter …>`）——这样既能命中末尾/中置/多处 bleed，又**绝不**误伤字符串值里合法含 `</parameter>` 字面量的内容（本项目自己的文档就有该字面量）。剥后 re-validate。
- **unicode — 空白打断的 `\uXXXX` 转义修复**（项目 `unicode`，landed 后新增）：`fixBadUnicodeEscapes` 单遍扫描器。遇 `\u` → 若紧跟 4 hex 原样透传；否则从 `\u` 后收集 hex、**仅跳过 hex 之间的空白**（空格/tab/CR/LF），去空白后**恰好** 4 hex 且确实消费过空白才输出 `\u`+4hex，否则原样不动。保守边界：`\u` 紧跟空白 / 少于 4 hex / 非 hex 字符一律不修；`\\u…`（转义反斜杠 + 字面文本）经 backslash 跟踪不误判。**误修面≈0**（合法 JSON 的 `\u` 后绝无空白；200k 合法 JSON + 全控制字符转义 fuzz 零字节变更）。**必要性**：jsonrepair 对坏 `\u` 转义直接 `throw`（`Invalid unicode character`），故这类只有 `unicode` 项目能修（真实 case `req_1782778207147_144`：`默`=`\u9 ed8`）。剥后 re-validate。
- **Layer 2 — jsonrepair 库**（项目 `jsonrepair`）：仍非法时跑 `jsonrepair`（npm，纯 JS、无 node-gyp、bun-first 合规，实测 3.14.1 活跃维护）。**必须 try/catch 包裹**——实测对 antml-bleed 与坏 `\u` 转义都会 `throw`（§7-C2），不能让异常冒泡污染改写链。jsonrepair 是**启发式**：修结构缺括号/多余括号/trailing comma 有效（965 实测正确、语义保真），但对个别输入可能产出"合法但语义偏移"的结果。故**保留 before/after 字节供审计**（§3），且仅在 jsonrepair 输出能 re-parse 时采用。

每项后都 re-validate；任一启用项产出合法 JSON（且是 plausible tool input = JSON object）即采用并停（顺序 `tags → unicode → jsonrepair`，省 happy-path 与 antml-bleed/坏转义的 jsonrepair-throw 开销，§5 OQ1 定稿）。**项目可叠加**：每项把变换叠加在前一项输出的 `current` 上（如 strip 后再 fix unicode 再 jsonrepair），故混合畸形可被组合修复。

### 2.4 不可修复兜底：判 fail 让客户端重试（含跨层信号通道设计）

**审查 C1（确认）**：`ResponseRewrite.transform/flush` 只返回 `FrameAction = emit|suppress|buffer`（`rewrite-registry.ts:76`），**无法从 rewrite 内触发 `ctx.fail`/`sink.writeSynthetic`**。真正的 fail 决策在 **handler 的 complete-分支**读 **handler 自持的 accumulator 标志位**（`handler-v4.ts:790` "outcome 是 complete、`acc.streamError` 才翻成 `ctx.fail`"；截断检测靠 `acc.sawMessageStop`，line 858/934-939）。所以"修不好→fail"**不能**在解码器内直接做，必须新设一条 decode→handler 的信号通道。

**设计（plan-review 核验修正：信号挂 `ctx` 而非 `acc`）**：

1. 解码器修复失败时，经**既有 `onDecodeFailure` 回调**上报新原因 `DecodeFailureInfo.reason:"input-unrepairable"`（携 tool 名 + 原始字节）。
2. 该回调闭包**已 over `env.ctx`**（现 `onDecodeFailure: (info) => reportDecodeFailure(info, env.ctx)`，L199/214），故在 `env.ctx` 上置一个标志（如 `ctx.sawUnrepairableToolInput`）。**必须挂 ctx 而非 acc**——handler 的 `acc` 在 buffered-retry 的 `onAttemptReset` 会被 `createAnthropicStreamAccumulator()` 重建（`handler-v4.ts` L863），挂 acc 的标志会在重试时被清掉；`ctx` 跨 attempt 存活。（修正了旧 spec "镜像 `acc.sawMessageStop`" 的错误类比——`sawMessageStop` 走 raw-上游 accumulator 轨，decode 失败走 S5 rewrite 轨，二者不同源。）
3. handler 的 **complete-分支**（`handler-v4.ts` L949-984，现读 `acc.streamError`/`acc.sawMessageStop` 处）增读 `ctx` 该标志：置位则 `env.ctx.fail(...)` + `sink.writeSynthetic(anthropicErrorFrame(...))`，与截断检测**同一条 fail 出口**。**与截断叠加优先级**（`block_stop✓+message_stop✗` 象限）：unrepairable 在 `streamError` 之后判，与 truncation 同档（先到先判，error 帧二选一，须在 P4 定序）。

history 记失败 + 保留残缺投影；客户端据合成 error 帧原生重试拿干净响应。**绝不伪造**（不发空 input、不发降级 text）。fail 兜底的**质量**依 `protect_streaming_generation` 而异，见 §2.6。

### 2.5 非流式（transformWhole）

**审查 M2（修订）**：旧 spec 说非流式畸形"表现为整 body parse 失败或 input 落成字符串"——**前半不可达**：`transformWhole(response, env)` 接收的是**已 parse 的 response 对象**（`driver.ts` `runResponseWhole`），若整 body parse 失败，driver 在更早的反序列化阶段就拿不到结构化对象、`transformWhole` 根本不被调到（那种情况是上游 200+坏 JSON，归 `non-streaming-completeness` / parsing 层，不在本特性）。本特性非流式**只处理** `tool_use.input` 落成**字符串且非法**的块：走同一分层修复。**非流式 fail 走同一 ctx 标志**——decode 的 `transformWhole`（L208）的 `onDecodeFailure` 闭包同样 over `env.ctx`，unrepairable 时置 `ctx.sawUnrepairableToolInput`，handler 在 `renderNonStreamingV4` 调 `runResponseWhole` **之后**（`handler-v4.ts` L681/695 区，现有 `anthropicNonStreamingTruncation` gate 旁）增读该标志判 fail（`runResponseWhole` 本身无错误回传通道，故经 ctx 标志而非返回值）。主要观测来自流式，非流式作平行覆盖。

## 2.6 独立生效性与 protect_streaming_generation 的正交关系

**本特性独立生效，不依赖 `protect_streaming_generation`。** 经核实 `driver.ts`：非缓冲 live 路径 `runResponseSink` 与 L2 缓冲路径 `runResponseBufferedSink` **都是 `for await (const frame of runResponse(...))`**，`runResponse` 才是跑 S5 改写链的共享引擎。故解码器（含本修复）在两条路径都运行。

修复**成功路径完全独立**：解码器的块级 buffer（攒 input 到 stop）不是 protect_streaming 的整响应 buffer。即使 protect_streaming 关、走 live：前面 text 块照常实时流给客户端（UX 不变），tool_use 块 input 被本地缓冲到 stop 才放行——客户端**永不先收到畸形 input**。单开本特性即满足主场景。

只有**不可修复的 fail 兜底质量**依 protect_streaming 而异：

| protect_streaming | 修不好时 |
|---|---|
| **关**（live `runResponseSink`） | 前面 text 已 commit/转发，只能在残缺内容后补合成 error 帧 → 客户端可见错误、**客户端层重试**（同截断检测的 post-content 限制，§5 OQ2） |
| **开**（buffered `runResponseBufferedSink`） | 整响应未 commit → fail 可触发 **S4 透明重取新流**，客户端无感 |

### 设计动机：buffer 粒度 = 恢复手段粒度

本特性能做**块级** buffer，与 protect_streaming 必须**整响应** buffer，是**恢复手段粒度不同**所致，非孰优孰劣：

| 特性 | 恢复手段 | 故 buffer 粒度 |
|---|---|---|
| 本特性（tool-input 修复） | **就地变换**（剥标签/jsonrepair，无需重取上游） | **块级**——修完该块即放行，前块早已 live 转发 |
| protect_streaming | **重试 = 重取整条新流、整轮重新生成**（上游无块级续传；DESIGN.md：丢 buffer、回 S4、全量重置、all-or-nothing） | **整响应**——一旦 commit 前缀块，重试重生成全部块（非确定），客户端拿「首次前缀 + 重试全量」→ 重复+冲突 |

推论：protect_streaming **不能**放宽到块级（破坏 all-or-nothing 透明重试保证）；"只 buffer 最后那个大 tool_use 块、commit 前缀"也不安全（重试整轮重生、前缀在非确定生成下常 diverge，已 commit 的冲突内容收不回）。

## 3. 观测（richest-data-flow）

**审查 H3（增强）**：jsonrepair 引入"修成合法但可能语义偏移"的新风险，故后端必须完整记录足以事后判断"修对没"的数据：

- **per-entry**（进 history，非仅聚合）：命中层（`tags`/`jsonrepair`/`unrepairable`）+ **修复前后字节 diff**（`repair` 档；`sseEvents` 已存上游原始畸形帧，`inboundResponse` 存修复后帧，故 diff 可由两腿派生——确认无需额外列即可对账"修了什么、改了哪几字节"）。
- telemetry：计数（按 layer 命中、fail 次数、按 tool 名），经既有 `request-telemetry` registry（零持久版本 bump）。
- ctx feature tag：`tool-input-repaired`（携 layer）/ `tool-input-unrepairable`——**须先把这两个加进 `events.ts` 的 `FeatureKind` 封闭联合**（落地前置）。
- 日志：`[REWRITE] tool-input-repair`（命中 layer + 工具名 + 前后长度）。

## 4. 测试计划

- 单元（`tests/anthropic/`）：Layer 1 结构感知剥标签（含"字符串值合法含 `</parameter>` 字面量不被误伤"+ 中置标签 + 多块各自畸形 + 单层对象 的反例）；Layer 2 jsonrepair 对 **1304 抛异常被 try/catch 兜住**、对 **965 真实字节正确修复（语义保真）** 的实测断言；合法 input 零改动快路径；`server_tool_use` 不受影响。
- 流式（`.http`）：用 1304 + 965 **真实帧序**作 fixture，断言 `tags`/`repair` 下转发 input 合法、history 保原貌、**re-emit 帧过 `assertEventLineInvariant`**（合成 `input_json_delta` 须带正确 event 行，否则 Claude Code SDK 静默丢帧，同 recover-tool-call 旧坑）；不可修复（构造一个 strip+jsonrepair 都修不了的）→ handler fail + 合成 error 帧。
- 跨层信号（`.http`）：断言解码器 `onDecodeFailure(reason:"input-unrepairable")` → 置 `ctx` 标志 → handler complete-分支 fail 的整条通道（C1 的新机制须有 e2e 测试）。**测可观测行为**（fail + 合成 error 帧 + history 记失败），不锁内部字段名（self-consistent-needs-independent-oracle）。
- buffered-retry：unrepairable 信号挂 ctx，断言 `onAttemptReset` 重建 acc 后信号**不丢**（若误挂 acc 会被清，此测防回归）。
- 截断 regression：B 类（无 `content_block_stop`）**绝不**被修，仍走截断检测（`emitPendingAtStreamEnd` 原样吐）。
- 四象限 gate（审查 M3/H-gate）：`block_stop✓ + message_stop✗`（块完整但整体截断）—— 断言修复与截断检测的交叠行为明确（修了块、整体仍 fail）；`block_stop✓ + stop_reason≠tool_use` —— 断言不误修。
- golden：`false` 下逐字节同前（baseline lock）。
- hot-reload：配置键进 `config-hot-reload.it.test.ts` 矩阵。

## 5. Open questions

- OQ1（定稿）：Layer 2 仅在 Layer 1 失败后跑（省 happy-path 与 antml-bleed 的 jsonrepair-throw 开销）。实测支持。
- OQ2：fail 兜底在 text 已转发后触发（protect_streaming 关时），客户端拿"部分 text + error"——文档化为已知限制（同截断检测 post-content 暂缓），还是建议与 protect_streaming 同开以转透明重试？
- OQ-reemit：单个修复后 `input_json_delta` 替代原多个小 delta 的客户端等价性——以 recover/decode 既有 golden + Anthropic SDK 实测作**独立 oracle** 钉死（self-consistent-needs-independent-oracle），不口头断言。
- OQ-name：修复后 tool_use 经 filter(300)/`sanitizeToolNames` 的 name 还原是否仍正确？本特性只改 input 字节、不碰 name，预期 name-agnostic，须确认。
- OQ-回流：客户端把修复后 input 回传上游，上游看到的是"代理修过的 input"而非自己生成的畸形——是否触发后续轮次一致性/prompt-cache 问题（类比 `rewriteHistoryServerTools` 的回流处理）？
- OQ-范围：实测仅 Anthropic 见此畸形，故 YAGNI 排除 OpenAI/Responses。若日后 `tool_calls.arguments`/`function_call.arguments` 同源畸形有实证，则把"缓冲+parse+修复"抽共享 primitive 三格式复用（§2.0 备选）。

## 6. 落地后 doc-sync（completion-includes-doc-sync）

- DESIGN.md「活的架构现状」表：tool-input 解码器行补"含畸形修复能力"。
- DESIGN.md「运行时选项」配置表：新增 `tool_repair_malformed_input` 行。
- DESIGN.md「改写词汇」/ 模块图：decode 解码器职责更新。
- `events.ts` `FeatureKind` 扩展（§3）。
- 删除本 spec 的过时 pending 记忆、把已落地机制回填活文档。

## 7. 实测核验记录（主线亲验，非照搬 reviewer）

两轮对抗 subagent 审查后，对**会改变设计**的三项主张主线亲手核验（verifying-authoritative-claims：按独立实测裁决，非按 reviewer 自信度）：

- **C1（确认）**：`FrameAction = emit|suppress|buffer`（`rewrite-registry.ts:76`），rewrite 无 fail 路径；fail 由 handler complete-分支读 `acc`（`handler-v4.ts:790/934-939`）。→ 采纳：§2.4 新设 decode→handler 信号通道。
- **H1（确认）**：`decode-tool-input.ts` 已缓冲 input_json_delta 到 content_block_stop + `JSON.parse`（line 163）+ `onUndecodable("input-parse-failed")`（line 167）+ 中断流原样吐（line 128）。→ 采纳：§2.0 折叠进 decode 而非并行 rewrite。并修订旧 spec "完全静默"：965/921（AskUserQuestion）decode 已检出，仅 1304（TodoWrite，非选中集）静默。
- **C2（reviewer 实测结论部分错误，主线推翻）**：reviewer 用**自己捏造的** `{"q":"\\\\u67b6"}` 测出"jsonrepair 语义改坏"。主线用**真实 965 字节**亲测：jsonrepair **正确修复**（补缺失 `]}`，parse 后含**真实中文汉字**、无字面 `\u` 残留）——965 真因是结构缺括号非过度转义。**纠正**：jsonrepair 对结构类有效且语义保真，"语义改坏"是 reviewer 测错样本的伪结论。**保留**有效告诫：jsonrepair 对 antml-bleed 会 `throw`（须 try/catch），且为启发式（保留 before/after diff 审计）。

### 7.1 plan-review 接线层核验修正（第二轮，主线逐条对照源码确认 reviewer 全对）

plan 草稿描述接线时"镜像既有模式"但臆造了符号名与数据流，经主线核验全部修正：

- **回调名**：臆造的 `onUndecodable` **不存在**；真实是 `ToolInputRewriteOptions.onDecodeFailure`（L61）+ `DecodeFailureInfo.reason`（L41）+ 默认 sink `reportDecodeFailure(info, env.ctx)`（L97）。全文已改。
- **fail 信号载体 acc→ctx**：`acc.sawMessageStop` 走 raw-上游 accumulator 轨（`stream-accumulator.ts` L116/179）；decode 失败走 S5 rewrite 的 `onDecodeFailure` 闭包（over `env.ctx`，L199/214），**不同源**。且 `onAttemptReset`（`handler-v4.ts` L863）在 buffered-retry 重建 acc → 挂 acc 的标志会丢。**改为挂 `ctx`**（§2.4）。
- **激活开关漏写**：decode `appliesTo`（L192-193）不含 `toolRepairMalformedInput`；不补则 repair 开但 decode/backfill 全关时静默失效。§2.0 已补。
- **非流式 fail 通道**：`runResponseWhole` 无错误返回；经 `transformWhole` 的 `onDecodeFailure`→ctx 标志，handler L681/695 区增读（§2.5）。
- **FeatureKind 排序**：`recordFeature` 的 kind 是封闭联合，须在首个打 tag 的 phase 前扩展（plan P0/P3 前置，非 P6）。
- **happy-path ON 时序**：合法块新纳入缓冲后改为 stop 时整块到达（有意时序变化，同 recover/decode），**内容**仍 byte-identical 且**不**重打包（`finalize` 对未变 input 原样 replay `rawDeltas`）。reviewer 的"re-pack 单 delta"担忧方向错，真实是时序。

### 7.2 实现后 whole-domain subagent audit 修正（第三轮，主线复核 + 实测复现后修）

实现 P0-P6 后派 subagent 做 whole-domain audit，**主线逐条复现裁决**（非照搬），抓到三个真问题并修（commit `fix(anthropic): isolate per-attempt repair outcomes …`）：

- **C1（CRITICAL，已修）**：§2.4/§7.1 把 fail 信号"挂 ctx 非 acc"当目标，但**只挂不清**是缺陷——ctx 标志 set-once（`??=`）从不清空，L2 buffered-retry 中**被丢弃尝试**（attempt 1 畸形块到 `content_block_stop` 触发 `onDecodeFailure` 置标志、随后截断 → buffer 丢弃重试）的 unrepairable 信号会**污染后续成功 commit**（attempt 2 干净却被判 FAIL + 在合法内容后补 error 帧）。audit 用 http 测试复现（CALLS:2、HISTORY:failed）。**修**：改 set-once 标志为 **per-attempt 累积** `ctx.repairOutcomes`，`onAttemptReset` 清空之，**committed settle 点**一次性 flush；`unrepairableToolInput` 改为从 committed 累积派生。回归测试锁"discarded 尝试不污染 recovered commit"。
- **H1（HIGH，已修，同根）**：遥测计数器在 decode 闭包内 per-attempt 触发 → 被 retry 次数膨胀（audit 复现 4 尝试 → unrepairable=4）。**修**：随 C1 把 `recordToolInputRepair` + feature tag + 日志全移到 committed settle 点的 `flushToolInputRepairObservability`（镜像 protect-streaming `onBufferedResolve` 的 commit-时记录），计数反映 per-request 结果。
- **H3（HIGH，已修）**：jsonrepair 过度激进，把非 JSON 垃圾（`not json` → 裸 string `"not json"`）"修"成可 parse 但无意义的值，re-parse gate 只验可 parse 不验合理。**修**：加 plausibility gate——tool input 恒为 JSON object，裸 string/number/array/null 不算修好 → unrepairable。
- **H2（HIGH，文档化为已知局限）**：antml tags 溢入**被截断的 string 值内部**时（如 `{"cmd":"echo hi</parameter>`），Layer 1 正确不剥（在 string 内），Layer 2 jsonrepair 闭合 string 把标签封进 `cmd` 值。这是 jsonrepair 启发式对此特定形状的固有局限（无法在不误伤合法含 `</parameter>` 内容的前提下 gate）；`repair` 档本就是 opt-in 的激进启发式，before/after 审计留痕。real 1304/965 样本的标签都在结构边界（Layer 1 干净处理），H2 是另一形状。
- **VERIFIED CLEAN**（audit 实测确认）：off=byte-identical、event-line 不变量、流式/非流式 precedence 定序、history 保上游原貌、jsonrepair try/catch + Layer 2 跑 stripped 形态、server_tool_use 排除、FeatureKind 注册齐全。
