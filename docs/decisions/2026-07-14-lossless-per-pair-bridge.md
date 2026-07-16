# ADR：lossless-per-pair 桥为默认，收窄 CC-canonical hub 的适用边界

- **状态**：Accepted
- **日期**：2026-07-14
- **决策人**：用户（2026-07-14 会话）
- **关联**：**收窄** ADR [2026-07-11-universal-codec-translation-matrix.md](2026-07-11-universal-codec-translation-matrix.md)（本 ADR 不推翻其「全矩阵互通」目标，只翻转其「全部经 CC hub 中转」的**机制默认**）；RFC [2026-07-14-anthropic-responses-direct-bridge.md](../rfc/2026-07-14-anthropic-responses-direct-bridge.md)（实施依据）；DESIGN.md「活的架构现状」通用翻译矩阵行；退役 ADR [2026-07-13-server-tool-positioning-and-web-search-retirement.md](2026-07-13-server-tool-positioning-and-web-search-retirement.md)（server-tool 结果回显边界的对照）。

## 背景

[universal-codec-translation-matrix ADR](2026-07-11-universal-codec-translation-matrix.md) 建成 4 入站 × 3 出站的全矩阵互通，机制是 **openai-cc 为 hub 的 hub-and-spoke**——所有跨格式翻译经 CC 中间表示中转，理由是「不建 N² 点对点翻译器、加一个格式只需一对 ↔CC 翻译器」。

但 CC 是三格式里**表达力最弱**的（无 `encrypted_content` reasoning、无 server tool、无 thinking 结构）。当 **non-CC↔non-CC 对**（如 anthropic 客户端 → responses 模型）经 CC 中转时，两端本可表达的能力被中间格式**裁掉**：reasoning 被折成 `reasoning_effort` 标量、thinking 结构丢失、server tool 被 strip。对一个**价值全在于忠实翻译**的代理，这是 richest-data-flow 的违背。

用户裁决：这不是需要绕着走的约束，而是 **CC-as-canonical 这个前提本身错了**的证据——举证责任在产生诡异有损行为的设计一侧。

## 决策

**lossless-per-pair 桥是默认设计轴；CC-hub 只在某条腿真的就是 `/chat/completions` 时才合法。**

即翻转 [universal-matrix ADR](2026-07-11-universal-codec-translation-matrix.md) 的机制默认：
- **旧默认**：所有跨格式对经 CC hub 中转（CC-canonical）。
- **新默认**：每对用**该对最富、无损的桥**。CC-hub 降级为「一端真是 `/chat/completions`（openai-cc 入站、或上游腿本身是 CC）」时的一个**合法桥**，非普适枢纽。

**「N² 爆炸」被夸大**：`messages↔messages` / `cc↔cc` / `responses↔responses` 都是恒等，真正的点对点对没几个。首个落地的直接桥是 **(anthropic ↔ responses)** 对（前向 + 反向六个方向腿全直连，绕开 CC）。

**hub-translate 重塑为 per-pair 显式桥表**（RFC §2）：四个翻译分发器（请求 / 响应非流式 / 前向流 / 反向流）从「CC-canonical 单轴 + 串联 if」改成穷尽 `(source,target)` 桥表（漏对=编译错），消灭「往窄抽象上焊旁路」的挖洞倾向。

## 承重原则（从本决策派生，均已实施 + 审查）

1. **reasoning 全链路 round-trip（决不妥协）**：不止渲染、要可回喂续接。前向复用哨兵签名封装 responses `done` 密文；反向新建**独立** claude-signature 载体搬运**真 Claude 签名**（byte-exact，探针 e 实测 1 字符差即 400）。R-DIRECTION-ASYMMETRY：前向哨兵合成路径与反向真签名转发路径**两套不共享**。
2. **诚实边界 = 物理约束、非妥协**：reasoning 有真密文可 round-trip（Responses reasoning 端点不 gate encrypted_content）；**server-tool 结果回显永远降级**（Responses `web_search_call` 无 encrypted_content、合成撞 Anthropic 400 墙 = 复活退役双跳死坑）。请求侧 server-tool 原生透传合法、响应侧结果降级为 tool_use/text（R-NO-REVIVE）。
3. **两场景 per-pair 配置**：稳定模型完整互填 vs 中途切换模型剥签名保文本——代理无法自动判定（同格式跨模型前缀检测抓不到），交 `model_translation` per-pair `features:['strip-thinking-signature']` 声明。
4. **byte-equivalence 仅指客户端 wire 边界**：等价区（纯文本/基础 tool_use/usage/stop_reason）逐字节对旧 CC-via；改进区（reasoning 保真）用独立 oracle（真 SDK accumulator + round-trip 200），**绝不**拿旧有损 CC golden 焊死改进。

## 影响

- **正向**：anthropic↔responses 对上 CC 中转完全绕开，reasoning/thinking/server-tool 保真；未来加 non-CC↔non-CC 对（如 gemini↔responses）走同一 per-pair 桥表模式独立落地。
- **死码**：`(anthropic,responses)` 对的 CC-via 路径（`reasoning_encrypted_content` 穿 CC 私有字段的桥接）被直接桥取代——DESIGN.md 2026-07-14 架构注记预告的过渡态结束。仅 `synthetic-reasoning.ts` 封装 primitive 复用保留。
- **仍经 CC（未变）**：via-responses（openai-cc/gemini 客户端 → responses 模型）、gemini↔anthropic/responses——这些**推迟**（backlog），因它们一端真是 CC 形或 gemini 在 parse 阶段归一成 CC。
- **文档**：DESIGN.md 通用翻译矩阵行更新（CC-via for anthropic↔responses → 直接桥）；本 ADR 记录设计轴翻转。

## 推翻/收窄的既定决策（record-not-adopted）

- **[universal-matrix ADR](2026-07-11-universal-codec-translation-matrix.md) 的「全部经 CC hub 互通」机制默认** —— **收窄**（非推翻其全矩阵目标）：全矩阵互通仍成立，但 non-CC↔non-CC 对的机制从「CC-via」改为「per-pair 直接桥」，CC-hub 仅在真 `/chat/completions` 腿合法。
- **「保住 CC-hub、直接映射是要被最小化的 N² 特例」框架** —— 推翻（用户 2026-07-14 反锚点纠正）。直接映射是**默认理想**，非遗憾特例。

## 未采纳备选

- **保 CC-hub-as-universal、给 anthropic↔responses 挖一个 direct 洞**（在 hub 里塞 if 分支）——被否。那是「把现有代码当权威、为将就它降格最佳方案」，且退化成往铁板挖洞（R-EXPLICIT 红线）。正确形状是全面显式 per-pair 桥表。
- **N² 点对点翻译器全建**——不需要。恒等对 + 真 `/chat/completions` 腿的 CC 桥覆盖大部分，真正需要直接桥的 non-CC↔non-CC 对没几个（首个 anthropic↔responses，gemini 推迟）。
