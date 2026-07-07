# Kick-off prompts —— 反应式 per-model 上游拒绝协商

每个 phase 一个 self-contained kick-off prompt，供你**复制到新会话**逐 phase 实施。事实源分层：
- **设计冻结事实源**：[../../../rfc/2026-07-07-reactive-upstream-rejection-negotiation.md](../../../rfc/2026-07-07-reactive-upstream-rejection-negotiation.md)（O1–O6、缺口 A–H、commit invariants）。
- **how-to 事实源**：[../plan.md](../plan.md)（每 Task 的 file/TDD 步骤/factory 锚点表）。
- **项目纪律**：[项目 CLAUDE.md](../../../../CLAUDE.md) + user-level rules。

## 阶段依赖 DAG

```
P1 (primitive + A + B) ──┬── P2 (C)
   [承重, 前置]           ├── P3 (D / E / F / G)   ← 内部各子项格式独立可并行；F 须 golden-first
                          └── P4 (H)
```

- **P1 必须先做**：抽出的 `createReactiveRejectionStrategy` primitive 被 P2（C）+ P3（D/E）复用；`systemRejectModels` 的持久化 + 有效模式解析模式被 C 镜像。
- **P2 / P3 / P4 在 P1 落地后可并行**（不同会话 / worktree）。P3 内部 D/E/F/G 格式独立、可并行。
- 各 phase 用 **isolated worktree + 独立分支**（放 `./.worktrees/`）或共享树同文件不重叠行 + 显式 pathspec commit（见 skill `git-preference:avoiding-shared-worktree-conflicts`）。注意 **P1/P2/C 都改 `feature-negotiation.ts` / `sanitize/index.ts` / `codec/anthropic/strategies.ts`**——若并行须行级共存、绝不整文件退让。

## 集中红线（各 phase prompt 引用，逐条硬约束）

1. **no-auto-server-no-kill** —— 不运行 `bun run dev`/`start` 或任何启动服务器命令；不用 `kill`/`pkill`/`killall` 终止本项目实例。可跑 `bun run typecheck` / `lint:all` / `bunx eslint <path>` / `bun test`。需验证服务器行为时让用户启动。
2. **细粒度、显式 pathspec 提交** —— 每语义单元一提交，`git add -- <精确路径>` + `git commit -F <msgfile> -- <精确路径>`；conventional commits（feat/fix/refactor/…）；**无模型署名**（不 `Co-authored-by`）。
3. **喂 pre-S3 baseline 是正确性硬约束（O6）** —— A/C 的 re-sanitize arm 必须喂 `context.originalPayload`（pre-S3 baseline），**绝不**喂 already-S3 的 `currentPayload`（double-apply 整条链）。镜像 auto-truncate。
4. **判别轴 = resolved outbound 名** —— 一切 per-model 判别 key 在 `resolveModelName` 的最终 outbound 名（`payload.model` 在 sanitize 时已是 resolved），绝不 key 在 inbound 别名。归一化经 `normalizeForMatching`。
5. **能力框架非硬断言** —— 学入日志如实写「推断（Vertex 已知成因，不硬断言）」；命名按观测症状。
6. **正样本证 canHandle 触达目标** —— 每 strategy 测试用**真实上游错误串**做正样本，先证正则匹配；wire 正确性用 GHC 独立 oracle（实测，非字节自洽）。
7. **persist→reload golden** —— 每个新 negotiation 集必测「学入→snapshot 写盘→load 重载→重准备/重判定仍生效」（否则空集碰撞类 bug 会在绿测下于首次重启回归）。
8. **flaky/时序测试连跑 10–25 次** 确认确定性（反应式 mock、单例隔离）。
9. **never-swallow-errors** —— 不吞错误；预期错误至少有注释说明。
10. **subagent-explicit-rubric** —— 实现后派 subagent code-review，prompt 里写明裁判轴（**长远正确 + 完整，非 ROI/YAGNI**）；reviewer 的「无消费者/可删/已通过」绝对断言亲自对照代码复核。
11. **session-closeout** —— 每 phase 收尾走五步（subagent audit → doc-sync 跨文档 grep → 归档 plan 状态注解 → 提炼教训 → 细粒度提交）。
12. **test-isolation** —— 后端测试用 `useIsolatedRuntime` / DI 临时目录沙箱 `PATHS.NEGOTIATION_STATES`，绝不碰真实 `$HOME`/`~/.claude`（见 skill `test-isolation`）。

## Phase 索引

| Phase | Prompt | 交付 | 依赖 |
|---|---|---|---|
| P1 | [P1.md](P1.md) | primitive + A + B（承重） | 无（前置） |
| P2 | [P2.md](P2.md) | C（web_search-not-found 反应式） | P1 |
| P3 | [P3.md](P3.md) | D/E/F/G（变体缺口，F golden-first） | P1 |
| P4 | [P4.md](P4.md) | H（失败 attempt body 持久化） | 无（可并行） |
