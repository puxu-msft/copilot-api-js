# Kick-off prompt: ui-v4 模型列表页对齐

复制以下内容到新会话启动实施（subagent-driven）。

---

你在 `/home/xp/src/copilot-api-js`（`copilot-api-js`，见 CLAUDE.md）。请实施「ui-v4 模型列表页对齐」计划，补齐 ui-v4 模型列表页相对 Vue `ui/` 的 8 项回退。

**先读**（按序）：
1. 计划：`docs/plan/2026-07-08-ui-v4-models-list-parity.md`（8 个 task，每个 TDD 步骤 + 精确路径/命令，含 Global Constraints）。
2. 规格：`docs/spec/2026-07-08-ui-v4-models-list-parity.md`（含附录 A 验收 oracle）。
3. 项目纪律：`CLAUDE.md`（no-auto-server、显式 pathspec 提交、concurrent-sessions 行级共存、`~backend/*` 纯度、no-premature-stop）。

**执行方式**：用 skill `superpowers:subagent-driven-development`，每 task 派新 subagent，两阶段 review 之间把关。task 间无强依赖（Task 1 的 `options.endpoints` 被 Task 8 头部计数消费；Task 2 的 `modelBillingBounds` 被 Task 5 计数消费——按编号顺序执行即满足）。

**硬约束**（Global Constraints 摘要）：
- 数据源 SSOT：endpoint 用后端 `getEffectiveEndpoints`、能力用 `deriveCapabilities`——禁止 ui-v4 建重复实现。
- Billing 缺失-multiplier **当 0**（对齐 Vue）。
- 无新依赖（Slider 用已装 `radix-ui`）。
- 交付跑 `bun run build:ui-v4`（rollup 才暴露 `~backend` 纯度问题）；改动文件 `bunx eslint <path>`（无缓存）。
- **不启动服务器**（no-auto-server）；行为验证让用户启动。
- conventional commits、显式 pathspec、无模型署名。

**收尾**（8 项后）：全量前端测试 + build 绿 → 对照 spec 附录 A 逐项复核 → subagent code-review（裁判轴：长远正确 + 完整，对照 Vue file:line 与后端 SSOT）→ doc-sync（spec 状态改 landed）→ 若达 10 维过滤 parity，在 spec/DESIGN 记「模型列表页已达到并超越 Vue，可下线 `/ui` 列表页」。

有硬分叉/破坏性/矛盾才停下问用户，否则方向明确直接推进。
