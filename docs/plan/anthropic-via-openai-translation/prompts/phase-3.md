# Phase 3 Kickoff：非流式响应翻译（两向）

> self-contained kickoff。假设你零项目上下文。先读【必读】再动手。**Phase 0（router）+ Phase 1（路由骨架+二维门控）+ Phase 2（hub+请求翻译）已 landed master**，你建其上。

## 背景与为什么
copilot-api-js 正建通用「入站×出站」翻译矩阵。Phase 2 建成了**请求侧**翻译（Anthropic↔CC 请求翻译器 + hub 分派），但**响应侧仍 fail-fast**（anthropic codec 的 `renderResponse`/`renderResponseNonStreaming` 对翻译腿 throw，端到端 fail 而非返回坏数据）。

**Phase 3 接上非流式响应翻译——端到端首次打通（非流式）**：接上 `renderResponseNonStreaming` 的两向翻译后，`anthropic→cc` 的**非流式**请求就能真正返回正确 Anthropic 响应给客户端（不再 fail-fast）。**流式响应（逐帧 renderResponse + getStreamMeta 状态机）仍 fail-fast**，是 Phase 4（最难 byte-critical）。

**为什么非流式先行**：非流式是整体响应对象变换（一次性），比流式状态机简单、可用 mock 上游响应做往返单测。流式独立成 Phase 4 承压。

## 必读
- [RFC](../../rfc/2026-07-11-anthropic-via-openai-translation.md) **§9（翻译映射+OQ3）、§7.1（改写二维门控，Phase 1 已落）、§11（降级矩阵）、§14 OQ4（错误透传）**。
- [spec §7.1](../../spec/anthropic-via-openai-translation.md)（CC→Anthropic 非流式映射表）。
- [master plan Phase 3](../plan.md#phase-3非流式响应两向)（T3.1-T3.3 + Phase 2 排入的 T3.4）+ Phase 0/1/2 实施记录。
- [探针 PROBE-FINDINGS](../../../exp/anthropic-via-openai-translation/PROBE-FINDINGS.md)（**cc 腿 text/tool 拆多 choices**——响应侧必须折回、toolu_ 透传）。
- Phase 2 code-review 的 **N1（多 choices 折回契约）**：请求侧已折叠 text+tool_use 入单 CC message，响应侧（本 phase）必须把 GHC cc 腿返回的多 choices（choices[0] text + choices[1] tool_calls）**折回单 Anthropic message 的 content[]**，别只读 choices[0]。
- 现有 `src/lib/openai/translate/responses-to-cc.ts`（非流式对称参照）。
- [prompts/README](README.md) 通用红线。

## 目标
接上非流式响应翻译，**现状零回归 + anthropic→cc 非流式端到端打通 + 流式仍 fail-fast**：
1. CC→Anthropic 非流式（正向响应）。
2. Anthropic→CC 非流式（反向响应）。
3. anthropic codec renderResponseNonStreaming 按 targetEndpoint 委托 hub + OQ4 错误透传。
4. T3.4 createResponseAccumulator 按腿分派（若本 phase 消费；否则判断报告推 Phase 4）。

## Task（每个一 commit，每 commit 现状零回归 + 流式仍 fail-fast + 新单测过）

### T3.1 CC→Anthropic 非流式（正向响应）
- 建 `src/lib/openai/translate/cc-to-anthropic.ts`（非流式，与 `responses-to-cc.ts` 对称参照）。
- 映射（spec §7.1）：`choices[].message.content`(string)→`text` block；`message.tool_calls[]`→`tool_use` block（`function.arguments` JSON.parse 回 `input`，**parse 失败保留 raw 或走既有 tool-input-repair 思路**）；`finish_reason`→`stop_reason`（stop→end_turn / tool_calls→tool_use / length→max_tokens / content_filter→end_turn+可辨识标记 N3）；`usage`→Anthropic `usage{input_tokens,output_tokens}`；顶层包 `{id,type:message,role:assistant,model,content,stop_reason,usage}`；`toolu_*` 透传。
- **多 choices 折回（N1）**：GHC cc 腿多 choices → 折回单 Anthropic message 的 content[]（text block + tool_use blocks，块序保持）。
- 单测：各字段 + 多 choices 折回 + arguments parse 失败降级。

### T3.2 Anthropic→CC 非流式（反向响应）
- 建 `src/lib/openai/translate/anthropic-to-cc.ts`（非流式）。
- 映射：Anthropic `content[]`→CC `choices[0].message`（text block→content、tool_use→tool_calls[{id,function:{name,arguments:JSON.stringify(input)}}]）；**thinking/redacted_thinking 块→丢弃**（CC 无 thinking，非合成故无 400 风险）；`stop_reason`→`finish_reason`；`usage`→CC usage。
- 单测：各 block 反向 + thinking 丢弃。

### T3.3 anthropic codec renderResponseNonStreaming 按 targetEndpoint + OQ4
- anthropic codec `renderResponseNonStreaming` 按 `env.targetEndpoint`：`/v1/messages`→identity（现状）；翻译腿→委托 hub 的 CC→Anthropic 非流式（`renderResponseVia` 非流式路径）。
- **流式 renderResponse 逐帧仍 throw**（Phase 4 接）——只解锁非流式。
- **OQ4 错误透传（非流式路径）**：上游 CC 腿返回 error（4xx/5xx）→ 经 cc codec stream-error 映射 → 翻成 Anthropic error body。复用 formatError + mapHttpErrorToEnvelope。
- **端到端往返验证**：Anthropic 请求 → CC wire（P2）→ **mock CC 上游响应** → CC→Anthropic（P3）→ 端到端形状正确（不发真上游）。dry-run/往返单测。

### T3.4 createResponseAccumulator 按腿分派（Phase 2 排入）
- RFC §4.1：翻译腿上游是 CC 形，accumulator 须委托 cc accumulator（当前接口无 env 参）。
- **判断**：若 Phase 3 非流式路径**不消费** accumulator（accumulator 主要流式/history 用），则此项属 Phase 4，**判断后报告**是否推迟，别在非流式 phase 擅自扩接口（除非本 phase 真消费）。

## 验收 gate
- 每 commit：`bun run typecheck` 绿 + `bun test` 全套件通过（预存在 UI 404 除外）+ **Phase 0 golden 52 逐字节全过**（现状零回归）。
- 非流式翻译单测：正向各字段+多 choices 折回、反向各 block+thinking 丢弃、arguments parse 降级、OQ4 错误透传。
- **端到端往返**：mock CC 上游 → anthropic→cc 非流式返回正确 Anthropic 响应（不发真上游）。
- **@responses 四跳往返 oracle（W4 门控之一）**：anthropic→@responses 非流式（Anthropic→CC→Responses 上游→CC→Anthropic）往返形状正确。
- **流式仍 fail-fast**：renderResponse 逐帧 throw 不变（确认非流式解锁没误开流式）。

## 提交指引
`git commit -F <msgfile> -- <精确路径>`，conventional commits（feat/test），无模型署名。每 task 一 commit。

## 红线（见 [README](README.md)）
- **只解锁非流式，流式仍 fail-fast**（renderResponse 逐帧 throw 保持，Phase 4 接）——若发现改动误开了流式路径，停下报告。
- **现状 direct 零回归**（golden + 现状 codec 测试）。
- **多 choices 折回**（N1 契约）——响应侧别只读 choices[0]，否则 tool_calls 丢失。
- battle-tested：复用 responses-to-cc 非流式模式 + tool-input-repair 既有思路，别重写。
- no-auto-server（往返用 mock 上游，不发真上游）；empirical-verification。

## 若撞硬阻塞
① 某响应字段无法对称映射（CC/Anthropic 独有语义且非丢弃能解）② renderResponseNonStreaming 委托破坏现状 direct identity ③ 非流式与流式路径耦合无法只解锁非流式 ④ T3.4 accumulator 分派牵连流式接口——**停下报告**，附具体失败，别自行改设计或放宽 invariant。
