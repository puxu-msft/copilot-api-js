# Phase 1 执行报告：error-shaping.ts 核心决策引擎

**状态**：完成。3 个提交落地 `feat/upstream-error-client-shaping`（Phase 0 之上）。
**提交**：
- `26e51e23` feat: extend SyntheticOriginKind + FeatureKind for error-shaping（任务 1.3 + 类型逼出的消费站点）
- `5202f110` feat: add error-shaping decision engine（任务 1.1 + 1.2 builder + 1.4，单一新文件合并）
- `ecaced8e` refactor: absorb anthropicStreamErrorType into error-shaping (G-3)（任务 1.2 re-export）

## 产出文件

- `src/lib/anthropic/error-shaping.ts`（新）——纯 lib 模块，零 `routes/` 导入（`grep '^import' | grep routes` 为空）。导出全部对齐 README §4 契约：`ErrorShapingConfig` / `ShapingInput` / `ShapingDecision` / `decide()` / `buildCanonicalErrorFrame()` / `classifyStreamErrorType()` / `AuqQuestion` / `renderAuqQuestion()` / `DEFAULT_AUQ_TEMPLATE`。
- `tests/anthropic/error-shaping.unit.test.ts`（新）——36 test 全绿，52 expect。
- `src/lib/pipeline/frame-origin.ts` —— `SyntheticOriginKind` += `error-shaping-auq` / `error-shaping-canonical`。
- `src/lib/observability/events.ts` —— `FeatureKind` += 3 成员（紧邻 `refusal-errored` 之后）。
- `src/routes/messages/streaming-pump.ts` —— `anthropicStreamErrorType` 改 `export { classifyStreamErrorType as anthropicStreamErrorType } from …`（re-export，两真实调用点 handler-v4.ts:1193/:1452 零改动）。

## 收尾验证

- `bun run typecheck` 绿（含 e2e-ui tsconfig）；`bun run typecheck:ui-v4` 绿（ui-v4 无 FeatureKind/SyntheticOriginKind 消费者）。
- `bunx eslint`（无缓存）8 个 touched 文件全绿。
- 回归：`tests/anthropic/post-commit-error.unit.test.ts`（既有构造函数未破坏）、`anthropic-stream-roundtrip.it.test.ts`、`stream-shutdown-race.it.test.ts`（覆盖 shutdown→overloaded_error 真实路径）全绿。
- 未触碰 `codec/openai-cc` / `codec/openai-responses`（git status 确认）。

## 与需求单的偏差（须知会，供后续 Phase 同步）

1. **合并了模块类 3 个任务到 1 个提交**（1.1 + 1.2-builder + 1.4）。理由：`error-shaping.ts` 是单一新文件，把一次新建拆成 3 个提交需人为重构半成品文件态，是无价值 churn。跨文件的语义单元（1.3 类型扩展、1.2 G-3 re-export）仍各自独立提交。红-先-于-绿：整体红（模块缺失）已确认；每个 describe 块的断言均具体、非空验证。**这不改动任何契约签名**，Phase 2-5 消费不受影响。

2. **类型系统逼出了 4 个 README 未预见的消费站点**（"逼出全站点" 生效）。扩 `SyntheticOriginKind` 后 typecheck 报 3 处、扩 `FeatureKind` 后报 1 处，均已按 **richest-data-flow** 正确方向修复（放大 union 让新合成帧可被 history 记录 + 可辨识，而非在调用点丢弃）：
   - `src/lib/history/types.ts` `SseEventRecord.synthetic` union += 两个 error-shaping 值 + doc 段（SSOT，Phase 3/4 的 forwarded 合成帧落盘所需）。
   - `src/lib/pipeline/client-sink.ts` 两处 `sampleForwarded` 参数 union（169 SSE sink / 493 WS sink）。
   - `src/lib/tui/terminal-ui.ts` `renderFeatureTag` 穷尽 switch，3 个新 FeatureKind 归入 bare-name tag 组（同 refusal-recovered/-errored）。
   **这些是 Phase 3/4 本就需要的接线基础，非范围蔓延**——若不在此处修，Phase 1 无法 typecheck-green。README §4 / 各 Phase 若引用「synthetic 只有旧 5 值」需同步为「已含 error-shaping-auq/-canonical」。

3. **eslint --fix 移除了 1 处 `as AuqQuestion` 断言**（`d.kind` narrowing 后 `d.questions[0]` 已是 `AuqQuestion`，断言冗余），对应 `type AuqQuestion` 导入亦被移除。测试语义不变。README §4 的 `AuqQuestion` 接口本身保留、正常导出，Phase 4 消费不受影响。

4. **`buildCanonicalErrorFrame` 的 `errorType` 由 `decide()` 内 `anthropicErrorTypeForApiError()` 映射**（rate/quota/upstream_rate→`rate_limit_error`、server/network→`api_error`、content_filtered/token_limit/bad_request→`invalid_request_error`、payload→`request_too_large`、auth→`authentication_error`）。README §4 只给了 `canonical-error` 的字段形状、未固定 ApiErrorType→wire-type 映射表；此映射是本 Phase 新增的合理默认，若 spec 附录另有规定以 spec 为准（低风险、可 Phase 3 微调）。AUQ options 文案同理为最小起步集。

## concerns

- 无阻塞项。`clientVisibleStopEmitted` 按需求单设计为 Phase 6 前向兼容位，真值表已显式测试 `true`/`false` 结果一致（当前不变量）。
- 偏差 2 的 union 放大需在后续 Phase / README §4 的「synthetic 值集」处保持措辞同步，否则文档-代码会漂移。
