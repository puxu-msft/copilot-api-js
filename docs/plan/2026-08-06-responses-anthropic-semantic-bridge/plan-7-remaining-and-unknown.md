# P7 — Remaining Known Families and Production Unknown Fail-Loud

> **状态**：未实施
>
> **前置**：P6。首批支持集全部闭合后才允许启用 production unknown reject。

**Goal:** 迁移 message／text／image／citation／refusal／server-tool results／terminal等剩余真实结构，删除所有已知 silent default，并启用 identity passthrough＋translation fail-loud。

### Task 7.1: Message／text／image／citation family

**Files:**
- Create: `src/lib/openai/translate/semantic-bridge/families/message.ts`
- Modify: `src/lib/openai/translate/semantic-bridge/anthropic-to-responses-profile.ts`
- Modify: `src/lib/openai/translate/semantic-bridge/responses-to-anthropic-profile.ts`
- Modify: `src/lib/openai/translate/semantic-bridge/anthropic-renderer.ts`
- Modify: `src/lib/openai/translate/semantic-bridge/responses-renderer.ts`
- Modify: `src/lib/openai/translate/semantic-bridge/migration-dispatch.ts`
- Test: `tests/semantic-bridge/message-handler.unit.test.ts`
- Create: `docs/tmp/2026-08-07-responses-anthropic-semantic-bridge-progress-p7-remaining.md`

- [ ] 双向 text/message/content parts顺序与role映射。
- [ ] Images／input_file／document按真实target能力 mapped/degraded/rejected；不silent drop。
- [ ] URL citations保url/title/offset；不冒充server-tool result。
- [ ] refusal content与stop status分开建模，不能把content_filter当refusal。
- [ ] whole／stream共handler，mutation删citation或unknown part no-op后红。
- [ ] Commit: `feat(bridge): add message and citation families`

### Task 7.2: Anthropic server-tool result families

**Files:**
- Create: `src/lib/openai/translate/semantic-bridge/families/server-tool.ts`
- Modify: `src/lib/openai/translate/semantic-bridge/anthropic-adapter.ts`
- Modify: `src/lib/openai/translate/semantic-bridge/anthropic-to-responses-profile.ts`
- Modify: `src/lib/openai/translate/semantic-bridge/responses-to-anthropic-profile.ts`
- Modify: `src/lib/openai/translate/semantic-bridge/anthropic-renderer.ts`
- Modify: `src/lib/openai/translate/semantic-bridge/responses-renderer.ts`
- Modify: `src/lib/openai/translate/semantic-bridge/migration-dispatch.ts`
- Test: `tests/semantic-bridge/server-tool-results.unit.test.ts`

- [ ] 四格闭合：历史 assistant use、历史 user result、live stream、live whole。
- [ ] 有真实target结构则保结构；无等价result保关联id并诚实text degradation。
- [ ] error-shaped result不被成功规则误伤；image/result richest-data-flow有disposition。
- [ ] R-NO-REVIVE：不合成Anthropic签名result，不复活代理搜索双跳。
- [ ] Commit: `feat(bridge): map server tool histories and results`

### Task 7.3: Terminal／usage／stop status family

**Files:**
- Create: `src/lib/openai/translate/semantic-bridge/families/terminal.ts`
- Modify: `src/lib/openai/translate/semantic-bridge/anthropic-to-responses-profile.ts`
- Modify: `src/lib/openai/translate/semantic-bridge/responses-to-anthropic-profile.ts`
- Modify: `src/lib/openai/translate/semantic-bridge/anthropic-renderer.ts`
- Modify: `src/lib/openai/translate/semantic-bridge/responses-renderer.ts`
- Modify: `src/lib/openai/translate/semantic-bridge/migration-dispatch.ts`
- Test: `tests/semantic-bridge/terminal-mapping.unit.test.ts`

- [ ] 双向 completed/incomplete/failed、end_turn/tool_use/max_tokens/pause_turn/refusal/content_filter逐项表。
- [ ] Responses incomplete发 `response.incomplete`，payload status一致；Anthropic message_delta/message_stop顺序合法。
- [ ] usage cache/read/write/reasoning/modality whole/stream parity。
- [ ] unknown future reason走显式degradation／compatibility，不伪装max_tokens。
- [ ] mutation：incomplete发completed、usage细节掉字段、content_filter→refusal后红。
- [ ] Commit: `feat(bridge): map terminal semantics explicitly`

### Task 7.4: 首批支持集 population audit

**Files:**
- Create: `tests/architecture/semantic-bridge-supported-kinds.unit.test.ts`
- Modify: `src/types/api/openai-responses.ts`
- Modify: `src/types/api/anthropic.ts`

- [ ] 运行时枚举当前生产 source discriminators（fixtures＋项目合成项），不是手抄测试名。
- [ ] 四张 `SupportedKind` 与registry key精确相等；known lifecycle family与adapter accept set相等。
- [ ] 正样本证明守卫能命中一个临时已知kind；删除registry row／新增known type不加handler后红。
- [ ] 对未进入生产面的SDK-only结构保持候选，不注册空handler；报告排除项。
- [ ] Commit: `test(architecture): guard semantic bridge coverage`

### Task 7.5: Production unknown compatibility policy

**Files:**
- Modify: `src/lib/pipeline/hub-translate.ts`
- Modify: `src/lib/openai/translate/semantic-bridge/anthropic-to-responses-profile.ts`
- Modify: `src/lib/openai/translate/semantic-bridge/responses-to-anthropic-profile.ts`
- Modify: `src/lib/openai/translate/semantic-bridge/anthropic-adapter.ts`
- Modify: `src/lib/openai/translate/semantic-bridge/responses-adapter.ts`
- Modify: `src/lib/codec/anthropic/codec.ts`
- Modify: `src/lib/codec/openai-responses/codec.ts`
- Modify: `src/routes/messages/handler-v4.ts`
- Modify: `src/routes/responses/handler-v4.ts`
- Test: `tests/openai/semantic-bridge-unknown.http.test.ts`

- [ ] identity Responses→Responses／Anthropic→Anthropic unknown raw原样through。
- [ ] translation request unknown在dispatch前真实HTTP 4xx，History含raw upstream受保护轨＋request disposition。
- [ ] whole response unknown在headers前HTTP error。
- [ ] stream headers-committed/body-uncommitted typed terminal无partial；body-committed保partial＋terminal。
- [ ] unknown不编码成普通text成功，不进入transport/semantic/continuation retry。
- [ ] mutation：default break、empty emission、guess text后红；正确additive identity不false-red。
- [ ] Run: `bun test tests/openai/semantic-bridge-unknown.http.test.ts tests/pipeline/bridge-compatibility-retry.unit.test.ts`。Expected: request/whole/stream四格与dispatch delta全部PASS。
- [ ] Commit: `feat(bridge): reject unknown translated semantics`

### Task 7.6: 删除旧 translator 分支与文件收敛

**Files:**
- Modify: `src/lib/openai/translate/anthropic-to-responses-request.ts`（保留公共 export，收敛为 profile thin wrapper）
- Modify: `src/lib/openai/translate/anthropic-to-responses.ts`（保留公共 export，收敛为 profile thin wrapper）
- Modify: `src/lib/openai/translate/anthropic-to-responses-stream.ts`（保留公共 export，收敛为 profile thin wrapper）
- Modify: `src/lib/openai/translate/responses-to-anthropic-request.ts`（保留公共 export，收敛为 profile thin wrapper）
- Modify: `src/lib/openai/translate/responses-to-anthropic.ts`（保留公共 export，收敛为 profile thin wrapper）
- Modify: `src/lib/openai/translate/responses-to-anthropic-stream.ts`（保留公共 export，收敛为 profile thin wrapper）
- Delete: `src/lib/openai/translate/semantic-bridge/migration-dispatch.ts`
- Modify: `src/lib/openai/translate/index.ts`
- Modify: `src/lib/pipeline/hub-translate.ts`
- Test: `tests/architecture/semantic-bridge-supported-kinds.unit.test.ts`
- Test: `tests/architecture/semantic-bridge-zero-legacy.unit.test.ts`

- [ ] **Step 1: 证明可删除。** Population guard断言四张registry覆盖首批SupportedKind，dispatcher `migratedKinds`与SupportedKind精确相等；否则停止，不删shell。
- [ ] **Step 2: 捕获路径清单。** Run: `rg -n "webSearchCallToText|reasoningText|reasoningEncrypted|translateAssistantBlocks|foldInputItems|default:\s*\{" src/lib/openai/translate/{anthropic-to-responses-request,anthropic-to-responses,anthropic-to-responses-stream,responses-to-anthropic-request,responses-to-anthropic,responses-to-anthropic-stream}.ts`。Expected: 每个命中已在审计表有semantic owner或明确非bridge helper。
- [ ] **Step 3: 原子收敛。** Hub直接调用最终pair profiles并删除dispatcher。六个旧文件全部保留既有公共export与调用签名，但函数体收敛为只调用最终profile／renderer的thin wrapper；不得留下per-family matcher，也不删除CC/Gemini仍使用的shared primitives。
- [ ] **Step 4: 零残留守卫。** `semantic-bridge-zero-legacy` AST／import guard拒绝旧per-family matcher、旧default break和dispatcher import；插回任一旧case的mutation必须红。
- [ ] **Step 5: 运行。** Run: `bun test tests/architecture/semantic-bridge-supported-kinds.unit.test.ts tests/architecture/semantic-bridge-zero-legacy.unit.test.ts tests/pipeline/hub-translate.unit.test.ts && bun run typecheck && bun run test:backend`。Expected: PASS。
- [ ] **Step 6: commit。** Commit: `refactor(bridge): retire legacy direct translators`

## Phase 验收

- AC1–AC3、AC12、AC15、AC19通过。
- 首批支持集无silent drop；identity unknown passthrough、translation unknown fail-loud。
- 四格error wire、History与dispatch delta判据通过。
- 全量review 0 BLOCKER/MAJOR后才进P8。
