# Phase 2 执行报告：预提交 retry-signal 头注入

**状态**：完成。3 个提交落地 `feat/upstream-error-client-shaping`（Phase 0+1 之上）。

**提交**：
- `2dcebc76` feat(messages): pre-commit error-shaping glue for /v1/messages routes（实现）
- `d86751fc` test(messages): integration coverage for pre-commit error-shaping wiring（.it，Task 2.1/2.2/CF-1）
- `e9e19f8d` test(messages): exhaustive unit coverage for shapePrecommitError branches（.unit，Task 2.3，11 类穷尽）

## 产出文件

- `src/routes/messages/error-shaping-glue.ts`（新）—— `shapePrecommitError(c, error)`：`errorShapingEnabled` 关 → 直通 `forwardError`；abort → 直通；否则 `classifyError` → `decide({commitPhase:"pre-commit", ...})`，`retry-signal` 分支在调用 `forwardError` 之前经 `c.header()` 注入 `Retry-After`（若 `retryAfterSec` 存在）+ `x-should-retry:true`；其余分支（`ask-user-question`/`canonical-error`）直通 `forwardError`，body 不变（AUQ 合成是 Phase 4 范围）。
- `src/routes/messages/route.ts`（改）—— 两处 `catch (error)`（`/` 与 `/count_tokens`）把 `forwardError(c, error)` 换成 `shapePrecommitError(c, error)`。
- `tests/routes/messages/error-shaping-precommit.it.test.ts`（新）—— 真实 Hono app + mock 上游 fetch，7 test：Task 2.1 golden lock（disabled 字节级同旧行为）、Task 2.2（503/429 有头、402/400 无头）、CF-1 两条（未耗尽 401 透明重试 refresh 一次不到达 glue；耗尽 401 以 `auth_expired` 到达 glue 但因 `askUserQuestion` 默认关而走 canonical-error 无重试头）。
- `tests/routes/messages/error-shaping-glue.unit.test.ts`（新）—— 手工 fake Hono `Context`（捕获 `header()`/`json()`，不建真实 app/runtime），14 test 穷尽 11 种 `ApiErrorType` × A/B/C 分类的头注入结果 + CF-2 golden lock + retryAfterSec 有/无两条。

## 收尾验证

- `bun run typecheck` 全绿（含 e2e-ui tsconfig）。
- `bunx eslint --no-cache`（4 个改动文件）：首轮 18 处均为 import 排序/Prettier 格式问题（无逻辑问题），`--fix` 后二轮全绿。
- `git diff --stat -- src/lib/error/forward.ts` 为空——未改动。
- 6 个非-Anthropic 路由目录（azure-openai/chat-completions/embeddings/gemini/responses/models）`git diff --stat` 为空。
- 未触碰 `codec/openai-cc` / `codec/openai-responses`。
- 回归：`tests/infra/error.unit.test.ts` + `tests/infra/error-format.unit.test.ts` + `tests/anthropic/error-shaping.unit.test.ts` + `tests/pipeline/token-refresh-strategy.unit.test.ts` 共 164 test 全绿，未破坏。
- 本 Phase 全部新测试（21 个，.it + .unit）+ 回归共 185 test，0 fail。
- Task 2.3 做了溯回式红-绿验证：临时把 `shapePrecommitError` stub 成裸 `forwardError(c, error)`，重跑 `.unit` 套件 → 精确翻转 6 个「头存在」断言为 fail（4 个 A 类 x-should-retry + retryAfterSec 有/无各 1），其余 8 个「头不存在」断言保持绿（对 stub 和真实实现两者都成立，是正确、非虚警的结果）；确认后恢复真实实现（`diff` 确认逐字节一致）。CF-1 的两条 `.it` 测试同样验证了「未耗尽 401 从不到达 glue」这条不变量本身，而非仅仅测 glue 的分支。

## 与需求单的偏差（须知会）

1. **测试 helper 路径**：需求单第 30/143 行写的 `~~tests/support/isolated-runtime` / `tests/support/error-shaping-fixtures.ts` 在当前代码库中不存在——实际隔离 helper 是 `tests/helpers/isolated-fixture.ts` 的 `useIsolatedRuntime()`（`.it` 用）与 `tests/helpers/state-fixture.ts` 的 `autoRestoreState()`（`.unit` 用），已按 `test-isolation` skill 核实后使用真实路径，未凭空假设。

2. **未把 Phase 1 `tests/anthropic/error-shaping.unit.test.ts` 里的 `mk()` helper 提到共享 `tests/support/` 文件**（需求单第 141/143 行的建议）。理由：`mk(type, status, extra)` 直接构造 `ApiError`，绕过 `classifyError`；但 Task 2.3 需要覆盖 `shapePrecommitError` 自身的 `isAbortError` 短路 + `classifyError` 调用这两层，若用 `mk()` 会跳过这两层、测不到「abort 从不进 decide()」「CF-2 在 decide() 之前拦截」这两个结构性断言。故改为直接构造 `HTTPError`/`Error` 实例（经真实 `classifyError` 得到 11 个精确类型），更贴近生产链路，也顺带覆盖了 `classifyError` 的状态码分支路由（间接回归验证 Phase 1 之前已有的 `classify.ts`）。这是刻意的方案选择，非疏漏；若后续 Phase 需要跨文件复用 11 类 fixture，可再抽取。

3. **`forward.ts` 与 `classify.ts` 的既有分类分歧**（本 session 发现，非本 Phase 引入、`forward.ts` 禁改故无法在此修复）：`forward.ts:mapHttpErrorToEnvelope` 在其 503 分支之前有 `error.status === 429 || errorObj.error?.code === "rate_limited"`（精确匹配 `code`）的判断；若一个真实的 503 上游响应恰好带 `error.code: "rate_limited"`（精确值），最终 wire 状态会被 `forward.ts` 强制改写成 429，即便 `classify.ts` 的 `isUpstreamRateLimited`（用 `code.includes("rate")` 或 message 子串匹配，更宽松）已经把它正确分类为 `upstream_rate_limited`/503 交给 `decide()`。这意味着：**在这类特定的 503+精确 code 输入下，`decide()` 计算出的 A 类判断（`upstream_rate_limited` 应产生 retry-signal）与 `forwardError` 最终产生的 wire 状态码可能不一致**（`decide()` 视角认为是 503，实际响应是 429）——功能上不影响 `x-should-retry`/`Retry-After` 头本身的正确性（两条路径都会判定为 A 类可重试），但会影响客户端观察到的 HTTP 状态码。已把 Task 2.2 的 503 测试用例改为不含 `code` 字段的 fixture 以避免歧义、并在测试文件内联注释记录，此分歧建议记入 `docs/todo/deferred-backlog.md`（root cause 在 `forward.ts` 的独立分类器，修复需要改 `forward.ts`，超出本 Phase 授权范围）。

## concerns

- 见上方偏差 3——`forward.ts` vs `classify.ts` 的既有分类分歧，是一个真实的、跨越多个错误类型可能复现的架构债（不仅限于 503/429，理论上任何 `forward.ts` 独立判断优先于/不同于 `classify.ts` 判断的分支都可能有同类风险），建议排期一次专门的「统一错误分类」审查，但不阻塞本 Phase 交付。
- 当前 Phase 2 范围内，B 类（`content_filtered`/`quota_exceeded`/`auth_expired`）在 `askUserQuestion=false`（默认）时与 C 类行为完全相同（都直通 `forwardError` 无头变化）——这是需求单本身的设计（AUQ 合成是 Phase 4），非本 Phase 遗漏，但如果后续 Phase 4 迟迟不落地，B 类目前实质上"什么都不做"，值得在 Phase 4 kick-off 时提醒。
- 无阻塞项。
