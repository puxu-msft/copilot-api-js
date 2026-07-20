# Kickoff Prompts（复制即用）

每个 Phase 一段 kickoff。用于在新会话 / subagent 中启动实施。执行前先 `git worktree` 隔离（见 README「隔离 worktree」）。

---

## 通用前置（每段 kickoff 都隐含）

```
项目：copilot-api-js。遵循 CLAUDE.md 与 ~/.claude/rules/00-user/ 全局规则。
权威 spec：docs/spec/2026-07-12-ghc-usage-details.md
实施计划：docs/plan/2026-07-12-ghc-usage-details/（先读 README 的 Global Constraints + Phase DAG）
纪律：TDD、显式 pathspec 提交、conventional commits、不加模型署名、不启/杀服务器、每 task 独立可测。
在隔离 worktree .worktrees/ghc-usage-details（分支 feat/ghc-usage-details）实施。
```

---

## Phase 0 — PoC 净公式

```
执行 docs/plan/2026-07-12-ghc-usage-details/plan-0-poc.md 的全部 task。
目标：实测判定 GHC prompt_tokens 是否把 cache_write_tokens 算作子集，结论写 exp/ghc-cache-write/CONCLUSION.md。
服务器已在 localhost:4141 运行（勿启停），用 History API 取真实 cache-write 样本。
这是全特性门控——结论未出不进 Phase 1。取不到真实样本则记录并采保守子集假设。
完成后报告：采纳「子集」还是「additive」，及依据。
```

---

## Phase 1 — fix-forward（类型 + 提取 + G6）

```
前置：Phase 0 CONCLUSION.md 已定净公式（子集/additive）。
执行 docs/plan/2026-07-12-ghc-usage-details/plan-1-fix-forward.md 的 Task 1.1–1.8，逐 task TDD。
承重红线：
- 类型双拥有点锁步（C1）——改 UsageData（history/types.ts）必同 commit 改 ResponseData.usage 内联（context/types.ts），reasoning_tokens 两处同时转可选。typecheck 绿才提交。
- 穷举 usageFromTotalInput 全站点（H1/H2，约 11 处，含 recording.ts:138/180 流式主路径 + 流式 abort/partial），grep 逼出别凭记忆。
- responses 帧的 cache_write 在 input_tokens_details（非 prompt_tokens_details，M3）。
每 task 跑 bun test + bun run typecheck 绿再提交。完成后跑全量 bun test 报告。
```

---

## Phase 2 — 历史 backfill + 迁移

```
前置：Phase 1 完成，Phase 0 净公式已定。
执行 docs/plan/2026-07-12-ghc-usage-details/plan-2-backfill.md 的 Task 2.1–2.3。
承重红线（C2，最关键）：backfill 只从上游原始 sseEvents 帧「整份重算」cache_read/cache_creation/input，
绝不对已存的 input_tokens 做增量减（usage-normalize-backfill.ts:181 已把历史行净化过，再减会静默损坏）。
先写 golden 测试证「重算正确 + 对已净化行不二次减 + 幂等 + 跳过非流式无源行」，再实现。
串行接线在 usage-normalize 之后、legacy-stage 之后（startHistoryBackfills 链）。
参照先例 usage-normalize-backfill.ts。不启服务器。完成后 bun test 全绿 + 报告。
```

---

## Phase 3 — 出向转发 + 文档同步 + 收尾

```
前置：Phase 1/2 完成。
执行 docs/plan/2026-07-12-ghc-usage-details/plan-3-forward-docs.md 的 Task 3.1–3.3。
包含：出向翻译器转发 cache_write（仅目标格式有槽位处）；DESIGN.md 记双拥有点 + backfill 现状；
跨文档 grep 一致性；派 subagent 合并态审查（裁判轴=长远正确+完整）；bun run typecheck:ui-v4；
留言请用户实测（cache-create 请求 + backfill 日志）；worktree rebase+FF 收尾；记忆维护。
```
