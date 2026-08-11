---
状态：Accepted
日期：2026-08-11
决策者：用户（2026-08-11 明确要求「合并 A+B，接受双方得到的分析报告，构造长期最优的版本」）
---

# 统一语义桥权威：合并 A 线 spec 与 B 线 RFC

## 背景：两条线是怎么来的

本仓库对「OpenAI Responses ↔ Anthropic Messages 语义桥」这一个特性，存在**两条互不引用、且都经用户批准**的工作线：

| | A 线 | B 线 |
|---|---|---|
| 权威 | [`docs/spec/2026-08-06-responses-anthropic-semantic-bridge.md`](../spec/2026-08-06-responses-anthropic-semantic-bridge.md) | [`docs/rfc/2026-08-08-anthropic-responses-semantic-bridge.md`](../rfc/2026-08-08-anthropic-responses-semantic-bridge.md) |
| 批准 | 2026-08-06 定稿获批（`a0a53a6f`） | 2026-08-08 逐节获批（`82c0664e`） |
| 计划 | [`docs/plan/2026-08-06-responses-anthropic-semantic-bridge/`](../plan/2026-08-06-responses-anthropic-semantic-bridge/)（P0–P8，7 轮评审） | [`docs/plan/2026-08-08-semantic-bridge/`](../plan/2026-08-08-semantic-bridge/)（32 片 C0–C11，5 轮评审） |
| 进度 | 未实施 | C0 三片已交付；C1.1–C1.3 已落生产代码 |

两者**事实输入相同**（`docs/tmp/2026-08-06-thinking-translation-audit.md`），因此在结论上高度收敛——例如都独立断定「代理不得伪造 Anthropic 签名的 `web_search_tool_result`」（A 的 F7、B 的 §7 红线）。但架构互斥：状态模型、迁移粒度、continuation schema 三处不能同时落地。

## 决策

**B 线 RFC 升为 v2，作为语义桥的唯一权威；A 线的承重贡献并入其中；A 线 spec 与 plan 降为已被取代的设计记录。**

逐项取舍如下。每一项的理由都是**机制**，不是「谁先开始」——沉没成本不是技术论据。

### 1. 状态模型 —— 取 B 的 keyed semantic ledger

B 把 item、part、delta、authoritative 终值、provenance 收进一个可冻结、可 fork 的 ledger；stream 读 transition、non-stream 读 finalized snapshot，**两条路径物理上读同一份状态**。

A 的 `BridgeEmission` 是展示平面的窄 union，不含 item key、delta、终态与来源 identity，流式细状态留在 handler 闭包；其 whole／stream 同源是**handler 合约**（同一 handler 提供 `mapWhole` 与 `bindStream`），靠纪律维持两个入口一致，不是物理合一。

B 的 §1 审计已把「stream/non-stream 多份状态机分别判断同一领域事实」列为现存缺陷，A 的形状对这条缺陷的结构约束弱于 B。

### 2. Item 契约 —— 取 A 的双平面，用 B 的惯用法落地

**这是 A 线最承重的贡献，也是本次合并的核心改动。**

A 要求每个决策同时给出 `presentation` 与 `continuation` 两个平面，类型上禁止「展示降级」隐含「续接丢失」（A 的 N1）。B 全文没有等价的通用契约——它只在 reasoning 域用 `visible`／`opaque`／`carrierAction`／`boundary` 表达该分离。

**后果是可验证的，不是推测**：当前代码 `src/lib/pipeline/semantic/types.ts` 里 `PerOutputItemState.opaque` 的类型是 `ReasoningExchangeItem["opaque"]`——opaque **在结构上被绑死在 reasoning 上**；`SemanticItem` 的 `server-tool-call`／`server-tool-result` 两臂只有 `call`+`arguments` 与 `result`+`output`，**没有任何位置能放续接状态**。同文件有 `serverToolNotRepresentable` 降级码，只表达丢失，没有「已保留待续接」的对偶。

因此 server-tool 续接缺口**不是偶然疏忽，是结构必然**：没有一道类型闸问「这个 item 的续接怎么办」，新增 item 类型天然只回答展示那一半。补一个 carrier record 只修这一个实例；装上双平面才修那一类。

**落地形态**：不引入 A 的 `BridgeDecision` 返回值，而是给 `SemanticItem`（当前**五个**顶层臂）增加**必填**的 continuation 字段，并在同文件写一条**非分布式条件类型断言**兜住全部臂。

`[hard]` **必填字段本身不足以强制。** 实测（tsc 5.9.3 `--strict`）：仅在联合里新增一个缺该字段的臂，**零报错**；只有当消费者无条件访问该字段时才报 `TS2339`。因此「靠必填字段自动拦住新增臂」是**假绿**。承重的是断言的写法：`[SemanticItem] extends [{ disposition: ItemDisposition }] ? true : false`——**方括号包裹使其非分布式**，任一臂缺字段即整体塌为 `false`；写成分布式会分配到各臂再取并集（`true | never` 仍是 `true`），拦不住。形式与实测见 RFC §4.1。

这仍是 A 的 N1 在 B 的惯用法里的等价物，且比 A 原形状侵入更小。

### 3. Continuation carrier —— 取 B 的 v2 envelope，扩 A 的 server-tool record

B 的 `CarrierV2Envelope.kind` 目前只有 `claude-signature | responses-encrypted`。按 A 的 §8 增补可回指的 item reference 与权威完整 item 两类记录。

B 的 §15 与其计划的「未采纳与暂缓」**都没有**列过 server-tool carrier——这是omission，不是已裁决的拒绝，故本决策不推翻任何既有裁决。

B 对私有 carrier 一贯要求「跨 provider 接受性证据 + PoC + 独立 ADR」（它就是这么暂缓 context-management carrier 的）。该门槛**予以保留**，由下面第 5 项的探针满足，不予豁免。

### 4. 迁移策略 —— 取 B 的整方向原子 cutover

这一项**由第 1 项技术性地推出，不是偏好**：ledger 是每请求／candidate 持有整个响应的状态模型。若同一响应里一部分 item 走 legacy translator、另一部分走 ledger，就需要把两条输出流按一致顺序合并——这正是风险所在。**ledger 蕴含整方向切换**；A 的 per-family 粒度是为它自己的 per-item handler 架构配套的。

独立佐证：A 的双轨期存在**未被文档覆盖的洞**——它只给了每个 family 内部的原子性，没有给跨 family 共享排序／状态的迁移不变量。「必然不一致」没有证据，**「不会不一致」也没有保证**。

**代价必须诚实写下**：B 的路径到 C9／C10 之前用户可观察行为零变化，A 的 Phase 2 本可提前交付真实 Web Search 行为。本决策以长远正确优先，接受这个延迟。

### 5. 验证 —— 保留 B 的 C0，补 A 的上游接受性探针

B 的 C0 资产保留原样，不重造：mutation registry 的 coverage 判据**解析 RFC 原文取 join key**、跑 KNOWN-LOSS 生成 JUnit、**排除 `test.skip` 后**做集合精确相等，锚在作者控制不了的外部对象上，判别力强于 A 的 §15.2（后者更全面但一行未实施）。实测复算命令：`bun test tests/openai/semantic-bridge/ tests/helpers/protocol-oracles/`。

**但 A 独有一类 B 完全没有的证据：真实上游接受性探针。** A 的 P0-1 要实测「完整 item／`{type,id}`／`item_reference`／裸 id 哪种最小形态能被真实 Responses 上游接受」，P0-2 是 carrier 通道／byte-exact echo／长度／restart 矩阵。B 的立场是「Live GHC 只采 fixture，不作 merge gate」——这对 reasoning carrier 够用，但**回答不了「哪一种 server-tool reference 被真实上游接受」**。

A 的 F5 已记录既有真实探针证明**完整 `web_search_call` 能被 Responses 端点接受**，同时诚实标注最小形态未定（A 的 N5）。故探针的任务是收窄形态，不是从零证明可行性。

### 6. 事实基线 —— 并入 A 的 F5／F7／F8／F9

F7（不可伪造 Anthropic 签名结果）与 B 的 §7 红线一致，两线独立收敛，予以保留并明确标注双来源。F5、F8（`output_index` 是流式主键、opaque `item.id` 每事件重加密）、F9（web_search 独立流式 lifecycle event）并入 RFC 事实节。

## 未采纳

- **A 的 `BridgeDecision` 返回值形状** —— 双平面的**语义**采纳，**形状**不采纳。理由：ledger 已是状态权威，再引入一个并行的 decision 返回值会制造第二个状态源。改为 `SemanticItem` 必填字段，取得同样的类型强制力。
- **A 的 `migratedKinds` 逐 family 接管** —— 见第 4 项。技术上存在 hybrid（保留 B 的 ledger／golden／shadow，把切换粒度改成「每 family 全 cell 原子」），但它要改写 B 的方向原子不变量，并把 A 那个未闭合的跨 family 洞重新引入。
- **A 的窄 IR `BridgeEmission`** —— 被 ledger 取代。A 自己的 D1 已声明窄 IR 是择优而非必要。
- **新建第三份统一文档** —— 会使 B 计划里大量按节引用失效。改为**增量修订 B 的 RFC 且不重编号**。

## 后果

1. **C1 需要 retrofit，越早越便宜。** 落点是 `PerOutputItemState`（实测 `SemanticItem` 全仓零构造点零消费点，只改它是空操作）。**理由是「趁消费者尚未扩散」**，不是某个具体后继片在等它：C2.1 已于 `b0eb7997` 先行落地，但它落的是 `config-snapshot.ts` 与 envelope/codec 接线、未触及 item 契约——`PerOutputItemState` 至今仍只出现在 `ledger.ts`／`snapshot.ts`／`types.ts`（复算：`rg -l 'PerOutputItemState' src/ tests/`）。排期要求：早于任何开始消费 item 契约的片，且必然早于 C5／C7。给它加必填字段会打破现有 finish fixture——这是有意的。
2. **B 的 RFC 从 Accepted 变为 Accepted v2**，其冻结契约被本 ADR 授权修改。RFC 原有的「不在实现阶段重新裁决已冻结公共契约」仍然有效，本次修改走的是 ADR 授权，不是实现期自行裁决。
3. **新增一个探针片**，作为 C5／C7 的前置门。
4. **A 线 spec 与 plan 标注为已被本 ADR 取代**，保留为设计记录不删除（用户 2026-08-11 已裁决两份并列保留）。
5. **`src/lib/pipeline/semantic/types.ts` 的纪律不变**：RFC 仍是该文件每个形状的权威，改动先回 RFC。本 ADR 与随附的 RFC v2 修订正是该纪律要求的顺序。

## 已实测（本轮独立评审 + 主会话复验）

- **必填字段不足以强制新增臂回答**：tsc 5.9.3 `--strict` 下，仅新增一个缺 `disposition` 的联合臂**零报错**；有判别力的是非分布式条件类型断言（方括号包裹）。本 ADR 与 RFC §4.1 的措辞已按实测改写——**初稿把 TypeScript 联合的性质说强了**，此处留痕以免下次重犯。
- **`SemanticItem` 当前是五个顶层臂**（含 `drop`），初稿写成「四臂」，已订正三处。

## 待验证事项（不得以断言语气引用）

- 双平面必填字段对现有五个 `SemanticItem` 臂的**实际改动面**仍**未实测**（构造点与消费点清单）。C1.4 首步要求先跑一次 `bun run typecheck` 取真实破坏面，不得预估。
- 「ledger 蕴含整方向切换」是机制推理，**未经 PoC 证否**。若实施中发现存在既能保序又能混合 legacy 与 ledger 的构造，应回到本 ADR 重裁第 4 项。
- §6.1 新定义的 `ResponsesServerToolItemType` 受限集合目前**只列了 `web_search_call`**。这是当前唯一有真实证据的 server-tool 类型，**不是穷举结论**；开通其它 server tool 时逐条增补，不要改成裸 `string`。

## 与「快做快合」裁决的关系

用户 2026-08-11 另有「快做快合」裁决（见 CLAUDE.md），取代本项目此前的 SDD 流水线。本 ADR **不是**为动手而设的前置门——合并动作已经做完，本文是该裁决要求的**产物**（「文档不再是前置门，但仍是产物……决策与理由 → `docs/decisions/`」）。

据此，随附的 C1.4／C0.4 两片**不按穷举变异清单写**：只保留「这条判据存在的理由本身」那两处判别力确认，其余按主路径 + 已报错过的路径。这与 CLAUDE.md 中「限的是测多少、不是测得算不算数」一致。

