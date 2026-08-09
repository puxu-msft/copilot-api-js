# Anthropic ↔ Responses semantic bridge —— 主实施计划

> **权威 spec**：[docs/rfc/2026-08-08-anthropic-responses-semantic-bridge.md](../../rfc/2026-08-08-anthropic-responses-semantic-bridge.md)（Accepted，五轮对抗评审收口）。
> **决策依据**：[ADR 2026-08-08 protocol-neutral reasoning exchange](../../decisions/2026-08-08-protocol-neutral-reasoning-exchange.md)；收窄的既有决策 [ADR 2026-07-14 lossless-per-pair bridge](../../decisions/2026-07-14-lossless-per-pair-bridge.md)。
> **本文职责**：HOW —— 任务 DAG + 锚点表（精确 `file:line`）+ 每 commit invariant + 验收与 mutation。**WHY 与公共契约一律以 RFC 为准，本文不重新裁决、不复述类型定义正文**。
> **kickoff 提示词**：[prompts/README.md](prompts/README.md)（阶段导航 + 依赖 DAG + 通用红线）。
>
> **计划基线**：master `82c0664e`（RFC/ADR/评审报告合入点）。下方所有 `file:line` 在该基线复验过；实施者**开工第一件事是重新复验自己要改的锚点**——行号会随并发会话漂移，用内容匹配而非行号定位。

## Goal

把现有 Anthropic ↔ Responses direct bridge 的六份方向专用 translator（各自维护 stream/non-stream 双份领域状态机）收敛为：**一个 protocol-neutral semantic mapper + keyed item ledger + 两个纯 wire emitter**，使同一领域事实只裁决一次、stream 与 non-stream 结构性共享语义、能力缺口 fail-closed 且可观测。

## Architecture

RFC §3 的四层职责（mapper / ledger / policy resolver / driver+emitter）落到现有 v4 管线上：mapper 与 ledger 是新增的纯模块；policy resolver 挂在 ingress 与 candidate final-route 之间；delivery authority **扩展既有的客户端写出漏斗**（`src/lib/pipeline/delivery/session.ts` 的 `writeToSink`，它有四个调用方，见锚点 C-1/C-2），emitter 取代六个 translator 的 wire 部分。**现有 wire 算法核（usage 映射、stop-reason 投影、tool JSON 修复、carrier codec）extract-not-rewrite**，迁移的是它们各自私藏的 lifecycle 状态，不是重写字节算法。

## Tech Stack

TypeScript / Bun；SSE + WebSocket 流式；官方 `openai@^6.45.0`（`ResponseAccumulator` / `client.responses.stream().finalResponse()`）与 `@anthropic-ai/sdk@0.106.0`（`Stream.fromSSEResponse` / `.finalMessage()`）**仅作独立客户端 oracle**——两者都在 `devDependencies`（`package.json:110`、`:120`），这从依赖结构上保证了 RFC §2「不把 SDK 作为生产 emitter」，**不要把它们提升为 dependencies**；`safe-stable-stringify@2.5.0`（`package.json:96`，生产依赖、精确钉版）作 canonical JSON，须先过自建递归 validator（RFC §6.1）；bun test 分档 + eslint。**本计划不新增任何 npm 包。**

---

## Global Constraints（每个 task 隐含包含）

逐条来自 RFC §11.1，违反即返工：

- **G1 每 commit 可运行**：`bun run typecheck` 绿 + 目标测试可跑。中间态显式无害，绝不半坏。
- **G2 绝不双发** `[hard]`：旧 production path 仍是唯一 writer，**或**新 path 在同一 commit 原子取代该方向全部 cells。C1–C8 一律不得改变 production writer；只有 C9/C10 切换。
  **G2 的机械判据（C2.1 起每片必跑，不接受自评）**：`test:backend` 不回归**证不了**字节不变——它只证明没人断言到差异。C0.2 必须额外冻结一组**客户端 wire 字节 golden**（两方向 × stream/non-stream × 有无 retry，至少 6 条），C2.1–C8.3 每片在**改动前后各跑一次并逐字节对账**，差异即该片失败。这组 golden 直到 C9/C10 才允许按方向更新，且更新必须与 cutover 同 commit。
  `[hard]` **这组 golden 自己必须有灵敏度对照**：C0.2 要证明「production wire 改一个字节 → 至少一条 golden 变红」。**没有这条对照，后续十余片的 G2 对账可能全是空转而毫无信号** —— 捕获点取浅（捕在 translator 输出而非真实客户端字节）或归一化过度，都会让它对真实差异失明。
  `[hard]` **每片的 Verify 都隐含包含这条对账**，即使该片的 Verify 段没有逐字写出；执行者须把对账结果（相同／差异）写进自己的进度文件。**逐片写出的地方以本条为准，本条是权威**。
  **配套的穷尽性判据**：`writeToSink`（锚点 C-1）是**流式**客户端字节的单一漏斗；加一条结构守卫断言**其调用方集合被冻结**（当前四个，见 C-2）。⚠️ **该守卫只覆盖流式**，非流式走 `c.json`（见 C-0），由 C2.3 的非流式存在性正控覆盖 —— **不要把这条守卫读成「所有客户端写出都在此」**。
- **G3 shadow 无副作用** `[hard]`：shadow 只写 request-local 内存比较器。写客户端／日志／History／指标／任何共享状态即该 commit 失败。
- **G4 同模型原样回送** `[hard]`：同模型 Anthropic tool-use assistant content 完整、原序回送原生 thinking／redacted_thinking，不经 envelope 重建（RFC §3.3 第 7 条）。
- **G5 stream/non-stream 同源**：每个已切方向的两条路径语义来自同一 ledger snapshot。
- **G6 切换双向 mutation**：每个 cutover commit 同时有「新路径可达」与「旧路径不可达」两个 mutation 对照。
- **G7 配置非法组合解析期失败**：v2 policy rule 是原子单元，非法即整条 rule 不进运行态；**不得只剥非法叶子让其余字段带默认值继续**（这正是现有 `ModelTranslationSchema` 的 `cleanInvalidPaths()` 行为，见锚点表 A-9）。
- **G8 History 不记录 opaque 正文** `[hard]`：只存 carrier version／source／boundary／域分离 SHA-256／byteLength。

项目级红线（不重复正文，指向权威）：

- **实现优先、非 TDD red-first** —— user-rule `40-dev-workflow` `implementation-before-tests`。先写生产行为，再补直接覆盖该行为的核心测试。**唯一例外是 C0**：它是 golden 预捕获，按 skill `large-refactor` §4 必须在**改动前的旧码**上跑通。
- **4141 保护** `[hard]` —— 绝不 kill 用户主服务器；测试服务器起在非 4141 端口、按 PID 精确清理。见 CLAUDE.md `protect-user-main-server`。
- **提交纪律** —— 显式 pathspec `git commit -F <msgfile> -- <精确路径>`，一语义单元一 commit，conventional commits，无模型署名。共享树 pathspec 免疫 peer index race。
- **不可逆动作 fail-closed** —— 无法确定 opaque 来源、schema dialect 不接受、context-management 混合策略，一律 reject，不猜（RFC §14）。

---

## 当前生产现实：锚点表

**这一节是本计划最重要的部分。** RFC 描述目标态，下表是实施者会真正打开的文件。已在基线 `82c0664e` 复验。

### A. 翻译层（六个 translator —— 被 C8 emitter 取代的对象）

| ID | 锚点 | 现状与迁移取向 |
|---|---|---|
| A-1 | `src/lib/openai/translate/anthropic-to-responses-request.ts:113` | A→R request。`textParts`／`items`／两类 dropped-thinking 计数是**私藏状态**。:217-255 把 assistant text 汇总成一个 item 并 `unshift`，丢失 text/tool 交错顺序 → C4.1 治。:150-155 静默裁剪 `context_management`／stop sequences／`top_k` → C6 治。:243-245 丢 `server_tool_use` → C5 治。:381-388 只映射 `web_search`、其余剥离 |
| A-2 | `src/lib/openai/translate/anthropic-to-responses.ts:81` | A→R non-stream。:94-145 把所有 reasoning `unshift` 前置。:132-136 drop server-tool 两类。`mapStopReasonToResponsesStatus`（:145）／`mapUsage`（:205-263）是**要保留的算法核** |
| A-3 | `src/lib/openai/translate/anthropic-to-responses-stream.ts:139` | A→R stream。`createAnthropicToResponsesStreamTranslator`。:419-504 `flush` 无条件发 `response.completed`、只把 status 填成 incomplete → 违反 RFC §4 `ResponseTerminal` 不得改写，C8.1 治。:258-271 `content_block_start` 不读完整 input，flush 靠 `argumentParts.join("")` → 无 delta 的 function call 变空 input |
| A-4 | `src/lib/openai/translate/responses-to-anthropic-request.ts:113` | R→A request。`foldInputItems`（:148-277）三槽位按类别重组，丢原序 → C4.2 治。:122-128 静默裁剪 `previous_response_id`／context management／truncation |
| A-5 | `src/lib/openai/translate/responses-to-anthropic.ts:157` | R→A non-stream。:163-173 **单个** `reasoningText` + **单个** `reasoningEncrypted` → 多 reasoning item 被压扁；:210-219 只有 text 非空才生成 thinking → encrypted-only reasoning 被丢。`mapResponsesStatusToStopReason`（:221-234）／`mapUsage`（:305-351）／`repairToolInput`（:271-279）是**要保留的算法核** |
| A-6 | `src/lib/openai/translate/responses-to-anthropic-stream.ts:122` | R→A stream。同样只有一个 `reasoningEncrypted`（:129-139）。:274-294 在 `.done` 才捕获 opaque（**这是正确行为，Phase 0 探针已裁决 `.added` 是中间态**，勿回退）。:179-191 `buildSyntheticReasoningSignature` carrier |

**方向不对称提醒**：两向 carrier **故意不同**（Claude signature vs synthetic-reasoning 前缀），RFC §6.1 要求保持前缀分离并做 prefix↔kind↔source 联合校验；**不得为「统一」合并成通用 string**。

### B. 请求腿三点 seam（RFC §11 C8/C9 承重）

| ID | 锚点 | 说明 |
|---|---|---|
| B-1 | `src/lib/pipeline/hub-translate.ts:148` `anthropicToResponsesBridge`，:171 `REQUEST_BRIDGES`，:261 `RESPONSE_BRIDGES`，:337 `responsesForwardStreamFactory`，:358 `FORWARD_STREAM_FACTORIES`，:467 `responsesReverseStreamFactory`，:496 `REVERSE_STREAM_FACTORIES` | 四个穷尽 `satisfies Record` 桥表**已存在**。C9/C10 换的是表项指向，不是表结构。漏格=编译错，这条护栏继续用 |
| B-2 | `src/lib/codec/openai-responses/openai-responses-cell.ts:75` `bodyIsResponsesShaped`，:114 `translateOut`，:138 `prepareWire` | `translateOut` 的 dispatch 键是「是否 SKIP 翻译」，`prepareWire` 的键是「body 是否已 Responses 形」——**两个不同谓词，别混用** |
| B-3 | `src/lib/codec/openai-responses/openai-responses-leg.ts:111` `prepareResponsesDirectWire`，:135 `prepareViaResponsesWire` | 已是目标协议形状的 body 不得再经 CC 二次翻译 |
| B-4 | `src/lib/codec/cc-family-strategies.ts:42` `isAnthropicDirectResponsesLeg`，:47 `buildCcFamilyLegStrategies` | retry baseline 的第三点。**只改 B-2 而漏 B-3/B-4 会让 retry 腿回退成 CC 形**——RFC §12 要求逐点恢复旧路径的 mutation |

### C. Driver / delivery / candidate（C2 authority 与 C8 shadow 的宿主）

| ID | 锚点 | 说明 |
|---|---|---|
| C-0 | **见下方「客户端字节起点全集」小节** | ⚠️ **这是 C2.3 全部 authority 判据的作用域基石。** 本计划在这里连续写错**三次**，每次都是把一个**只在某作用域内成立**的事实写成全称。三次的形态见小节末尾 |
| C-1 | `src/lib/pipeline/delivery/session.ts:687` `writeToSink` | **流式客户端字节的单一漏斗**（**仅流式**，见 C-0）。它有**四个**调用方（见 C-2）。⚠️ **不要把 `writeCommittedBatch` 当成唯一 writer**：它确实在首次外部写前同步 `commit()`（`:378-379`）并据此分裂 `committed:false\|true`，但只覆盖 allocation 帧与 recovery batch，主流式路径根本不走它 |
| C-2 | 四个 `writeToSink` 调用方：`:165` `write()`（**流式主路径** —— `clientSink` 的 `write`/`writeSynthetic`/`writeKeepalive`/`writeSyntheticEnvelope`/`writeAnchor` 与 `writeScaffold`/`terminate` 全走它；driver 的 `sink.write` 五处 `driver.ts:1164,1168,1310,1540,1608` 落在这里）、`:387` `writeCommittedBatch`、`:531` `closeOpenAnchor`、`:564` `writeBlockFrame` | ⚠️ **四条路径的 commit 语义各不相同**：`write()` 无 commit 概念；`writeCommittedBatch` 的 commit 回调由调用方传入，且两个调用点传的还不一样（`:423-424` 传 `reservation.commit()`、`:492` `publish-recovery-batch` 传**空回调 `() => {}`**）；`closeOpenAnchor` 与 `writeBlockFrame` 各自内联写。**authority epoch 必须覆盖全部四条**，挂在任何单一调用方上都会漏掉主路径 |
| C-3 | `src/lib/pipeline/types.ts:509` `GenerationWireState`，:513 `activeLeg`，:514 `openAnchorIndex` | wire 状态 SSOT。`reservation.commit()` 只改 allocator 计数器，**不改变 owner 归属语义** → authority epoch 需要在此新增字段 |
| C-4 | `src/lib/pipeline/generation/coordinator.ts:182` `runRecovery`（:197 父 settle failed）、:215 `runContinuation`（:221-222 父 settle continued）、:234 `raceReadyCandidates` | segment boundary 的天然产生点。**`runRecovery` 与 `runContinuation` 性质不同**：前者「父失败、子重开」，后者「父已部分交付、子续接」——RFC §3.4 的 fallback 与 continuation 分别对应，**不得用同一个函数处理**。`raceReadyCandidates` 是「哪个段成为权威」的判定点，不是新建点 |
| C-5 | `src/lib/pipeline/generation/candidate-response-session.ts:104` `createState()`，:110 `captureTerminalSnapshot`，:184 `snapshot()`，:189 缓存返回 | candidate-local 状态宿主。`State` 是不透明类型参数，**可以**承载 per-candidate ledger segment。⚠️ **已知阻碍**：:189 在 `terminalSnapshot !== undefined` 时直接返回缓存，不再读最新 `state`；continuation 若要读父 ledger，必须在 `captureTerminalSnapshot` 冻结前取，或新增直接持有 `State` 的旁路（当前无此旁路） |
| C-6 | `src/lib/pipeline/committed-blocks-ledger.ts:15` `CanonicalBlock`，:24 `createCommittedBlocksLedger`，:40 `hasCompleteInteractiveToolUse` | ⚠️ **与新 semantic ledger 是两件事，禁止合并**。它只负责 continuation 的「已交付前缀」（text/tool_use 两型，故意排除 thinking），由 driver 在 commit boundary 喂养。新 ledger 管完整语义 lifecycle。两者由同一 delivery boundary 驱动，但职责不重叠 |
| C-7 | `src/lib/context/request.ts:1494` `selectGenerationWinner`，:901 `commitGenerationObservabilityTerminal` | candidate 选定与 terminal 记录。observation stage 晋级要接在这里 |

### C-0 附：authority 的作用域，以及为什么不要枚举写出点

`[hard]` **本小节记录一次连错四轮的教训，读完再动 C2.3。**

#### 真正的错误：我一直在错误的轴上枚举

RFC §6 的不变量原文是：

> 「request 在任一时刻至多一个 **candidate** 持 `active` delivery authority」「未持 authority 的 **candidate** 不得写任何客户端 sink」

它约束的是**一个请求内的 candidate 之间**（谁是现任写者），**不是**「进程里每个写出字节的地方都要过一道 authority 检查」。我把 candidate 级不变量读成了写出点级全称，于是四轮都在补一份**永远补不完**的写出点清单：

1. 「`writeCommittedBatch` 是唯一客户端 writer」——漏同文件的 `write()`。
2. 「`writeToSink` 是所有客户端字节的漏斗」——流式内正确，漏非流式 `c.json`。**且为它加的守卫会为这个假全称背书。**
3. 「客户端字节有两条互不相交的路径」——漏自持 `streamSSE`。
4. 「冻结 `streamSSE(`／`c.json(` 调用点即可抓住下一类」——漏 `ws.send(`。**连专门用来防复发的守卫也犯了同一个错。**

若继续沿这条轴走，第五次是 `forwardError`（`lib/error/forward.ts:524`，约十处调用，含 `server.ts:90` 的 app 级 onError —— 它按 `c.req.path` 判别 wire 格式，**确实为模型路由兜底**），第六次会是别的。**枚举写出原语这件事本身没有终点。**

#### 正确的形状：authority 建在请求作用域，不建在写出点

- **authority 在 ingress 按请求建立一次**，归属由 candidate lineage 管（C2.2）。请求内的写出**由构造继承**它，无需逐点检查。
- 于是「至多一个 active」变成 **candidate 之间**的性质 —— 由 C2.2 的 lineage 与 C2.3 的 transfer 临界区保证，**与写出点数量无关**。
- 写出点枚举**只对一个窄得多的问题有用**：**哪个写出点负责记录 terminal wire 的 ACK 或 delivery failure**。这个集合小且有界，且它的遗漏是**可观测的**（terminal 记录缺失），不像「某处绕过 authority」那样静默。

#### 因此本计划的作用域声明

`[hard]` **在范围内**（必须归入某个请求的 authority）：承载**模型请求的响应或其终态错误**的写出。当前已知：

| 类 | 起点 |
|---|---|
| ① delivery session 流式 | `client-sink.ts:494`／`:697`（`createDownstreamDeliverySession` 仅有两个创建点）；消费方 `messages:1584`、`responses:358`／`:607`、`responses/ws.ts:377`、`chat-completions:530`／`:767`、`gemini:446`／`:651`。漏斗 `writeToSink`（`session.ts:687`）四调用方见 C-2 |
| ② handler `c.json`／`c.body` 非流式 | `messages:1377`／`:1344`／`:788`、**`responses:269`／`:534`**、`chat-completions:400`／`:691`、`gemini:350`／`:580` |
| ③ 自持 `streamSSE` | `messages/error-shaping-glue.ts:129`、`lib/anthropic/warmup.ts:211`／`:241` |
| ④ 直接 `ws.send` | `responses/ws.ts:167`（错误整形 canonical 帧）、`:614`、`:686` |
| ⑤ 共享错误出口 | `lib/error/forward.ts:524` `forwardError`，含 `server.ts:90` 的 app 级兜底 |

**明确在范围外**（不承载模型响应，不参与 authority；**这是声明，不是遗漏**）：History／event-logging／config／status 等管理端点的响应；`server.ts:86` 的 WS 升级失败 `c.text("", 500)`。

`[hard]` **这份清单不自称穷尽。** 它是「已知在范围内的写出点」，作用是让实施者知道该去哪几处记录 terminal；**authority 的正确性不依赖它完整** —— 那由请求作用域的建立保证。

#### 守卫怎么写才不会变成下一个假全称

`[hard]` 守卫的断言消息**必须写明它冻结的是什么、以及它不证明什么**：

- `delivery-writer-set` —— 冻结 `writeToSink` 的四个调用方。**只覆盖 ①**。
- `client-byte-origins` —— 冻结**模型路由**下的客户端写出原语集合（`streamSSE(`／`writeSSE(`／`c.json(`／`c.body(`／`ws.send(`／`forwardError(`）**及其调用点**；出现**未登记的新原语**时也要 fail，不只是已知原语多一个调用点。
- **两条守卫都必须在断言消息里写「本守卫不证明客户端写出集合已穷尽」** —— 前四轮的失效，每一次都是因为一条只覆盖某一类的判据被读成了全称背书。

**发现方式也值得记**：第四类是用**与前三次不同的扫描思路**（改扫 `new Response(`／`c.text(`／`.send(` 等其它原语）才撞到的。沿用自己的思路复查，只会复现自己的盲点。

---

---

### D. 配置（C2/C6 的对象）

| ID | 锚点 | 说明 |
|---|---|---|
| D-1 | `src/lib/config/schema.ts:1242` `MODEL_TRANSLATION_INGRESS_VALUES`，:1252 `MODEL_TRANSLATION_FEATURE_VALUES`（当前只有 `"strip-thinking-signature"`），:1266 `ModelTranslationRuleSchema`，:1283 `ModelTranslationSchema`，:1427 顶层字段 | v1 schema。RFC §6.2 的 `policy` 段在此扩展 |
| D-2 | `src/lib/config/schema.ts:1594-1601` `AssertAssignable` 双向锁 | schema 与 foundation 词表 lockstep。改一边不改另一边 → 编译错。**这是要保留的护栏** |
| D-3 | `packages/foundation/src/state-vocabulary.ts:231-247` `ModelTranslationIngress` / `Feature` / `Rule` / `ModelTranslation` | 词表侧 |
| D-4 | `src/lib/config/model-translation.ts:38` `resolveTranslationFeatures`，:57 `ingressForClientFormat`，:68 `stripThinkingSignatureFor`，:74 `modelIdFor` | v1 resolver。C6.2 由 policy resolver 取代；`features:["strip-thinking-signature"]` 迁移为 `policy.carrier_unknown:"strip"` 并发弃用警告 |
| D-5 | `src/lib/config/schema.ts:1009` 注释所述 `cleanInvalidPaths()` 行为 | ⚠️ **当前行为是「剥掉出错的叶子、其余继续」，正是 G7 禁止的**。C6.2 必须让 v2 rule 走 rule-level 原子失败路径 |

### E. History（C3 的对象）

| ID | 锚点 | 说明 |
|---|---|---|
| E-1 | `src/lib/history/types.ts:217` `PipelineInfo`，:222 `wirePartialDelivery`，:225 `translation?.anthropicToResponses` | 旧槽。迁移窗口内只作**旧读兼容投影**，新 mapper 只写 `semanticBridgeV2`（RFC §10.1 末条） |
| E-2 | `src/lib/history/v3/projection.ts:187` `recordToHistoryEntry`，:388 `pipelineInfo` 取自 `terminalMeta` | ⚠️ **当前 `pipelineInfo` 只经 terminal metadata 落地**，是 terminal-only 路径 |
| E-3 | `src/lib/history/in-flight.ts:54` `putInFlight`，:58 `updateInFlight`；`src/lib/history/entries.ts:33` 发布 `history.entry_updated` | in-flight 是**独立的内存 `HistoryEntry` 映射**，不走 V3 record。RFC §10.1 的 `lifecycle:"in-flight"` variant 要求实时可见 → **C3.2 必须同时接这条路径，只改 V3 terminal 投影不够** |
| E-4 | `src/lib/context/model-operation-record.ts` `setExtension(namespace, value)`（terminal committed 后调用会抛，见 `tests/context/model-operation-record.unit.test.ts:332`） | 建议宿主：semantic bridge 活状态挂 `extensions["translation.semanticBridgeV2"]`，in-flight 与 terminal 两条投影**从同一 extension 派生**，避免两份可独立写入的真相 |

### F. 已存在的 oracle 资产（C0 的起点，不要重造）

| ID | 锚点 | 说明 |
|---|---|---|
| F-1 | `tests/openai/responses-to-anthropic-stream.unit.test.ts:97` `sdkAccumulate` | 已在用**真** `@anthropic-ai/sdk` `Stream.fromSSEResponse`，含 N1 event-line 不变量断言（:78）。C0.1 提取为共享 test-only oracle |
| F-2 | `tests/e2e-client/responses-nodelta.probe.it.test.ts:266` `finalOf` | 已在用**真** OpenAI SDK `client.responses.stream().finalResponse()` 走真实 HTTP（in-process `Bun.serve`），且已有负控：缺 `content_part.added` 的 `.done` 让 SDK 抛 `missing content`（:311、:327）。**这正是 RFC C0 要的红样本，已存在** |
| F-3 | `tests/openai/anthropic-responses-reverse-roundtrip.unit.test.ts` | 现有 carrier round-trip 测试 |
| F-4 | 六个 translator 的 `tests/openai/*.unit.test.ts` | 现状锁定基线 |
| F-5 | `tests/e2e-client/anthropic-sdk.it.test.ts`、`continuation-sdk.it.test.ts`、`precontent-recovery.it.test.ts` | 已覆盖 pre/post-commit retry 与 continuation 的真 SDK 场景，C2.3 authority 测试可复用其 harness |

---

## 任务 DAG

```text
C0.1 ─┬─ C0.2 ─ C0.3 ─┐
      └───────────────┤
                      ▼
              C1.1 → C1.2 → C1.3
                             │
                             ▼
              C2.1 → C2.2 → C2.3
                             │
                             ▼
              C3.1 → C3.2 → C3.3 → C3.4        ← C3.4 = 共享 JSON-value validator
                                    │
       ┌───────┬───────┬────────────┴───────┐
       ▼       ▼       ▼                    ▼
   C4.1/4.2  C5.1/5.2  C6.1/6.2         C7.1/7.2   ← 四组可并行
       └───────┴───────┴────────────────────┘
                      ▼
              C8.0a ∥ C8.0b                       ← wire → ledger ingest mapper（两方向）
                      ▼
               C8.1 ∥ C8.2                        ← ledger → wire emitter（两方向）
                      ▼
                    C8.3                          ← 全 cell shadow parity
                      ▼
                     C9  (A→R 原子 cutover)
                      ▼
                     C10 (R→A 原子 cutover)
                      ▼
              C11.1 → C11.2
```

**串行硬约束**：C1→C2→C3 严格串行（后者消费前者的类型契约）。**C3.4 是 C4–C7 全部四组的共同前置** —— `json-value-validator` 被 C6.1（structured output）与 C7.1（carrier canonical JSON）**共同**消费，RFC §6.1 与 §8.1 都要求「先自建递归 validator 再进 `safe-stable-stringify`」，两处必须是**同一份**实现。C8.0 必须在 C8.1/C8.2 之前（emitter 消费的 ledger 得先有人喂）。C8.3 必须在单一集成态吸收 C4–C7 全部语义。C9→C10 串行，以便每次 cutover 独立证明可达性并可单方向回滚。

**并行边界**：C4–C7 四组彼此独立，可分派不同 implementer；但它们**共改** `src/lib/pipeline/semantic/` 下的 mapper 与 policy 模块 → 需协调合并顺序，建议按 C7 → C5 → C6 → C4 依次合并（**四组都在 C3.4 之后起分支**，此时 validator 已在基线里，不存在「C7 要用 C6 尚未创建的文件」的倒置）。C8.0a 与 C8.0b、C8.1 与 C8.2 均格式独立可并行。

---

## 任务详情

每片的固定字段：**Files / Interfaces / Steps / Commit invariant / Verify / Mutation**。
「Verify」列出的命令是**该片的最小充分集**；交付前另跑 `bun run test:backend`。

`[hard]` **C2.1 起每片的 Verify 都额外包含「G2 wire 字节 golden 逐字节对账」**（改动前后各跑一次），**无论该片的 Verify 段有没有逐字写出**。对账结果（相同／差异）写进该片的进度文件。

这条之所以放在这里而不是只写在 G2 里：**kickoff 是自包含分派的**，实施者读的是自己那一片。凡是给某片写 kickoff 的人，必须把这条抄进该片的验收段 —— 一条只在全局声明一次的规则，对只读自己那一片的执行者等于不存在。

改 History／REST／删代码／把 shadow 塞进生产路径的几片（C3.2、C3.3、C8.3、C11.1）**尤其**不能省：它们改的是生产代码，而其本地测试全绿并不能证明客户端收到的字节没变。

---

### C0.1 —— 共享 SDK oracle harness

**Goal**：把已分散在两处的真实 SDK oracle 提取为共享 test-only 模块，供 C0.2 起全部后续片复用。**纯测试改动，零生产改动。**

**Files**
- Create `tests/helpers/protocol-oracles/anthropic-sdk-oracle.ts` —— 提取 F-1 的 `sdkAccumulate` + `assertEventLineInvariant` + `toWire`
- Create `tests/helpers/protocol-oracles/responses-sdk-oracle.ts` —— 提取 F-2 的 `finalOf` + in-process proxy harness 接线
- Create `tests/helpers/protocol-oracles/index.ts`
- Modify `tests/openai/responses-to-anthropic-stream.unit.test.ts`（改调共享 oracle，断言逐字不变）
- Modify `tests/e2e-client/responses-nodelta.probe.it.test.ts`（同上）

**Interfaces**
- Produces：`accumulateAnthropic(frames): Promise<Message>`、`assertAnthropicEventLineInvariant(frames): void`、`finalResponseOf(sseFrames): Promise<FinalOutput>`。命名以最佳方案为准。

**Steps**
1. 纯移动提取，不改任何断言语义。
2. 两个现有测试改调共享实现。
3. `bun test tests/openai/responses-to-anthropic-stream.unit.test.ts tests/e2e-client/responses-nodelta.probe.it.test.ts` —— **必须逐条仍绿**，这是「纯移动」的证明。

**Commit invariant**：零生产文件改动（`git diff --stat` 只含 `tests/`）；两个既有测试的用例名集合与通过数不变。

**Verify**：`bun run typecheck` + 上述两个测试文件 + `bunx eslint tests/helpers/protocol-oracles/`

**Mutation**：故意在共享 oracle 里跳过 `event:` 行校验 → F-1 的 N1 用例必须变红。若不红说明提取时丢了断言。

---

### C0.2 —— 缺陷语料与现状锁定

**Goal**：为 RFC §1 列出的九类已确认缺陷各建一条 fixture，**在旧码上跑通并显式标注当前是「已知有损」**，作为 C8 之后逐条转绿的对照。

**Files**
- Create `tests/openai/semantic-bridge/known-defects.unit.test.ts`
- Create `tests/openai/semantic-bridge/fixtures/`
- Create `tests/openai/semantic-bridge/client-wire-golden.http.test.ts` —— **G2 的字节基线**

**Interfaces**
- Produces：具名 fixture 导出，供 C1–C8 直接 import；每条附 `expectedAfterMigration` 注释说明目标行为由哪个 commit 兑现。
- Produces：**客户端 wire 字节 golden**（两方向 × stream/non-stream × 有无 retry，至少 6 条）。这是 G2 在 C2.1–C8.3 每片的机械判据，**不是可选项**。

**Steps**
1. 每条缺陷写一个断言，断言**当前（有损）行为**，并在测试名与注释里写明「KNOWN-LOSS，C<N> 后应改为 X」。
2. 九类逐条覆盖，缺一即本片未完成。
3. 同模型 Claude 原样回送那条是 **G4 的守护**，它从现在到 C11 必须一直绿。
4. **锁 G2 的客户端 wire 字节 golden**（见 Interfaces）。

**⚠️ fixture 清单按「旧码可否表达」二分（防结构性 false-red）**

RFC §11 的 C0 清单里有一部分**在旧码上根本无从表达**——例如「child part 开放时提前 finish item／response 的拒绝正控」，它需要 part／item／response 三层 terminal，而那要到 C1.2 才存在。本片是**零生产改动**的片，若把这类断言也塞进来，执行者会撞上一道过不去的门，唯一出路就是弱化或删断言——**那会让整道门失效**。

- **本片只做旧码可表达的**：九类 KNOWN-LOSS、nested parts 与 multi-reasoning 的**现状**、encrypted-only 的**现状**、`.done.arguments` 三类的**现状**、server-tool 四格现状、Scenario A/B 四腿、同模型原样回送、以及 G2 wire golden。
- **需要 C1.2 之后才能表达的**（三层 terminal 的拒绝正控、response terminal provenance 合成）→ **移到 C1.2 的验收**，本片不做。
- **正样本跑出来是红的怎么办**：`[hard]` **不要改断言**。那说明你发现了第十类缺陷 —— 登记进 KNOWN-LOSS 并回报，这是发现不是障碍。

**Commit invariant**：零生产改动；全部新测试在**改动前的旧码**上绿（golden 预捕获，skill `large-refactor` §4）。

**Verify**：`bun test tests/openai/semantic-bridge/` + `bun run test:fast`。**用例集合用运行时枚举冻结**，`[hard]` 不要用 `rg -c 'KNOWN-LOSS'` 当计数判据 —— 注释里写九次同样能满足它，与断言是否存在无关（参数化与模板名也会让 grep 结构性失明）。

**Mutation**（三条，各自指名期望变红的用例）
- **encrypted-only**：翻转 `responses-to-anthropic.ts:210` 的 `if (reasoningText.length > 0)` 条件（改为 `>= 0`）→ encrypted-only 那条 KNOWN-LOSS 变红。⚠️ **不要用「把 `reasoningEncrypted` 改成数组」当这条的 mutation** —— 该字段的基数与 `:210` 这道门无关，改它**不可能**让 encrypted-only 变红（本计划初稿就是这么写的，是错的；而且改成数组会先撞 `buildSyntheticReasoningSignature` 的签名，patch 本身跑不通）。
- **multi-reasoning**：把 `:172` 的覆盖赋值（`reasoningEncrypted = item.encrypted_content`）改为累加 → multi-reasoning 那条 KNOWN-LOSS 变红。
- `[hard]` **wire golden 的灵敏度对照**：改动 production wire 的**一个字节**（例如改 A-3 某个 `event:` 名，或改一个 usage 字段值）→ **至少一条 wire golden 变红**。
  **这条不做，整组 golden 就没有判别力** —— 它是 C2.1–C8.3 十余片 G2 的唯一机械判据，若捕获点取浅（捕在 translator 输出而非真实客户端字节）或归一化过度，后续每一片的对账都是空转，而且不会有任何信号提示你。本条结论记进 C0.3 的 registry。

---

### C0.3 —— mutation registry

**Goal**：把「每个阻断式判据都有 exact mutation，且失败来自目标机制」制度化，避免 C1–C10 每片各自口头声称。

**Files**
- Create `tests/openai/semantic-bridge/mutation-registry.md` —— 表格：判据 ID / 目标机制 / mutation 的精确 patch 描述 / 期望变红的用例 / 已核对失败原因来自目标机制（是/否）
- Create `docs/plan/2026-08-08-semantic-bridge/progress/README.md` —— 进度文件约定（一 agent 一文件，随每个实现 commit 提交）

**Steps**
1. 为 C0.2 的九类 + RFC §12 验收矩阵的十七行各登记一条。
2. 每条写明**如何构造 mutation**（改哪个函数的哪一行，改成什么），不写「注释掉相关代码」这种不可执行描述。
3. 明确记录：mutation 不变红有**三**解 —— 测试没咬住 / mutation 没生效 / fixture 造不出被测状态。排除前两条后先写探针问「这状态真存在吗」，别改断言。

**Commit invariant**：纯文档 + 测试目录，零生产改动。

**Verify**：人工核对 registry 行数 ≥ RFC §12 矩阵行数；`rg -c '^\|' mutation-registry.md` 与矩阵对账。

---

### C1.1 —— ledger 类型契约与 declare/delta reducer

**Goal**：落 RFC §4 的 `ItemKey`/`PartKey`/`SegmentId`/`SemanticItem`/`PartState`/`PerOutputItemState`/`LedgerUpdate`，实现 declare 与 delta 累积。**不接 wire、不写 sink。**

**Files**
- Create `src/lib/pipeline/semantic/types.ts`
- Create `src/lib/pipeline/semantic/ledger.ts`
- Create `tests/pipeline/semantic/ledger-declare.unit.test.ts`

**Interfaces**
- Produces：`createSemanticLedger(): SemanticLedger`，含 `apply(update: LedgerUpdate): void`。类型逐字对齐 RFC §4，**不得自行增删字段**。

**Steps**
1. 类型文件按 RFC §4 落地（RFC 是唯一权威，冲突时改代码不改 RFC）。
2. reducer 实现 declare-item / declare-part / append-part-text / append-arguments / append-result-output。
3. 落 declare 期不变量：每 key 只 declare 一次；part 只能引用已 declare 的 item；`sourceIndex` 同 item／kind 内唯一；kind↔metadata 互斥（call 只允许 `call`、result 只允许 `result`，错配 fail-closed）。
4. 补单测覆盖每条不变量的违反路径。

**Commit invariant**：纯新增模块 + 单测；无任何生产调用者（`rg 'semantic/ledger' src/ | rg -v 'semantic/'` 为空）；typecheck + `test:backend` 全绿。

**Verify**：`bun run typecheck` + `bun test tests/pipeline/semantic/`

**Mutation**：删掉「重复 declare 拒绝」分支 → 对应单测变红。

---

### C1.2 —— 三层 terminal 与拒绝规则

**Goal**：落 part／item／response 三层 terminal 与 RFC §4 的全部拒绝规则。**这是本 RFC 最密集的不变量群，逐条落、逐条测。**

**Files**
- Modify `src/lib/pipeline/semantic/ledger.ts`
- Create `tests/pipeline/semantic/ledger-terminal.unit.test.ts`

**Steps**
1. `finish-part` / `finish-item` / `finish-response`。
2. 逐条落 RFC §4 的 terminal 规则，**清单不得省略**：
   - terminal 后拒绝更新；
   - `finish-item` **不隐式终结 child part**；item terminal 前所有已 declare part 必须已 terminal；
   - `complete` item：非 discarded part 全部 complete、discarded part 须有具名 degradation、**不得含 partial part**；
   - `partial` item：所有开放 part 先以具名 EOF／abort／fallback／continuation／wire-error provenance 终结为 partial，既有 complete／discarded 保持原终态；
   - `discarded` item：所有开放 part 先以同一或派生 reason 终结为 discarded；
   - kind-specific 权威值门：reasoning／text 目标投影 part 已 terminal 且可派生 final visible；call 须有 `CallMetadata` + `authoritativeArguments`；result 须有 `ResultMetadata` + `authoritativeOutput`；drop 永远只能 discarded；**缺权威值时不得用 delta 拼接值冒充 done**；
   - partial provenance 为 `fallback` 必带 `fallbackId`、`continuation` 必带 `continuationId`，其它 provenance 不得带二者；discarded 必带 reason；
   - response terminal 恰一个；`completed` 前不得有开放 item／part 且所有非 discard item 必须 complete；`incomplete`／`failed`／`cancelled` **不得被改写为 `completed`**；缺 wire terminal 时只能由 EOF／abort／driver-cancel provenance 合成对应非成功终态。
3. 每条拒绝路径一条单测。

**Commit invariant**：仍无生产调用者；上述每条规则**都有对应用例**（用例名带规则编号，便于 C0.3 registry 对账）。

**Verify**：`bun run typecheck` + `bun test tests/pipeline/semantic/`

**Mutation**：让 `finish-item` 隐式把开放 part 标 complete → 「item terminal 前 part 必须已 terminal」用例变红。**核对失败信息确实来自该门，而非旁路断言**。

---

### C1.3 —— immutable snapshot、fork 与 property tests

**Goal**：落 `LedgerSnapshot`／`LedgerTransition`／`fork()`，并用 property test 覆盖 RFC §12 中「多 reasoning 不串槽」「authoritative done」两行。

**Files**
- Modify `src/lib/pipeline/semantic/ledger.ts`
- Create `src/lib/pipeline/semantic/snapshot.ts`
- Create `tests/pipeline/semantic/ledger-property.unit.test.ts`

**Interfaces**
- Produces：`snapshot(): LedgerSnapshot`（immutable，结构共享）、`fork(): SemanticLedger`（写时隔离）、有序 `LedgerTransition` 流供 C8.1/C8.2 消费。

**Steps**
1. 结构共享 immutable snapshot；fork 后互不影响。
2. Property：任意交错的多 reasoning item declare/delta/done 序列，各 item 的 visible 与 opaque 永不互串。
3. Property：**authoritative done 的三类载体** —— RFC §4 要求 part **text**、**arguments**、**result output** 三者都遵守「`.done` 为权威值、delta/done 冲突产生 observation」。对三者各跑三种输入（无 delta／有 delta 且与 done 一致／delta 与 done 冲突），断言最终 snapshot **一律取 authoritative value**。冲突 observation 的**实际生成**由 C3.1 承接（observation 类型那时才存在），本片**为三类各留结构位**，不要自己发明 observation 类型，**也不要只留 arguments 一类** —— 另两类没有其它片承接。
4. 复杂度守护：O(events + items)，ledger 内存 request/candidate-local。**「模块级不残留引用」的可执行手法**：用 `FinalizationRegistry` 或显式断言模块级容器在生命周期结束后 size 为 0，不要写成无法执行的描述。

**Commit invariant**：仍无生产调用者；fork 隔离性有正负控。

**Verify**：`bun run typecheck` + `bun test tests/pipeline/semantic/` 连跑 10 次确认确定性。**property test 用随机序列时必须固定种子并把种子写进用例名** —— 否则偶发红会被当成 flaky 而降门（false-red 会让整道门失效）。

**Mutation**（两条）
- 让 fork 共享可变 Map → 隔离性用例变红；
- 让 part **text** 的 `.done` 不覆盖 delta 拼接值 → 三类载体那条 property 变红（证明它真的覆盖了 arguments 之外的载体）。

---

### C2.1 —— ingress config snapshot

**Goal**：在任何 route／candidate 分叉前捕获一次 `TranslationConfigSnapshot`，identity 冻结到 `RequestEnvelope`。

**Files**
- Create `src/lib/pipeline/semantic/config-snapshot.ts`
- Modify `src/lib/pipeline/envelope.ts`（新增 `readonly translationConfigSnapshot?`，随 `requestState` 一样走 request-lifecycle-STABLE 语义，**不进 `with()` 的 patch 集**）
- Modify inbound codec 的 `parse`（与 `requestState` 同一捕获点）
- Create `tests/pipeline/semantic/config-snapshot.unit.test.ts`

**Steps**
1. snapshot 含 `snapshotId` + 冻结的 `model_translation` 视图。
2. 接线：ingress 捕获一次，后代 candidate 只读。
3. 热重载测试：ingress 后改配置，**在飞请求的 snapshot 不变**，下一次 ingress 才变。

**Commit invariant**：snapshot 仅被捕获与读取，无消费者改变行为；既有 config 热重载测试全绿；G2 wire golden 逐字节不变。

**Verify**：`bun run typecheck` + `bun test tests/pipeline/semantic/ tests/config/` + G2 wire golden 对账

**正控（不只防 false-green）**：**retry／fallback 腿之后 `snapshotId` 必须不变**。`translationConfigSnapshot` 按引用透传、不进 `with()` 的 patch 集，所以 `with()` 若漏保留它，热重载隔离用例**照样绿**——那条 mutation 抓不到这个失效。补一条：走一次 retry，断言前后 `snapshotId` 相等。

**Mutation**（两条）
- 让后代 candidate 重读热配置 → 热重载隔离用例变红；
- 让 `envelope.with()` 丢掉 `translationConfigSnapshot` → 上述 retry 正控变红。

---

### C2.2 —— candidate lineage 与 policy resolver

**Goal**：落 `CandidateTranslationLineage` 与 `PairTranslationPolicy` 解析（RFC §6）。

**Files**
- Create `src/lib/pipeline/semantic/policy-resolver.ts`
- Create `src/lib/pipeline/semantic/lineage.ts`
- Modify `src/lib/pipeline/generation/coordinator.ts`（C-4 三点，只**新增** lineage 记录，不改变现有 settle 语义）
- Create `tests/pipeline/semantic/lineage.unit.test.ts`

**Steps**
1. 每 candidate 在 final route 确定后，从**同一** ingress snapshot 按完整 source／target `ModelIdentity` 解析一次 policy。
2. candidate 改 route → 新 candidate／dispatch／segment／policy，**祖先 policy 不变**。
3. 在 C-4 的三个点建立 segment：`runRecovery`（fallback 性质）与 `runContinuation`（continuation 性质）**分别处理，不共用函数**；`raceReadyCandidates` 只做权威判定，不新建 segment。
4. 未命中 rule 时用 RFC §6.2 的全局安全默认（unknown carrier `reject`、structured output `strict`、context management `reject`）。
5. **boundary 状态机不变量（RFC §3.4，本片是唯一 owner）** —— C2.3 只管 authority phase 与 transfer，这组是**另一件事**，逐条落且逐条测：
   - 同一 kind／ID **只能声明一次**；
   - **fallback 与 continuation 是不同 kind，不共用 ID 命名空间**；
   - 嵌套／多跳边界按**到达顺序形成 segments**；`[hard]` **不得使用单个全局「当前 fallback／continuation」布尔值**，也不得靠模型名变化猜边界；
   - boundary 到达前已 declare 的 item 标为对应 ID 的 `pre`，之后新 item 标为同 ID 的 `post`；**已有 item 的 source／provenance 永不改写**；
   - fallback boundary **冻结新的 target route/policy**；continuation boundary 从同一 ingress snapshot 按其实际 route 解析后代 policy，**即使 source identity 相同也创建新 candidate／ledger segment**；旧 segment 不被新 emitter 重新解释；
   - 回送历史时**每个 item 独立执行** `carrierAction`（C7.2）；segment boundary 只是 audit 边界，**不替代 per-item provenance**。

**Commit invariant**：lineage 只被记录不被消费；现有 retry／hedge／continuation 行为**逐字节**不变（G2 wire golden 对账 —— 既有 e2e 全绿只证明没人断言到差异，证不了字节不变）。

**Verify**：`bun run typecheck` + `bun test tests/pipeline/ tests/e2e-client/continuation-sdk.it.test.ts tests/e2e-client/precontent-recovery.it.test.ts` + G2 wire golden 对账

**Mutation**（三条）
- 让 continuation 复用 recovery 的 segment 构造 → 「continuation 继承父 ledger、recovery 不继承」用例变红；
- 让 fallback 与 continuation 共用一个 ID 命名空间 → 第 5 条对应用例变红；
- 把多跳边界实现成单个全局布尔值 → 嵌套边界形成有序 segments 的用例变红。

---

### C2.3 —— delivery authority 与原子 transfer

**Goal**：落 `DeliveryAuthorityState` 与 RFC §6 的唯一 writer 不变量。**本片是整个 RFC 最容易做错的一片。**

**Files**
- Modify `src/lib/pipeline/delivery/session.ts`（**流式四条写出路径全覆盖**，见 C-1/C-2）
- Modify `src/routes/messages/handler-v4.ts` 与 `src/routes/responses/handler-v4.ts`（**② 非流式 authority 落点，共四处**：messages `:1377`／`:1344`、responses `:269`／`:534`）
- Modify `src/routes/messages/error-shaping-glue.ts`、`src/lib/anthropic/warmup.ts`（**③ 自持 `streamSSE`**）
- Modify `src/routes/responses/ws.ts`（**④ 直接 `ws.send`**：`:167`／`:614`／`:686`）
- Modify `src/lib/error/forward.ts`（**⑤ 共享错误出口 `forwardError`**，模型路由分支）
- Modify `src/lib/pipeline/types.ts`（C-3 `GenerationWireState` 新增 authority 字段）
- Modify `src/lib/pipeline/semantic/lineage.ts`
- Create `tests/pipeline/semantic/delivery-authority.it.test.ts`（**三类各一组**）
- Create `tests/architecture/delivery-writer-set.unit.test.ts`（冻结 `writeToSink` 调用方，**仅覆盖 ①**）
- Create `tests/architecture/client-byte-origins.unit.test.ts`（**冻结 `streamSSE(`／`c.json(` 调用点集合，覆盖 ②③ 并抓第四类**）

**Step 0（前置，不得跳过）：先读作用域，别急着枚举**

`[hard]` **先读锚点表的「C-0 附：authority 的作用域，以及为什么不要枚举写出点」。** 本计划在这里连错四轮，四次都是把 candidate 级不变量当成写出点级全称，于是补一份永远补不完的清单。**你不要继承任何一版旧表述。**

**核心**：authority **在 ingress 按请求建立一次**，请求内的写出**由构造继承**它。「至多一个 active」是 **candidate 之间**的性质，由 lineage 与 transfer 临界区保证，**与写出点数量无关**。

写出点清单只用来回答一个窄问题：**哪几处负责记录 terminal wire 的 ACK／delivery failure**。C-0 附表列了已知的五类，**该表不自称穷尽**；开工时自己复扫一遍并把结果写进进度文件，**用与表格不同的思路扫**（别只复跑表里给的命令——那会复现同一个盲点）。

**Steps**
1. **authority 在请求作用域建立**：ingress 一次，归属由 C2.2 的 lineage 管。**不要在每个写出点各插一道检查** —— 那正是前四轮的错路。
2. **terminal 记录点**：按 C-0 附表的五类，在承载模型响应／终态错误的写出处记录 terminal wire ACK 或 delivery failure。本 RFC 两方向优先级：① 的 `writeToSink` 四路径、② 的 messages／responses、③ 的 `error-shaping-glue`、④ 的 `ws.ts:167`、⑤ 的 `forwardError`（模型路由分支）。cc／gemini 与管理端点见 C-0 的作用域声明。
3. `[hard]` **两条既有路径与不变量 5 的矛盾必须先处理**：③ 的 `error-shaping-glue` 与 ④ 的 `ws.ts:167` 都是**无 authority 的 writer 在发错误帧**。给它们接上请求 authority，或显式裁决豁免并写明理由与 History 后果。**不得假装不变量已经成立。**
4. **两条守卫**，`[hard]` **断言消息必须写明各自冻结什么、以及「本守卫不证明客户端写出集合已穷尽」**：
   - `delivery-writer-set.unit.test.ts` —— 冻结 `writeToSink` 四调用方，**只覆盖 ①**；
   - `client-byte-origins.unit.test.ts` —— 冻结**模型路由**下的写出原语集合（`streamSSE(`／`writeSSE(`／`c.json(`／`c.body(`／`ws.send(`／`forwardError(`）**及其调用点**，且**出现未登记的新原语时也 fail**。
5. 落下面「要落的不变量」十七条。
3. 初始 commit：首次不可逆客户端 emission 建立 `active(epoch=0)`。
4. 两类无内容帧终态也必须建立唯一 authority：**preflight fail-closed**（driver 接受 typed rejection 时建 `active(0)`、冻结 `failed/preflight-reject`、由该 authority 发错误 wire 并等 sink 结果后转 terminal）与 **contentless success**（同样先建 active、发完并确认 terminal wire 后转 terminal）。
5. post-commit transfer：祖先先把开放 part／item 按真实 provenance 终结为 partial → 按目标协议顺序发送并确认全部 closing wire effects → 在**同一临界动作**内把祖先改 `transferred(epoch=N,toCandidateId)`、后代改 `active(epoch=N+1)`。准备／ACK／校验任一失败都不发布 transfer，authority 仍归祖先。
6. pre-commit fallback `partialOutputKept:true` 的**两支且只有两支**：①旧 segment 有可发 wire effect → 旧 candidate 先建 epoch 0、flush+ACK、再 transfer 给 epoch 1；②旧 segment 无任何可发 wire effect → 旧 candidate discard，fallback candidate 首写时直接建 epoch 0，**不产生 transferred ancestor 也不产生 `wirePartialDelivery`**。具名 normalized observation 归属新 candidate。
7. hedge losers 一律 `discarded`，不写客户端／WARN／History actual／业务指标。
8. `authorityPhase` 由 driver 据锁内事实派生，**不接受 wire 自报**；陈旧或矛盾值须据锁内事实重构，重构不了则 fail-closed。
9. **导出接线坐标供 C3.1 消费**：把「当前 candidate 的 authority 状态」暴露为一个**具名导出**（如 `readDeliveryAuthority(...)`），C3.1 的 observation 晋级**必须 import 它**。这样接力靠**编译错**保证，不靠进度文件散文——见下方交接说明。

**Commit invariant**：production writer 行为**逐字节**不变（G2 wire golden 对账，不是靠 `test:backend` 沉默）；**任一时刻至多一个 active authority** 有确定性中点探针证明；写出路径集合守卫绿。

**Verify**：`bun run typecheck` + `bun test tests/pipeline/semantic/delivery-authority.it.test.ts` 连跑 25 次 + `bun test tests/architecture/delivery-writer-set.unit.test.ts` + `bun run test:backend` + G2 wire golden 逐字节对账

**Mutation**（六条，逐条核对失败来自目标机制）
- 让 transfer 在 closing ACK 前发布 → 中点探针断言「恰一个 active」变红；
- 让 preflight reject 不建 authority → 该终态的 lineage 用例变红；
- 让 pre-commit 空 segment 也产生 transferred ancestor → 分支②用例变红；
- 让 flush 失败仍 transfer → 分支①失败支用例变红；
- **让主路径 `write()`（`:165`）不带 epoch** → 普通流式请求的 authority 用例变红。**这条是四条旧 mutation 全都漏掉的那个失效**，缺它则「epoch 只挂在 allocation 路径」这个错误实现可以全绿通过；
- **让 `publish-recovery-batch`（`:492`，空 commit 回调）那条路径不带 epoch** → 以 `onBeforeRecoveryBatchCommit` hook 为中点探针的正控变红。

**正控（不只防 false-green）** —— `active` 数为 0 时「至多一个」同样成立，所以唯一性断言**必须**配存在性正控。按**请求形态**取样（不是按写出点逐个测）：
- **流式请求**：首帧写出后存在**恰一个** `active`；恢复批次发布后同样。
- **非流式请求**：响应返回前存在**恰一个** `active`，返回后转 `terminal`。**至少覆盖 messages 与 responses 两个路由** —— 只测一个，另一方向的洞照样全绿。
- **WS 请求**：`responses/ws.ts` 腿同样。
- **终态错误请求**：③④⑤ 三类各取一个代表，错误 wire 写出前存在**恰一个** `active`，或已显式裁决豁免且该裁决本身被断言。

**Mutation**（九条，逐条核对失败来自目标机制）
- 让 transfer 在 closing ACK 前发布 → 中点探针断言「恰一个 active」变红；
- 让 preflight reject 不建 authority → 该终态的 lineage 用例变红；
- 让 pre-commit 空 segment 也产生 transferred ancestor → 分支②用例变红；
- 让 flush 失败仍 transfer → 分支①失败支用例变红；
- **让 ① 的主路径 `write()`（`:165`）不记 terminal ACK** → ① 的 terminal 记录用例变红；
- **让 `publish-recovery-batch`（`:492`，空 commit 回调）那条路径不记** → 以 `onBeforeRecoveryBatchCommit` 为探针的正控变红；
- `[hard]` **让某个非 messages 路由（如 `responses:269`）的非流式请求不建 authority** → 该路由的存在性正控变红。**必须打非 messages 路由**；
- `[hard]` **让 ③ 或 ④ 的错误腿不建 authority** → 终态错误的存在性正控变红；
- **临时引入一个未登记的写出原语**（如在模型路由里加一处 `c.text(`）→ `client-byte-origins` 守卫变红。
  **这条验证的是「守卫对新原语而非仅新调用点报警」** —— 前四轮的失效正是守卫只盯已知项。

---

### C3.1 —— typed observation 与 stage 晋级

**Goal**：落 `TranslationObservation` 与 proposed → authority-committed → sink-emitted 三态。

**Files**
- Create `src/lib/pipeline/semantic/observation.ts`
- Modify `src/lib/context/request.ts`（C-7 请求级聚合与 terminal 记录接点）
- Create `tests/pipeline/semantic/observation-stage.unit.test.ts`

**Interfaces**
- Consumes：`[hard]` **C2.3 导出的 authority 读取接口**（如 `readDeliveryAuthority`）。晋级判定**必须 import 它**，不得自行从 `request.ts` 另找一处 authority 近似物 —— 这样「两片接在同一处」由**编译错**保证，而不是靠 C2.3 的进度文件散文交代。若该导出不存在，说明 C2.3 未完成第 9 步，**停下回报，不要绕开**。

**Steps**
1. `observationId` 请求内唯一；每 ID 任一时刻**只有一个当前 stage**；晋级是原子状态替换，**不是追加第二份副本**。
2. mapper 只产 `proposed`，不自称 authority 或 sink 效果。
3. driver 接受 update 时读 candidate 当前 authority：未获权／已 discarded 保持 proposed；`active(N)` 的写为 `authority-committed` 并带 `authorityEpoch:N`。
4. 初始 commit 把该 candidate 此前所有 proposed **原子晋级**为 committed(epoch 0)；后续 transfer 只让新 candidate 的新 observation 用新 epoch，**不重复晋级祖先记录**。
5. `effect:"semantic"` 到 committed 即终态；`effect:"wire"` 须 sink ACK 同一 observationId 才晋级 sink-emitted，wire 失败保留 committed 但不产生 emitted。
6. 请求级 WARN 聚合：同 reason／quadrant／stage 聚合，日志至多一条；错误用稳定 code，**不得让 retry／客户端逻辑解析英文 message**。
7. **delta/done 冲突 observation 的 producer 在此落地**（RFC §4 要求 part text、arguments、result output **三者**的冲突都产生 observation）。C1.3 只为 arguments 留了结构位；本片补齐三类的实际生成，并各配一条 mutation。**不要只做 arguments 那一类** —— 另两类没有任何其它片承接。

**Commit invariant**：observation 只记录不改变任何 wire 行为（G2 wire golden 对账）。

**Verify**：`bun run typecheck` + `bun test tests/pipeline/semantic/` + G2 wire golden 对账

**Mutation**（四条）
- 让晋级变成追加副本 → 「每 ID 单一当前 stage」用例变红；
- 让 `effect:"wire"` 在 sink 失败时也晋级 `sink-emitted` → 第 5 条用例变红；
- 让 part **text** 的 delta/done 冲突不产生 observation → 第 7 条对应用例变红；
- 让 **result output** 的 delta/done 冲突不产生 observation → 同上。

---

### C3.2 —— History V3 类型与双路径投影

**Goal**：落 `SemanticBridgeHistoryV2`（RFC §10.1），**同时接 in-flight 与 terminal 两条投影**。

**Files**
- Modify `src/lib/history/types.ts`（E-1 新增 `translation.semanticBridgeV2`，旧 `anthropicToResponses` 保留为旧读兼容）
- Modify `src/lib/context/types.ts`
- Modify `src/lib/history/v3/projection.ts`（E-2）
- Modify in-flight 路径（E-3）
- Create `tests/history/v3/semantic-bridge-projection.it.test.ts`

**Steps**
1. 类型逐字对齐 RFC §10.1，含 `lifecycle` 判别联合、非空 tuple `authorityLineage`、`SegmentDeliverySummary`、`CandidateDiagnosticsProjection`。
2. **单一真相源**：活状态挂 `ModelOperationRecorder.setExtension("translation.semanticBridgeV2", …)`（E-4），in-flight 与 terminal 两条投影**都从该 extension 派生**，不各存一份。
3. in-flight：每次 authority／observation 推进后更新 in-flight entry 并发 `entry_updated`（E-3）。`lifecycle:"in-flight"` 时 `authorityLineage` 为空表示尚未建立 authority。
4. terminal：`lifecycle:"terminal"` 时 tuple 类型保证 terminal leaf 存在。
5. opaque hash 固定 `SHA-256("semantic-bridge-opaque-v2\0" || kind || "\0" || rawOpaqueUtf8Bytes)` lowercase hex；**不存正文**（G8）。
6. `candidateDiagnostics` 不可省略：`captured` 要求 `total === candidates.length`；`pruned` 要求 `total > retained` 且 `retained === candidates.length`。
7. 旧记录无 `semanticBridgeV2` 按 unknown capability 处理，**不回填虚构默认**。

**Commit invariant**：新槽只写不读（除测试）；旧 `anthropicToResponses` 读者行为不变；G8 有守护测试。

**Verify**：`bun run typecheck` + `bun test tests/history/` + `bun run test:backend` + **G2 wire 字节 golden 逐字节对账**（本片改 History 生产代码，本地测试全绿证不了客户端字节没变）

**Mutation**（两条）
- 让 History 写入 opaque 正文 → G8 守护变红；
- 只更新 terminal 投影不更新 in-flight → in-flight 可见性用例变红（**这条专防「只改 V3 projection 就以为接完了」**）。

---

### C3.3 —— REST／WebSocket readback 与文档同步

**Goal**：公开契约在 cutover **之前**就位（RFC §10.1 明确禁止把它拖到 C11）。

**Files**
- Modify History REST route（`GET /history/api/entries/:id` 返回该投影）
- Modify History WebSocket 完整 entry 事件
- Modify list／summary 端点（只暴露 `semanticBridgeVersion`、actual disposition 计数、是否有 degradation，**不复制大数组**）
- Modify `docs/history.md`、`docs/API.md`
- Create `tests/history/semantic-bridge-readback.http.test.ts`

**Steps**
1. REST readback 端到端：写入 → `GET /history/api/entries/:id` → 逐字段核对。
2. WS 完整 entry 沿同一 `HistoryEntry` shape。
3. 列表端点只出计数，不出大数组（有断言守护）。
4. 文档同步：`docs/API.md` 补该投影字段；`docs/history.md` 补 lifecycle 与 lineage 语义。

**Commit invariant**：REST／WS 既有契约无破坏（既有 History 测试全绿）；文档与实现同 commit 落地。

**Verify**：`bun run typecheck` + `bun test tests/history/` + `rg -n 'semanticBridgeV2' docs/API.md docs/history.md`（非空）+ **G2 wire 字节 golden 逐字节对账**（本片改 REST／WS 生产代码）

**Mutation**：让 list 端点也返回 `actual` 全数组 → 「列表不复制大数组」用例变红。

---

### C3.4 —— 共享 JSON-value validator

**Goal**：落一份**唯一的**递归 JSON-value validator，供 C6.1（structured output schema 序列化）与 C7.1（carrier canonical JSON）共同消费。

**为什么单列一片、且必须在 C4–C7 分叉之前**：RFC §6.1 与 §8.1 **各自**要求「先用共享 JSON-value validator 拒绝非法值，再调用 `safe-stable-stringify@2.5.0`」。若让 C6.1 创建、C7.1 复用，则 C7 组从 C3 拉分支时该文件尚不存在——要么 typecheck 不绿（违反 G1），要么自造第二份，而**两份 validator 必然漂移**，且 C7.1 的 mutation 只测 prefix↔kind、抓不到这种分叉。前移为共同前置是唯一能同时满足两条 RFC 要求的排法。

**Files**
- Create `src/lib/pipeline/semantic/json-value-validator.ts`
- Create `tests/pipeline/semantic/json-value-validator.unit.test.ts`

**Interfaces**
- Produces：`assertPlainJsonValue(value: unknown): asserts value is JsonValue`（fail-closed，抛 typed error）。C6.1 与 C7.1 **都 import 这一个**。

**Steps**
1. 递归校验：遇 **bigint、function、symbol、undefined、cycle、非有限数字（Infinity/-Infinity/NaN）** 一律 fail-closed。
2. **不得依赖 `safe-stable-stringify` 自行拒绝** —— 实测它把 Infinity/NaN 变 `null`、省略 `undefined`、bigint 数值化、cycle 写成 `"[Circular]"`，全部是**静默有损**。
3. 六类非法输入逐条正控。
4. 加一条**唯一性结构守卫**：全仓只允许存在一处 JSON-value 校验实现（冻结命中集合），防止 C6/C7 各造一份。

**Commit invariant**：纯新增，无生产调用者；六类非法输入逐条有正控；唯一性守卫存在。

**Verify**：`bun run typecheck` + `bun test tests/pipeline/semantic/json-value-validator.unit.test.ts`

**Mutation**：去掉 cycle 检测直接调库 → cycle 用例变红（且核对失败信息指向 validator，不是库的 `"[Circular]"` 输出）。

---

### C4.1 —— ordered-turn model 与 A→R 保序

**Goal**：落 RFC §5 的 `TurnToken`／`NormalizationOutcome`，修 A-1 的 `unshift` 重排。

**Files**
- Create `src/lib/pipeline/semantic/ordered-turn.ts`
- Create `tests/pipeline/semantic/ordered-turn-forward.unit.test.ts`

**Steps**
1. 默认保持 source ordinal。
2. 只有目标协议**明确硬约束**允许重排，每次重排必须有具名规则 + observation + 正确样本 + mutation。
3. **不得从「thinking first」推导 text/tool 可任意重排**（RFC §5 明文）。
4. 用 transducer property 测双向顺序。

**Commit invariant**：新模块无生产调用者；A-1 现有行为不动（C9 才切）。

**Verify**：`bun run typecheck` + `bun test tests/pipeline/semantic/`

**Mutation**：去掉具名重排规则校验、允许无理由重排 → 保序 property 变红。

---

### C4.2 —— R→A 保序

**Goal**：同上，覆盖 A-4 的 `foldInputItems` 三槽位重组。

**Files**
- Modify `src/lib/pipeline/semantic/ordered-turn.ts`
- Create `tests/pipeline/semantic/ordered-turn-reverse.unit.test.ts`

**Steps**：同 C4.1，方向对称。注意 R→A 的 system／developer 降级为 user 是既有行为，需在 mapper 里保留为具名 normalization + observation，不再静默。

**Commit invariant / Verify / Mutation**：同 C4.1 结构。

---

### C5.1 —— server-tool history 两格

**Goal**：RFC §7 表格前两行 —— history assistant use、history user result。

**Files**
- Create `src/lib/pipeline/semantic/server-tool.ts`
- Create `tests/pipeline/semantic/server-tool-history.unit.test.ts`

**Steps**
1. history use：可表达时保留为 native／function；否则降级为**带 correlation ID 的 text**。
2. history result：保留 result／error 与 correlation ID；不可表达时 text。
3. **红线**：永不合成 Anthropic `web_search_tool_result`（无法伪造上游签名内容）。加一条守护测试断言输出中永不出现该 block 类型。

**Commit invariant**：无生产调用者；红线守护测试存在。

**Verify**：`bun run typecheck` + `bun test tests/pipeline/semantic/`

**Mutation**：让降级路径合成 `web_search_tool_result` → 红线守护变红。

---

### C5.2 —— server-tool live 两格

**Goal**：live streaming 与 live non-stream **同一 semantic disposition、独立 wire lifecycle**。

**Files**
- Modify `src/lib/pipeline/semantic/server-tool.ts`
- Create `tests/pipeline/semantic/server-tool-live.unit.test.ts`

**Steps**
1. 两格从同一 mapper 判定得出 disposition。
2. parity 测试断言两格 disposition 相同、wire 形态不同。

**Commit invariant / Verify**：同 C5.1。

**Mutation**：让 live-stream 与 live-nonstream 各判一次 disposition 且给出不同结果 → parity 用例变红。

---

### C6.1 —— structured output policy

**Goal**：RFC §8 —— canonical schema hash + 可配置降级。

**Files**
- Create `src/lib/pipeline/semantic/structured-output.ts`
- Create `tests/pipeline/semantic/structured-output.unit.test.ts`

**Interfaces**
- Consumes：**C3.4 的 `assertPlainJsonValue`**（不得自建第二份 validator）。

**Steps**
1. **先** 调 C3.4 的 validator 拒 bigint／function／symbol／undefined／cycle／非有限数字，**再**调 `safe-stable-stringify@2.5.0`。**不得依赖库自行拒绝**——实测它把 Infinity/NaN 变 `null`、省略 `undefined`、bigint 数值化、cycle 写成 `"[Circular]"`。
2. hash：canonical UTF-8 bytes 的 SHA-256 前 32 位 lowercase hex；name 固定 `json_schema_<32hex>`（总长 44）。**hash 只提供稳定命名／诊断关联，不替代 schema 内容校验**。
3. strict mode 两向按 RFC §8.1；验证基于**完整 schema 而非 hash**，失败返回 translation error，**不删除 keyword**。
4. allow-unconstrained：`strict:false`／省略 strict／`json_object` 默认 fail-closed；显式配置才可删约束继续，每请求至多一条 WARN，History 记录原格式类型／丢失字段／原因，**不声称 structured output 仍生效**。

**Commit invariant**：无生产调用者；**未新建第二份 validator**（C3.4 的唯一性守卫仍绿）。

**Verify**：`bun run typecheck` + `bun test tests/pipeline/semantic/` + G2 wire golden 对账

**Mutation**：让 `structured-output.ts` **绕过** C3.4 的 validator 直接调 `safe-stable-stringify` → Infinity／cycle／bigint 三类用例变红（核对失败来自 validator 缺位，而非库的有损输出恰好不等值）。

---

### C6.2 —— context-management policy 与配置 schema v2

**Goal**：RFC §9 + §6.2 —— per-pair 配置化降级，且非法 rule **原子失败**。

**Files**
- Create `src/lib/pipeline/semantic/context-management.ts`
- Modify `src/lib/config/schema.ts`（D-1；新增 `policy` 段，**走 rule-level 原子失败而非 D-5 的剥叶子**）
- Modify `packages/foundation/src/state-vocabulary.ts`（D-3，与 D-2 lockstep）
- Modify `src/lib/config/model-translation.ts`（D-4，旧 `features` 迁移为 `policy.carrier_unknown`）
- Regenerate `config.schema.json`（`scripts/generate-config-json-schema.ts`）+ `config.example.yaml`
- Create `tests/config/model-translation-v2.unit.test.ts`

**Steps**
1. `reject`（默认）／`warn-drop`／`threshold-only` 三态；`threshold-only` 必须**整体原子命中** RFC §9 表格的唯一支持子集，混合或未知策略 reject，**不部分映射**。
2. 缺省 threshold **不猜**（Responses 未公开默认值；Anthropic 的 150000 默认不得借用）。
3. 配置 v2：未知字段／非法 mode／互斥冲突／新旧同时声明 → typed diagnostic + **整条 rule 不进运行态**。服务器继续用其余有效 rule（warn-continue 保留在文件层），但**失效 rule 不得静默回落成看似命中的默认 policy**；只匹配失效 rule 的请求返回稳定 typed config error。
4. 旧 `features:["strip-thinking-signature"]` 作输入兼容别名迁移，发一次弃用警告；同 rule 同时声明新旧 = rule-level 冲突，整条失效。
5. `top_k`／stop sequences／cache control 的 capability table 一并落。
6. **响应侧与触发后语义（RFC §9 末段，本片是唯一 owner）** —— 前五步只覆盖**请求配置**，RFC 还要求：
   - 两端的返回状态载体**不等价**：Anthropic 返回可读 `compaction` block 并可能以 `stop_reason:"compaction"` 暂停；Responses 返回**必须回送的 opaque encrypted compaction item**。`[hard]` **threshold-only 不转换这些 carrier**；
   - **一旦实际触发，必须产生 degradation**，`[hard]` **不得宣称跨轮透明连续**；
   - Anthropic 的 `instructions`／`pause_after_compaction:true` 无 Responses 等价；`clear_tool_uses`／`clear_thinking` 也无等价物，**不能伪装成 compaction**，只能 reject 或显式 warn-drop；
   - 暂不实现私有 compaction carrier（RFC §15 本轮不采用）。

**Commit invariant**：D-2 的双向 `AssertAssignable` 仍编译通过（改一边不改另一边必须报错）；`config.schema.json` 与 `.describe()` 同 commit 重生成（注意：该文件由 `.describe()` 生成，改 TSDoc 是 no-op）。

**Verify**：`bun run typecheck` + `bun test tests/config/` + G2 wire golden 对账。
**schema 对账的 false-red 提醒**：`git diff --exit-code config.schema.json` 在**共享工作树**里会被并发会话的改动打成假红。判据改为：重生成后**只比较你这次改动涉及的 JSON 指针**（如 `model_translation` 子树），或先确认该文件当前无 peer 改动再整文件比。**不要因为一次假红就删掉这条门。**

**Mutation**（四条）
- 让非法 v2 rule 走 D-5 的剥叶子路径 → 「整条 rule 失效」用例变红；
- 让只匹配失效 rule 的请求回落全局默认 → 「返回 typed config error」用例变红；
- **让 threshold-only 在实际触发后不产生 degradation** → 第 6 条对应用例变红；
- **让 `clear_tool_uses` 被映射成 compaction** → 「无等价物只能 reject／warn-drop」用例变红。

---

### C7.1 —— carrier v2 编解码

**Goal**：RFC §6.1 wire grammar 与 strict decoder。

**Files**
- Create `src/lib/pipeline/semantic/carrier-v2.ts`
- Create `tests/pipeline/semantic/carrier-v2.unit.test.ts`

**Steps**
1. 两前缀分离：`copilot-api:claude-signature:v2:` 与 `copilot-api:synthetic-reasoning:v2:`。
2. 编码：复用 **C3.4 的** `assertPlainJsonValue` → `safe-stable-stringify` → 无 padding base64url。**不得自建第二份 validator**（C3.4 唯一性守卫会咬）。
3. 解码：先校验字符集与长度 → schema 验证 → canonical stringify + base64url re-encode → **必须与原 payload 字节相等**。
4. **联合校验** prefix ↔ `kind` ↔ `source.protocol`：`claude-signature` 只允许 Claude 前缀 + Anthropic 来源；`responses-encrypted` 只允许 synthetic-reasoning 前缀 + Responses 来源。任一不一致 fail-closed，**不按 opaque 内容猜 kind**。
5. `boundary.partial` 只是父 item terminal 的序列化投影，**无独立 setter**；decoder 据它恢复统一 item terminal，不建 reasoning 专属第二状态源。
6. v1 decoder 永久保留到独立迁移决策。

**Commit invariant**：无生产调用者；round-trip 字节相等有 property test。

**Verify**：`bun run typecheck` + `bun test tests/pipeline/semantic/ tests/openai/anthropic-responses-reverse-roundtrip.unit.test.ts`

**Mutation**：去掉 prefix↔kind 联合校验 → 交叉前缀用例变红。

---

### C7.2 —— provenance 与 carrierAction

**Goal**：RFC §6 的逐块 `carrierAction`。

**Files**
- Modify `src/lib/pipeline/semantic/carrier-v2.ts`
- Modify `src/lib/pipeline/semantic/policy-resolver.ts`
- Create `tests/pipeline/semantic/carrier-action.unit.test.ts`

**Steps**
1. v2 carrier 有完整 source identity：**protocol／provider／resolved model 三者全匹配才 preserve**；任一维不同都 strip opaque、**保留 visible**。
2. v1／external／unknown → `carrierFallback`；未知 provenance 且无明确 fallback → 稳定诊断错误，**不猜**。
3. **不维护 session-last-model**（RFC §15 已否决）。
4. `source.model` 是 final resolved model ID，不是客户端 alias。
5. 同模型原生 Claude assistant content **不包装成 v2 再回送**（G4）。
6. **`visible.kind:"redacted"` 的跨协议契约（RFC §3.3 不变量 4，policy 侧 owner）**：源侧 redacted 时，目标协议**能表达 redacted 就表达、不能表达就记 typed degradation**，`[hard]` **任何情况下都不得伪造明文**。注意这与 G4 是**两件不同的事**：G4 守的是「同模型原生 `redacted_thinking` 原样回送」（旁路，不经 envelope）；本条守的是「**跨模型／跨协议**时 redacted 怎么投影」。C0.2 与 G4 只覆盖前者，后者在此落地。
7. Scenario A/B 混合来源 History 覆盖。

**Commit invariant**：G4 守护测试（C0.2 那条）仍绿；跨协议 redacted 有独立正负控。

**Verify**：`bun run typecheck` + `bun test tests/pipeline/semantic/ tests/openai/` + G2 wire golden 对账

**Mutation**（三条）
- 让 provider 不同也 preserve → 三维匹配用例变红；
- 让 provenance 不匹配时连 visible 一起丢 → 「只剥 opaque」用例变红；
- **让跨协议 redacted 合成一段可读明文** → 第 6 条的负控变红。

---

### C8.0a —— Responses wire → ledger ingest mapper

**Goal**：把 Responses 协议的 raw response 事件与 non-stream payload 映射成有序 `LedgerUpdate`。

**⚠️ 这一层在 RFC 的 Commit DAG 里是隐含的**（§11.2 的 C8 只点名 emitter），但 §3.1「direction-specific semantic mapper」与 §3.2「stream 与 non-stream 都必须先经过同一 semantic-operation mapper 并写入同一 ledger contract」明确要求它存在。**没有它，ledger 没有喂养者，C8.1 的 emitter 无从消费。** 本计划把它显式化为独立任务。这是对 RFC DAG 的补充，不是对其冻结契约的改动。

**Files**
- Create `src/lib/pipeline/semantic/ingest/responses-ingest.ts`
- Create `tests/pipeline/semantic/ingest/responses-ingest.unit.test.ts`

**Interfaces**
- Consumes：C1 的 `LedgerUpdate`、C4–C7 的 mapper/policy 判定。
- Produces：`ingestResponsesStreamEvent(event): readonly LedgerUpdate[]`、`ingestResponsesResponse(payload): readonly LedgerUpdate[]`。

**Steps**
1. **stream 与 non-stream 两条入口产出同一套 `LedgerUpdate` 语义**（G5 的结构基础）。加 parity 测试：同一逻辑响应经两条入口后 ledger snapshot 等价。
2. nested part 正确 declare：reasoning-summary / reasoning-content / text 各有自己的 declare→delta→done，**不得凭 item 完成猜 nested part 已完成**（RFC §4）。
3. `.done` 为权威值；delta/done 冲突产出 observation（消费 C3.1 的类型）。
4. 多 reasoning item 各自独立 key，**不复现 A-5/A-6 的单槽压扁**。
5. **`visible.kind:"redacted"` 的处理**：源侧 redacted 时 ledger 记 `reasoningVisibleKind:"redacted"`，**不伪造明文**（RFC §3.3 不变量 4）。配负控：断言输出中不出现任何合成的可读文本。

**Commit invariant**：无 production dispatch；stream/non-stream parity 有测试。

**Verify**：`bun run typecheck` + `bun test tests/pipeline/semantic/ingest/` + G2 wire golden 对账

**Mutation**：让 non-stream 入口跳过 nested part declare 直接产 item → parity 用例变红；让 redacted 合成明文 → 不变量 4 的负控变红。

---

### C8.0b —— Anthropic wire → ledger ingest mapper

**Goal**：对称方向。把 Anthropic message/content-block 事件与 non-stream payload 映射成 `LedgerUpdate`。

**Files**
- Create `src/lib/pipeline/semantic/ingest/anthropic-ingest.ts`
- Create `tests/pipeline/semantic/ingest/anthropic-ingest.unit.test.ts`

**Steps**
1. 同 C8.0a 的 stream/non-stream parity 要求。
2. thinking / redacted_thinking / signature 的 declare→delta→done；**redacted 不伪造明文**，同样配负控。
3. `[hard]` **同模型原生 Claude assistant content 不进 ingest 重建**（G4）—— 它走旁路原样回送。本片必须有一条**可达性正控**证明该旁路仍然被走到，以及一条负控证明「若让它进 ingest，G4 守护会红」。

**Commit invariant / Verify**：同 C8.0a 结构。

**Mutation**：让同模型原生内容进 ingest → G4 守护（C0.2 那条）变红。

---

### C8.1 —— Responses wire emitter

**Goal**：一个 emitter，**同时**消费 stream transition 与 non-stream finalized snapshot。

**Files**
- Create `src/lib/pipeline/semantic/emit/responses-emitter.ts`
- Create `tests/pipeline/semantic/emit/responses-emitter.unit.test.ts`

**Steps**
1. response／item／content／summary lifecycle 与 terminal event。
2. **emitter 不得修改 ledger、policy 或 observation**（RFC §3.1）。
3. 修 A-3 缺陷：`incomplete`／`failed`／`cancelled` 发对应 event，**不再无条件发 `completed`**。
4. 修「无 arguments delta 的 function call 变空 input」：从 authoritative arguments 取值。
5. 用 C0.1 的真 OpenAI SDK oracle 验证完整 lifecycle；**含 F-2 已有的负控**（缺 `content_part.added` 的 `.done` 让 SDK 抛）。

**Commit invariant**：emitter 无 production dispatch（G2）；stream 与 non-stream 两条消费路径**共享同一 snapshot 来源**（G5）。

**Verify**：`bun run typecheck` + `bun test tests/pipeline/semantic/emit/`

**Mutation**：让 non-stream 路径自己重判 terminal → G5 parity 用例变红。

---

### C8.2 —— Anthropic wire emitter

**Goal**：对称的 Anthropic emitter。

**Files**
- Create `src/lib/pipeline/semantic/emit/anthropic-emitter.ts`
- Create `tests/pipeline/semantic/emit/anthropic-emitter.unit.test.ts`

**Steps**
1. message／content-block／signature／stop lifecycle。
2. 每帧必带 `event:` 行且为 SDK 可识别名（沿用 C0.1 的 N1 不变量）。
3. 修 A-5/A-6 缺陷：多 reasoning item 各自独立，encrypted-only 不丢。
4. 用真 Anthropic SDK oracle 验证。

**Commit invariant / Verify**：同 C8.1 结构。

**Mutation**：合并多个 reasoning 到单槽 → 「多 reasoning 不串槽」property 变红。

---

### C8.3 —— 全 cell shadow parity

**Goal**：在单一集成态吸收 C4–C7 全部语义，按方向穷举 production cells 并跑零副作用 shadow。

**Files**
- Create `src/lib/pipeline/semantic/shadow.ts`（**request-local 比较器，仅测试与显式调试配置下启用**）
- Create `tests/pipeline/semantic/shadow-parity.it.test.ts`
- Modify `docs/plan/2026-08-08-semantic-bridge/progress/`（记录 cell 枚举结果）

**Steps**
1. 按 RFC §11 C8 逐条枚举 cells：request semantic mapper；codec `translateOut`／cell 选择（B-2）；leg `prepareWire`（B-3）；initial dispatch 与每种 retry strategy 的 baseline／fork 形状（B-4）；HTTP／WS、stream／non-stream emitter；terminal／usage／error／cancel／EOF／flush；observation authority stage 与 History projection。
2. **前向三点分别做**：首次 dispatch 正控、retry 正控、以及「恢复任一旧点即红」的 mutation（三点各一条，共三条）。
3. **反向按其实际接线列 cells，不把前向的非对称三点虚构成对称路径**（RFC §11 明文）。
4. Scenario B request consumer 漏接**不能只靠 response parity 代替**——单列一条。
5. 每个 cell 的结束条件四件套：正确正样本、目标 mutation 红样本、官方 SDK 或结构 oracle、shadow parity 结果。

**Commit invariant** `[hard]`：**production dispatch 仍全部指向旧 translator**；shadow 有任何客户端／日志／History／指标／共享状态副作用即本片失败（G3）。加一条守护测试断言 shadow 运行前后 History 条目数与日志行数不变。

**Verify**：`bun run typecheck` + `bun run test:backend` + shadow parity 测试连跑 10 次 + **G2 wire 字节 golden 逐字节对账**（本片把 shadow 接进生产路径，是 G3 最脆的一片 —— golden 差异即证明 shadow 产生了副作用）

**Mutation**：让 shadow 写一条 History → G3 守护变红。

---

### C9 —— Anthropic→Responses 原子方向 cutover

**Goal**：**一个语义 commit** 内切换该方向全部 cells 并删除该方向旧 production dispatch。

**Files**
- Modify `src/lib/pipeline/hub-translate.ts`（B-1：`REQUEST_BRIDGES` 与 `FORWARD_STREAM_FACTORIES` 的该方向表项）
- Modify `src/lib/codec/openai-responses/openai-responses-cell.ts`（B-2）
- Modify `src/lib/codec/openai-responses/openai-responses-leg.ts`（B-3）
- Modify `src/lib/codec/cc-family-strategies.ts`（B-4）
- Delete 该方向旧 translator 的 production 调用（A-1／A-2／A-3 的生产入口）
- Modify `tests/openai/semantic-bridge/known-defects.unit.test.ts`（该方向的 KNOWN-LOSS 断言转为目标行为断言）

**Steps**
1. request semantic mapper、`translateOut`、`prepareWire`、initial/retry baseline、HTTP／WS、stream／non-stream response、terminal／usage、observation authority、History actual projection —— **同一 commit 全切**。
2. **不得先切 stream 再切 non-stream；不得遗漏 retry 路径；不得保留运行时 flag 双轨**。
3. test-only fixture replay adapter 可暂留到 C11。

**Commit invariant** `[hard]`：G6 —— 同 commit 内有「新路径可达」与「旧路径不可达」两组 mutation，**且覆盖 B-1…B-4 全部四点**；G2 无双发；该方向 C0.2 的 KNOWN-LOSS 条目全部转绿；反方向行为字节不变（G2 wire golden 反方向逐字节对账）。

**Verify**：`bun run typecheck` + `bun run test:backend` + `bun run test:it` + 该方向 e2e（`tests/e2e-client/`）

**Mutation（G6，冻结命中集合 —— 逐点各一条，不接受只打一点）**

`[hard]` 本计划锚点表 B-4 已写明「**只改 B-2 而漏 B-3/B-4 会让 retry 腿回退成 CC 形**」。这个失效**不会被首次 dispatch 的测试抓到** —— 现有 `tests/anthropic/forward-leg-strategies.it.test.ts` 的三条用例（`:115`／`:127`／`:137`）断言的全是**首次 dispatch** 的上游 wire 形状，**没有 retry baseline 对照**。所以：

- **B-1 恢复旧桥表项** → 变红；
- **B-2 恢复旧 `translateOut`** → 变红；
- **B-3 恢复旧 `prepareWire`（让已是 Responses 形的 body 再经 CC）** → 变红；
- **B-4 恢复旧 retry baseline** → 变红。**这一条必须配一个独立正控**：真实触发一次重试后，断言 retry 腿的上游 wire **仍是 Responses 形**（不是只断言首包）。没有这条正控，B-4 的 mutation 可能因为根本没有测试走到 retry 路径而假绿。
- **旧路径不可达**：保留旧 dispatch 分支并让它可达 → 变红。

四点缺任一条，本 commit 不算完成。

---

### C10 —— Responses→Anthropic 原子方向 cutover

**Goal**：同 C9 方法，按该方向**实际非对称接线**。

**Files**
- Modify `src/lib/pipeline/hub-translate.ts`（B-1：`RESPONSE_BRIDGES` 与 `REVERSE_STREAM_FACTORIES`）
- Delete A-4／A-5／A-6 的 production 调用
- Modify 该方向 KNOWN-LOSS 断言

**Steps**
1. 按该方向实际 cells 枚举切换（反向请求腿在 hub 内，无前向的三点问题）。
2. **同模型原生 Claude assistant content 的旁路不经 semantic envelope 重建**，其 reachability 正负控必须与 cutover 同 commit 通过（G4）。

**Commit invariant** `[hard]`：同 C9 —— G6 的 mutation 按**该方向实际接线**逐点冻结成命中集合（反向请求腿在 hub 内，无前向的三点问题，但 `RESPONSE_BRIDGES` 与 `REVERSE_STREAM_FACTORIES` 两张表各算一点，且 retry 腿同样需要独立正控）；**不得把前向的非对称三点虚构成对称路径**；G4 旁路正负控同 commit 绿。

**Verify**：同 C9 + `bun run test:ci` 前置档位

**Mutation**：让同模型内容走 envelope 重建 → G4 旁路用例变红。

---

### C11.1 —— 退休旧路径

**Goal**：删除 shadow 比较器、test-only replay adapter、旧 translator 死逻辑。

**Files**
- Delete `src/lib/pipeline/semantic/shadow.ts` 及其测试
- Delete 六个旧 translator 中已无消费者的部分（**逐个用独立 oracle 确认无消费者，不凭 reviewer 断言**）
- Modify `src/lib/history/types.ts`（旧 `anthropicToResponses` 槽的移除**需另有 reachability 证明**，无证明则本片不动它）

**Commit invariant**：删除项逐个有「无消费者」的独立证据（`rg` + typecheck + 全量测试三重）；`bun run test:ci` 全绿。

**Verify**：`bun run typecheck` + `bun run test:backend` + `bun run test:it` + **G2 wire 字节 golden 逐字节对账**（删代码最容易连带删掉仍被走到的分支）

---

### C11.2 —— 文档同步与合并态评审

**Goal**：DESIGN／backlog／RFC 状态同步 + merged-state review。

**Files**
- Modify `docs/DESIGN.md`（「活的架构现状」表 —— 权威状态源）
- Modify `docs/todo/deferred-backlog.md`
- Modify 本 plan（四档状态注解）
- Modify RFC 状态行

**Steps**
1. **History 正式契约已在 C3.3 同步，C11 只核对最终实现并移除迁移期兼容说明，不首次定义它。**
2. 派 merged-state review agent（异模型，显式写裁判轴：长远正确 + 完整，非 ROI/YAGNI）。
3. 逐条核对 RFC §12 验收矩阵十七行。

**Commit invariant**：文档与代码同步；merged-state review 零未决 blocker／major。

**Verify**：`bun run test:ci` + 跨文档 `rg` 验证（无指向已删符号的引用）

---

## Self-review：RFC 节 → 任务覆盖

| RFC 节 | 覆盖任务 |
|---|---|
| §3.1 四层职责边界 | C1（ledger）／C2.2（policy resolver）／C2.3（driver authority）／**C8.0a-8.0b（direction-specific semantic mapper，wire → ledger）**／C8.1-8.2（emitter） |
| §3.2 stream 与 non-stream 同源 | C1.3（snapshot/transition）+ **C8.0a/8.0b（两条入口产出同一套 `LedgerUpdate`，parity 的结构基础）** + C8.1/8.2（双消费路径）+ G5 |
| §3.3 Reasoning Exchange Envelope 七条不变量 | C1.1（类型）／C7.1-7.2（carrier 与 provenance；**不变量 4 跨协议 redacted 在 C7.2 第 6 步**）／C8.0a-8.0b（ingest 侧 redacted 不伪造明文）／G4（不变量 7） |
| §3.4 boundary 状态转移 | **C2.2 第 5 步（边界状态机不变量：单次声明、ID 命名空间分离、多跳有序 segments、无全局布尔）**／C2.3（authorityPhase 与两支 pre-commit retain） |
| §4 核心类型契约与 ledger invariants | C1.1／C1.2／C1.3（**三类载体的 authoritative done**）／C3.1 第 7 步（三类冲突 observation 的 producer） |
| §5 ordered-turn request model | C4.1／C4.2 |
| §6 config snapshot／lineage／policy／authority | C2.1／C2.2／C2.3 |
| §6.1 carrier v2 wire grammar | C3.4（共享 validator）／C7.1 |
| §6.2 配置 schema v2 与迁移 | C6.2 |
| §7 server-tool 四格 | C5.1／C5.2 |
| §8 structured output | C3.4（共享 validator）／C6.1 |
| §9 context management | C6.2（**第 6 步覆盖响应侧载体不等价与触发后 degradation**） |
| §10 observation／错误／History | C3.1／C3.2 |
| §10.1 History V3 与 API 公开投影 | C3.2／C3.3 |
| §11.1 全局不变量 | Global Constraints G1–G8，逐 task 隐含；**G2 由 C0.2 的 wire 字节 golden + C2.3 的 writer 集合守卫机械保障** |
| §11.2 Commit DAG | 本文任务 DAG（**C3.4 与 C8.0 是本计划对 RFC DAG 的显式化补充，见各自任务说明**） |
| §12 验收矩阵 | C0.3 registry 逐行登记，C11.2 逐行核对 |
| §13 性能与资源 | C1.3（复杂度与内存）／C8.3（shadow 限测试与显式调试） |
| §14 失败处理 | C1.2（typed 拒绝）／C3.4 + C6.1-6.2（fail-closed）／C7.1（fail-closed decoder） |
| §16 实施前门 | 本 plan 即其产物；用户 2026-08-08 已授权协调实施，plan 定稿后不再询问是否开始 C0。**kickoff 提示词按阶段增量产出，见下方裁决记录** |

### 对 RFC 的两处显式化（不是改动其冻结契约）

- **C3.4 共享 JSON-value validator**：RFC §6.1 与 §8.1 各自要求它，但 §11.2 的 DAG 未给它独立位置。若按 DAG 字面把它放进 C6，则并行的 C7 组无法编译。本计划把它前移为 C4–C7 的共同前置。
- **C8.0a／C8.0b wire → ledger ingest mapper**：RFC §3.1／§3.2 明确要求 direction-specific semantic mapper，但 §11.2 的 C8 只点名 emitter。没有它，ledger 无喂养者、emitter 无可消费之物。本计划把它显式化为独立任务。

两处都只是**补上 DAG 的隐含层**，未改变任何公共契约。若评审认为这构成对 RFC 的实质改动，应回到 RFC 层裁决而非在计划层消化。

### 裁决记录：kickoff 提示词增量产出（**仍存分歧，待用户裁决**）

**RFC §16 原文要求**：「实施计划必须把 C0–C11 拆成可直接派给独立 implementer 的小片，并为每片定义进度文件、commit invariant、测试、mutation 和 review 闭环。」

**已满足**：plan.md 为**全部 30 片**逐片给出 Files／Interfaces／Steps／Commit invariant／Verify／Mutation；进度文件协议见 `progress/README.md`；review 闭环见本节与 C11.2。按字面读，§16 列举的五样每片都有。

**当前状态**：`prompts/` 下已写 **C0.1–C3.4 共十片**；C4 及之后（15 片）标为「待写」。

**评审意见（第 2 轮，契约对齐 reviewer）**：坚持要求全部补齐。理由是「plan 定稿产物应当已经为每片提供可直接派发的 kickoff；『分派前再写』是未来流程门，不满足**当前交付物**的完整性」。它同时抓到一个我确实写错的事实（导航称已就绪而 `c3-4.md` 当时不存在），该事实错误已修复 —— c3-4.md 已补写。

**我的理由（未采纳其「立即补齐」的部分）**：

1. kickoff 的价值在于给零上下文实施者**当前真实的锚点**。C4 之后的锚点会被 C1–C3.4 的 commit 改变。
2. **本计划两轮评审的两条最大 blocker，都正是「措辞肯定、看起来合理、但事实已不成立」的指令** —— 先是「`writeCommittedBatch` 是唯一 writer」，修完又变成「`writeToSink` 覆盖所有客户端字节」。提前写 15 片，等于批量制造这类失效。
3. **项目已有先例，且该特性已落地**：`docs/plan/anthropic-via-openai-translation/prompts/README.md:16` 写着「per-phase kickoff 增量产出：Phase 0 已就绪可执行；后续 phase 在推进到该阶段前展开（避免一次性写全、上下文腐化）」；该 plan 的 Phase 0–4 均标注 landed，`prompts/` 下的 `phase-1.md`…`phase-5.md` 也确实随推进被逐个写出。
   ⚠️ **但这个先例同时暴露了一个失效**：那张导航表**至今仍写着「待写」**，而文件早已存在。所以本计划的硬触发**要求写 kickoff 与更新导航表是同一次改动**（已写进 `prompts/README.md`）——先例证明了做法可行，也证明了不加这一条会陈旧。
4. 「分派前必须先写」不是空头承诺，而是挂在**必经流程**上的触发点：要派活就得看导航表。

**这一条我不自行终裁**：提出方是当事人（我），复核方也是当事人（它自己的发现），双方各执一词。**请用户裁决**——

- **维持现状**（增量产出 + 硬触发），或
- **一次性补齐全部 15 片 kickoff** 后再定稿。

级别 C（落进产物但可逆）。在用户裁决前，本计划按「维持现状」执行；若裁定补齐，只需新增 15 个文件，不影响已定稿的任何契约。

## 未采纳与暂缓

- **不合并 `CommittedBlocksLedger` 与新 semantic ledger**（C-6）—— 两者职责不重叠，合并会让 continuation 的「已交付前缀」语义被完整 lifecycle 污染。理由见 RFC §15「各方向独立 keyed translator」的同族论证。
- **旧 `pipelineInfo.translation.anthropicToResponses` 槽不在本计划移除** —— RFC §10.1 要求「所有读者迁移完毕并另有 reachability 证明」后才移除，本计划只把它降为旧读兼容投影，移除另立决策。
- **Gemini direct bridge、真实 Chat Completions 腿改写** —— RFC §2 明确非目标。
- **context-management 私有 carrier** —— RFC §15 本轮不采用，未来须先有双向真实 GHC PoC 和独立 ADR。
