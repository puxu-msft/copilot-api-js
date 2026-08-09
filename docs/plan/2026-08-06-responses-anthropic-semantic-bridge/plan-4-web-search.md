# P4 — Web Search Family: First Production Cutover

> **状态**：未实施
>
> **前置**：P0 Web Search／carrier gates、P1–P3。Web Search 是首个 production family；完成后不得保留旧 `webSearchCallToText` 双轨。

**Goal:** 将 Web Search 的 request declaration／choice、whole／stream presentation、continuation、reverse echo 和 Claude Code 外层行为原子迁入 semantic bridge。

### Task 4.1: Responses Web Search source adapter

**Files:**
- Create: `src/lib/openai/translate/semantic-bridge/responses-adapter.ts`
- Create: `src/lib/openai/translate/semantic-bridge/anthropic-adapter.ts`
- Create: `src/lib/openai/translate/semantic-bridge/anthropic-to-responses-profile.ts`
- Create: `src/lib/openai/translate/semantic-bridge/responses-to-anthropic-profile.ts`
- Create: `src/lib/openai/translate/semantic-bridge/anthropic-renderer.ts`
- Create: `src/lib/openai/translate/semantic-bridge/responses-renderer.ts`
- Create: `src/lib/openai/translate/semantic-bridge/families/web-search.ts`
- Modify: `src/types/api/openai-responses.ts`
- Test: `tests/semantic-bridge/web-search-lifecycle.unit.test.ts`
- Create: `docs/tmp/2026-08-07-responses-anthropic-semantic-bridge-progress-p4-web-search.md`

**Produces:** complete／incomplete whole source union；`response.web_search_call.in_progress/searching/completed` typed progress；`output_item.done` 权威 close。

- [ ] 写完整序列：added→in_progress→searching→completed→done。
- [ ] 写缺 added合成 open、重复 completed、乱序、type change 反向控制。
- [ ] Adapter 以 `output_index` 关联，禁止 item.id。
- [ ] mutation：改用 item.id 后 per-event re-encrypted fixture 红。
- [ ] Commit: `feat(bridge): model web search lifecycle`

### Task 4.2: 双平面 Web Search handler

**Files:**
- Modify: `families/web-search.ts`
- Test: `tests/semantic-bridge/web-search-handler.unit.test.ts`

**Produces:** presentation=`degraded`，emissions 含 synthetic `server-tool-use`＋text/citations；continuation=`carrier`，保存 P0 冻结的权威 reference／whole item。

- [ ] complete action.query、action.queries、incomplete无action三类正控。
- [ ] lostFields 明确 Anthropic native result set／result encrypted content；不伪造 `web_search_tool_result`。
- [ ] display degradation 与 continuation carrier 同时成立。
- [ ] mutation：删 continuation、改成纯 text、伪造成功 result 后红。
- [ ] Commit: `feat(bridge): add web search dual-plane handler`

### Task 4.3: Anthropic request declaration／choice handler

**Files:**
- Modify: `families/web-search.ts`
- Modify: `anthropic-to-responses-profile.ts`
- Test: `tests/openai/anthropic-to-responses-request.unit.test.ts`

- [ ] `web_search_YYYYMMDD` → `{type:"web_search"}`；forced choice同 mapper。
- [ ] declaration过滤时 named／any choice同步省略；零工具 required省略。
- [ ] 当前基础 variant和新 dynamic variant均按 prefix映射，但能力／平台差异由 source type真实保留在 disposition，不猜目标 schema。
- [ ] mutation回旧 `{type:"function",name:"web_search"}` 后原400 fixture红。
- [ ] Commit: `feat(bridge): map web search request atomically`

### Task 4.4: Whole／stream renderers 与 continuation echo

**Files:**
- Modify: `responses-to-anthropic-profile.ts`
- Modify: `anthropic-to-responses-profile.ts`
- Modify: `anthropic-renderer.ts`
- Modify: `continuation.ts`
- Test: `tests/openai/responses-to-anthropic.unit.test.ts`
- Test: `tests/openai/responses-to-anthropic-stream.unit.test.ts`
- Test: `tests/semantic-bridge/web-search-roundtrip.it.test.ts`

- [ ] whole与stream消费同一 handler final decision；progress lifecycle-only不被 unknown拒绝。
- [ ] stream carrier 首次可得时点按 P0裁决选择 reference／buffer；不可行 live path显式 compatibility error，不谎称无损。
- [ ] Claude／SDK echo 后 Anthropic→Responses request profile恢复 continuation，mock／真上游 oracle接受。
- [ ] History upstream保原始 source，forwarded保 synthetic presentation，disposition只记录 scheme/version/kinds。
- [ ] Commit: `feat(bridge): round trip web search continuation`

### Task 4.5: 原子 production cutover 与旧分支删除

**Files:**
- Modify: `src/lib/pipeline/hub-translate.ts`
- Modify: `src/lib/openai/translate/responses-to-anthropic.ts`
- Modify: `src/lib/openai/translate/responses-to-anthropic-stream.ts`
- Modify: `src/lib/openai/translate/anthropic-to-responses-request.ts`
- Test: `tests/pipeline/hub-translate.unit.test.ts`
- Test: `tests/anthropic/anthropic-codec-forward-leg.it.test.ts`

- [ ] 在两个pair profile注册Web Search，并把`migration-dispatch.ts`的`migratedKinds`加入且仅加入`web_search_call/web_search`相关source kinds；未迁message/reasoning/function继续只走legacy shell。
- [ ] Hub仍调用现有translator shell；shell在Web Search case委托dispatcher，其他case保持旧实现。禁止仅含Web Search的profile接管整份response。
- [ ] 同一commit删除`webSearchCallToText`和request旧Web Search special case；whole／stream／reverse echo／diagnostics同commit。
- [ ] Architecture guard断言同kind恰一个owner；semantic Web Search失败不得回退legacy。
- [ ] mutation：删除registry row、同kind双跑、semantic失败回legacy或空emission后红。
- [ ] Commit: `feat(bridge): cut over web search family`

### Task 4.6: Claude Code WebSearch 外层 E2E

**Files:**
- Create: `tests/e2e-client/semantic-bridge-web-search-cli.e2e.test.ts`
- Reuse: `tests/e2e-client/harness/drive-claude-cli.ts`
- Reuse/extend: mock hook harness

- [ ] 从真实 Claude Code `WebSearch.call()`／CLI tool registry入口启动，不直接调内部 Messages请求。
- [ ] Mock Responses upstream发完整web-search lifecycle＋message/citations；不生成Anthropic`web_search_tool_result`。
- [ ] 断言内部声明／forced choice正确、query／query-update／`searchCount>0`／duration正确；`data.results`只含commentary字符串，不含`{tool_use_id,content:[{title,url}]}`结构化link entry。
- [ ] 断言外层普通`tool_result`含commentary并进入下一主循环，但不含伪造`Links:`段；此降级路径不要求`search_results_received`progress。
- [ ] 正控至少一次synthetic`server_tool_use`＋commentary；删server-tool-use时searchCount/query-update红，伪造`web_search_tool_result`时no-link/no-`Links:`断言红。
- [ ] incomplete无action不崩、不虚构query；carrier不触发第二次client tool执行。
- [ ] Run: `bun test tests/e2e-client/semantic-bridge-web-search-cli.e2e.test.ts`
- [ ] Commit: `test(e2e): verify Claude Code web search bridge`

## Phase 验收

- AC5–AC8／AC11通过；真实外层 client行为与内部wire都可解释。
- 旧 Web Search translator分支零残留，Web Search registry是唯一owner；未迁family仍由legacy shell单独拥有，无双跑。
- `bun run test:backend`、typecheck、SDK／CLI E2E通过。
- 独立 reviewer验证错误状态与正确状态两个方向。
