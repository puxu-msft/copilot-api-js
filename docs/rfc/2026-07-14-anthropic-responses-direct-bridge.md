# RFC：anthropic ↔ responses 直接桥 + hub-translate 重塑为 per-pair 桥选择器

日期：2026-07-14｜状态：**设计定稿（待异模型对抗审查 → plan）**
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
5. **配置重命名** `model.model_overrides` → `model.model_mapping`（留旧键读时别名）。

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

### 1.2 真伪密文分水岭（round-trip 可行性的关键区分）

退役 ADR 的 `exp/encrypted-content-400` 死墙——上游对 `encrypted_content` 要求「真实有效非空 string」，`""`/`null`/占位/缺失全 400——是因为 web_search 双跳**伪造**了空 encrypted_content 回显。

直接桥 round-trip 回传的 reasoning / server-tool 密文全是**上游真实签发的真货**（`exp/synthetic-reasoning-summary-shape/FINDINGS.md` 实测：Responses 流式 reasoning item 携带非空 `encrypted_content`）。回喂真密文 → 有望被上游接受。

**这是 round-trip 物理可行性的分水岭**，也是本 RFC 不复活退役死坑的根本原因：机制完全不同（原生透传真密文 vs 合成双跳伪造密文）。

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

### 2.3 调用点几乎不变

cell 的 `translateOut` / stream translator 调用点（`openai-responses-cell.ts:68` 等）几乎不变，变的是它们背后 hub 函数的**内部 dispatch**。cell-assembly 的出站结构、driver 的 hybrid dispatch 都不动。

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

### 3.2 extract-not-rewrite：提取纯逻辑核，全新最佳实现

直接桥**不是**从零平行手搓一套 anthropic↔responses 映射，也**不是**继承旧两跳的结构。方法：

1. **审计**两跳 `responses→CC→anthropic`（及反向）里的两段现有映射，识别与 CC 无关的**纯块映射逻辑**（tool_use↔function_call、content block↔output item、usage 换算、stop_reason 映射）。
2. **提取**为干净的具名 helper 函数（纯函数，无 CC 依赖）。
3. **全新最佳实现**直接桥，组合这些 helper——跳过 CC 中间表示。
4. 旧 CC-via 实现**降级为事后 regression oracle**（§7），不作为模板或约束。

**承重复用点（不重造）**：
- reasoning round-trip 复用 [synthetic-reasoning.ts](../../src/lib/anthropic/synthetic-reasoning.ts) 的哨兵签名 primitive `copilot-api:synthetic-reasoning:v1:<base64url(encrypted_content)>`。
- 剥离守卫复用 `sanitize/` 的 `stripSyntheticReasoningBlocks`。

### 3.3 红线 R-NO-INTERNAL-ADAPT：byte-equivalence 仅指客户端边界

**⚠️ byte-equivalence 是客户端 wire 边界的概念，绝不指内部模块。** regression oracle 只看客户端观测到什么，永不要求直接桥的内部中间表示去匹配旧 CC-via 的内部形状/命名/模块边界。**为强行适配内部模块而扭曲结构 = 怪味，禁止。** 旧实现只做批判性参考，不为准（旧版本本身也不是最好的）。

---

## 4. round-trip 逐轮数据流（承重、最易出错）

### 4.1 前向 reasoning round-trip（anthropic 客户端 ↔ responses 模型）

1. **轮 1 请求**：anthropic messages body → `translateAnthropicToResponses` → responses body（带 `reasoning.summary:"auto"`，复用已 landed 的请求侧改动）。
2. **轮 1 响应**：responses 上游流出 reasoning item（真 `encrypted_content`）+ 明文 summary delta → 前向流 translator → anthropic thinking 块：明文进 thinking text，`encrypted_content` 经 `synthetic-reasoning.ts` 封装进 `signature`。
3. **轮 2 请求**：客户端原样回传 thinking 块 → `translateAnthropicToResponses` 遇带哨兵签名的 thinking 块 → 剥签名取回**真·上游 encrypted_content** → 重建 responses reasoning item 回喂上游续接。
4. **上游接受性** = P0 去风险验证点（§7）：回喂真密文（非伪造），设计**为成功而设计、不预设 fallback**（遵「决不妥协」），plan 阶段实测坐实。

### 4.2 反向对称（openai-responses 客户端 ↔ Claude 模型 @messages）

Claude 上游流出 thinking 块（真 signature）→ 反向流 translator → responses reasoning item；客户端回传 → `translateResponsesToAnthropic` → 重建 anthropic thinking 块回喂 Claude 上游。

### 4.3 两场景 · 密文有效性 · per-pair 配置

reasoning round-trip 有两个语义不同的场景，**代理无法自动判定**（这是用户在客户端选模型时的主动决策，信息只在用户侧）：

- **场景 A · 稳定模型 · 格式仅名义入口**（默认）：客户端始终用 anthropic-messages 入口，但实际始终访问同一个 `gpt-5.5@openai-responses`。thinking↔reasoning 只是文字游戏——`signature`↔`encrypted_content` 互填、文本互填，**完整 round-trip 保真**。回喂同一上游签发的真密文 → 接受。
- **场景 B · 中途切换模型**：先用 A 格式模型攒上下文，中途切到 B 格式模型。历史里 thinking/reasoning 的 `signature`/`encrypted_content` 是 A 模型上游签发、回喂 B 模型上游必被拒（跨模型密文无效）→ **必须剔除 signature/encrypted，但文本显示内容仍互填**（保上下文连续性）。

**为何必须配置、不能自动判定**：用户从 `gpt-5.5@openai-responses`（场景 A、历史全是我方哨兵密文）切到**另一个** `gpt-6@openai-responses`——仍是我方哨兵、仍是 responses 格式，但密文是 gpt-5.5 上游签的、对 gpt-6 无效。前缀检测抓不到这种**同格式跨模型**失效。密文有效性根本上是用户意图，必须配置声明。哨兵前缀检测保留为**次级安全**（识别外来非哨兵签名，如场景 B 里 Claude 真签名），不作为场景判定唯一依据。

### 4.4 红线 R-DIRECTION-ASYMMETRY：真 signature 转发 vs 哨兵合成两路径

**⚠️ 前向合成哨兵 thinking（靠剥离守卫兜底）与「反向绝不合成 thinking」是不同方向的不同契约。** 反向（Claude 上游真 thinking → responses 客户端）转发的是**真 Claude signature**，不是我方哨兵。若实现里两向共用一个「合成 thinking」helper 不分真伪来源，会污染。**真 signature 转发**与**哨兵合成**定为两个不共享的路径。

---

## 5. server tool 通用透传 + 诚实边界

### 5.1 通用策略（取代 web_search 特例）

直接桥对 anthropic 侧 server tool 采用「能映射就原生透传、映射不上就降级」：
- anthropic `web_search_20250305`（前缀 type + Anthropic schema）→ responses `web_search_preview`（不同参数，**名称鸿沟映射非零工作**）→ 让 **responses 上游原生执行**。
- 结果回显：responses 搜索结果的 encrypted_content 是**真·上游签发** → 与 reasoning 同构、物理上可 round-trip（受 §4.3 per-pair `features` 同样调制：跨模型切换须剥离）。
- 映射不上的 server tool → 降级为普通 tool_use / text（诚实边界）。

### 5.2 红线 R-NO-REVIVE：不复活退役双跳

**⚠️ server tool 透传不复用退役双跳的任何合成代码（那套 `web-search/synthesize.ts` 已删）。** 直接桥是**纯请求侧工具声明映射** + 让上游原生干活，机制与退役双跳（第二跳搜索后端 + 合成结果）完全不同。若实现里试图复活合成 = 怪味。RFC 明确：server tool 走「工具声明映射」，不走「结果合成」。这不与退役 ADR 冲突——退役的是**合成双跳**，本 RFC 做的是**原生透传**。

### 5.3 诚实边界总表（区分真伪、非妥协）

| 能力 | 直接桥行为 | 边界性质 |
|---|---|---|
| reasoning 明文 | 完整互填保真 | 无损 |
| reasoning encrypted_content（真密文） | 完整 round-trip（场景 A）/ 剥离保文本（场景 B，per-pair feature） | 物理边界，非妥协 |
| server tool 请求侧 | 原生透传 + 名称映射 | 映射不上才降级 |
| server tool 结果回显（真密文） | round-trip（场景 A）/ 降级（场景 B 或映射不上） | 与 reasoning 同构 |

---

## 6. 配置

### 6.1 `model_translation` 新段（key = ingress format）

`ingress` 是有限枚举（`anthropic-messages` / `openai-cc` / `openai-responses` / `gemini`）→ 提为 map key，每个 ingress 挂一组 match 规则。可扩展容器，未来纳入更多翻译特性：

```yaml
model_translation:
  anthropic-messages:
    - match: gpt-5.5@openai-responses   # 仅当 model_mapping 等最终把路由定到 model=gpt-5.5 且走 openai-responses format 时生效
      features: ['strip-thinking-signature']
```

- **key = ingress format**（客户端入口格式），**value = 有限规则列表**。
- `match: <model>@<format>` = 对**最终路由结果**（经 model_mapping 解析后的真实上游 model + format）匹配，非对客户端原始 model 名匹配——匹配发生在路由裁决**之后**。
- `features: [...]` = 该配对生效的翻译特性列表（首个特性 `strip-thinking-signature` = 声明场景 B）。默认无 `features` = 场景 A 完整互填。

### 6.2 配置重命名 `model_overrides` → `model_mapping`

`model.model_overrides`（`Record<string,string>`，model 名→canonical id 映射，消费点 [resolver.ts:114](../../src/lib/models/resolver.ts)）→ 重命名 `model.model_mapping`（更贴切：做的是 model 名→上游 model/format 映射）。触及 [schema.ts](../../src/lib/config/schema.ts) / [state.ts](../../src/lib/state.ts) / [config.ts](../../src/lib/config/config.ts) / resolver.ts / [normalize-id.ts](../../src/lib/models/normalize-id.ts) / [route.ts](../../src/routes/config/route.ts) + config.yaml 文档。

**兼容层（配置享兼容负担、代码不享——项目配置哲学）**：留旧键 `model_overrides` 读时别名映射到 `model_mapping`，配置问题绝不杀进程（warn-continue、热重载安全）。

---

## 7. 测试 / golden / P0 去风险

### 7.1 golden 双区划线（承重，§3.3 落地）

- **等价区** golden（改前锁 HEAD、逐字节）：纯文本、基础 tool_use、usage、stop_reason——直接桥客户端 wire 必须与旧 CC-via **客户端观测等价**（byte-equivalence 仅指客户端边界）。
- **改进区** oracle（独立正确性标准，**绝不用旧 golden**）：reasoning 保真用真 `@anthropic-ai/sdk` accumulator + round-trip 回喂 200；server tool 用真上游帧序。

**⚠️ 旧 CC-via 输出在改进区是有损基线、批判性参考，拿它当目标 = 焊死损失进新实现，是最阴险的怪味。** RFC 显式划线，避免 reviewer/实现者反射式拿旧 golden 锁死改进区。

### 7.2 P0 去风险验证（plan 第一 task）

起非-4141 隔离服务器、独立 history.db、烧少量真实额度，坐实：
- **(a)** responses 上游接受回喂的**真** reasoning encrypted_content 续接（场景 A）。
- **(b)** server tool 真密文回显 round-trip。

为成功而设计、实测坐实（`empirical-verification`：实测 > 推断），非事前 fallback。若探针证伪 → 是真发现须升级，非预设降级。

---

## 8. 迁移 / commit invariants

cell-assembly hybrid dispatch 结构已备（`MIGRATED_CELLS`），但本 RFC 是**桥选择器内部重塑**非 cell 迁移。按 `large-refactor` commit invariants：
- 每 commit 终态不变量、中间态绝不半坏。
- 串联 if→穷尽桥表是纯结构重构，golden 把关（等价区）。
- 安全增量：先纯提取 helper（等价区 golden 兜底）→ 桥表重塑 → 直接桥实现（改进区 oracle）→ round-trip → 配置。

---

## 9. 红线汇总

| 红线 | 内容 | 反面（怪味） |
|---|---|---|
| **R-EXPLICIT** | 全部翻译 dispatch 改穷尽 `(source,target)` 桥表，漏对=编译错 | 只塞一个 `if` 分支 = 往铁板挖洞 |
| **R-NO-INTERNAL-ADAPT** | byte-equivalence 仅指客户端 wire 边界 | 为适配旧内部模块形状扭曲新结构 |
| **R-GOLDEN-TWO-ZONE** | 等价区用旧 golden、改进区用独立 oracle | 拿旧有损 golden 当改进区目标，焊死损失 |
| **R-DIRECTION-ASYMMETRY** | 真 signature 转发与哨兵合成两路径不共享 | 一个「合成 thinking」helper 不分真伪来源 |
| **R-NO-REVIVE** | server tool 走工具声明映射，不复活退役合成双跳 | 复活 `web-search/synthesize.ts` 类合成 |

---

## 10. gemini 两条同类债务（推迟，不制造第二特例）

`gemini↔responses`、`gemini↔anthropic` 同属 non-CC↔non-CC 经 CC 中转有损，且 gemini 在 codec **parse 阶段**就被归一成 CC（本身可能是 gemini 侧损失点）。推迟合理（无技术耦合，directness 按 `(source,target)` 桥表选即可独立落地），桥表留位。gemini↔responses 是否也需 direct，取决于 anthropic↔responses direct 的收益验证。

---

## 11. 开放问题（留 plan 或实测裁决）

- **OQ1**：server tool 名称映射的完整覆盖面——anthropic 侧 server tool 全集 → responses 对应工具的映射表，哪些能映射、哪些降级？（plan 审计 `tools[]` schema）
- **OQ2**：`model_translation` `match` 的语法边界——是否支持通配（`*@openai-responses`）？初版只做精确 `model@format`，通配留扩展。
- **OQ3**：场景 B 剥离后，responses reasoning item 若 encrypted 被剥、上游是否要求 reasoning item 至少带某最小结构？（plan P0 探针附带验证）
- **OQ4**：ADR 归属——是否新写 ADR 收窄 [CC-hub ADR](2026-07-11-anthropic-via-openai-translation.md) 的适用边界（从「CC-canonical 默认」到「lossless-per-pair 默认、CC 仅在真 `/chat/completions` 腿」）？倾向新写 ADR 记录这个第一性设计轴翻转，由 review 裁决。
