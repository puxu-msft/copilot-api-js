# Phase 2 Kickoff：hub 共享翻译层 + Anthropic↔CC 请求翻译

> self-contained kickoff。假设你零项目上下文。先读【必读】再动手。**Phase 0（decideRoute→router）+ Phase 1（路由骨架+二维门控）已 landed master**，你建其上。

## 背景与为什么
copilot-api-js 正建通用「入站×出站」翻译矩阵。Phase 0-1 建立了路由地基（router 决策全矩阵、后缀解析、二维门控），但**刻意不做实际翻译**（translateOut 恒 identity，未接线的 translate 腿 fail-fast throw）。

**Phase 2 开始真正的翻译逻辑——但只请求侧**：建 hub 共享翻译层 + 一对 Anthropic↔CC **请求**翻译器。响应翻译是 Phase 3（非流式）/Phase 4（流式）。

**为什么请求先行**：请求翻译（Anthropic Messages body → CC payload）是纯变换、可离线验证；响应翻译（尤其流式状态机）是最难的 byte-critical 部分，独立成后续 phase。分离让请求翻译先用 golden/oracle 锁定。

## ⚠️ 本 phase 最微妙的 commit invariant（务必理解）
Phase 2 引入请求翻译，但**翻译腿端到端必须仍 fail-fast**——因为响应侧（CC→Anthropic）还没实现，若让 anthropic→cc 请求真发上游、拿到 CC 响应直接返回给 Anthropic 客户端 = 返回坏数据。所以：

1. **请求翻译器**（hub + anthropic-to-cc-request + cc-to-anthropic-request）是**纯函数**，完整 TDD 单测 + **dry-run inspector 离线验证**（见下），**不消耗上游配额**。
2. **anthropic codec `translateOut` 按 targetEndpoint 委托 hub**（翻译腿产 CC body）——这让 dry-run 能验证请求侧翻译到 wire。
3. **但翻译腿的响应侧仍 fail-fast**（`renderResponse`/`getStreamMeta` 对翻译腿 throw，延续 Phase 1 WARN-1 的 never-swallow 精神），使端到端 anthropic→cc **fail 而非返回坏 CC**。Phase 3 接响应翻译后才端到端打通。
4. **现状 direct 腿逐字节零回归**（Phase 0 golden 52 + 现状 codec 测试全过）。

**若你发现某 task 会让翻译腿端到端返回响应给客户端（而响应未翻译）= 违反 invariant，停下报告。**

## 必读
- [RFC](../../rfc/2026-07-11-anthropic-via-openai-translation.md) **§4.2（hub 共享翻译层）、§9（翻译映射+OQ3+WARN-E 反向红线）、§3.1（二维门控轴，Phase 1 已落）**。
- [spec §6](../../spec/anthropic-via-openai-translation.md)（Anthropic Messages → CC 映射表：system/tool_use/tool_result/image/tools/tool_choice/thinking/max_tokens/stop_sequences/cache_control/server tools）。
- [master plan Phase 2](../plan.md#phase-2hub-共享翻译层--anthropiccc-请求翻译)（T2.1-T2.4 + factory 锚点）+ Phase 0/1 实施记录。
- [探针实测 PROBE-FINDINGS](../../../exp/anthropic-via-openai-translation/PROBE-FINDINGS.md)（cc 腿 claude 返 toolu_ 透传、多 choices 分裂）。
- [prompts/README](README.md) 通用红线。
- **dry-run inspector**：`/api/debug/dry-run-pipeline`（见 skill `proxy-api-reference` 或 `src/routes/debug/dry-run-pipeline.ts`）——离线把合成请求喂进真实 driver、`stopAfter=translate/prepare-wire` 输出请求翻译中间态，**不发上游**。这是 Phase 2 请求翻译的主验证工具。

## 目标
建请求翻译基础设施，**现状零回归 + 翻译腿端到端 fail-fast**：
1. hub 共享翻译层（请求侧委托骨架）。
2. Anthropic→CC 请求翻译器（正向）。
3. CC→Anthropic 请求翻译器（反向，WARN-E 硬约束）。
4. anthropic codec translateOut 委托 hub（翻译腿产 CC body，dry-run 可验）。

## Task（每个一 commit，每 commit 现状零回归 + 翻译腿仍 fail-fast + 新单测过）

### T2.1 hub 共享翻译层骨架
- 建 `src/lib/pipeline/hub-translate.ts`：请求侧委托 `translateRequestVia(sourceFormat, targetEndpoint, env)` —— 内部持 CC↔Anthropic（本 phase 新建）+ 复用现有 CC↔Responses primitive（`src/lib/openai/translate/`）。响应侧委托是 Phase 3/4 骨架（本 phase 可留 throw stub）。
- **消解 W-gemini 双委托**：hub 是共享层，gemini→messages 经 hub 的 Anthropic 腿，不需 gemini 自持 anthropic 子委托。
- 单测：hub 分派正确（anthropic→cc 走 anthropic-to-cc、cc→messages 走 cc-to-anthropic）。

### T2.2 Anthropic→CC 请求翻译（正向）
- 建 `src/lib/openai/translate/anthropic-to-cc-request.ts`（与现有 `responses-to-cc-request.ts` 对称参照）。
- 映射（spec §6 全表）：top-level `system`→`messages[0]{role:system}`、text block→text、`tool_use{id,name,input}`→`tool_calls[{id,type:function,function:{name,arguments:JSON.stringify}}]`、`tool_result{tool_use_id,content}`→`{role:tool,tool_call_id,content}`、`image`→`{type:image_url}`、`tools`→CC function tools、`tool_choice`→CC tool_choice、`thinking`→`reasoning_effort`(若模型支持,budget→档位启发式,OQ2)或丢弃、`max_tokens`、`stop_sequences`→`stop`、`cache_control`→**剥离**、native server tools→**剥离**。
- assistant turn text+tool_use 混排 → CC assistant content + tool_calls 并存；多 tool_result → 多条 role:tool。
- 单测：各 block 类型往返映射 + 多 choices 感知（探针发现 cc 腿拆多 choices，请求侧折叠对称）。

### T2.3 CC→Anthropic 请求翻译（反向，WARN-E 硬约束清单）
- 建 `src/lib/openai/translate/cc-to-anthropic-request.ts`（CC payload → Anthropic Messages，反向格子用）。
- **WARN-E 硬约束逐项**：① **thinking 绝不合成**（CC 无 thinking，反向若合成 Anthropic thinking 块无 signature 必撞 GHC "cannot be modified" 400/毒化——skill `ghc-anthropic-upstream`；reasoning 只经 reasoning_effort 或丢弃）；② tool_use.id 格式（CC `call_*`→Anthropic tool_use.id，探针验证 GHC 腿是否接受非 toolu_ 前缀）；③ cache_control 不注入；④ server tools 剥离。
- 单测：各 block 反向 + **红线测试**（断言输出绝无 thinking content block）。

### T2.4 anthropic codec translateOut 委托 hub
- anthropic codec（`src/lib/codec/anthropic/codec.ts`）的 `translateOut` 按 `env.targetEndpoint`：`/v1/messages`→identity（现状）；`/chat/completions`/`/responses`→委托 hub 产 CC body。
- prepareWire 翻译腿产 CC wire（委托 hub / 内部 cc 逻辑）。
- **响应侧保持 fail-fast**：renderResponse/getStreamMeta 对翻译腿仍 throw（Phase 3 接）。
- **dry-run 验证**：合成 anthropic 请求 + model_overrides 映射到 cc-capable 模型 + `stopAfter=prepare-wire` → 确认产出正确 CC wire（不发上游）。

## 验收 gate
- 每 commit：`bun run typecheck` 绿 + `bun test` 全套件通过（预存在 UI 404 除外）+ **Phase 0 golden 52 逐字节全过**（现状零回归）。
- 请求翻译单测：正向各 block + 反向各 block + WARN-E 红线（无 thinking 块）。
- dry-run 验证请求翻译到 wire（贴 stopAfter=prepare-wire 输出）。
- 翻译腿端到端仍 fail-fast（响应侧未接）——确认不返回坏 CC 给 Anthropic 客户端。

## 提交指引
`git commit -F <msgfile> -- <精确路径>`，conventional commits（feat/test），无模型署名。每 task 一 commit。

## 红线（见 [README](README.md)）
- **翻译腿端到端 fail-fast，不返回坏数据**——响应未翻译前，anthropic→cc 端到端必须 fail 而非返回 CC 给客户端。
- **WARN-E 反向红线**：cc-to-anthropic-request **绝不产生 Anthropic thinking content block**（GHC 400/毒化）。红线测试断言。
- **现状 direct 腿零回归**（golden + 现状 codec 测试）。
- **dry-run 验证不发上游**（省配额）；no-auto-server；empirical-verification。
- battle-tested：请求翻译复用现有 `responses-to-cc-request` 的模式与 primitive，别重写 CC↔Responses 已有的翻译。

## 若撞硬阻塞
① 请求翻译器某映射无法对称（Anthropic 独有语义 CC 无对应且非「剥离/降级」能解决）② translateOut 委托 hub 破坏现状 direct 的 identity ③ 无法在不返回坏数据的前提下让翻译腿请求侧可验证——**停下报告**，附具体失败，别自行改设计或放宽 invariant。
