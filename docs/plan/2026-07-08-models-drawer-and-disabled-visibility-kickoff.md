# Kick-off prompt — 模型详情模态抽屉 + 禁用模型可见性

把下面整段复制到新会话即可开始实施。

---

你要实施一个已定稿的计划：让 ui-v4 模型详情用 Radix Dialog 模态抽屉（不挤占列表宽度），并让 config-disabled 模型在列表可见（三态 status 标记 + 可筛选）。

**先读这三份（按序）：**
1. 计划 `docs/plan/2026-07-08-models-drawer-and-disabled-visibility.md`（逐任务 TDD 步骤 + 完整代码）
2. 规格 `docs/spec/2026-07-08-models-drawer-and-disabled-visibility.md`（含 2 轮对抗审查 changelog，理解 why）
3. 项目 `CLAUDE.md` 的工作哲学与工程纪律

**实施方式**：用 `superpowers:subagent-driven-development`——每个 Task 派一个 fresh subagent 实施、两阶段 review 后再下一个。Phase A（禁用可见性，A1-A6）与 Phase B（模态抽屉，B1-B2）互相独立，可顺序做（A→B）。

**承重红线（务必守住）：**
- **R1**：只改内部 `/api/models`（`src/routes/models/internal.ts` + `src/lib/state.ts` 新增导出）。**绝不改** `state.modelIndex`、`state.models` 过滤、任何 vendor 端点（OpenAI/Anthropic `/models`、`/status`、setup）。
- **合成标记不污染上游 Model 形状**：`disabled` 只在 envelope 顶层。
- **SSOT 类型**：`InternalModelsResponse` 在后端 `src/lib/models/client.ts` 一处定义，前端经 `~backend/lib/models/client` re-export，**不内联**。
- **行 muting 只 config-disabled**（picker-disabled 占目录 51%、只给 chip 不 muting），用前景色 token 非 `tr` opacity。

**关键命令**（no-auto-server：不跑 dev/start、不 kill）：
- 后端测试：`bun test tests/models/internal-route.http.test.ts`
- ui-v4 纯逻辑：`cd ui-v4 && bun test tests/<x>.bun.test.ts`
- ui-v4 组件：`cd ui-v4 && bunx vitest run tests/<x>.vitest.test.tsx`
- typecheck：`bun run typecheck` + `cd ui-v4 && bun run typecheck`
- **UI 交付必跑 `bun run build:ui-v4`（rollup 真实构建，验 `~backend` 模块纯——vitest 可能假绿）**
- 单文件 lint：`bunx eslint <path>`（无缓存）

**纪律：**
- 严格 TDD：每 Task 先写失败测试→确认失败→最小实现→确认通过→提交。
- 细粒度提交，显式 pathspec（`git add -- <路径>` / `git commit -- <路径>`），conventional commits，无模型署名。
- 本仓常有并发会话：只提交本任务精确文件，别整文件退让。
- **dont-stop-if-clear**：Phase 内步骤清晰就连续做，不每步问；只在矛盾/破坏性/上下文不足时停。

**收尾（全部任务后，按 `session-closeout` skill）：**
1. 全仓 `bun run typecheck` + `bun run lint:all` + 后端 + ui-v4 全测试 + `bun run build:ui-v4` 全绿。
2. 派 subagent 交付审计（显式裁判轴 = 长远正确 + 完整）：核验红线未破、三态正确、Escape 测试真驱动 document、build 绿。
3. doc-sync：`docs/DESIGN.md`「活的架构现状」更新 `/api/models` 语义 + Models 详情抽屉；spec 头部 Status 改「已落地」+ commit 号。
4. plan 头部加实施状态注解。

从 Task A1 开始。
