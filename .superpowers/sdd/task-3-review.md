# Task 3 独立代码复审

## 结论更正：`4967548f` 已被生产反例推翻

- **评审范围**：候选 `1e7b527a..4967548f`（19 commits）。此前仅验证 Chat buffered、driver/candidate局部套件及若干定向 probe，未运行 Responses完整 production seam。
- **新增权威证据**：独立 acceptance verifier 在 `4967548f` 单独运行 `tests/responses/responses-buffered.it.test.ts` 确定性失败；证据报告：`/home/xp/src/copilot-api-js/.worktree/agent-a469985c95582c518/.superpowers/sdd/task-3-acceptance-rereview.md:10-13`。完整 `response.completed` 被误判为 `upstream stream truncated: closed without message_stop`，clean first try只收到 error，retry recovery也无法交付 `COMPLETE_ATTEMPT_2`。
- **更正后的总体 verdict**：**Spec FAIL；Quality CHANGES_REQUIRED；不可集成。**
- **blocker 数量**：0。Critical 0；Important 1；Minor 2。

## Superseded verdict

此前写出的“Spec PASS；Quality APPROVED；可集成”以及“未发现 Responses 兄弟协议回归”均标记为 **SUPERSEDED／错误结论**。Chat `cc-buffered.it` 5／5、driver/candidate 54／54、局部 projection probe全绿，只证明 Chat局部修复成立，不能支持跨协议共享 driver merge正确。

## 事实性发现

### Important

[Important] `/tmp/copilot-api-js-task3-review-4967548f/src/lib/pipeline/driver.ts:1351-1368` — 为恢复 Chat recovery winner finish而新增的 `currentSession(current).responseOpts` 二次 merge，破坏 Responses buffered attempt的 terminal projection；完整 `response.completed` 未进入本 attempt commit gate，被当作 truncation — 证据为 production integration test确定性红，上一候选该正确状态为绿 — **修复建议**：由已派出的接力实现者在共享 driver opts组合层修复，必须同时以完整 Chat buffered 5类和完整 Responses buffered suite作双协议正样本，不得再用单协议局部绿放行。

### Minor

[Minor] `/tmp/copilot-api-js-task3-review-4967548f/src/lib/pipeline/driver.ts:1359-1368` — 多次 spread merge使 callback/projection所有权不可审计，也是本轮跨协议回归的直接温床 — 推荐收敛为一次显式组合，并分别串接 candidate observer与driver observer。

[Minor] `/tmp/copilot-api-js-task3-review-4967548f/src/lib/pipeline/generation/candidate-response-session.ts:213-215` — compatibility projection与canonical outcome的迁移期双读面仍应在Task 4同 commit删除；当前不得据此弱化Task 3修复要求。

## 双向判据更正

- Chat错误状态与正确状态均通过，不代表 Responses正确状态能通过；此前漏跑兄弟协议完整 production seam，形成 false-green。
- 后续新 HEAD 复审的最低门：完整 `tests/chat-completions/cc-buffered.it.test.ts`、完整 `tests/responses/responses-buffered.it.test.ts`、driver/candidate suites、typecheck；两协议均绿后再审 callback顺序与winner session归属。

## 当前状态

等待新 HEAD。本文不再声称 `4967548f` 可集成；主会话按 production oracle裁定不可集成是正确的。
