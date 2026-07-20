# Kick-off prompt: ui-v4 Raw JSON 双视图共享组件

复制以下内容到新会话启动实施（subagent-driven）。

---

你在 `/home/xp/src/copilot-api-js`（`copilot-api-js`，见 CLAUDE.md）。请实施「ui-v4 Raw JSON 双视图共享组件」计划：抽全站共享 `<RawJsonView>`（树 + 高亮原文），并增强自研 `CodeBlock`/`JsonTreeView`，铺到所有 raw JSON 面。

**先读**（按序）：
1. 计划：`docs/plan/2026-07-08-ui-v4-raw-json-dual-view.md`（7 个 task，TDD 步骤 + 精确路径/命令，含 Global Constraints 与 open 态提升/懒展开设计）。
2. 规格：`docs/spec/2026-07-08-ui-v4-raw-json-dual-view.md`（§3 契约、§4 迁移清单与两级 toggle/非 JSON 守卫、§5 风险不变量）。
3. 项目纪律：`CLAUDE.md` + skill `debugging-frontend-tests`（portal 落 body、shiki 异步首帧 plaintext、否定断言先证正向）。

**执行方式**：skill `superpowers:subagent-driven-development`，每 task 派新 subagent。**task 有依赖顺序**：Task 1（CodeBlock 增强）→ Task 2（JsonTreeView 增强）→ Task 3（RawJsonView 组合）→ Task 4-7（迁移），必须按序。

**硬约束**（Global Constraints 摘要）：
- **零新第三方依赖**（只增强自研，不引 Monaco/CodeMirror/textea）。
- 默认 **source**、视图态每实例 local ephemeral、**不持久化**。
- 复制统一复用 `ui-v4/src/lib/clipboard.ts` 的 `copyText`，禁止重造。
- `RawJsonView` **只接结构化 JSON**；非 JSON 文本（SSE raw/error/纯字符串）**保留 `<pre>`/`RawPre`**。
- **排除不迁**：`ConfigPage`（编辑器）、`MessageDiffView`（diff 文本源）。
- source 搜索 = 行级高亮 + 跳转；展开全部不强制物化 >200 项数组。
- 交付跑 `bun run build:ui-v4`；改动文件 `bunx eslint <path>`（无缓存）。
- **不启动服务器**（no-auto-server）；性能验证的探针让用户启动或用测试样本。
- conventional commits、显式 pathspec、无模型署名。

**注意并发**：Task 5 改 `ModelsPage.tsx` 的 Raw 分支，与姊妹 plan（models-list-parity）可能同改此文件——改动落不同区块，共享 worktree 用显式 pathspec commit。

**收尾**（7 task 后）：全站 grep 复核剩余 `<pre>` 均为有意的非 JSON 文本 → 全量 vitest + build 绿 → 最大真实样本实测 source/tree 性能 → 对照 spec §7 验收 + 确认 ConfigPage/MessageDiffView 未误迁 → subagent code-review（裁判轴：长远正确 + 完整；重点核 non-JSON 守卫、copyText 复用、无新依赖）→ doc-sync（spec 状态改 landed）。

有硬分叉/破坏性/矛盾才停，否则方向明确直接推进。
