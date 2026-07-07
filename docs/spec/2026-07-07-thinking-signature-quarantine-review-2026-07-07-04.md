# Subagent Review 报告 #04：v4 de-stack 设计（架构 + 对抗）

- 日期：2026-07-07
- 对象：[2026-07-07-thinking-signature-quarantine.md](2026-07-07-thinking-signature-quarantine.md) v4
- 裁判轴：长远正确 + 完整；亲手核对代码锚点。
- 结论：**三层形状健壮、PoC 支撑扎实，但不能按 §3.1 原文进入实施**——1 CRITICAL（顺序自伤）+ 数 HIGH/MEDIUM 规格级必修。

## CRITICAL — de-stack 插入点写反，必须终末 pass（主会话已亲自核实）
spec §3.1 原写「接入 `sanitizeAnthropicMessages`（`processToolBlocks` 之前）」。**错**：
- 失败模式 A：de-stack 用某 tool_use 作分隔插两 thinking 间 → 后跑的 `processToolBlocks`（[tool-blocks.ts:91-96](../../src/lib/anthropic/sanitize/tool-blocks.ts#L91) 无 thinking guard 删孤儿 tool_use）删掉它 → thinking 重新相邻 → 400。
- 失败模式 B（更狠）：本已合法 `[T,toolA,T,toolB,T]` 若 toolA 孤儿 → `processToolBlocks` 删 toolA → `[T,T,toolB,T]` 新生相邻 → 400，de-stack 在前则永远看不到、漏防。
- `finalize`（[result.ts:41](../../src/lib/anthropic/sanitize/result.ts#L41)）终末 `filterEmptyAnthropicTextBlocks` 删空 text（含空分隔符）。
- **修正**：de-stack = `sanitizeAnthropicMessages` **最后一个** pass（`processToolBlocks` + `filterEmptyAnthropicTextBlocks` 之后）。放最后额外闭合「processToolBlocks 删孤儿制造相邻、当前无人修」的既有洞。分隔符充分条件 `#thinking ≤ #非thinking+1` **只计 trim 后非空**的非 thinking 块。

## anchor #1 结论：能共存，但需一条架构硬约束（非「天然正交」）
- thinking 不变量层无冲突：de-stack 满足 protection 全部红线（内容 verbatim / 相对序不变 / 不丢块）；protection 的谓词（[thinking-protection.ts:29-43](../../src/lib/anthropic/thinking-protection.ts#L29)）gate 的是 merge/strip pass，不阻止 de-stack。
- **真冲突在反方向**：block-level 模型核心假设「非 thinking 块可被任意 pass 自由删」（[thinking-protection.ts:11-13](../../src/lib/anthropic/thinking-protection.ts#L11)）；de-stack 反过来**依赖分隔符不被后续删** → 正是 CRITICAL 根因 → 解法 = de-stack 放最后（架构硬约束）。
- **必须更新 [thinking-protection.ts:8-15](../../src/lib/anthropic/thinking-protection.ts#L8) docstring**：显式声明「相邻性非受保护属性、de-stack 可在 thinking 间插非 thinking 块」，否则未来维护者依 docstring 判 de-stack 违规、或在其后再加删块 pass 重引 CRITICAL。§8「impl 需核对」升级为「必须改 docstring + 加 de-stack×protection 组合测试」。

## HIGH — de-stack 插入破坏减法 stats 模型
`finalize`（[result.ts:44-47](../../src/lib/anthropic/sanitize/result.ts#L44)）`emptyTextBlocksRemoved = totalBlocksRemoved − orphanUse − orphanResult − thinking`，全链假设 block 只减不增（[payload-rewrites.ts:16-21](../../src/lib/anthropic/payload-rewrites.ts#L16) 明警 whole-pipeline-residual model）。de-stack 插入 → 增 → 残差失真。且 messageMapping（[request-rewrite-adapter.ts:75](../../src/lib/codec/anthropic/request-rewrite-adapter.ts#L75)）不感知插入/重排 → history 归因错位。**修正**：de-stack 终末、自带插入/重排计量项、**不进减法残差**；messageMapping 标合成块为「无 baseline 源」。

## MEDIUM
- **幂等 + byte-lock**：`resanitize`（[codec.ts:322](../../src/lib/codec/anthropic/codec.ts#L322)）每次 retry 重跑整链含 de-stack → 必须严格幂等（`de-stack(de-stack(x))==de-stack(x)` 逐字节）；default=true 穿过所有既有 sanitize fixture → 对无相邻 thinking 请求须严格 no-op，跑绿既有 byte-lock 套件（`tests/pipeline/payload-rewrite-registry.it.test.ts`）。
- **合成标记落地**：标记进上游 wire（上游只收纯 text 无元数据）→ 需 ① 固定 sentinel 常量（无歧义、不像真实产出）② history 侧标注为合成（synthetic-must-be-distinguishable ADR）③ telemetry 单独计数。cache 断点（插标记移 cache 边界致该轮 miss，仅对否则 400 的毒请求、净正，记 docs）。回流良性（确定性重算不自触发 400，安全）。
- **L1/L3 出站 order**：L1 de-stack 与 L3 主动 strip-all 同在出站；若 L3 strip-all 排在 L1 后 → L1 先插标记、strip-all 只删 thinking → 残留孤儿标记。**修正**：L3 strip-all 命中排在 L1 **之前**（strip 掉 thinking → L1 自然 no-op）。
- **跨消息 gap**：§3.1 自标未覆盖跨消息相邻，但**是否真发生 PoC 未证** → impl 期 :4141 专门探针量化，决定是否 L1 就做跨消息。

## LOW
- latest-assistant 未单独隔离：PoC 元凶是中间消息；建议补「de-stack 最新 assistant 毒消息 → 200」探针（block-level 模型强烈支持安全）。
- redacted 混合：de-stack 须按 `type∈{thinking,redacted_thinking}` 双判（§3.1 已注）；测 `[redacted,redacted]` 相邻。

## 已验证正确（放心）
- HIGH-1 原生 env-strategy 成立（[legacy-strategy-adapter.ts:100-103](../../src/lib/pipeline/legacy-strategy-adapter.ts#L100) onResolved 无 ctx；[driver.ts:283](../../src/lib/pipeline/driver.ts#L283) 传带 ctx env）。
- L1 一处覆盖双路径成立（web_search orchestrator 直调 `sanitizeAnthropicMessages`）；L2/L3 不覆盖 web_search（[handler-v4.ts:211](../../src/routes/messages/handler-v4.ts#L211) bypass）→ 需双接入点，spec 已识。
- **tool 配对不受 de-stack 影响**（`processToolBlocks` 按 ID 集合配对、顺序无关）——anchor #2「配对被破坏」担忧不成立；真风险只在 CRITICAL 的分隔符被删。
- config 接线可行（`state.ts` 现成模式）。

## 进入实施前硬约束（规格级，均必修）
1. de-stack = 终末 pass（processToolBlocks + filterEmptyAnthropicTextBlocks 之后）。
2. 分隔符选择不变量：真实分隔符 trim 非空；充分条件只计非空非 thinking 块。
3. stats/messageMapping de-stack 感知（自带计量、标合成块无 baseline 源、不进减法残差）。
4. 幂等 + byte-lock 守卫测试。
5. L1/L3 出站 order 钉死（L3 strip-all 在 L1 前）。
6. protection docstring 更新 + de-stack×protection 组合测试。
7. sentinel 常量 + telemetry + history 合成标记（synthetic-must-be-distinguishable 落地）。
补齐后三层形状健壮完整，风险几乎全集中在 L1 de-stack × 既有 sanitize 链的顺序耦合，修掉即放行。
