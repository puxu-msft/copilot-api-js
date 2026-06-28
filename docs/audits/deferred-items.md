# 暂缓项 / 待办（Deferred Items）

本文件登记"已确认值得做、但当下有意暂缓"的事项，附根因/当前状态/理想形态/为何暂缓/若做需改什么，供日后决策。每条自洽，按主题分节。

## 1. Orphan commits 待裁（2026-06-21）

会话中在一个**分叉基底**（lineage 提交线 `b8bd275…`，非 master 的 pipeline 线）上做了两个 commit，现已与 master（`5eefc9d`）分道、成为 orphan：

- **`b28c2f6` `feat(anthropic): backfill AskUserQuestion question from header`** —— **功能重复于 master**。会话开始时该基底缺 backfill，遂重新实现了一遍；但 master 早在 Stage A（`c276b2e`/`2b025ed`）就已完整实现同一功能（`ToolInputRewriteOptions`、`backfillQuestionFromHeader` state 字段、v4 `anthropic/response-rewrites.ts` 接线、连 JSDoc 措辞都一致）。即 master 当前**已含**此功能，这个 orphan commit 对 master 无新增价值。
- **`01b4a57` `docs(claude): mandate proactive per-stage commits + strict range-based staging`** —— **非重复**。它修订了 `CLAUDE.md` 原则2：完成一阶段即主动提交、严格 file-line range-based 暂存。这部分 master 没有，值得保留。

**待决策**：倾向"丢弃 `b28c2f6`、把 `01b4a57` 的 CLAUDE.md 原则修订 cherry-pick（或手工重应用）到 master"。用户选择先记 TODO、以后再细究，故暂不动这两个 orphan。

**根因教训**（值得日后提炼成 memory）：在分叉/非 master 基底上工作时，会话起手的"功能是否已存在"判断只在**当前基底**上成立，不等于 master 的真实状态；应先对齐 `git log master` 与 HEAD 谱系，避免在错误基底上重复实现既有功能。涉及记忆 `mem:empirical-probe-via-history-api`、`mem:methodology-probe-harness-must-match-prod`（同类"探针/基底与真实目标失配"）。

## 2. AskUserQuestion `questions`-as-string 线上失败：根因待确诊 + 加固待办（2026-06-21）

### 现象
Claude Code 客户端报 `InputValidationError: AskUserQuestion ... parameter questions type is expected as array but provided as string`。一条真实请求里上游 `AskUserQuestion.input.questions` 是**合法 JSON 数组字符串**，forwarded 到客户端**仍是字符串**（decode 未触发）。`decodeToolInputFields`（默认 `{AskUserQuestion:["questions"]}`，线上 `/api/config` 实测已开）本应把它 decode 回数组。

### 已确诊的事实（实测，附证据）
- **线上服务器跑 legacy `handler.ts`，从未跑 v4 driver**：启动 HEAD=`cbc1dc7`（Jun 19 16:56，uptime ~38h），`route.ts` 只调 `handleMessages`；v4 接入（`f7f2f4c` Jun 20 04:20，默认 OFF）与 flag-on（`977a634` Jun 20 04:57）都在启动**之后**。
- **decode 核 legacy↔当前逐字节相同**：`git diff cbc1dc7 HEAD -- src/lib/anthropic/decode-tool-input-core.ts src/lib/anthropic/decode-tool-input.ts` = 0 行。
- **legacy 流式确有接 decoder 进流循环**：`cbc1dc7:handler.ts:548` 建、`608/659/830` 三处 `processEvent`、`816-826` compatFrames `continue` 旁路分支（红队核实只命中 thinking 帧、对 tool_use 不直接致命）。
- **当前 v4 链 decode 正确**：subagent 用真实探针驱动 `driver.runResponse` + 真实 `ANTHROPIC_RESPONSE_REWRITES` 实测 PASS（`exp/decode-driver-probe/`）。**但线上从不跑 v4，此 PASS 对线上失败零证明力**（探针-生产失配）。
- 真实失败 entry（`req_1782023040387_1643`，raw/forwarded 均 392 deltas、questions 仍 string）已被 reaper 淘汰；现象**间歇**，当前无法被动复现。

### 根因判断（高可能、未确诊）
失败**不在 decode 算法**（两路逐字节相同、核正确），而在 **legacy 流式编排**（多分支帧路由 + compat 旁路）。v4 迁移用干净的 registry S5 链替换了这套 legacy 编排。故**重启到当前(v4)代码很可能修复**——但因真实 entry 已淘汰、未钉死确切触发分支，属高可能而非确诊。先前"重启即修"的断言被红队正确击穿为过度自信。

### Step 0 闸门：确诊（进行中，用户操作）
用户重启 live 到当前(v4)代码 → 复现 AskUserQuestion 流程 → 抓新鲜 history entry（带 `sseEvents`）核对 raw vs forwarded 的 `questions` 类型。复现不再出错 → 确认 legacy 编排根因且已修；仍出错 → 更深问题，用新 entry 定位。

### Step 1 加固待办（确诊后做；均为讨论暴露的真缺口，独立于本案具体根因）
1. **✅ 已做（da5d9c6，2026-06-21，应用户"顺手做"提前于确诊）** **decode 静默失败可观测性**（真盲点：本次诊断花了 25+ 探针就因为零日志）。适配层 `onDecodeFailure` 回调 + 默认 sink `reportDecodeFailure`（`consola.warn("[DECODE] ...")` + `recordFeature("tool-input-decode-failed")`），覆盖 `input-parse-failed`（整块 JSON parse 失败）+ `field-undecodable`（显式配置字段解码后仍为 string）。**红队三铁律已落实**：env.ctx 注入；per-request 去重（key=tool:field:reason）；不在 flush/中断报。4 个 decode 消费点共用同一 sink。诚实边界：覆盖畸形/非法变体，**不覆盖本案**（合法 JSON 会成功 decode）。经 subagent 审查 PASS + 修了一个 MEDIUM（input-parse-failed 对 backfill-only 工具也报，已诚实化 docstring 并加测试锁定）。
2. **✅ 已做（文档化，ac62471，2026-06-21）** **`sanitizeToolNames:true` × decode-按-wire-名匹配 的潜在盲点**（红队发现、机理已核）。decode（order 200）早于 name-restore（order 300）、按上游 **wire 名**匹配 `decodeToolInputFields` 的 key。`sanitizeToolNames:true` 下名字含非法字符/超长的工具其 wire 名会变，则 decode 的 config key（客户端原名）对此类请求静默 miss。`AskUserQuestion` 是合法名（`makeValidToolName` 不改）故**永不触发**，默认 config 安全。**YAGNI 门控执行=文档化**（无真实触发）：`decode-tool-input.ts` content_block_start 匹配点加 KNOWN LIMITATION 注释（记触发条件 + 修法：resolve `block.name` 经 `env.ctx.toolNameMapper.toClient` 后匹配，需穿过流式 + 非流式 + 两个 decode-rewrite call site）。有真实含非法名工具进 decode config 时再实现该 fix。
3. **测试缺口**：
   - (A) **✅ 已做（c5dc63f）** `decodeRewrite.appliesTo` **关闭侧**——用 dry-run endpoint（`tests/infra/debug-dry-run-pipeline.http.test.ts`）测全 gate off → forwarded 逐字透传（questions 保持字符串）。dry-run endpoint 正服务此类确定性 gating 测试（比 golden 更易控 config + afterEach restoreStateForTests 自动隔离）。
   - (B) **✅ 已做（2026-06-21）** web_search 双跳旁路有**第二份 decoder 副本**（`src/routes/messages/web-search-direct.ts:376` 流式 `createToolInputStreamDecoder` / `:554` 非流式 `decodeToolInputBlocksInResponse`），先前零 decode 断言。在 `tests/anthropic/web-search/web-search.http.test.ts` 补**流式 + 非流式**两条断言：经 **pass-through 再分发**（`firstHopToolUse=false` 探针不搜索 → `handleDirectAnthropicCompletion`，唯一触达旁路 decoder 的路径；搜索路是 synthesized 不进 decoder）喂一个 `AskUserQuestion` tool_use（`input.questions` 为 stringified 数组且 item 缺 `question`，双重降级，复用 dry-run 主路径锁的同一输入 = 跨路径 drift 守卫 T3）。断言**客户端转发**侧 decode 成数组 + backfill `question=header`，而 **history**（流式 top-level `sseEvents`、非流式 `outboundResponse.content`）保留上游 stringified 原貌（`richest-data-flow`）。红队对抗 review（4 个 mutation 实证每条断言为正确原因失败、803 pass/0 fail、逐 file:line 核验路径/字段/隔离）PASS 无问题。两份副本对此输入逐位等价（`sanitizeToolNames`/`recoverToolCallText` 默认 off，`AskUserQuestion` 合法名全程不变，旁路非流式旧序 filter→recover→restore→decode 与主路径 wire-名匹配的差异对此输入不咬合）。

### Step 2（暂缓）
两份 decoder 副本（主 S5 + web_search 旁路）合并——待旁路迁 driver 时自然收敛，非本案阻塞。

### 探针产物
`exp/decode-driver-probe/`（subagent 留存的 v4 driver decode 探针，按 `mem:feedback-experiments-in-repo-exp-dir` 归档）。

## 3. dry-run inspector：配置经 env/deps 注入消竞态（2026-06-21，Phase 3 收尾记）

dry-run inspector（`POST /api/debug/dry-run-pipeline`）Phase 1-3 已全部落地（全格式 + 请求/响应侧，见 [archive/2606-landed-rfcs/pipeline-dry-run-inspector.md](../archive/2606-landed-rfcs/pipeline-dry-run-inspector.md) §8）。MVP 故意**砸掉 `configOverrides`**——dry-run 一律用当前 live 配置。

### 为何暂缓（根因 + 当前行为）
响应侧 rewrites **逐帧读 module-global `state`**（`response-rewrites.ts` 的 thinking 逐帧读 `state.thinkingSignatureCompat`、`appliesTo`/`prepareWire` 每次读 global）。若要支持"按不同配置对比回放"，朴素做法是 temp state-swap，但其窗口=**整条响应流时长**（opus 长 thinking 数十秒~数百秒），会长时间污染并发真实请求配置（评审 C1 实证）。且回放本就该用 live 配置——`configOverrides` 是投机表面。

### 理想架构（若日后要做）
**配置经 env/deps 注入、rewrites 读快照而非 module-global `state`**（彻底消竞态）。这是跨**所有** response rewrite 的重构（每条 rewrite 的 `appliesTo`/`createState`/`transform` 都改为读注入的配置快照）。**绝不**用 temp state-swap 绕（已证窗口=整流时长、live 污染）。

### 触发条件
仅当真出现"同一回放输入要对比多套配置下的客户端实收"需求时再做。当前 dry-run 用 live 配置已覆盖"上游某响应经**当前**代码+配置处理后客户端会收到什么"——本案（AskUserQuestion decode/backfill）已够用。
