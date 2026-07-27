# GPT 异模型评审：空 streaming delta 透传修复

## 评审范围

- 目标 worktree：`/home/xp/src/copilot-api-js/.worktrees/keepalive-300s`
- 目标 commit：`131ea3b2 fix(anthropic): preserve empty streaming deltas`
- 评审对象：实现、回归测试、生产接线、Claude Code watchdog 独立 oracle、现网影响面表述、ADR/spec/DESIGN/记忆同步，以及相对当前 `master` 的三方合并结果。
- 注意：原始 `git diff master..fix/client-proxy-keepalive-300s` 因分支从旧 merge-base `3150b219` 分出、当前 `master` 已前进而显示 53 个文件的大量反向差异；`git merge-tree --write-tree master fix/client-proxy-keepalive-300s` 证明真实三方合并无冲突，最终只引入本 commit 的 12 文件、41 additions/17 deletions。合并时应走正常 merge/cherry-pick，不应把两点 diff 当 patch 机械应用。

## 已读取／执行的证据

- 读取最终代码与生产接线：`src/lib/anthropic/recover-tool-call/stream.ts`、`src/lib/codec/anthropic/response-rewrite-adapters.ts`、`src/lib/pipeline/{rewrite-registry,driver}.ts`、`src/lib/anthropic/{decode-tool-input,server-tool-filter,recover-refusal}.ts`、`src/routes/messages/streaming-pump.ts`、shipped `config.yaml` 与 state/schema 默认值。
- 读取 Claude Code 2.1.207 打包源码：`/home/xp/.claude/refs/claude-code-2.1.207/app.pretty.js:88228-88239,298085-298093,298198-298205,298274-298299,298355-298366,298411-298433`。确认 event-idle 下限为 300000ms；`event: ping` 在 watchdog reset 前 `continue`，其它解析事件会调用 `he()` 重置；已有部分输出时 watchdog 最终生成 `Response stalled mid-stream`。
- 独立核对 debugger 留下的真实产物：修前 `/tmp/g2-proxy-claude.json` 为 `duration_ms=300402,is_error=true`；修后 `/tmp/g2-proxy-fixed-claude.json` 与 `...run2.json` 为 `315526/315477,is_error=false,result=IDLE_SURVIVED_MARKER`。`/tmp/g2-curl.sse` 为 0 个空 text delta、15 个 ping；`/tmp/g2-curl-fixed.sse` 为 22 个空 text delta、0 个 ping。
- 运行目标测试：`tests/anthropic/recover-tool-call-stream.it.test.ts`，10 pass/0 fail。
- 在临时完整仓库中把精确机制改回 `if (delta.text === "") return []`，目标测试 9 pass/1 fail，失败点正是新增空 delta 断言；另用 parent commit + 新测试得到相同红灯。positive control 有效。
- 自构造三组边界序列：`<in` + 空 delta + `voke`、完整 marker 后 BUFFERING 中插空 delta、多个 marker 边界插空 delta。三组均恢复一个 `tool_use`、不泄漏 marker，并保留全部空 delta，3 pass/0 fail。
- 运行生产 rewrite wiring/contract 测试：`recover-tool-call-feature-detail.unit.test.ts` 与 `response-rewrite-contract.unit.test.ts` 通过。
- `bun run --cwd ... typecheck` 通过；从 worktree 根运行 ESLint 检查两个改动 TS 文件通过，仅有 dependency freshness warning。
- `test:backend` 入口因本机 rustup 未配置默认 Cargo toolchain，在 `build:history-search` 前置步骤失败；绕过该构建直接跑 unit+it+http 得到 6355 pass/3 fail，其中一条性能断言失败、两条 Bun worker SIGILL/SIGSEGV 崩溃。故我不能独立背书“当前 checkout backend 0 fail”，但目标测试、相关接线测试与 typecheck 均绿。

## 总体 verdict

**修复 2 个 major 后可合并入 `master`。**

- blocker：0
- major：2
- minor：1
- nit：0

实现中新增的空 `text_delta` 旁路本身正确；它不会削弱 tool-call marker 恢复。真实 CC/wire 证据也支持 debugger 的直接根因链和谨慎的现网影响限定。当前不能合并的原因是：同一生产 rewrite 链仍有一个已启用的兄弟吞帧点，以及文档把“载体／路径可行性已证明”过度写成“当前 buffered 默认配置的 >300s 门已闭合”。

## 事实性发现

### [major] `/home/xp/src/copilot-api-js/.worktrees/keepalive-300s/src/lib/anthropic/decode-tool-input.ts:328-347` — shipped tool-input decoder 仍会吞掉空 `input_json_delta`，所以“空协议帧保活”缺陷族只修了 text 分支

**问题**：shipped `config.yaml:893-903` 开启 `response_tool_use_fix.malformed_input`，因此 `response-rewrite-adapters.ts:277-296` 会对所有 Anthropic `tool_use` block 启用 `tool-input-decode`。该 decoder 在 block start 时为每个 tool_use 建 buffer，并对每个 `input_json_delta`——包括 `partial_json:""`——执行 `return []`，直到 `content_block_stop` 才重放。若一个上游 tool block 在 >300s 间隔内周期发空 `input_json_delta`，这些本应重置 CC event-idle watchdog 的帧仍无法及时到达客户端，症状与本次 text 缺陷同构。

**证据或失败场景**：

- `config.yaml:903` 的 repair set 非空，使 `repairEnabled=true`。
- `decode-tool-input.ts:328-336` 在 repair enabled 时选中所有 tool_use；`:341-347` 对空 `partial_json` 也缓冲并返回空数组；`:352-356` 只在 stop 时释放。
- 独立探针 `/tmp/keepalive-tool-delta-swallow.test.ts` 观测到 start 立即透传、空 delta 返回 `[]`、stop 才返回 `[emptyDelta, stop]`。
- CC 2.1.207 的 watchdog reset 位于事件类型分派之前，空 `input_json_delta` 与空 `text_delta` 一样是有效 reset 事件；项目已有 `docs/spec/anthropic-keepalive-content-delta.md:34-40` 的真 CC 覆盖矩阵也记录它能保活。
- 这不影响 sink 在 `empty_text` 模式自行合成的 tool keepalive，因为 sink 注入发生在 S5 rewrite 之后；但它确定影响“上游原生空 tool delta 经生产 rewrite 链转发”的同类场景，因此不能称本次已穷尽其它吞帧点。

**建议**：由 `gpt-souls:implementer` 在 `decode-tool-input.ts` 中对 `delta.type === "input_json_delta" && delta.partial_json === ""` 做与 text 修复同构的即时透传，不写入 `chunks/rawDeltas`；空串不携带待 decode/repair 数据，插在任意 JSON fragment 之间不改变 `chunks.join("")`。补三类测试：独立空 delta 立即透传、空 delta 夹在非空 JSON fragments 中仍正确 decode/repair、生产 `ANTHROPIC_RESPONSE_REWRITES` 链下空 tool delta 不被后续 filter 吞掉。

### [major] `/home/xp/src/copilot-api-js/.worktrees/keepalive-300s/docs/spec/2026-07-22-max-tokens-continuation.md:160` — 文档把“空 text delta 经 rewrite 可达”误写成“全面 buffered 的 >300s keepalive 前置门已通过”，与仍冻结的 D2 默认 `ping` 冲突

**问题**：本 commit 正确地没有越权反转 ADR D2，`docs/decisions/2026-07-22-continuation-retry-sequential-anchor.md:27` 明确要求另行用户裁决是否重新启用 `empty_text`。但 max-tokens spec 随即断言“全面 buffered”的 >300s 长静默门已经通过；`exp/block-level-anchor-sequential/FINDINGS.md:38-40` 也写成“不再要求换载体或接受限制”。当前 shipped/default 仍是 `stream_keepalive_mode: ping`，而 ping 确定不重置 300s event-idle。此次代码只保证**已经存在的上游空 text delta**不被 recover rewrite 吞掉，并没有令默认 ping 流自动产生 content delta。

**证据或失败场景**：

- `config.yaml:753-765` 与 `src/lib/state-defaults.ts:75-76` 的默认仍是 `ping`。
- `docs/DESIGN.md:306` 也诚实写明 `ping` 可能 >300s 断，`empty_text` 只是可选模式。
- G2 hook 自己每 15s 产生空 delta，所以修复后 G2 能通过；这证明 carrier 和 rewrite path 可行，不等于默认 production buffered path 会产生 carrier。
- 若后续计划据 `max-tokens-continuation.md:160` 直接翻转 `protect_streaming_generation` 而不重新裁决／切换 keepalive mode，默认配置仍会在 >300s 纯静默时只发 ping，计划所依赖的前置门并未成立。
- 同一事实修订还未同步到 operator-facing／代码权威注释：`config.yaml:757-764`、`src/lib/config/schema.ts:656-664`、`src/lib/state.ts:407-416`、`src/lib/state-defaults.ts:76` 仍声称“G2-proven unable／G2 实证不能重置”。这些字句在 parent 与当前 master 都已存在，但本 commit 既以“多份文档同步”为目标，又更新了相邻 SSOT，留下了直接矛盾。

**建议**：由 `gpt-souls:doc-writer` 做一次定向 doc↔code 对账：

1. 把“G2 门已通过”收窄为“空 text carrier + recover rewrite 可达性门已通过”；明确当前默认 `ping` 的 >300s 限制仍在。
2. 将“全面 buffered 可默认开启”继续标为依赖新的用户裁决：选择 `empty_text`、或选出别的能产生 content delta 的模式后才闭合 operational gate。
3. 保留 ADR D2 的历史正文与 2026-07-27 事实更正，不回写／抹除用户当时的决策；只修正 config/schema/state 注释中已被证伪的 G2 事实前提。
4. 同步修正 `tests/pipeline/anchor-multiblock-lifecycle.it.test.ts:343-346` 的旧注释，避免测试成为错误权威声音。

### [minor] `/home/xp/src/copilot-api-js/.worktrees/keepalive-300s/tests/anthropic/recover-tool-call-stream.it.test.ts:122-159` — 新测试能咬住直接回归，但没有锁住本次评审最承重的“空 delta 夹在 marker 片段中间”组合

**问题**：新增测试只检查“刚进入 text block 后的独立空 delta 立即返回”；已有下一个测试只检查 marker 跨两个**非空** delta。两者分别为绿，不能自动证明组合序列 `<in` + `""` + `voke` 在 PASSTHROUGH／BUFFERING 两种状态下都安全。

**证据或失败场景**：我独立构造三组组合探针后均通过，说明当前实现没有功能缺陷：空串不推进 `seen`，直接发出 raw frame也不改变 marker 文本拼接；即使已进入 BUFFERING，空帧提前发出相对被缓冲文本的顺序变化对文本累积是 no-op。问题只是这一关键不变量没有固化，未来重排条件或统一 buffer 逻辑时容易回归。

**建议**：把独立探针收编为参数化测试，至少覆盖：① marker 未完整识别前插空 delta；② `mode === "BUFFERING"` 后插空 delta；③多个空 delta 穿插 parameter fragments。断言空 delta 数量逐帧保留、仅一个合成 tool_use、客户端 text 不含 `call/<invoke`。可再加一条 HTTP golden，让真实 response rewrite registry 走完 recover→decode→filter 链，减少只测 factory 的接线盲区。

## 已确认无问题／对抗结论

1. **旁路不会削弱 tool-call 恢复**：当前 `seen` 只表示非空文本串；空 delta 不含 marker 字符，把它排除在 lookahead 状态外与字符串拼接恒等。三组跨边界探针均通过，包括已进入 BUFFERING 后插空帧。
2. **直接根因链成立**：CC 报文存在于客户端 bundle 而非仓库；300s event watchdog、ping 不 reset、非 ping event reset 均可从打包源码独立读出。修前／修后 curl 与真 CC 产物严格对应“空 delta 被吞→只剩 ping→300s fail”和“空 delta 到达→315s pass”。
3. **现网影响限定基本诚实**：`invoke_in_text:true` 确实由 shipped config 开启，所以代码有生产影响能力；但默认 keepalive 是 sink 生成的 `ping`，sink 位于 response rewrite 之后，ping 不会经过 recover lookahead。仅凭 G2 不能证明历史真实请求已受害，实际受害依赖上游／hook 是否产生空 text delta。应保留这一限定，不应宣传成已证实的广泛 incident。
4. **ADR 没有被越权反转**：commit 只在 D2 前加入事实更正，明确“是否重新启用 `empty_text`”要另行用户裁决；这个处理正确。问题在于其它 spec 又把门写成已全面闭合，需按 major 2 收敛。
5. **改动本体简洁且可维护**：旁路位置在 marker lookahead 入口，既避免污染 `seen`，也避免在每个 flush/rollback 分支补丁式处理；没有必要引入第三方库。


---

# 第二轮复审：`faaa37e7 fix(anthropic): escalate keepalive before content timeout`

## 第二轮评审范围

- 新 commit：`faaa37e7`，范围 `git diff 131ea3b2..faaa37e7`。
- 同时复核上一轮 2 major + 1 minor 的闭合，并按 merged-state 检查整分支 `131ea3b2 + faaa37e7` 相对当前 `master` 的三方合并结果。

## 第二轮已读取／执行的证据

- 读取最终实现：共享空 delta primitive、两处 response rewrite、delivery heartbeat owner、SSE sink adapter、Anthropic handler anchor 接线、live/buffered reconcile、config/state/schema、相关 ADR/spec/DESIGN。
- 全仓枚举 Anthropic response rewrite 的 suppression/buffer 站点，并逐项读 `recover-tool-call`、`tool-input-decode`、`server-tool-filter`、`recover-refusal` 的门控。确认除协议有意过滤的 server-tool block 与 terminal refusal 替换外，空 text/thinking/input-json delta 的生产 buffering 只有已修复的两处；`streaming-pump.ts` 的 falsy text 仅跳 repetition detector，不丢帧。
- 独立重跑短流字节等价：在 42051/42052 各起一个**自己启动**的隔离服务器，分别设置 `stream_keepalive_escalate_sec:0/200`，同一个 deterministic upstream hook；两份 SSE 均 1675 bytes，SHA-256 都是 `8691db71ca3b692468ae91dfc2df108871c8f5f684acc73f3832975d60f2a6a0`，`cmp` 完全一致。服务器均按精确 PID 停止，未触碰 4141。
- 核对已有长 gap 实测产物：三次真 CC 2.1.220 分别 `315537/315532/315502ms`、`is_error:false`、最终 `IDLE_SURVIVED_MARKER`；curl wire 为 21 个 ping + 1～2 个空 text delta。
- 运行新增／改动测试：5 个文件，446 pass/0 fail；typecheck 通过；改动 TS 文件 ESLint 通过，仅 dependency freshness warning。
- 对共享 primitive 做 mutation `return false`：recover/decode 相关测试 50 pass/3 fail；对 escalation due 做 mutation `false`：delivery 测试 7 pass/3 fail。测试确实咬住承重机制。
- 运行真实 `@anthropic-ai/sdk` safety oracle：空 `thinking_delta` 插在真实 thinking 文本与 `signature_delta` 之间，最终 `thinking` 与 `signature` 均逐字正确；7 场景 ALL PASS。
- 运行 `bun run generate:config-schema` 后 `config.schema.json` 无 diff，确认生成物同步。
- `git merge-tree --write-tree master fix/client-proxy-keepalive-300s` 无冲突；整分支有效合并结果为 28 个文件、467 additions/74 deletions。

## 第二轮总体 verdict

**整分支存在 blocker，不能合并入 `master`。**

- blocker：1
- major：1
- minor：1
- nit：0

上一轮的两个 major 和一个 minor均已针对其原始范围闭合：共享 primitive 覆盖 text/input-json 两个生产 buffer；spec 已区分“透传必要条件”和“按需升级最终闭门”；marker/JSON fragment 组合测试与 mutation 都有效。新 commit 的主方向也正确，短请求默认 wire 等价、open block 原 index 空 delta、真实 content delta 重置 deadline、ping 不重置 deadline均得到验证。但 pre-content scaffold 的门控遗漏“此前已经完成过真实 block”的 inter-block 状态，会在默认 ping 模式下迟发一个 index 0 anchor，破坏 Anthropic block index 单调性；这是 production-path 协议正确性 blocker。

## 第二轮事实性发现

### [blocker] `/home/xp/src/copilot-api-js/.worktrees/keepalive-300s/src/lib/pipeline/delivery/session.ts:119-138` — “无 open block”被错误等同于“pre-content”，导致长 inter-block idle 在已完成真实 block 后注入 index 0 anchor

**问题**：content deadline 到期时，只要 `pendingOpenBlocks.length === 0` 就调用 `injectContentScaffold()`。但“当前无 open block”也包括“至少一个真实 block 已完成后的 inter-block gap”。delivery 已维护 `semanticBlockCount`，却没有用它限制 scaffold。于是默认 `ping + escalate=200` 下，一个快速完成的 real block@0 后若进入 >200s block 间静默，会调用既有 `makeSyntheticAnchorInjector`，写 `content_block_start@0 + empty delta@0`。这不是 pre-content；index 0 已经被真实 block 用过。

**证据或失败场景**：

- 独立 FakeClock probe `/tmp/keepalive-late-anchor-collision.test.ts`：先写完整真实 block@0，`semanticBlockCount===1`；推进 200s 后，确认 `injectContentScaffold` 被调用一次，wire 尾部正是 `anchor content_block_start@0` + `keepalive content_block_delta@0`。
- 真 `@anthropic-ai/sdk` probe `/tmp/duplicate-anthropic-index-sdk.test.ts` 证明重复 completed index 并非无害：输入真实 block@0、再注入 anchor@0、再真实 block@1，SDK 最终 content 顺序变成 `first, second, empty-anchor`，而不是 wire 的 `first, empty-anchor, second`。真实客户端累积被重排，不能视为协议等价。
- 现有 `tests/pipeline/delivery-session.unit.test.ts:196-231` 只覆盖从未出现任何真实 block 的纯 pre-content case；`anchor-multiblock-lifecycle` 只推进短 15s，明确不触达 200s deadline，因此没有覆盖这个 seam。
- ADR D2 的“严格按 index 顺序输出”只约束 buffered **真实块** commit 顺序；此 out-of-band anchor 由 delivery heartbeat 直接写 sink，绕过 driver 的 block ordering gate，故不能由 D2 第 3 点兜住。

**建议**：由 `gpt-souls:debugger` 先确定完整状态机，再由 implementer 修复。最低正确门应至少是 `pendingOpenBlocks.length === 0 && semanticBlockCount === 0`，即 scaffold 仅允许“尚无任何真实完成块”的 pre-content 阶段；一旦真实 block 已完成，不能回到 index 0 anchor。还需明确 inter-block >300s 的长期方案：若客户端允许，可在上一真实 block 关闭后使用下一个**未用 index**的短命 synthetic text block，并保证后续真实 index remap；否则需让 driver/delivery 暴露合法的顺序 scaffold API。不能简单静默退回 ping，否则又留下 >300s 门。补 producer wire oracle + 真 SDK/CC oracle，覆盖“完整 real block@0 → 200s gap → 后续 real block@1”。

### [major] `/home/xp/src/copilot-api-js/.worktrees/keepalive-300s/src/routes/messages/handler-v4.ts:1071-1079` — `enveloped_ping` 与按需 content scaffold 共用同一个 one-shot `AnchorState.injected`，会使 escalation 永久失效

**问题**：`enveloped_ping` 的普通 heartbeat 先通过 `injectAnchor=makeSyntheticEnvelopeInjector` 设置共享 `anchorState.injected=true`，但按需升级的 `injectContentAnchor` 又使用同一 `anchorState` 构造 `makeSyntheticAnchorInjector`。content deadline 到期后，后者在 `keepalive-anchor.ts:225-226` 因 `state.injected` 直接返回 false；delivery 的单一 `scaffoldAttempted` 此前已被普通 envelope scaffold latch，甚至不会再调用 content scaffold。结果 `enveloped_ping + escalate_sec>0` 仍只发 ping，300s 会断。

**证据或失败场景**：独立 probe `/tmp/keepalive-enveloped-escalation.test.ts` 模拟普通 20s envelope scaffold 后推进到 260s，`injectContentScaffold` 调用次数仍为 0、空 content delta 为 0；测试因预期应升级而红。当前文档把 `stream_keepalive_escalate_sec` 描述为 ping keepalive 的独立升级机制，但没有声明 `enveloped_ping` 被排除；schema 也允许该组合。

**建议**：若按需升级应覆盖所有 ping-shaped 模式，必须把“message envelope 已注入”和“content anchor 已注入”拆成独立状态／attempt latch；`injectScaffold` 与 `injectContentScaffold` 也不能共享一个 `scaffoldAttempted`。若产品明确只支持 `stream_keepalive_mode:ping`，则 schema/config 应拒绝或禁用 `enveloped_ping + escalate>0` 并把限制写入 DESIGN；鉴于该模式保留用于 watchdog 实验，推荐修状态机而非制造静默组合例外。

### [minor] `/home/xp/src/copilot-api-js/.worktrees/keepalive-300s/docs/DESIGN.md:75,78` — live architecture 表仍把 `empty_text` 写成当前默认，与配置和本 commit 的按需升级架构冲突

**问题**：同一 DESIGN 的运行时选项表已正确写 `streamKeepaliveMode` 默认 `ping`，但“流式写出”与“流式上游 RST 缓冲重试”两行仍写“默认 `empty_text`”。这会误导后续实现者认为 pre-commit 总有常驻 anchor，掩盖本 commit 实际新增的“默认 ping + 200s on-demand”状态机。

**建议**：由 `gpt-souls:doc-writer` 把这两处活架构描述同步为当前事实，并在 `docs/spec/anthropic-keepalive-content-delta.md:10-12,54-55,82-87` 给历史 spec 加明确的“已被 2026-07-22 D2 + 2026-07-27 partial reversal supersede”注记，避免其“content_delta/default empty_text”叙述继续冒充活状态。历史 ADR 正文可以保留时间点事实，但活架构必须唯一一致。

## 第二轮已确认无问题／闭合项

1. **上一轮 major #1 已闭合**：`isEmptyAnthropicStreamDelta` 统一识别三种空 payload；recover 与 decode 两处生产 buffer 均在入 buffer 前旁路。全仓 suppression 审计未发现第三个同类生产吞帧点。`server-tool-filter` 对已判定 server-tool index 的 delta 抑制是目标协议过滤，不属于该缺陷。
2. **上一轮 major #2 已闭合**：`max-tokens-continuation.md:160` 现明确“透传必要但不充分”，并把最终门绑定到用户裁决的按需升级；没有再把 `131ea3b2` 单独宣传成门闭合。
3. **上一轮 minor 已闭合**：新增 marker 前／BUFFERING 后空 delta、JSON fragments 中空 input delta组合测试；精确 mutation 均转红。
4. **短请求默认零 wire 变化已独立确认**：deterministic hook 下 `escalate=0/200` 两流逐字节一致，均 1675 bytes；这项核心不回归主张成立。
5. **content deadline 不被 ping 推迟**：delivery 独立维护 `lastContentDeltaAtMonotonic`，普通 write/ping只更新 `lastWriteAtMonotonic`；tick 先检查 content deadline，再检查 write-idle。已有长 gap 真 CC 与 fake-clock test共同支持该机制。
6. **已有 open block 的升级形状正确**：从 post-wire ledger 取栈顶 block，`makeAnthropicKeepaliveFrame` 在原 index 发匹配空 `thinking_delta/text_delta/input_json_delta`，不新增 block 结构。真实 SDK oracle确认空 thinking delta 不改 thinking 文本或 signature；signature 是独立 `signature_delta`，空字符串追加是恒等变换。
7. **配置接线完整**：schema、state 默认、setter pick、apply、hot-reload matrix、shipped config 与生成的 `config.schema.json` 均存在；重新生成 schema 无 diff。
8. **ADR D2 修订边界正确**：只撤销被证伪的“空 delta 无效”理由，保留“日常空 text block 形状错误”、默认 ping、块级严格顺序输出，并记录用户 2026-07-27 的按需升级裁决。没有越权推翻 D1/D3/D4。
