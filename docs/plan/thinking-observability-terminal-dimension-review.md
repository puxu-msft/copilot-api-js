# 对抗性审查:thinking 可观测性合并方案

> **类型**：对抗性审查报告 —— 非独立 plan，实施状态见父 plan [thinking-observability-terminal-dimension.md](thinking-observability-terminal-dimension.md)。

裁判轴:长远正确 + 完整 + richest-data-flow + single-source-of-truth；YAGNI 仍成立。

## 结论速览

方案的**方向是对的**(合并 thinking/thinking-wire、单锚点发一次、消费者渲染 delta),但 `{requested, effective}` 这个 detail 形状在 **type 维度上窄化了**——它把 thinking 这个多子维度信号坍缩成只剩 `type`,而真实让 wire ≠ requested 的变换里**有几条根本不改 type**(budget clamp、effort clamp、budget→effort 映射)。于是新模型会在这些路径上判 `requested===effective`→渲染 `thinking:adaptive`,**谎称"无 coercion"而其实发生了 coercion**。这是用一个新的、更体面的数据模型把旧的盲点固化下来。详见 HIGH-1 / HIGH-2。

逐条如下。

---

## CRITICAL

无。方案不引入数据丢失、竞态、资源泄漏或协议破坏——它是 display-only 信号重构,history/wire 真相不动(`inboundRequest.payload.thinking` / `outboundRequest.payload.thinking` 始终持久化,方案正确识别了这点 plan:9)。

---

## HIGH

### HIGH-1 `effective = wire thinking type` 漏掉所有"改 thinking 但不改 type"的变换路径(对抗追问 4,真问题)

方案把 `effective` 定义为"post `coerceAdaptiveThinking` 的 wire thinking type"(plan:16)。但 prepare 链里改 thinking 的 step 有三个,只有第一个改 type:

- `coerceAdaptiveThinking`(request-preparation.ts:360)——`enabled→adaptive`,**改 type**。✓ 被捕获
- `adjustThinkingBudget`(request-preparation.ts:384)——`{type:"enabled", budget_tokens}` 的 budget 被 min/max/max_tokens clamp(request-preparation.ts:396-411),**type 不变**。✗ 不可见
- `clampEffortLevel`(request-preparation.ts:575)——`output_config.effort` 被 clamp 到模型白名单(request-preparation.ts:599-607),**完全不在 `thinking` 对象里**、更不改 thinking.type。✗ 不可见
- `coerceAdaptiveThinking` 的 `best_effort` 分支(request-preparation.ts:371-377)——把 `budget_tokens` 映射成 `output_config.effort`,**这是 thinking 意图的实质改写**,但只改 type 的请求(enabled→adaptive)会让 requested/effective 都等于变化前后的 type,effort 的新增完全不体现。

后果:client 发 `thinking:enabled` + `budget_tokens:64000` 给一个 max=32000 的模型 → budget 被砍半 → 但若该模型非 adaptive-only(coerce 不触发),`requested.type==="enabled"===effective.type` → 渲染 `thinking:enabled`,**console 谎称"原样透传",而 budget 实际被腰斩**。同理 effort 被 clamp(opus-4.7 只支持 medium、client 发 high)时,thinking.type 全程不变,coercion 对 console 完全隐形。

为什么是真问题:方案在 Context 里把"是否发生 coercion、从什么到什么"称作"the only valuable part"(plan:8),然后又把可观测维度锁死在唯一一个**最不常被 coerce 的子维度**(type)上。这不是 YAGNI 取舍——budget/effort clamp 是**已存在、已在跑、会真实改写 wire** 的代码路径(不是投机性未来能力),它们产生的 coercion 当前就发生、就该被看见。`{requested, effective}` 若只承载 type,等于给"显示 coercion"这个明确目标做了一个结构上无法达成的实现。

**判断**:`type` 不是恰当边界。最长远正确的 `effective`/`requested` 应是 thinking 的**结构化指纹**而非单 string——至少覆盖 `{type, budget_tokens?, effort?}`(effort 取自 `output_config.effort`,因为 best_effort 把它当 thinking 的一部分在写)。渲染时对发生变化的子维度做 delta。否则这是又一个窄化半成品,只是比现状体面。

### HIGH-2 `requested` 取 `env.body.thinking?.type` 与 `effective` 取 wire,两者跨过了 budget/effort 变换,使 "requested===effective ⇒ 无 coercion" 成为**假命题**(对抗追问 1,真问题)

承 HIGH-1 但独立成条,因为它攻击的是 plan:22 的渲染逻辑本身:`requested && requested !== effective → 显示 delta;else → 显示单值`。这个 `else` 分支的前提是"type 相等 ⟺ 无变换"。如前所述该前提为假。于是渲染逻辑会在 budget/effort 被改时落入 `else`,**主动把一个"发生了 coercion"的请求渲染成零冗余的单值 `thinking:adaptive`**——比现状(`thinking:adaptive, thinking-wire:adaptive` 至少两个 tag 都在)更糟:现状的冗余 tag 虽然没显示 budget,但不会**断言**"没变";新方案的单值渲染是一个 positive claim。

richest-data-flow 视角:生产者(prepare,既知 budget 改没改、effort clamp 没 clamp)把这些丰富信息丢弃,只发 type,然后让 console 这个消费者在缺失信息的前提下做 delta 判断。这恰好违反"生产者发最丰富数据、消费者末端决策"——正确做法是 prepare 把它**实际改了哪些子维度**作为自包含 detail 发出(它是唯一同时持有 before/after 全部子维度的点),而非只发 type 让消费者用残缺数据推断。

### HIGH-3 retry 路径上 `effective` 的"最新一次"语义可能漏掉中间 attempt 的 coercion(对抗追问 4 的衍生,需方案显式处理)

方案称 prepare-after 锚点"runs per-attempt and so also covers retries"(plan:29)。但 console 的 feature 累积是**按 tag 字符串去重**(console.ts:139 `!entry.tags.includes(tag)`),且 `[ OK ]` 行只渲染最终 `entry.tags` 集合。设想:attempt-1 因 `legacy-thinking-retry`(pipeline.ts:174)触发——这条 strategy 正是为捕获 400 后把 thinking 自愈成 adaptive 而存在(request-preparation.ts 注释提到双层防御)。若 attempt-1 prepare 发 `thinking:enabled→adaptive`,attempt-2(strategy 已注入 hint)prepare 发 `thinking:adaptive`(已是 adaptive,requested===effective)——两个不同 tag 都进 `entry.tags`,console 最终行会**同时显示** `thinking:enabled→adaptive, thinking:adaptive`,既冗余又矛盾。

旧的 `thinking-wire` 双 kind 设计下也有这问题,但旧 handler-v4 retry 锚点(handler-v4.ts:455 `getLatestEffectiveThinking`)是**读"最新 effective"覆盖语义**,每次 retry 刷新单一来源。方案删掉这个锚点(plan:36)、改成纯靠 per-attempt prepare 自发,**丢掉了"最新覆盖"语义、退化成"每 attempt 各发各的并集"**。这是 richest-data-flow 里"生产者不替消费者决策"被误用的反例:console 需要的是"这个请求最终的 requested→effective",而非每次 attempt 的逐条。

**判断**:方案需要显式定义 retry 下的合并语义(要么 console 按 feature kind 而非 tag string 做 last-wins 覆盖,要么锚点保留"latest"语义)。当前 plan 文本默认 per-attempt 自发即正确,是漏掉的边界。注意 plan:39 自己也标记了 `getLatestEffectiveThinking` 删除需 dead-code check——但它没意识到这个 helper 承载的"latest 覆盖"语义正是 retry 正确性所需,删了不是纯清理。

---

## MEDIUM

### MEDIUM-1 feature tag 是否该持久化:方案在"不持久化"前提上优化,但未论证该前提(对抗追问 2)

方案正确指出 thinking 真相已在 payload 持久化、feature tag 是 display-only(plan:9)。但它**把"feature_applied 不进 history"当既定事实接受并据此优化**,没评估这是否是正确终态。

考量:thinking coercion(尤其 HIGH-1 的 budget/effort clamp)是一个**对调试有真实价值的历史事实**——"为什么这次请求的 thinking budget 和我发的不一样"是会被回溯的问题。当前要回答它,得人肉 diff `inboundRequest.payload.thinking` vs `outboundRequest.payload.thinking`(两个 payload 都在,理论上可推导)。所以 feature tag 不持久化**不构成数据丢失**(payload 是 source of truth)——这点方案是对的,持久化 feature tag 会违反 single-source-of-truth(coercion 可从两 payload 推导,额外存 = 派生数据冗余)。

**判断**:方案默认"不持久化"在此处**恰好正确**,但理由是"可从 payload 推导"而非方案给的"前端不消费"。这两个理由结论相同但若哪天前端要展示 coercion badge,正确做法是**前端从已持久化的两个 payload 推导**(richest-data-flow:统一数据源多端消费),而不是去让 feature_applied 进 history。方案对 ws/frontend "no change"(plan:44)的处理是对的,但应在 plan 里把这个推导关系写明,免得未来有人误以为"前端要 badge 就得持久化 feature"。这是文档完整性缺口,非设计缺陷。

### MEDIUM-2 既然真相在 payload,console 的独立 recordFeature 通道是否冗余?(对抗追问 3)

追问质疑:能否彻底取消 feature tag、console 从 payload 推导。**判断:不能,feature 通道有 payload 无法替代的价值,方案保留它是对的。**依据:

- console sink 消费的是 `RequestContextSnapshot`(events.ts:66),**不含 payload**——console 刻意不让 sink 闭包 over 重对象(events.ts:14 设计属性)。让 console 反序列化/读 payload 来推导 thinking 会违反这个边界、把重数据拖进实时日志路径。
- feature 是**实时**信号(prepare 时即发),payload diff 是终态。console footer/OK 行要的是前者。

所以"合并成单一 feature"确实比"消除整个通道"更恰当——后者是错误的过度简化。但这反过来加强 HIGH-1:既然 console 注定看不到 payload、只能靠 feature detail,那 detail **更**应该自包含足够子维度,否则 console 永远无法显示 budget/effort coercion。

### MEDIUM-3 `FeatureKind` doc 注释与方案新 shape 不一致,且 `thinking-wire` 注释里写的是 `{type: string}` 而 thinking 写 `{type: "adaptive"|"enabled"}`——合并后类型收窄需小心

events.ts:116-119 当前:`thinking` 注释 `detail: {type: "adaptive"|"enabled"}`,`thinking-wire` 注释 `detail: {type: string}`。方案要合并成 `{requested?: string, effective: string}`(plan:43)。注意 wire 侧 type 可以是 `adaptive` 以外的值(adjustBudget 后仍是 `enabled`,或其他),所以新 `requested`/`effective` 必须是 `string` 而非字面量联合——方案写的是 `string`,正确。仅提示:删 `thinking-wire` 时确认无 exhaustive switch 依赖(方案 plan:43 已自查 `renderFeatureTag` 是 `string`+default、`retryMetaFeature` 不返回 thinking,这点正确)。

---

## LOW

### LOW-1 `renderFeatureTag` 的 `→` 约定复用合理,但 delta 字符串需考虑多子维度后的可读性

plan:22 用 `thinking:enabled→adaptive`,复用同函数 `ws→http` 约定(console.ts:447 附近)。若采纳 HIGH-1 的多子维度修复,delta 渲染会变复杂(如 `thinking:enabled(budget 64k→32k)`)。这不是当前方案的缺陷,而是修 HIGH-1 时的下游设计点——提前标记,避免又渲染成只显示 type 的窄化。

### LOW-2 plan:51 "optional 测试"对 retry 多 attempt 合并语义无覆盖

方案的测试(plan:50)只覆盖 `renderFeatureTag` 纯函数的 equal/differ/missing 三态,不覆盖 HIGH-3 的 retry 并集/覆盖语义。若 HIGH-3 成立,这是测试盲区——单测 renderFeatureTag 全绿不能证明 retry 下 console 行正确。

---

## 哪些方案已正确(避免误伤)

- 识别 feature tag 为 display-only、thinking 真相在 payload 持久化(plan:9)——✓ 准确,我核对 history.ts:155 确实消费 feature_applied 但不写 thinking 真相,payload 是 source of truth。
- 单锚点 prepare-after 是"唯一同时持有 requested+effective"的点(plan:29)——✓ 准确,codec.ts:387 和 pipeline.ts:145 确实是 wire thinking 成形后、两值在 scope 的点。
- 删除 6 个散落 recordFeature、收敛到 2 个 per-path 锚点的方向——✓ 符合 single-source-of-truth,散落点(request-rewrites.ts:84 发 sanitized client 值、codec.ts:389 发 wire 值)本就是"两个采样点让消费者 diff"的反模式。
- ws/frontend no-change(plan:44)——✓ 正确,ws.ts:120 转发但前端 union 不含 `feature_applied`,合并不影响。
- `getLatestEffectiveThinking` 死代码检查(plan:39)——✓ 我核实全仓仅 handler-v4.ts:455 一处消费,删锚点后确成死代码;**但**见 HIGH-3,它承载的 latest 语义不是纯噪声。

---

## 给主线的最小行动建议(不给完整替代方案,只点问题)

1. **必须**:把 `{requested, effective}` 从 `string` 升为结构化(至少 `{type, budget_tokens?, effort?}`),否则 budget/effort coercion 永久隐形且被误判为"无变化"(HIGH-1/2)。或者:显式文档化"本方案只可视化 type 维 coercion,budget/effort coercion 不可见"作为暂缓项(architecture-health-first 要求暂缓项完整记录根因/理想架构/为何暂缓)。
2. **必须**:定义 retry 下 console 的 thinking 合并语义(last-wins vs 并集),别默认 per-attempt 自发即正确(HIGH-3)。
3. 建议:在 plan 里写明"未来前端 badge 应从两 payload 推导、而非持久化 feature"(MEDIUM-1),封住误导。
