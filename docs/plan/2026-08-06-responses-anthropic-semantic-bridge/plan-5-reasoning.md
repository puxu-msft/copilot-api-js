# P5 — Reasoning Family and Opaque Continuation

> **状态**：未实施
>
> **前置**：P0 carrier／affinity／timing 裁决，P1–P4。与 P6/P7 共改 profile／renderers，严格串行。

**Goal:** 原子迁移双向 reasoning request／whole／stream／reverse echo，支持多个 reasoning item、encrypted-only、权威 `.done` opaque state、v1兼容和 affinity-aware v2 continuation。

### Task 5.1: Reasoning family handler 与 per-item state

**Files:**
- Create: `src/lib/openai/translate/semantic-bridge/families/reasoning.ts`
- Modify: `src/lib/openai/translate/semantic-bridge/anthropic-to-responses-profile.ts`
- Modify: `src/lib/openai/translate/semantic-bridge/responses-to-anthropic-profile.ts`
- Modify: `src/lib/openai/translate/semantic-bridge/migration-dispatch.ts`
- Test: `tests/semantic-bridge/reasoning-handler.unit.test.ts`
- Create: `docs/tmp/2026-08-07-responses-anthropic-semantic-bridge-progress-p5-reasoning.md`

**Produces:** 每 source reasoning item 独立 `BridgeDecision<BridgeEmission>`；不使用全局 `reasoningText/reasoningEncrypted` 单槽。

- [ ] 写两个 reasoning items `A/ENC-A`、`B/ENC-B` 正控：两个独立 thinking／reasoning，carrier不串配。
- [ ] 写 encrypted-only (`summary:[]`＋非空 encrypted_content) 正控：仍产生可回传 carrier。
- [ ] Whole／stream state按 `output_index` 独立；`.added` 只开状态，`.done` 才提交 authoritative opaque。
- [ ] mutation：退回全局单槽、捕 `.added` blob、只有 summary非空才发射后红。
- [ ] Commit: `feat(bridge): add per-item reasoning handler`

### Task 5.2: Forward Responses→Anthropic presentation／carrier

**Files:**
- Modify: `src/lib/openai/translate/semantic-bridge/anthropic-renderer.ts`
- Modify: `src/lib/semantic-bridge/continuation.ts`
- Test: `tests/openai/responses-to-anthropic.unit.test.ts`
- Test: `tests/openai/responses-to-anthropic-stream.unit.test.ts`

- [ ] 每 reasoning item生成独立 thinking block；Anthropic thinking-first仅在同 source group内稳定前置。
- [ ] 继续识别 `copilot-api:synthetic-reasoning:v1:`，v2落地后 v1 decoder仍有 fixture。
- [ ] Stream signature carrier按 P0 timing选择可行通道；不得在已发可见 content后回插 thinking。
- [ ] strip scenario只剥 opaque carrier，summary保留并记录 disposition。
- [ ] Anthropic SDK `.finalMessage()` 对 empty thinking＋signature、多 thinking、text/tool siblings深等通过。
- [ ] Commit: `feat(bridge): render Responses reasoning for Anthropic`

### Task 5.3: Reverse Anthropic→Responses presentation／carrier

**Files:**
- Modify: `src/lib/openai/translate/semantic-bridge/responses-renderer.ts`
- Modify: `src/lib/anthropic/claude-signature-carrier.ts`（只复用／加v2兼容，不与 synthetic prefix合并）
- Test: `tests/openai/anthropic-to-responses.unit.test.ts`
- Test: `tests/openai/anthropic-to-responses-stream.unit.test.ts`

- [ ] 每 Anthropic thinking block独立 Responses reasoning item；真实 Claude signature byte-exact装 carrier。
- [ ] `redacted_thinking` 不能冒充 plaintext；按已裁决 presentation／continuation处理并留 disposition。
- [ ] Target Responses grammar完整发 output_item／summary_part added/done，terminal正确。
- [ ] OpenAI SDK accumulator 对多 reasoning／empty summary／text siblings通过。
- [ ] mutation：共享 synthetic／Claude prefix、漏 summary_part.added、合并多个 item后红。
- [ ] Commit: `feat(bridge): render Anthropic reasoning for Responses`

### Task 5.4: Request echo reconstruction 与 affinity

**Files:**
- Modify: `src/lib/openai/translate/semantic-bridge/families/reasoning.ts`
- Modify: `src/lib/openai/translate/semantic-bridge/anthropic-to-responses-profile.ts`
- Modify: `src/lib/openai/translate/semantic-bridge/responses-to-anthropic-profile.ts`
- Test: `tests/openai/anthropic-responses-reverse-roundtrip.unit.test.ts`
- Test: `tests/semantic-bridge/reasoning-roundtrip.it.test.ts`

- [ ] 同 source affinity恢复 opaque item；同 resolved model alias正控；不同 compatibilityKey剥 opaque但保 presentation。
- [ ] Echo后的 request wire由 mock／真上游接受；本地 encode→decode自洽不是充分验收。
- [ ] Scenario B policy一次 route resolution后同时供 request consumer／whole／stream renderer，四腿不漂移。
- [ ] mutation：删 affinity仍恢复、request consumer漏 policy、v1 decoder删除后红。
- [ ] Commit: `feat(bridge): reconstruct reasoning continuation`

### Task 5.5: 原子 production cutover

**Files:**
- Modify: `src/lib/pipeline/hub-translate.ts`
- Modify: `src/lib/openai/translate/anthropic-to-responses-request.ts`
- Modify: `src/lib/openai/translate/anthropic-to-responses.ts`
- Modify: `src/lib/openai/translate/anthropic-to-responses-stream.ts`
- Modify: `src/lib/openai/translate/responses-to-anthropic-request.ts`
- Modify: `src/lib/openai/translate/responses-to-anthropic.ts`
- Modify: `src/lib/openai/translate/responses-to-anthropic-stream.ts`
- Modify: `src/lib/openai/translate/semantic-bridge/migration-dispatch.ts`
- Test: `tests/anthropic/anthropic-codec-forward-leg.it.test.ts`
- Test: `tests/responses/reverse-responses-messages.it.test.ts`

- [ ] 在dispatcher加入reasoning相关source kinds；每个旧translator shell的reasoning case改为委托dispatcher，并同commit删除case内旧算法。Web Search仍semantic，message/function仍legacy；禁止reasoning semantic失败回legacy。
- [ ] 当前 family upstream／forwarded／disposition对账。
- [ ] 运行 byte-golden＋两个 SDK oracle＋真 GHC targeted probe。
- [ ] `bun run test:backend`、typecheck、lint。
- [ ] Commit: `feat(bridge): cut over reasoning family`

## Phase 验收

- AC4、AC8–AC10、AC14、AC21通过。
- 多 reasoning、encrypted-only、v1/v2、alias/cross-source 双控齐全。
- Synthetic Responses carrier 与真实 Claude signature carrier仍是两个独立 primitive／prefix。
- 旧 reasoning分支零残留，独立 reviewer 0 BLOCKER/MAJOR。
