# Anthropic→Responses thinking 丢弃汇总实施计划

**目标：** 用户主动把含 Claude 历史的会话切换到 Responses 模型时，继续正确舍弃不可移植的 Claude-signed thinking 块，但把逐块 WARN 改为每请求一次 INFO，并将精确数量与原因持久化到 `PipelineInfo`。

**架构：** `translateAnthropicToResponses` 在一次遍历中累计外来 thinking 块数量；翻译结束后只产生一个领域诊断对象。source-signed 的 INFO、unsigned 的 WARN 与 `RequestContext` 的结构化 `PipelineInfo` 都投影自该对象。`RequestContext` 使用独立 merge slot，确保后续 `setPipelineInfo` 的全量替换不会抹掉该诊断。

**技术栈：** TypeScript、Bun test、现有 `consola` 与 History V3 `PipelineInfo`。

## 全局约束

- Claude-signed thinking 块继续舍弃，不伪造 Responses `encrypted_content`。
- 我方 `copilot-api:synthetic-reasoning:v1` 哨兵块继续无损还原为 Responses reasoning item。
- 普通文本、tool_use 与 tool_result 的翻译输出不变。
- 合法 source-signed thinking 每请求最多输出一条 INFO；畸形 unsigned thinking 每请求最多输出一条 WARN；两类都不得逐块刷屏。
- 结构化诊断必须包含精确块数和稳定 reason，并写入 History `pipelineInfo`。

### Task 1：用红测冻结请求级汇总契约

**文件：**
- 修改：`tests/openai/anthropic-to-responses-request.unit.test.ts`
- 修改：`tests/context/request-buffered-merge-info.unit.test.ts`
- 修改：`tests/anthropic/anthropic-codec-forward-leg.it.test.ts`

- [x] 添加纯转换测试：多个 Claude-signed thinking 块只产生一次 INFO；unsigned 块保持请求级 WARN；callback 只调用一次且分类 count 精确；Responses reasoning item 仍为 0、普通文本保留。
- [x] 添加 RequestContext 测试：translation 诊断在未调用 `setPipelineInfo` 时可见，之后的全量替换不覆盖它，终态 History 仍保留。
- [x] 添加 forward-leg 集成测试：真实 codec/cell 的 Anthropic→Responses 路由将 callback 接入 RequestContext。
- [x] 运行三个目标测试，确认因接口尚不存在或行为仍逐块 WARN 而红。

### Task 2：实现单源汇总与结构化持久化

**文件：**
- 新建：`src/lib/pipeline/translation-degradation.ts`
- 修改：`src/lib/openai/translate/anthropic-to-responses-request.ts`
- 修改：`src/lib/pipeline/hub-translate.ts`
- 修改：`src/lib/codec/openai-responses/openai-responses-cell.ts`
- 修改：`src/lib/history/types.ts`
- 修改：`src/lib/context/types.ts`
- 修改：`src/lib/context/request.ts`

- [x] 在 `PipelineInfo` 增加窄的 Anthropic→Responses translation degradation 字段，包含总数、source-signed/unsigned 分类与稳定 `reason`。
- [x] 给 `RequestContext` 增加独立记录方法和 merge slot，遵循现有 buffered-merge/max-tokens 诊断模式。
- [x] 将 translator 改为遍历时累计、函数末单次 callback，并按 source-signed/unsigned 分类各输出至多一次 INFO/WARN；删除逐块日志，修正“should never happen”旧注释。
- [x] 经 `HubTranslateContext` 把 callback 从 Responses cell 的 `env.ctx` 接入 translator。
- [x] 重跑目标测试直到全绿。

### Task 3：验证、评审与提交

- [x] 跑目标测试、`bun run typecheck`、`bun run test:backend`（主会话最终目标 36/36、backend 本次发现 4746 项并全部通过；独立 reviewer 复跑 backend 本次发现 5539 项并全部通过；精确改动文件 lint 0；全量 lint 仍被未触及路径与 worktree project-service 基线错误阻断）。
- [x] 检查结构怪味：已消除逐块日志/结构化双计数源；translation 采用按 pair 命名空间；source-signed 与 unsigned 分开记录。
- [x] 独立 reviewer 同时检查 false-green 与 false-red；首轮唯一 MAJOR 要求 callback mutation 正控，同一 reviewer 用冻结 exact patch 独立复验后关闭为 fixed。最终 C1–C9 全通过、0 blocker、0 major、可合并；报告见 `docs/tmp/2026-08-05-thinking-drop-summary-review.md`。
- [x] 完整通读本计划，核对文件与实现一致。
- [x] 使用显式 pathspec 创建 Conventional Commit；保持提交仅在本地，不推送。
