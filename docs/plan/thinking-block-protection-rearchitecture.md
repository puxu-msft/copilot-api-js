# Thinking 块保护体系重构(实证驱动)

> **实施状态：已完成**
> **落地**：—
> **现状锚点**：运行时选项 `thinkingBlockMessagePolicy`（preserve|stripped）；`src/lib/anthropic/thinking-protection.ts`
> **备注**：Part 1-4 全落地；旧 immutable/fixed-index policy 全仓零残留（旧文件为 deprecated shim）

## Context(为什么做这个重构)

thinking 块是 Anthropic 模型的加密签名推理块。现有保护体系基于"signature 脆弱/绑定上下文/位置敏感"的**过度保守假设**,设计了三档 policy(`stripped`/`immutable`/`fixed-index`)+ 散落在 8 个清洗 pass 的短路保护。

**实证已推翻该假设**(通过 `localhost:4141` 真实后端 + 从 history API 取真实 signature block 实测,opus-4.8):
- 真实 signature block 放进**完全无关的新对话首块** → 200
- thinking 放在 **text 之后(非首块)** → 200
- `[tool_use, thinking, text]` + 配对 tool_result(server_tool 降级后形态) → 200

→ signature **完全自包含**(加密 thinking 内容本身,上游解密重建),不绑定上下文/位置。唯一真实约束:**thinking 块原样不改、连续 thinking 序列不重排**。

因此 `immutable`(整条冻结)与 `fixed-index`(保数组长度)的区别保护的是**不存在的风险**,反而阻止了必要清理(删孤儿 tool、降级 server_tool、编辑非 thinking 文本),并衍生 4 个已知问题(见下)。本重构把"**消息级**保护(整条冻结/保长度)"精确化为"**块级**保护(merge 不并 thinking 消息 + 不删/改 thinking 块 + 不重排连续 thinking)",并顺带修掉 4 个问题。

**全面 pass 审计结论**(经 Explore subagent 逐文件核实):删块/降级/拆分/编辑文本的 pass 天然不碰 thinking 块(可移除短路);只有 merge(dedup/system-messages)和 strip(stripThinkingBlocks)会重排/删 thinking——它们的 guard 键于 thinking **存在性**(`hasThinkingSignatureBlocks`/`shouldPreserveThinkingBlocks`),与 immutable/fixed-index 区别无关,**保留即可**。

预期结果:policy 简化为 `preserve`/`stripped` 两档;问题 1/2/3/4 全部消解或修复;thinking 传递在 signature 层面经实证安全。

---

## Part 1 — policy 两档简化

新枚举:`type ThinkingBlockMessagePolicy = "preserve" | "stripped"`,默认 `"preserve"`。
- `preserve`(新默认):保护 thinking 块本身、不重排连续 thinking,但允许周围一切清理(删孤儿 tool、降级 server_tool、编辑/删非 thinking 文本)。
- `stripped`:不变,主动删 thinking 块。

改动:
- `src/lib/state.ts`:`:47` 类型改两档;**`:40-46` type JSDoc**(写死三档语义,必改否则自相矛盾)+ `:166-171` 字段 JSDoc(默认改 preserve);`:888` `CONFIG_MANAGED_DEFAULTS` 默认 `"preserve"`。
- `src/lib/config/schema.ts:156` `nullableEnum(["preserve","stripped"])`。
- `src/lib/config/compat.ts`(⚠️ **must-fix,先 TDD**):(a) 现有 `immutable_thinking_messages` 迁移(~129):`true→"preserve"`、`false→"stripped"`;(b) **新增值迁移**:`anthropic.thinking_block_message_policy` 的 `"immutable"`/`"fixed-index"` → `"preserve"`。**现有框架(`validation.ts:57-78` extractAndTranslateDeprecated)是"无条件 delete+warn-once → translate 产 patch → missing-only 重加",有两个陷阱**:① warn-once 在 translate 之前无条件触发 → 用合法 `preserve`/`stripped` 的用户会被误报 warn + 走删-重加;② translate 对 `preserve`/`stripped` 必须**返回 patch**(不能返回 undefined,否则删掉的合法键被静默丢弃)。→ 必须实现**就地值强制的专用变体**:仅当值为 `immutable`/`fixed-index` 才 warn+改写,所有合法值都回写 patch。**修复落点在 `extractAndTranslateDeprecated` 循环结构本身**(把 `:68` delete + `:69` warn 改为"仅当值确为 legacy 才执行"),纯 migration builder 无法抑制无条件 warn。先单测(`expect(warnSpy).not.toHaveBeenCalled()` for 合法值)。
- `config.schema.json`:**不要手改**——它是 `scripts/generate-config-json-schema.ts` 的生成物。改完 schema.ts 后跑 `bun run generate:config-schema` 重新生成(否则与 Zod 导出漂移,`config-schema-json-export.unit.test.ts` 会暴露不一致)。
- `config.yaml:194-198` / `config.example.yaml:209-213`:重写注释(两档)+ 值设 `preserve`。
- `docs/DESIGN.md:256`:更新表格行(类型/默认/描述,反映实证模型)。**一并修问题2(默认值文档错)。**
- `docs/sync-ghc-api/messages-api.md:80`:更新对 `thinking-immutability.ts`(已改名)+ "immutable 策略"的引用(否则死引用)。

## Part 2 — `thinking-immutability.ts` → 改名 `thinking-protection.ts`

- 改名文件,更新约 6 处 import(用 serena `rename_symbol`/路径更新:tool-blocks、rewrite-server-tool-history、tool-utils、system-reminders、content-blocks、system-messages、deduplicate-tool-calls、truncation 的 import)。
- **删除** `isImmutableThinkingMessage`、`isFixedIndexThinkingMessage`。
- **保留** `hasThinkingSignatureBlocks`(dedup protectedIds + shouldPreserve 的原语)、`shouldPreserveThinkingBlocks`(= `policy !== "stripped" && hasThinking`,两档下即 `preserve && has-thinking`,语义不变)。
- 更新 module JSDoc 反映实证模型(signature 自包含;只需块级原样 + 不重排)。

## Part 3 — 各 pass 改动

**移除短路(天然 thinking-safe)**:
- `sanitize/tool-blocks.ts:89-92` 删 `isImmutableThinkingMessage` 短路 + import。
- `sanitize/rewrite-server-tool-history.ts:150-154` 删短路 + import + 改写 line ~30/150 的 "byte-frozen" 注释。**消解问题3 + 让问题1 回传天然安全(rewrite 总是降级,thinking 留 assistant turn)。**
- `auto-truncate/tool-utils.ts:108-112`(orphaned tool_result)、`:160-164`(orphaned tool_use)删短路 + import。
- `sanitize/system-reminders.ts:81-101` 合并 immutable/fixed-index 双分支为单一"编辑 text、保留 thinking"逻辑(即原 stripped 分支 `sanitizeTextBlocksInArray`,~103-109);删两个 import + 可能不再用的 `AssistantMessage`/`ContentBlock` import(改后核实)。
- `sanitize/content-blocks.ts` `filterEmptyAnthropicTextBlocks`:删 `:17` 的 `shouldPreserveThinkingBlocks` guard + `:7` import(filter 只删空 text 块,不碰 thinking)。

**保留 guard(会重排/删 thinking,不改)**:
- `auto-truncate/truncation.ts:36` `stripThinkingBlocks` 的 `shouldPreserveThinkingBlocks`(stripped 才删 thinking)。
- `sanitize/deduplicate-tool-calls.ts:135`(merge guard)+ `:75`(`hasThinkingSignatureBlocks` protectedIds,保护 thinking 消息的 tool_use ID 不被去重孤儿化)。
- `sanitize/system-messages.ts:79`(mergeAdjacentSameRole guard)。
- `content-blocks.ts` `filterEmptyThinkingBlocks`:不变(只删损坏/无签名块,不耦合 policy)。

## Part 4 — 问题1:web_search 第二跳 thinking 注入

synthesize 层已有 thinking 防御分支(`buildStartContentBlock:181` 空 start、`buildContentBlockDeltas:209-219` thinking_delta+signature_delta),只需接通:
- `web-search/orchestrator.ts`:新增 `collectThinkingBlocks(response)`(取 `type==="thinking"||"redacted_thinking"` 块,**逐字保留** thinking/signature/data);`completeWebSearch:411` 后 `const thinkingBlocks = collectThinkingBlocks(secondResponse)`,传入 `buildWebSearchResponse`。
- `web-search/synthesize.ts`:`BuildWebSearchResponseArgs:33` 加 `thinking?: Array<Record<string,unknown>>`;`buildWebSearchResponse:74-82` content 构造为 `server_tool_use → web_search_tool_result → ...thinking → text`(`if (args.thinking?.length) content.push(...args.thinking)`,在 result 后 text 前)。`webSearchResponseToEvents` 等无需改(防御分支变 live)。
- **未证假设(有兜底,不阻塞)**:第二跳 `stream=false`,`collectThinkingBlocks` 依赖非流式响应返回带签名 thinking 块——经验未证。兜底:无 thinking 时 `args.thinking?.length` 为假,退化为 `server_tool_use→result→text`(回归用例覆盖)。执行时实测确认。

## Part 5 — 问题4:损坏块过滤产空消息(改用移位方案,消除连续同 role 风险)

根因:`filterEmptyThinkingBlocks` 在 finalize 跑,晚于 `processToolBlocks`(空消息清理),双空块独占的消息被清空后无人删 → `content:[]` 发上游 400。

**reviewer 指出末尾新增 drop-only 会把前后两个 user turn 变相邻 → 连续同 role 400。** 故改用**移位方案**(更优,不新增 drop 逻辑):把损坏 thinking 块过滤从 `result.ts` 的 finalize **移到 `sanitize.ts` 主流程 `processToolBlocks` 之前**(在 `rewriteServerToolHistory` 之后)。这样 `processToolBlocks` 既有的空消息删除(`tool-blocks.ts:146/180` `length===0 → continue`)直接兜底——**复用既有删空消息行为,连续同 role 风险与现状一致(不恶化,非新增)**。
- `emptyThinkingBlocksRemoved` stats 改在移位处用 block-count delta 计算,传入 `finalizeAnthropicSanitization`(改其签名,移除内部的 thinking 过滤)。
- 受 `state.thinkingBlockSanitizeCheck` 门控不变。
- **执行时实测确认**:用 history API 探针构造"删空 assistant 消息后前后相邻 user"的请求,POST 后端验证上游是否容忍连续同 role(若 400,则在移位后追加复用 `system-messages.ts:74` 的 `mergeAdjacentSameRole` 提取为共享工具)。先按移位方案实现,实测兜底。

---

## Part 6 — TDD 顺序 + 测试更新

**先写失败测试(red)**:
1. compat 值迁移(`tests/config/config-validation.unit.test.ts`):`immutable`/`fixed-index` → `preserve` + warn;legacy bool `true→preserve`/`false→stripped`。**(先验证框架支持值改写——Part 1.4 的风险点)**
2. web_search thinking 注入(扩 `tests/anthropic/web-search/web-search.http.test.ts` 或新 synthesize 单测):`buildWebSearchResponse({thinking:[…]})` → content `[server_tool_use, web_search_tool_result, thinking, text]`;events 发空 start+thinking_delta+signature_delta,accumulator 重建签名块。
3. 空消息清扫(扩 `message-sanitizer.it.test.ts`):双空块独占的消息被整条移除,无 `content:[]` 残留。
4. preserve 下清理生效(`message-sanitizer.it.test.ts` 新断言):含 thinking + 孤儿 tool_use 的消息,孤儿被删而 thinking 块逐字不变;非 thinking text 块的 system-reminder 被剥而 thinking 保留。

**改现有测试(green)**:
- `message-sanitizer.it.test.ts:1619`(immutable 整条冻结):改为 preserve 下 thinking 逐字不变 + 周围清理生效(`toBe` 引用相等改结构断言);`:1652`(保空 text 块):改为空 text 被删 + thinking 保留。
- `request-server-tool-history-rewrite.unit.test.ts:152/169`(immutable 不降级 vs stripped 降级 pair):改为 preserve 下含 thinking 也降级(thinking 留 assistant、tool_result 移 user、逐字不变)。
- `config-validation.unit.test.ts:52/117-141`:fixture/断言 `immutable`/`fixed-index` → `preserve`/迁移结果。
- `dedup-tool-calls.it.test.ts:284`、`system-messages-sanitize.it.test.ts:182`、`pipeline/auto-truncate.it.test.ts:380`:`"immutable"` 字面量 → `"preserve"`(merge/strip guard 语义保留,改名去 immutable);auto-truncate 若有"immutable 消息不被孤儿过滤动"的断言,改为"孤儿被删 + thinking 保留"。
- `config-validation.unit.test.ts:47-61`("fully-valid passes unchanged" 用 `immutable` + 断言 `warn not called`):整块改值为 `preserve`(否则迁移后会 warn);`:52/117-141` 同步。
- `config-compat.unit.test.ts:125` `toBe("immutable")` → `toBe("preserve")`(字面断言,typecheck 不捕获,靠 test:backend)。
- `config-yaml-routes.http.test.ts:179/451`:PUT 回显期望 `immutable` → 值迁移后变 `preserve`,**round-trip 断言必须改**。
- `config-hot-reload.it.test.ts:274-278`:用 `sampleYamlValue:"stripped"`(仍合法)+ 动态 `CONFIG_MANAGED_DEFAULTS`(自动追踪新默认)——**确认无需改**(跑一遍验证)。

**顺序**:schema/state/compat(解锁类型)→ thinking-protection.ts 改名+删函数 → 5 处 pass 改动(编译驱动)→ synthesize/orchestrator 注入 → result.ts 清扫 → 跑测试逐个修绿。

---

## Part 7 — Verification

- `bun run typecheck`(tsc 捕获所有删函数/删 import/枚举收窄点)
- `bun run lint`
- `bun run test:backend`;迭代中跑 `bun test tests/anthropic/message-sanitizer.it.test.ts tests/anthropic/request-server-tool-history-rewrite.unit.test.ts tests/config/config-validation.unit.test.ts tests/anthropic/dedup-tool-calls.it.test.ts tests/anthropic/system-messages-sanitize.it.test.ts tests/anthropic/web-search/web-search.http.test.ts`
- **flaky/边缘**:涉及 sanitize 顺序与合并的测试连跑确认确定性。
- **subagent review**:执行后派 subagent 复审 + 主线亲手核对关键断言(原则6)。
- **真实后端端到端(问题1)**:`web_search.enabled:true` + `rewrite_history_server_tools:"downgrade"` + `preserve`,opus-4.8 thinking on,发触发搜索且第二跳有 thinking 的请求 → 查 history 确认合成序列 `server_tool_use→result→thinking→text` 且 signature 非空;再发回传该 turn 的后续请求 → 确认 wire 降级后上游 **200**(无 server_tool 未定义 400、无 thinking 空块 400)。回归:无搜索请求仍走 direct path;无第二跳 thinking 的搜索仍合成 `server_tool_use→result→text`。

## 关键文件
- `src/lib/anthropic/thinking-immutability.ts`(→ `thinking-protection.ts`)
- `src/lib/state.ts`、`src/lib/config/compat.ts`、`src/lib/config/schema.ts`
- `src/lib/anthropic/web-search/synthesize.ts`、`web-search/orchestrator.ts`
- `src/lib/anthropic/sanitize/result.ts`
- 移除短路:`sanitize/{tool-blocks,rewrite-server-tool-history,system-reminders,content-blocks}.ts`、`auto-truncate/tool-utils.ts`
- config 面:`config.schema.json`、`config.yaml`、`config.example.yaml`、`docs/DESIGN.md`
