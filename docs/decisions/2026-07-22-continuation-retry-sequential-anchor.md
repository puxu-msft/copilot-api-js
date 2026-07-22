# ADR: 续写重试 + 顺序 anchor —— 退役整响应缓冲、以完整响应换保真度

- 状态：Proposed（待用户确认）
- 日期：2026-07-22
- 关联 spec：[docs/spec/2026-07-22-continuation-retry-and-sequential-anchor.md](../spec/2026-07-22-continuation-retry-and-sequential-anchor.md)
- 修订：[2026-07-11-block-level-buffered-retry](2026-07-11-block-level-buffered-retry.md)（前 spec）在 Anthropic 上未完成的部分

## 背景

incident `req_162`（opus-4.8 / Claude Code CLI）：tool_use 中途 `NGHTTP2_CANCEL`，首块 commit 后按当今 `partial-degrade` 终局不重试，用户 0 可用产出。mid-stream CANCEL 协议上不可安全重试。前 spec 的 Anthropic 块级因 anchor-coexist 对 CLI 不安全而默认关、未完成。

## 决策

### D1 —— 退役整响应缓冲，兜底为 live（非 whole）

删除 `protect_streaming_generation` 的 whole-response 语义。所有缓冲一律块级。Anthropic 块级不可用（300s 死线门 FAIL）时回退 **live**（现有 pre-response keepalive），**永不回退 whole**。

**理由**：whole 是历史遗留的平行实现，与块级骨架重复；用户明确要求彻底退役、无双轨包袱（项目「无向后兼容负担」）。live 回退已被现有代码路径覆盖，无需保留 whole。

### D2 —— 顺序 anchor 取代 anchor-coexist

Anthropic 块级保活从「anchor@0 全程 open + 真实块并存」改为「任一时刻单块 open：anchor 在真实块前 close、每 gap 新开 anchor」。

**理由**：coexist 的「两 index 并存 open」把 Claude Code CLI 的 agent-loop 搞糊涂 → stall（实测），是前 spec Anthropic 默认关的根因。顺序形状经 mock upstream + 真 CLI 实证 CLI-safe（numTurns=1、不丢块）。附带：不需 coexist 逼出的 sink 块栈改造，更简单。**代价**：块间穿插空 text 块（index 膨胀、渲染为空），可接受。

### D3 —— 首块后续写重试，以合成 continuation 轮实现

首块 commit 后被掐 → 重投上游，请求 = `[原始体] + [已commit块作assistant] + [合成user续写轮]`（默认 `"network issue. please continue"`，可配置）。

**理由**：上游不支持 assistant-prefill（haiku+opus-4.8 双拒实测），合成 continuation 轮是唯一可行形状（PoC 证可续 tool_use）。**取舍**：重发整上下文 + 重新计费 + 续写保真度不完美（合成轮是「重构意图」非模型真实内部状态）。用户裁决：client 优先「拿到完整响应」，不在乎双重计费/不完美（记忆 `feature-over-security` 域外的产品取舍）。

### D4 —— 全端点块级 + 续写默认 on

Responses WS 升块级、CC 升块级；续写覆盖 Anthropic + Responses(HTTP/WS) + CC；`continuation.enabled` 默认 true；续写与首块前透明重试共享 `max_retries`（默认 3）。Gemini 排除。

**理由**：长远、泛用优先（项目哲学）；CC 有内部结构（indexed tool_calls）可重建块边界，不应留退化档。默认 on 契合用户「完整响应优先」立场。

## 后果

- 正面：incident 类 mid-stream cancel 可被续写救回；Anthropic 块级终于 CLI-safe 可默认 on；全端点统一块级骨架、无 whole 双轨。
- 负面/代价：续写重发上下文 + 重新计费（prompt cache 摊薄）；续写块保真度降级（诚实标注 synthetic:"continuation"）；块间空 anchor 块使 index 膨胀；CC/Responses/WS 续写形状 + 顺序 anchor 300s 死线依赖计划期 PoC 门，FAIL 则该格式/角落回退 partial-degrade。

## 备选（未采纳）

- native prefill 续写：上游双拒，无绕过。
- 保留 whole 作 Anthropic 兜底：用户裁决彻底退役，回退 live。
- 续写独立预算旋钮：弃，用共享预算。
- 无限续写：弃，受 max_retries 共享预算约束（防病态大请求续写风暴）。
