# RFC：anthropic ↔ responses 直接桥 + hub-translate 重塑为 per-pair 桥选择器

日期：2026-07-14｜状态：**✅ landed（Phase 0-7 全实施 + 三次合并态异模型对抗审查 + 收官审查；ADR [2026-07-14-lossless-per-pair-bridge](../decisions/2026-07-14-lossless-per-pair-bridge.md) 记录设计轴翻转）** ← v2（两轮对抗审查已处理：GPT 1 BLOCKER + Claude/GPT 各 major，全部亲手核实 file:line 后订正）
需求源：用户裁决「non-CC↔non-CC 经 CC 中转有损违背 richest-data-flow，给 (anthropic↔responses) 做直接 translator」（2026-07-14 会话）
前置：
- 交接硬发现 [docs/todo/anthropic-responses-direct-mapping-handoff.md](../todo/anthropic-responses-direct-mapping-handoff.md)（两轮异构对抗审查的裁决，本 RFC 校正其两处基于推断的过度表述，见 §1.3）
- [通用翻译矩阵 RFC](2026-07-11-anthropic-via-openai-translation.md)（hub-and-spoke 的起点，本 RFC 从第一性收窄其 CC-canonical 前提的适用边界）
- [集中化 cell 装配 RFC](2026-07-13-inbound-codec-outbound-leg-split.md)（出站层已是 `(cf×te)` 穷尽笛卡尔积——本 RFC 复用该结构，只重塑 hub-translate 内部的翻译原语选择）
- [reasoning 透传项目](../memory/project-reasoning-passthrough-synthetic-thinking.md)（synthetic-reasoning 哨兵签名 primitive，本 RFC 的 round-trip 复用它）
- 退役 ADR [2026-07-13-server-tool-positioning-and-web-search-retirement](../decisions/2026-07-13-server-tool-positioning-and-web-search-retirement.md)（web_search 双跳退役——本 RFC 的 server tool 透传是**不同机制**，不复活它，见 §5.2）

---

## 0. TL;DR

**问题（第一性）**：`hub-translate.ts` 强制**一切请求/响应翻译过 CC**。CC 是三格式里表达力最弱的，当 non-CC↔non-CC 对的中转时必然裁掉两端本可表达的能力——`(anthropic client → responses model)` 上，reasoning 被折成 `reasoning_effort` 标量、server tool 被 strip、thinking 结构丢失。对一个价值全在于忠实翻译的代理，「用 DRY 换保真」这个取舍从根上是反的。

**方案**：
1. **hub-translate 重塑为 per-pair 桥选择器**：翻译分发的 key 从「单轴 CC 枢纽」改成 `(source, target)` 对，每对解析到**该对最富、无损的桥**。全部 dispatch（请求 + 响应非流式 + 流式两向）改成**穷尽 `(source,target)` 桥表**（漏对=编译错），消灭现有串联 `if` 分发。CC 桥降级为「某端真是 `/chat/completions` 时」的一个合法桥，非默认枢纽。
2. **anthropic↔responses 直接桥（前向 + 反向一次做完）**：新增 6 个方向的直接翻译原语（去重后 2 组核心方向 × 3 层），跳过 CC 中间表示。
3. **reasoning / server tool 全链路 round-trip（决不妥协）**：复用 `synthetic-reasoning.ts` 哨兵签名封装**真·上游签发密文**，跨轮回喂上游续接。真伪密文之别是 round-trip 可行性的分水岭（§1.2）。
4. **两场景 per-pair 配置**：稳定模型（完整互填）vs 中途切换模型（剥签名保文本）——代理无法自动判定（信息只在用户侧），交 `model_translation` per-pair `features` 声明。
5. **配置重命名** 顶层 `model_overrides` → `model_mappings`（经 compat renameLeaf 留旧键读时别名）。

**红线（§9）**：全面显式桥表（不挖洞）｜byte-equivalence 仅指客户端边界（不适配内部模块）｜等价区 vs 改进区 golden 双区划线（旧 CC-via 输出绝不当改进区目标）｜真 signature 转发与哨兵合成两路径不共享。

---

## 1. 背景与第一性问题

### 1.1 CC-hub 的取舍从根上反了

当前 [hub-translate.ts](../../src/lib/pipeline/hub-translate.ts) 有 5 个 CC-centric 分发器，全部把 CC 焊死为唯一枢纽：

| 分发器 | 现状 |
|---|---|
| `translateRequestVia` → `toCcBody` / `toAnthropicBody` | 请求 body 一律先归一到 CC（或 Anthropic），responses↔anthropic 走两跳 |
| `renderResponseNonStreamingVia` | 响应非流式，forward 腿 `Responses→CC→Anthropic` 两跳 |
| `createForwardStreamTranslator` | 响应流式 forward，responses 腿 `Responses→CC→Anthropic` 两跳（`hub-translate.ts:222`） |
| `createReverseStreamTranslator` | 响应流式 reverse，openai-responses 腿 `Anthropic→CC→Responses` 两跳（`hub-translate.ts:332`） |
| `createResponsesToCcFrameRenderer` | via-responses 逐帧原语 |

CC 是三格式里表达力最弱的（无 `encrypted_content` reasoning、无 server tool、无 thinking 结构）。当 `(anthropic, responses)` 这种 non-CC↔non-CC 对经 CC 中转时，两端本可表达的能力被中间格式裁掉。这不是实现 bug，是 CC-as-canonical 这个**前提本身错了**。

**设计轴纠正**：CC-hub 用「少写 translator（DRY）」换「数据保真」。「N² translator 爆炸」被夸大——`messages↔messages` / `cc↔cc` / `responses↔responses` 都是恒等，真正的点对点对没几个（gemini 推迟后，本 RFC 只需 anthropic↔responses 一对）。正确的设计轴是「**每对用最富、无损的桥**」：直接映射是默认理想，CC-hub 只在某条腿真的就是 `/chat/completions`（openai-cc 入站、或上游腿本身是 CC）时才合法。

### 1.2 真伪密文分水岭（reasoning 成立，server-tool 结果**不**成立——两条腿不同构）

退役 ADR 的 `exp/encrypted-content-400` 死墙——上游对 `encrypted_content` 要求「真实有效非空 string」，`""`/`null`/占位/缺失全 400——是因为 web_search 双跳**伪造**了空 encrypted_content 回显。

**reasoning 腿（分水岭成立）**：直接桥 round-trip 回传的 reasoning 密文是**上游真实签发的真货**（`exp/synthetic-reasoning-summary-shape/FINDINGS.md` 实测：Responses 流式 reasoning item 携带非空 `encrypted_content`；类型见 [openai-responses.ts:194-201](../../src/types/api/openai-responses.ts) `ResponsesReasoningOutput.encrypted_content`）。回喂真密文 → 有望被上游接受。

**server-tool 结果腿（分水岭不成立、审查 BLOCKER 订正）**：Responses 的 `ResponsesOutputItem` union（[openai-responses.ts:204](../../src/types/api/openai-responses.ts)）只有 message / function_call / reasoning **三种，没有 web_search 输出 item 类型**——**搜索结果本身不带任何 `encrypted_content`**。要把它回显成 Anthropic `web_search_tool_result` 块多轮存续，`encrypted_content` **只能自己合成** → 撞退役双跳同一堵墙。故 server-tool 结果回显与 reasoning **不同构**：reasoning 有真密文可搬、server-tool 结果无密文可搬。这是**协议层的物理约束**，见 §5 订正后的诚实边界。

**这是 round-trip 物理可行性的分水岭**（只对 reasoning 成立），也是本 RFC 对 reasoning 不复活退役死坑的根本原因：reasoning 机制完全不同（原生透传真密文 vs 合成双跳伪造密文）。server-tool 请求侧透传合法（让上游原生搜），但结果回显与退役双跳撞同一堵墙——诚实降级。

> **Phase 0 实测精化（[FINDINGS.md](../../exp/anthropic-responses-direct/FINDINGS.md)）**：reasoning round-trip 可行的真实机制**不是「过了 400 gate」，而是 Responses reasoning 端点根本不 gate `encrypted_content`**（实测回喂空/中间态/权威版全 200）。故「分水岭」更准确的表述：Anthropic `/v1/messages` 的 `search_result` 块 **gate** encrypted_content（退役死墙）、Responses reasoning 端点**不 gate**——是端点差异而非真伪差异在决定可行性。server-tool 的 `web_search_call` 无 encrypted_content 字段，responses↔responses 靠 opaque `id` 原生 round-trip，但渲染给 anthropic 客户端仍撞 Anthropic 侧 gate → 降级成立。

### 1.3 对 handoff 两处推断表述的校正（基于实测）

handoff 的两轮对抗审查是在**尚未通读 cell-assembly 重构后代码**时做的，有两处基于推断、与代码地面存在张力：

- **「重写整个 hub 抽象」框架收窄**：cell-assembly C0-C6 后，出站层[已经是 `(cf×te)` 穷尽笛卡尔积](../../src/lib/pipeline/cell-assembly.ts)。托管 per-pair 桥的**结构层已存在**。本 RFC 不是「往铁板 hub 上挖洞」也不是「新造平行分发器」，而是把 hub-translate **内部**的翻译原语选择从 CC-canonical 改成 per-pair 桥表。
- **reasoning「只能单向明文」过于悲观**：handoff MAJOR-1 引用的 `encrypted-content-400` 死墙测的是 web_search `search_result` 块的 encrypted_content（另一字段/item 类型），**不能等同** reasoning item。实测证明 Responses 流式 reasoning item 携带非空真密文，且 `synthetic-reasoning.ts` 已把它藏进签名载荷**正是为跨轮 round-trip**。→ reasoning 定性升级为**完整 round-trip 设计目标**（§4）。

---

## 2. hub-translate 重塑为 per-pair 桥选择器

### 2.1 桥表结构（全面显式，漏对=编译错）

翻译分发的 key 从「单轴 CC 枢纽」改成 `(sourceCanonical, targetCanonical)` 对。每对解析到该对的桥：

| 规则 | 桥 |
|---|---|
| 恒等对（messages↔messages / cc↔cc / responses↔responses） | identity |
| 一端真是 `/chat/completions`（openai-cc 入站，或上游腿本身 CC） | CC 桥（合法，非降级） |
| anthropic↔responses | **新直接桥**（本 RFC §3） |
| gemini↔responses / gemini↔anthropic | **暂经 CC**（§10 推迟；桥表留位，加桥即独立落地） |

四个 dispatch（`translateRequestVia` / `renderResponseNonStreamingVia` / `createForwardStreamTranslator` / `createReverseStreamTranslator`）**全部**改成穷尽 `(source,target)` 桥表（穷尽 Record，与出站层同构）。

### 2.2 红线 R-EXPLICIT：不挖洞

**⚠️ 现 `createForwardStreamTranslator`/`createReverseStreamTranslator` 用串联 `if (targetEndpoint === CHAT) ... if (RESPONSES) ...` 分发。若只往里塞一个 anthropic↔responses 的 `if` 分支 = 退化成「往铁板挖洞」，正是用户 2026-07-14 警告的反锚点。** 重塑必须把这些 translator 的 dispatch 也改成显式桥表——漏一对 = 编译错。这是本 RFC 的承重红线，非可选清理。

### 2.3 调用点改动范围（审查 MAJOR 订正：非全部 hub-内部，前向请求腿跨三点）

**校正先前的过度简化**：不是所有直接桥都只改 hub-translate 内部。四条方向腿里，改动落点非对称：

| 方向腿 | 改动落点 | 是否纯 hub-内部 |
|---|---|---|
| 前向**请求** `(anthropic → responses)` | translateOut（[openai-responses-cell.ts:65](../../src/lib/codec/openai-responses/openai-responses-cell.ts)，现停在 CC）+ prepareWire（[openai-responses-leg.ts:119](../../src/lib/codec/openai-responses/openai-responses-leg.ts) `prepareViaResponsesWire` 现做 CC→Responses）+ retry-baseline（[cc-family-strategies.ts:38](../../src/lib/codec/cc-family-strategies.ts) 现取 `env.body as ChatCompletionsPayload` 期望 CC）| **否，跨三点** |
| 反向**请求** `(openai-responses → messages)` | messages leg 的 prepareWire 不再翻译，翻译在 hub | 是 |
| 前向**响应流** `(responses → anthropic)` | `createForwardStreamTranslator(RESPONSES)` 全在 hub | 是 |
| 反向**响应流** `(anthropic → responses)` | `createReverseStreamTranslator(openai-responses)` 全在 hub | 是 |

**⚠️ 承重（前向请求腿）**：若直接桥让 `env.body` 变 Responses 形，`prepareViaResponsesWire` 会把已是 Responses 的 body **当 CC 再翻一次** → 双翻译/垃圾请求；且 `cc-family-strategies.ts:38` 的 CC retry baseline 也坏。所以前向请求直接桥**必须**同时改 `isDirect` 分叉（对 anthropic clientFormat 走 direct）+ prepareWire（不再 CC→Responses）+ retry baseline（Responses 形）。这三点改动进 §8 迁移清单，planner 不得按「纯 hub 内部」低估。

cell-assembly 的**穷尽 Record 结构、driver hybrid dispatch** 不动（结构层已备），动的是 leg/cell 内部的 direct 分叉逻辑 + hub 翻译原语。

---

## 3. 新翻译原语拆分

### 3.1 6 个方向（去重后 2 组核心方向 × 3 层）

现有原语**全部**取道 CC，无一个 anthropic↔responses 直接件。前向的响应侧方向 = 反向的请求侧方向，故去重后：

| 层 | `responses → anthropic` 方向 | `anthropic → responses` 方向 |
|---|---|---|
| **请求 body** | 反向请求（openai-responses 客户端 @messages） | 前向请求（anthropic 客户端 → responses 模型） |
| **响应非流式** | 前向响应 | 反向响应 |
| **响应流式** | 前向流 translator | 反向流 translator |

**放置**：新增 `src/lib/openai/translate/anthropic-to-responses-*.ts` 与 `responses-to-anthropic-*.ts`（贴现有 `anthropic-to-cc-*` / `responses-to-cc-*` 命名约定）。**最终命名以最佳方案为准**，不继承旧模块的细节/命名/边界。

### 3.2 extract-not-rewrite：三分类，别笼统「提取+组合」（审查 MAJOR 订正）

直接桥**不是**从零平行手搓，也**不是**继承旧两跳结构，但也**不是**笼统「提取纯块映射拼起来」——CC 中间表示不只是「多此一举的中转」，部分语义变换发生在 **CC 归一化本身**。审计两跳时须把现有逻辑**三分类**：

1. **真跨格式通用、可提取的映射**：tool_use↔function_call 的 id/name/arguments、content text 提取、基础 stop_reason 映射——与 CC 无关，提为干净具名 helper。
2. **CC-canonical 特有、直接桥不需要 → 重新设计而非提取**：GHC cc 腿的 **multi-choices fold/split**（[anthropic-to-cc-request.ts](../../src/lib/openai/translate/anthropic-to-cc-request.ts) + [cc-to-anthropic-stream.ts](../../src/lib/openai/translate/cc-to-anthropic-stream.ts)，把一轮 text+tool_use 拆成独立 choices，是 CC 协议怪癖）、CC 的 tool_call `index` 分配语义——Responses 的 `output[]` 语义完全不同，直接桥需**全新状态机**。
3. **需重新推导的复合逻辑**：**usage 换算**——三方 cache token 语义两两不同构（Anthropic `cache_read_input_tokens`/`cache_creation_input_tokens` 两独立字段；Responses `input_tokens_details.cached_tokens`/`cache_write` 嵌套；CC 又一种形状）。直接桥须写全新 `Responses usage → Anthropic usage` **单跳**映射，非两段拼接。

**plan 阶段的任务拆分必须体现这个三分类**，别按「大部分是提取」低估、漏掉「multi-choices 在直接桥不存在须重设计」「usage 须重推导」这类结构性差异。旧 CC-via 实现降级为事后 regression oracle（§7），不作模板。**最终命名以最佳方案为准**。

**承重复用点（不重造）**：
- reasoning round-trip 复用 [synthetic-reasoning.ts](../../src/lib/anthropic/synthetic-reasoning.ts) 哨兵签名 primitive `copilot-api:synthetic-reasoning:v1:<base64url(encrypted_content)>`（**仅前向**，反向须新建，见 §4.4）。
- 剥离守卫复用 `sanitize/` 的 `stripSyntheticReasoningBlocks`。
- **流式终端 meta 累积器**（usage 换算 + stop_reason 映射）是独立子关注点：现 `createForwardStreamTranslator(RESPONSES)` 靠 `ccToAnthropic` 累积器产终端 meta（[hub-translate.ts:207](../../src/lib/pipeline/hub-translate.ts)），直接桥跳过 CC 后须**自带**终端累积器——列为第 3 类显式 helper，别藏在「响应流 translator」一行里。

### 3.3 红线 R-NO-INTERNAL-ADAPT：byte-equivalence 仅指客户端边界

**⚠️ byte-equivalence 是客户端 wire 边界的概念，绝不指内部模块。** regression oracle 只看客户端观测到什么，永不要求直接桥的内部中间表示去匹配旧 CC-via 的内部形状/命名/模块边界。**为强行适配内部模块而扭曲结构 = 怪味，禁止。** 旧实现只做批判性参考，不为准（旧版本本身也不是最好的）。

---

## 4. round-trip 逐轮数据流（承重、最易出错）

### 4.1 前向 reasoning round-trip（anthropic 客户端 ↔ responses 模型）

1. **轮 1 请求**：anthropic messages body → `translateAnthropicToResponses` → responses body（带 `reasoning.summary:"auto"`，复用已 landed 的请求侧改动）。
2. **轮 1 响应**：responses 上游流出 reasoning item（真 `encrypted_content`）+ 明文 summary delta → 前向流 translator → anthropic thinking 块：明文进 thinking text，`encrypted_content` 经 `synthetic-reasoning.ts` 封装进 `signature`。
   **⚠️ 捕获时机（审查 MAJOR，承重）**：同一 reasoning item 的 `encrypted_content` 在 `response.output_item.added` 与 `.done` **两事件间不同**（实测 `exp/synthetic-reasoning-summary-shape/upstream-event-types.json`：enc_len 1632→1744，同族 [item.id 每事件重加密](../memory/reference-ghc-responses-item-id-reencrypted-per-event.md)）。现 CC 桥只在 `added` 捕获（[responses-to-cc-stream.ts:58](../../src/lib/openai/translate/responses-to-cc-stream.ts)）。直接桥必须先确认**哪个事件的密文是可回喂的权威最终版**（大概率 `.done`），否则 §7 P0 探针 (a) 可能因捕获中间态密文假阴性——须 P0 前置澄清（§7.2）。
3. **轮 2 请求**：客户端原样回传 thinking 块 → `translateAnthropicToResponses` 遇带哨兵签名的 thinking 块 → 剥签名取回**真·上游 encrypted_content** → 重建 responses reasoning item 回喂上游续接。
4. **上游接受性** = P0 去风险验证点（§7）：回喂真密文（非伪造），设计**为成功而设计、不预设 fallback**（遵「决不妥协」），plan 阶段实测坐实。
5. **前向 round-trip 脆弱不变量**：sanitize 的 `stripSyntheticReasoningBlocks` 门控是 `targetEndpoint===MESSAGES`（[request-rewrite-adapter.ts:65](../../src/lib/codec/anthropic/request-rewrite-adapter.ts)），responses 腿上**不触发**，故哨兵 thinking 块能活到 forward-translate 被取回。**若未来 sanitize 门控扩到 responses 腿，前向 round-trip 即断**——plan 须记为守卫不变量。

### 4.2 反向对称（openai-responses 客户端 ↔ Claude 模型 @messages）——欠规约，须新建 primitive（审查 MAJOR）

Claude 上游流出 thinking 块（**真 Claude signature**，非我方哨兵）→ 反向流 translator → responses reasoning item；客户端回传 → `translateResponsesToAnthropic` → 重建 anthropic thinking 块回喂 Claude 上游。

**⚠️ 现有 primitive 不覆盖此向**：`synthetic-reasoning.ts` 三 primitive（`buildSyntheticReasoningSignature`/`extractEncryptedReasoning`）是**单向**的（GPT `encrypted_content` → 我方哨兵签名 → 回程剥出），消费点全在 `cc-to-anthropic*`（GPT→Anthropic 前向）。反向需要一个**把真 Claude 签名塞进 responses reasoning item 并原样取回**的机制——现无此 primitive。plan 须新建，明确载体字段与 round-trip 通道。

**⚠️ 反向物理可行性未 P0 探针**：responses 客户端（如 Codex）是否原样回传 non-GPT 签发的 `encrypted_content` **未验**。§7.2 P0 须补反向探针，与前向对等。若反向物理不可行（responses 上游拒绝外来密文），按「决不妥协」升级为真发现、escalate，而非默认降级。

### 4.3 两场景 · 密文有效性 · per-pair 配置

reasoning round-trip 有两个语义不同的场景，**代理无法自动判定**（这是用户在客户端选模型时的主动决策，信息只在用户侧）：

- **场景 A · 稳定模型 · 格式仅名义入口**（默认）：客户端始终用 anthropic-messages 入口，但实际始终访问同一个 `gpt-5.5@openai-responses`。thinking↔reasoning 只是文字游戏——`signature`↔`encrypted_content` 互填、文本互填，**完整 round-trip 保真**。回喂同一上游签发的真密文 → 接受。
- **场景 B · 中途切换模型**：先用 A 格式模型攒上下文，中途切到 B 格式模型。历史里 thinking/reasoning 的 `signature`/`encrypted_content` 是 A 模型上游签发、回喂 B 模型上游必被拒（跨模型密文无效）→ **必须剔除 signature/encrypted，但文本显示内容仍互填**（保上下文连续性）。

**为何必须配置、不能自动判定**：用户从 `gpt-5.5@openai-responses`（场景 A、历史全是我方哨兵密文）切到**另一个** `gpt-6@openai-responses`——仍是我方哨兵、仍是 responses 格式，但密文是 gpt-5.5 上游签的、对 gpt-6 无效。前缀检测抓不到这种**同格式跨模型**失效。密文有效性根本上是用户意图，必须配置声明。哨兵前缀检测保留为**次级安全**（识别外来非哨兵签名，如场景 B 里 Claude 真签名），不作为场景判定唯一依据。

### 4.4 红线 R-DIRECTION-ASYMMETRY：真 signature 转发 vs 哨兵合成两路径

**⚠️ 前向合成哨兵 thinking（靠剥离守卫兜底）与「反向绝不合成 thinking」是不同方向的不同契约。** 反向（Claude 上游真 thinking → responses 客户端）转发的是**真 Claude signature**，不是我方哨兵。若实现里两向共用一个「合成 thinking」helper 不分真伪来源，会污染。**真 signature 转发**与**哨兵合成**定为两个不共享的路径。

---

## 5. server tool 通用透传 + 诚实边界（审查 BLOCKER 订正）

### 5.1 通用策略：请求侧透传无损，结果回显永远降级（物理约束，非妥协）

直接桥对 anthropic 侧 server tool 采用「请求侧能映射就原生透传、结果回显永远降级」：
- **请求侧（无损）**：anthropic `web_search_20250305`（前缀 type + Anthropic schema）→ Responses 裸 builtin `{type:"web_search"}` → 让 **Responses 上游原生执行搜索**。这条 wire 形状由 Phase 0 探针与 2026-08-04 强制选择探针共同实测为 HTTP 200；不是 `web_search_preview`。
- **工具选择与声明同源（承重不变量）**：`tools[]` 与 `tool_choice` 必须由同一映射决策产生。若声明映射为 builtin `{type:"web_search"}`，强制选择也必须是 `{type:"web_search"}`，绝不能伪装成 `{type:"function",name:"web_search"}`；若声明被过滤、named choice 找不到存活声明，或 `any`/`required` 翻译后零工具可用，则 choice 同步省略。此不变量同样约束 Responses→Anthropic 与 Responses→CC 的降级腿，防止留下悬空 choice。
- **结果回显（永远降级、非妥协）**：Responses 的 `ResponsesOutputItem` union（[openai-responses.ts:204](../../src/types/api/openai-responses.ts)）**没有 web_search 输出 item 类型、搜索结果不带任何 `encrypted_content`**。要回显成 Anthropic `web_search_tool_result` 块多轮存续，`encrypted_content` **只能自己合成** → 撞退役双跳同一堵墙（`encrypted-content-400`）。故结果回显**永远走降级路径**：普通 `tool_use`/`text` 块，**绝不合成 `web_search_tool_result`**。
- 映射不上的 server tool → 同样降级为普通 tool_use / text。

**这与 reasoning 那条腿不同构**（§1.2 分水岭订正）：reasoning 有真密文可搬 → 可 round-trip；server-tool 结果无密文可搬 → 只能降级。**降级是协议层物理约束、非裁判轴意义的缩范围**——reasoning 全链路 round-trip 目标完整保留，server-tool 只是诚实承认上游协议没暴露可搬运的签名密文。

### 5.2 红线 R-NO-REVIVE（订正：明确排除响应侧结果回显）

**⚠️ server tool 请求侧透传不复用退役双跳的合成代码（`web-search/synthesize.ts` 已删）。** 请求侧是**纯工具声明映射** + 让上游原生干活，机制与退役双跳（第二跳搜索后端 + 合成结果）不同。**但响应侧结果回显本质上仍撞退役双跳同一堵墙**（源头无真密文、须合成）——R-NO-REVIVE **只保护请求侧**，响应侧结果回显归入「§5.1 永远降级」。不得以「直接桥名义」在响应侧复活合成 `web_search_tool_result`。

### 5.3 诚实边界总表（reasoning 与 server-tool 不同构）

| 能力 | 直接桥行为 | 边界性质 |
|---|---|---|
| reasoning 明文 | 完整互填保真 | 无损 |
| reasoning encrypted_content（真密文） | 完整 round-trip（场景 A）/ 剥离保文本（场景 B，per-pair feature） | 物理边界可行，非妥协 |
| server tool 请求侧 | 原生透传 + 名称映射（上游原生搜） | 无损（映射不上才降级） |
| server tool 结果回显 | **永远降级为普通 tool_use/text**（无真密文可搬、绝不合成） | **物理约束不可 round-trip，与 reasoning 不同构** |

---

## 6. 配置

### 6.1 `model_translation` 新段（key = ingress format）

`ingress` 是有限枚举（`anthropic-messages` / `openai-cc` / `openai-responses` / `gemini`）→ 提为 map key，每个 ingress 挂一组 match 规则。可扩展容器，未来纳入更多翻译特性：

```yaml
model_translation:
  anthropic-messages:
    - match: gpt-5.5@openai-responses   # 仅当 model_mappings 等最终把路由定到 model=gpt-5.5 且走 openai-responses format 时生效
      features: ['strip-thinking-signature']
```

- **key = ingress format**（客户端入口格式），**value = 有限规则列表**。
- `match: <model>@<format>` = 对**最终路由结果**（经 model_mappings 解析后的真实上游 model + format）匹配，非对客户端原始 model 名匹配——匹配发生在路由裁决**之后**。核实：`router.ts` 的 `decideRoute` 先解析 `targetEndpoint`，之后才走 hub 桥选择，故时序上可行。plan 须显式确认配置读取点挂在**格式无关的桥选择函数**内部（非 per-cell `translateOut` 各读一次，避免两路径状态不一致）。
- `features: [...]` = 该配对生效的翻译特性列表（首个特性 `strip-thinking-signature` = 声明场景 B）。默认无 `features` = 场景 A 完整互填。

### 6.2 配置重命名 `model_overrides` → `model_mappings`（审查 MAJOR 订正：顶层键、非 `model.` 段）

**校正**：`model_overrides` 是 ConfigSchema **顶层**字段（[schema.ts:982](../../src/lib/config/schema.ts)，与 `buffered_retry`/`disabled_models`/`retry` 同级），**无 `model` 段**。先前 §5/§6.2 写的 `model.model_overrides` 事实错。目标是**顶层 `model_mappings`**（不新建 `model` 段，避免连带 5 项嵌套段改动）。`Record<string,string>`，model 名→canonical id 映射，消费点 [resolver.ts:114](../../src/lib/models/resolver.ts)。

**触及清单（补全）**：
- [schema.ts:982](../../src/lib/config/schema.ts)（字段名）+ `RECORD_MERGE_STRATEGIES`（[schema.ts:1059](../../src/lib/config/schema.ts) 现绑 `ModelMappingsSchema` 的 per-key 策略，换名后须重绑否则退化 replace）。
- **[compat.ts:159](../../src/lib/config/compat.ts) `CONFIG_MIGRATIONS`**（先前漏）：加一条 `renameLeaf("model_overrides", "model_mappings")`——这是「留旧键读时别名」的**唯一正确归属**（贴现有 renameLeaf 模式）。
- [state.ts](../../src/lib/state.ts)（`DEFAULT_MODEL_MAPPINGS`/`modelMappings` 内部字段）+ [config.ts](../../src/lib/config/config.ts) + resolver.ts + [route.ts:264](../../src/routes/config/route.ts)（`replaceCollection` 路径 + `:191 out.modelMappings` HTTP API 字段）。
- **`config.schema.json`（生成物，须 `scripts/generate-config-json-schema.ts` 重生成）** + `config.example.yaml` + 用户 `config.yaml`（靠 compat 迁移）。
- [normalize-id.ts:16](../../src/lib/models/normalize-id.ts)（仅注释提及，改注释）。
- **doc-sync**：`docs/` 下多份仍引用 `model_overrides`（`model-resolution.md` / `anthropic-compat.md` / `DESIGN.md` / `spec/anthropic-via-openai-translation.md`），落地时 grep 全仓一并同步。

**界定（plan 澄清）**：内部 camelCase 字段 `state.modelMappings` + HTTP config API 字段 `out.modelMappings` 是否同改？倾向只改 YAML 键 + 内部字段一并改（`ui-v4` grep 无 `modelMappings` 消费，无前端涟漪），但 `route.ts:191` 是 config API 契约字段——plan 界定改内部字段是否动 API。

**兼容层（配置享兼容负担、代码不享）**：旧键 `model_overrides` 经 compat renameLeaf 读时映射，配置问题绝不杀进程（warn-continue、热重载安全）。

---

## 7. 测试 / golden / P0 去风险

### 7.1 golden 双区划线（承重，§3.3 落地）

- **等价区** golden（改前锁 HEAD、逐字节）：纯文本、基础 tool_use、usage、stop_reason——直接桥客户端 wire 必须与旧 CC-via **客户端观测等价**（byte-equivalence 仅指客户端边界）。
- **改进区** oracle（独立正确性标准，**绝不用旧 golden**）：reasoning 保真用真 `@anthropic-ai/sdk` accumulator + round-trip 回喂 200；server-tool 请求侧透传用真上游帧序。
- **判定规则（plan 落成用例分类表）**：同一响应对象的**不同字段可跨区**——如 usage 里 `reasoning_tokens` 属改进区（新保真）、其余 usage 字段属等价区。plan 须给一张具体用例→区的分类表，避免实现阶段「该用旧 golden 还是独立 oracle」判断分歧。

**⚠️ 旧 CC-via 输出在改进区是有损基线、批判性参考，拿它当目标 = 焊死损失进新实现，是最阴险的怪味。** RFC 显式划线，避免 reviewer/实现者反射式拿旧 golden 锁死改进区。

### 7.2 P0 去风险验证（Phase 0 已跑，权威 [exp/anthropic-responses-direct/FINDINGS.md](../../exp/anthropic-responses-direct/FINDINGS.md)）

起非-4141 隔离服务器（4157）、独立 history.db、真 GHC 实测（2026-07-14）：
- **(a) 前向 reasoning round-trip ✅ 可行**：实测 `added`(enc 1600) ≠ `done`(enc 1684) 两版不同 blob（GPT MAJOR 属实）；回喂 `done`/`added`/**空** encrypted_content **全 200**。→ **Responses reasoning 端点根本不 gate encrypted_content**（非 400 墙）。保真续接用 **`done` 权威版**（修现有 CC 桥 `responses-to-cc-stream.ts:66` 的 added 捕获）。
- **(c) server-tool 请求侧透传 ✅ 可行 + nuance**：`/responses` 原生返 `web_search_call`（keys=`action/id/status/type`，**无 encrypted_content**，GPT BLOCKER 核心属实）；responses↔responses passthrough 靠 opaque `id` round-trip 200；但 **anthropic-facing 渲染须降级**（转 Anthropic `web_search_tool_result` 需 encrypted_content、web_search_call 没有 → 合成撞 Anthropic 400 墙）。
- **(b) 反向 reasoning round-trip ⏳ 部分**：反向路由工作（200）但当前 CC-via 丢 Claude thinking；端到端 round-trip **留 Phase 4/5 桥就位后复验**（两半旁证：responses 侧宽松接受任意 reasoning item + Claude 侧真签名不篡改过 quarantine）。

为成功而设计、实测坐实（`empirical-verification`：实测 > 推断）。**探针未证伪方向**，反而发现 Responses reasoning 端点比设想更宽松（§1.2 分水岭对 reasoning 路径不成立——它不 gate；只对 anthropic-facing 的 web_search 渲染成立）。

---

## 8. 迁移 / commit invariants

cell-assembly hybrid dispatch 结构已备（`MIGRATED_CELLS`），本 RFC 大部分是**桥选择器内部重塑**，但**前向请求腿是例外**（§2.3）：跨 translateOut + prepareWire + retry-baseline 三点，须改 leg/cell 内部 direct 分叉。按 `large-refactor` commit invariants：
- 每 commit 终态不变量、中间态绝不半坏。
- 串联 if→穷尽桥表是纯结构重构，golden 把关（等价区）。**gemini 两 cell（`gemini|MESSAGES`/`gemini|RESPONSES`）虽逻辑不变，仍须在桥表显式声明「暂经 CC」维持穷尽性（R-EXPLICIT）→ 其现有 golden 须验重塑后仍 byte-identical**。
- 安全增量：先纯提取 helper（等价区 golden 兜底）→ 桥表重塑 → 前向请求腿三点改动 → 直接桥流式实现（改进区 oracle）→ round-trip → 配置。
- **plan 第一步先对现 CC-via 输出锁 HEAD golden**（等价区基线），否则「改前锁 HEAD」无基线可锁。

---

## 9. 红线汇总

| 红线 | 内容 | 反面（怪味） |
|---|---|---|
| **R-EXPLICIT** | 全部翻译 dispatch 改穷尽 `(source,target)` 桥表，漏对=编译错 | 只塞一个 `if` 分支 = 往铁板挖洞 |
| **R-NO-INTERNAL-ADAPT** | byte-equivalence 仅指客户端 wire 边界 | 为适配旧内部模块形状扭曲新结构 |
| **R-GOLDEN-TWO-ZONE** | 等价区用旧 golden、改进区用独立 oracle | 拿旧有损 golden 当改进区目标，焊死损失 |
| **R-DIRECTION-ASYMMETRY** | 真 signature 转发与哨兵合成两路径不共享 | 一个「合成 thinking」helper 不分真伪来源 |
| **R-NO-REVIVE** | server tool **请求侧**走工具声明映射；**响应侧结果回显永远降级**（无真密文、不合成） | 响应侧以「直接桥名义」复活合成 `web_search_tool_result` |

---

## 10. gemini 两条同类债务（推迟，不制造第二特例）

`gemini↔responses`、`gemini↔anthropic` 同属 non-CC↔non-CC 经 CC 中转有损，且 gemini 在 codec **parse 阶段**就被归一成 CC（本身可能是 gemini 侧损失点）。推迟合理（无技术耦合，directness 按 `(source,target)` 桥表选即可独立落地），桥表留位。**注意**：gemini 桥表位存在不等于加桥即可——要真 direct 须先把 gemini 的 CC-归一从 parse 移出（否则 direct 桥拿到的已是 CC 形 body）。gemini↔responses 是否也需 direct，取决于 anthropic↔responses direct 的收益验证。

---

## 11. 开放问题（留 plan 或实测裁决）

- **OQ1**：server tool 名称映射的完整覆盖面——anthropic 侧 server tool 全集 → responses 对应工具的映射表，哪些能映射、哪些降级？（plan 审计 `tools[]` schema）
- **OQ2**：`model_translation` `match` 的语法边界——是否支持通配（`*@openai-responses`）？初版只做精确 `model@format`，通配留扩展。
- **OQ3**：场景 B 剥离后，responses reasoning item 若 encrypted 被剥、上游是否要求 reasoning item 至少带某最小结构？（plan P0 探针附带验证）
- **OQ4**：ADR 归属——是否新写 ADR 收窄 CC-hub 适用边界（从「CC-canonical 默认」到「lossless-per-pair 默认、CC 仅在真 `/chat/completions` 腿」）？须收窄的是真正的 ADR [decisions/2026-07-11-universal-codec-translation-matrix.md](../decisions/2026-07-11-universal-codec-translation-matrix.md)（非同名 [RFC 2026-07-11-anthropic-via-openai-translation](2026-07-11-anthropic-via-openai-translation.md)——审查逮到先前 §11 OQ4 误标）。倾向新写 ADR 记录这个第一性设计轴翻转，由 review 裁决。
