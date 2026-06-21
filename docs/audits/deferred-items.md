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
2. **`sanitizeToolNames:true` × decode-按-wire-名匹配 的潜在盲点**（红队发现、机理已核）。decode（order 200）早于 name-restore（order 300）、按上游 **wire 名**匹配 `decodeToolInputFields` 的 key（`decode-tool-input.ts:155` `shouldDecodeToolInput(block.name, cfg)`）。`sanitizeToolNames:true`（线上已开）下，名字含非法字符/超长的工具其 wire 名会变，则 decode 的 config key（客户端原名）对**所有**此类请求静默 miss。`AskUserQuestion` 是合法名故非本案，但是真潜伏 bug。**YAGNI 门控**：有真实含非法名/超长名且进 decode config 的工具才修（修法：在 restore 后或用 `mapper.toClient(block.name)` 比对 config key），否则文档化即可。
3. **测试缺口**（locked 双侧 + 第二份副本）：
   - (A) `decodeRewrite.appliesTo` **关闭侧**从未测（全 gate off → forwarded 逐字透传、不出现结构化数组）。建议在 `tests/anthropic/response-rewrite-golden.http.test.ts` 加 S2-off 用例，**必配 `autoRestoreState()`**（隔离纪律：三个 gate 全关是 mutate 全局 state）。这正是"线上若是 state/gating 问题"会落入的空白。
   - (B) web_search 双跳旁路有**第二份 decoder 副本**（`src/routes/messages/web-search-direct.ts:375` 流式 / `:550` 非流式），零 decode 断言。补流式+非流式 decode 断言，防与主路径行为漂移（`mem:feedback-fix-all-comparison-sites`）。

### Step 2（暂缓）
两份 decoder 副本（主 S5 + web_search 旁路）合并——待旁路迁 driver 时自然收敛，非本案阻塞。

### 探针产物
`exp/decode-driver-probe/`（subagent 留存的 v4 driver decode 探针，按 `mem:feedback-experiments-in-repo-exp-dir` 归档）。
