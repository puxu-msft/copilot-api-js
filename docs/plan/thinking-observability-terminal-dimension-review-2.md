# 对抗性审查:thinking observability 合并为 `{requested, effective}` 方案

> **类型**：对抗性审查报告 —— 非独立 plan，实施状态见父 plan [thinking-observability-terminal-dimension.md](thinking-observability-terminal-dimension.md)。

## 裁判轴
长远正确 + 完整。下列为亲自读 file:line 后确认的真实缺陷,按严重度排。不赞同方案"display-only、无行为变化、安全"的自我定性 —— 它在重试维度引入了**新的归因错误 + 跨 attempt 矛盾展示**,这两点是 display 正确性问题。

---

## 当前事实基线(读码确认)

- **当前 requested 信号唯一来源**:`src/lib/codec/anthropic/request-rewrites.ts:83-85`(S3),发 `recordFeature("thinking", { type: sanitized.thinking.type })`——基于 **sanitize 后的客户端原始请求**,**只发一次**(S3 在重试循环之外,`driver.ts:140` 在 `runExchange` 之前),整个请求生命周期不随重试变化。
- **当前 effective 信号来源**:`src/lib/codec/anthropic/codec.ts:387-390` `prepareAnthropicWire` 读 `prepared.wire.thinking.type`,发 `thinking-wire`。`prepareWire` 在 `runExchange` 循环内 **per-attempt** 调(`driver.ts:241`)。
- **当前 `prepareAnthropicWire` 不读 `env.body.thinking`**——方案要新增这个读取作 requested。
- **重试 mutate env.body 确认**:`legacy-strategy-adapter.ts:79-97` `legacy.handle` 返回的 `action.payload`(legacy-thinking-retry.ts:80-84 把 thinking 改成 `{type:"adaptive"}`)→ `env.with({ body: action.payload })` → `driver.ts:294` `current = action.env` → 下一轮 `driver.ts:241` `prepareWire(current)` 读到的 `current.body.thinking` 已是 adaptive。
- **console 去重**:`console.ts:139` `if (tag && !entry.tags.includes(tag)) entry.tags.push(tag)`——精确整串去重,无"同维度(同 feature 前缀)替换/去重"。
- **gate**:方案明文"`effective !== "disabled"` 才发"(design L18),与现状一致。

---

## CRITICAL #1 — 重试场景 coercion 归因丢失(方案明确点名的 #1,成立)

**触发**:老客户端发 `thinking:{type:"enabled"}` 给一个 `modelHasAdaptiveThinking` **检测漏判**的 adaptive-only 模型(metadata 缺 + 名字不在 allowlist —— 正是 legacy-thinking-retry 存在的理由,strategy.ts:13-16 docstring)。

**链路**:
- attempt 0:`coerceAdaptiveThinking`(request-preparation.ts:360)因检测漏判**不触发**,wire.thinking 仍 `enabled`。`env.body.thinking` = `enabled`。方案锚点发 `recordFeature("thinking", { requested:"enabled", effective:"enabled" })` → console 渲染 `thinking:enabled`。
- 上游 400,legacy-thinking-retry(strategy.ts:80-84)把 **env.body.thinking 改成 adaptive**。
- attempt 1:`prepareAnthropicWire(current)` 读 `current.body.thinking` = **adaptive**(已被 strategy mutate)。wire.thinking 也 adaptive。方案锚点发 `{ requested:"adaptive", effective:"adaptive" }` → console 渲染 `thinking:adaptive`。

**缺陷**:attempt 1 把"requested"读成 **adaptive**——但**客户端原始请求是 enabled**,是被上游策略(legacy-thinking-retry)改写的。新模型把"已被重试策略 mutate 的 env.body"当作"客户端请求",于是这次真实发生的 coercion(enabled→adaptive,由 strategy 完成)在 console 上**完全不可见**,显示成 `thinking:adaptive`,运维者看不出"客户端发的是旧形状、被自愈了"。

**对比当前 thinking-wire**:当前 requested 信号(S3,request-rewrites.ts:84)是 sanitize 后客户端请求,**只发一次且不随重试漂移**,值永远是 `enabled`(客户端真实意图)。所以当前 `thinking:enabled, thinking-wire:adaptive` 反而**诚实地**把"客户端要 enabled、wire 最终 adaptive"展示出来了(虽然啰嗦)。**方案用 per-attempt 的 env.body 当 requested,反而把当前已正确表达的 coercion 归因弄丢了**。

**为何是真问题(非风格)**:legacy-thinking-retry 的整个存在目的就是"prepare-time coerce 漏判时的反应式自愈"。这条路径上的请求恰恰是**最需要可观测**的——运维者要知道"我的模型 metadata 没标 adaptive、靠 400 自愈在兜底"。方案在这条路径上把信号抹成 `thinking:adaptive`(看起来像一切正常),正好瞎在最该看见的地方。

**哪个语义更诚实**:requested 应锚定**客户端原始 / sanitize 后请求**(单次、不随重试 mutate),而非 per-attempt 的 env.body。方案当前取 `env.body.thinking` 作 requested 是错的取值点。

---

## CRITICAL #2 — 跨 attempt 同维度冗余/矛盾标签(方案明确点名的 #2,成立)

**触发**:同 #1 的重试场景(coerce 漏判 + legacy-thinking-retry 自愈),但**检测命中的普通 coercion 路径也会触发另一变体**(见下)。

**链路(承 #1)**:
- attempt 0 锚点发 `{requested:"enabled", effective:"enabled"}` → tag = `thinking:enabled`,push 进 `entry.tags`。
- attempt 1 锚点发 `{requested:"adaptive", effective:"adaptive"}` → tag = `thinking:adaptive`。
- `console.ts:139` 精确字符串去重:`thinking:adaptive !== thinking:enabled`,于是**两个都留**。
- 最终 `[ OK ]` 行 extra = `(thinking:enabled, thinking:adaptive)`——**同一请求同一维度出现两个 thinking 标签**,且二者矛盾(一个说 enabled 一个说 adaptive),运维者无法判断到底跑了哪个。

**更糟的变体(coerce 命中路径)**:模型检测命中、attempt 0 就 coerce:
- attempt 0:`env.body.thinking`=enabled(coerce 不写回 env.body,只改 wire——request-preparation.ts:380 改的是 `wire.thinking`,且 buildWirePayload deep-clone 了 thinking 进 wire,见 L291/296),wire.thinking=adaptive。锚点发 `{requested:"enabled", effective:"adaptive"}` → tag `thinking:enabled→adaptive`。
- 若该请求又因**别的** 400(如 unsupported-beta / effort)重试:attempt 1 `env.body.thinking` 仍 enabled(那些 strategy 不碰 thinking),wire 仍 coerce 成 adaptive。锚点又发 `{requested:"enabled", effective:"adaptive"}` → tag `thinking:enabled→adaptive`——**与 attempt 0 整串相同,被去重**。这个变体侥幸不冗余。

但 #2 主链路(legacy-thinking-retry)**必然**产生两个不同串、必然双标签。

**为何是真问题**:方案声称"单 tag、一眼看清"是核心卖点(design L25),但在重试维度它**反而比当前更糊**——当前 thinking 维度无论多少 attempt 最多两个固定 tag(`thinking:X` + `thinking-wire:Y`,各只发一次:S3 一次 + 每 attempt 的 wire 但整串常相同被去重)。方案的 per-attempt requested 漂移**制造了新的、跨 attempt 的同维度矛盾标签**,而方案**完全没有处理跨 attempt 的同维度去重**(没有"同 `thinking:` 前缀只保留最新一个"的逻辑)。这是方案自身卖点的反例。

**注**:`recordRetryPipelineStateV4`(handler-v4.ts:455-458)被方案删除——但它读 `codec.getLatestEffectiveThinking()`(=最新 attempt 的 `env.body.thinking`,codec.ts:442 `effectiveThinking: effBody.thinking`)。当前这个 retry 站点同样发 per-attempt thinking,**当前就可能有跨 attempt 冗余**;但当前发的是 `thinking-wire` 之外的 `thinking`(单维度),且值多来自 sanitize 后请求。方案把"requested+effective"合并后,**冗余的语义代价被放大成"矛盾的 transition 串"**。删 handler-v4 retry 站点是对的方向,但把锚点的 requested 取成 per-attempt env.body 是把问题搬了家而非解决。

---

## HIGH #3 — "thinking 被完全关掉"的 coercion 被 gate 吞掉

**触发**:`requested` 非 disabled(客户端要 thinking),但某变换把 `effective` 变 disabled。

**读码核对 gate**:方案与现状都是 `effective !== "disabled"` 才发(design L18 / codec.ts:388)。若 effective=disabled 则**整条不记**,即使 requested=adaptive/enabled。

**是否真存在 effective→disabled 的变换**:
- `coerceAdaptiveThinking` 只 enabled→adaptive,不产 disabled。
- `adjustThinkingBudget` 只改 budget_tokens,不改 type。
- `stripUnsupportedStructuredOutputs` 只动 output_config。
- 但 `buildWirePayload`(request-preparation.ts:268-312)按 `collectRejectedFields` strip 整个字段:**若 `thinking` 被学进 negotiation cache 的 reject 集合 / 或 config `reject_body_fields` 含 `thinking` / 或 `"*"`**,则 wire 里 thinking 被整字段删除 → `wire.thinking` = undefined → `wireThinking?.type` falsy → 不记。此时"客户端要 thinking、被剥光"完全不可观测。

**严重度定 HIGH 非 CRITICAL**:thinking 被 reject-field strip 是边角配置(需 operator 显式或学习把 thinking 列入 reject)。但**这恰是最该可观测的 coercion**(客户端要 thinking、代理悄悄剥掉,行为差异巨大)。方案沿用旧 gate 是合理的"不扩大范围",但**值得在暂缓项里文档化**:gate 只看 effective,会吞掉 requested→disabled 这类"降级到无"的可观测点。当前 `thinking-wire` 双轨也有同样盲点(thinking-wire 也 gate effective!==disabled),所以**这不是方案引入的回归**,是既有盲点 —— 但合并方案有机会顺手修(gate 改成 `requested || effective` 任一非 disabled 即记),不修则应文档化。

---

## MEDIUM #4 — type-only 模型表达力不足,漏掉 signature/sanitize 类 thinking 改写

**读码核对**:运维者关心的 thinking 改写不止 `type` 维度:
- `thinking_signature_compat`(DESIGN 运行时选项表)——客户端转发流里重整形 thinking 帧(signature_delta 合成 / redacted_thinking)。这是**响应侧**改写(ANTHROPIC_RESPONSE_REWRITES 的 thinking-signature-compat@150),不在请求 prepare 锚点范围,本就不该由这个请求侧 feature 表达——**OK,不算缺陷**,但需确认方案没暗示它覆盖。
- `thinkingBlockSanitizeCheck`(empty_thinking / empty_any)——发上游前剥损坏 thinking block,在 `sanitizeAnthropicMessages` 内(请求侧)。这改的是 **messages 里的 thinking block**,不是顶层 `thinking.type`。方案的 `{requested,effective}` 只取 `payload.thinking?.type`,**完全不表达** message 内 thinking block 的剥离。
- `coerceAdaptiveThinking` 的 `best_effort` 还会写 `output_config.effort`(request-preparation.ts:371-376)——type 维度看不出"budget 被换算成 effort 了"。

**严重度 MEDIUM**:这些大多当前 `thinking`/`thinking-wire` 双标签**也表达不了**(它们也只取 `.type`),所以**不是方案引入的回归**。但方案 design L11 宣称"thinking 建模为一个 self-contained feature / 单一语义维度",这个宣称**过强**——thinking 是多维(顶层 type + budget/effort + message block 完整性 + 响应侧 signature shim)。把它叫"the single semantic dimension"会误导未来维护者以为这一个 feature 覆盖了所有 thinking 可观测面。**建议**:把 feature 命名/注释收敛为"顶层 thinking.type 的 requested→effective",别宣称"thinking 的全部"。type-only 不增缺陷,但**别在 docstring 里过度承诺**。

---

## LOW #5 — env.body 取值时机正确(核对结论:无缺陷,但要点名锁住)

方案要在 `prepareAnthropicWire` 读 `(env.body as MessagesPayload).thinking?.type` 作 requested。核对取值是否取到"已被 mutate 的 wire 值":
- `prepareAnthropicRequest`(request-preparation.ts:254)入参是 `env.body`,内部 `buildWirePayload` 对 `thinking` **structuredClone 进 wire**(L291 DEEP_CLONE_FIELDS 含 "thinking",L296 `structuredClone(value)`),后续 coerce 改的是 `ctx.wire.thinking`(L380),**不写回 env.body**。codec.ts:386 注释也确认"does not write back to env.body"。
- 所以同一 attempt 内,`env.body.thinking`(requested)= prepare 前的逻辑值,`prepared.wire.thinking`(effective)= coerce 后的 wire 值,**二者在 prepareWire 内是分离的、未被同一次 prepare 串扰**——取值机制本身正确。

**但**:这个"正确"只在**单 attempt 内**成立。跨 attempt,env.body 被 strategy mutate(#1/#2 的根因),所以 #5 的"取值正确"不能洗白 #1/#2——单 attempt 取值对、但 requested 的**锚点选错**(应锚客户端原始请求而非 per-attempt env.body)。

---

## 结论与最小修正方向(不替方案做决策,只给数据)

方案的**删冗余卖点**(去掉 console 上 `thinking:adaptive, thinking-wire:adaptive` 的同值双标签)在**无重试的成功请求**上成立且有价值。但它在**重试维度**引入两个真实 display 缺陷:

1. **#1 归因丢失**:requested 取 per-attempt `env.body.thinking` → legacy-thinking-retry 自愈后被读成 adaptive,真实 coercion 在最该可见的路径上隐形。
2. **#2 跨 attempt 矛盾双标签**:精确字符串去重挡不住 `thinking:enabled` + `thinking:adaptive` 同时出现,违背方案"单 tag 一眼清"的自我卖点。

**两个缺陷同源**:把 `requested` 锚到**会被重试策略 mutate 的 per-attempt env.body**。

**可选修正(供决策,非指令)**:
- **A. requested 锚定单一源**:requested 取**客户端原始/sanitize 后请求的 thinking.type**(像当前 S3 那样**只记一次**),effective 仍 per-attempt 取 wire。则锚点不能都放 prepareWire——requested 应在 S3(或 parse 后单次)定格,effective 在 prepareWire 更新;合并成一个 feature detail 需要 detail 可"补字段"(先记 requested、后补 effective),或拆成"requested 单发 + effective per-attempt 发、console 端合并渲染"。这跟方案"单锚点 per-attempt 发完整 pair"的简洁性冲突,是真实的设计张力,需用户定夺。
- **B. 跨 attempt 同维度去重**:console 端把 `thinking:` 前缀的旧 tag 替换而非追加(`entry.tags` 里同前缀只留最新)。能消 #2 的矛盾双标签,但消不了 #1 的归因丢失(最新那个仍是 `thinking:adaptive`)。
- **C. 文档化暂缓 #3**:gate 只看 effective,吞掉 requested→disabled 的"降级到无";若不改 gate,在暂缓项记录(根因/当前行为/理想 gate `requested||effective`/为何暂缓)。
- **D. 收敛 #4 的过度承诺**:docstring 别宣称覆盖"thinking 全部维度",限定为"顶层 thinking.type 的 requested→effective"。

#1 和 #2 若不处理,方案是"在常见无重试路径上更干净、在重试路径上更错且更乱"的净负权衡(重试路径恰是诊断价值最高的)。
