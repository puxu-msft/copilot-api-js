# GHC 升级版 usage 明细捕获 — 实施计划总览

> **For agentic workers:** REQUIRED SUB-SKILL: 用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐 task 实施。步骤用 `- [ ]` 复选框追踪。

**Goal:** 让 copilot-api-js 完整捕获 GitHub Copilot 升级后的 usage 明细——Tier 1 把 `cache_write_tokens` 接到 `cache_creation_input_tokens`（修计费），Tier 2 blob-only 扩 `UsageData` 装模态/prediction 分解，加历史 backfill 与非流式 rawBody 补存。

**Architecture:** fix-forward（新请求即刻正确）+ 历史 backfill（仅流式行、从上游原始帧整份重算）。类型有**两个拥有点须锁步**（`UsageData` + `ResponseData.usage` 内联）。净公式由 Phase 0 PoC 门控。

**Tech Stack:** TypeScript / Bun runtime / bun:sqlite + Umzug 迁移 / zstd blob / `bun test` (bun 内置 runner) / consola。

**权威 spec：** [`docs/spec/2026-07-12-ghc-usage-details.md`](../../spec/2026-07-12-ghc-usage-details.md)（本计划实现它；术语/背景/未采纳记录以 spec 为准）。

---

## Global Constraints（每个 task 隐含包含）

- **类型双拥有点锁步（spec §5.1 / 复审 C1）**：任何 `UsageData`（`src/lib/history/types.ts`）字段变更，必须**同一 commit**同步改 `src/lib/context/types.ts` 的 `ResponseData.usage` 内联字面量，逐字对齐。二者结构必须始终可互相赋值。特别是 `output_tokens_details.reasoning_tokens` 转可选**两处同时**转。
- **backfill 绝不增量减（spec §6.2 / 复审 C2）**：cache-write-backfill 只从**上游原始 sseEvents 帧**整份重算 `input/cache_read/cache_creation`，**绝不**对已存的 `input_tokens`（可能已被 usage-normalize 净化过）做减法。
- **fix-forward 穷举站点（spec §5.2 / 复审 H1/H2）**：`grep -rn 'usageFromTotalInput' src/` 逼出全部约 11 个调用点逐一改，不凭记忆计数。
- **无服务器命令（项目 CLAUDE.md `no-auto-server-no-kill`）**：不跑 `bun run dev/start`，不 `kill`。可跑 `bun test` / `bun run typecheck` / `bunx eslint <path>`（无缓存核单文件）/ `bun run typecheck:ui-v4`。
- **提交纪律（项目 CLAUDE.md）**：显式 pathspec（`git add -- <精确路径>`、`git commit -F <msgfile> -- <精确路径>`），每语义单元一提交，conventional commits，不加模型署名。
- **隔离 worktree**：本特性在 `.worktrees/ghc-usage-details` + 分支 `feat/ghc-usage-details` 实施，收尾 rebase + FF 回 master。
- **无向后兼容负担**：旧库行经读时适配即可，破坏性改动只要长远正确可做；但历史 token 数据**不可静默损坏**（C2 铁律）。

---

## Phase DAG（依赖与红线）

```
Phase 0 (PoC 净公式)  ──gate──►  Phase 1 (fix-forward)  ──►  Phase 2 (backfill)  ──►  Phase 3 (转发 + 文档)
                                        │                          │
                                        └── Phase 1 完成后 Phase 2/3 可并行开始，但 Phase 2 依赖 Phase 1 的类型/解析器形状
```

- **红线 1**：Phase 0 未定净公式（子集 vs additive）前，**不写** Phase 1 的 `usageFromTotalInput` 减法分支与 Phase 2 的 backfill 重算。Phase 0 结论落 `exp/ghc-cache-write/CONCLUSION.md`。
- **红线 2**：Phase 1 类型改动必须两拥有点锁步、`bun run typecheck` 绿后才提交（C1）。
- **红线 3**：Phase 2 backfill 必须先有 golden 测试证「整份重算 == 原始帧值」且「对已净化行不二次减」，再接线进 `startHistoryBackfills` 串行链（usage-normalize 之后、legacy-stage 之后）。

---

## 文件结构（谁负责什么）

| 文件 | 职责 | Phase |
|---|---|---|
| `exp/ghc-cache-write/CONCLUSION.md` | PoC 净公式结论（子集/additive）+ 原始样本 | 0 |
| `src/types/api/ghc-usage.ts`（新） | GHC 扩展 usage 形状（cache_write + 模态 + prediction），自有类型不 augment SDK | 1 |
| `src/lib/history/types.ts`（改 `UsageData`） | canonical usage + 新可选字段（拥有点 A） | 1 |
| `src/lib/context/types.ts`（改 `ResponseData.usage` 内联） | 拥有点 B，与 A 锁步 | 1 |
| `src/types/api/openai-responses.ts`（改 `ResponsesUsage`） | Responses 帧 input_tokens_details 加 cache_write | 1 |
| `src/lib/request/usage-normalize.ts`（改） | `usageFromTotalInput` 加 `cacheCreation` + details 直通 | 1 |
| `src/lib/openai/stream-accumulator.ts`（改） | chat 累积 cache_write/模态/prediction（`prompt_tokens_details`） | 1 |
| `src/lib/openai/responses-stream-accumulator.ts`（改） | responses 累积（`input_tokens_details`） | 1 |
| `src/lib/request/recording.ts`（改 138/180） | 流式主写路径透传 cacheCreation + details | 1 |
| chat/responses/gemini `handler-v4.ts` + `responses/ws.ts`（改全站点） | 非流式 + 流式 abort/partial 提取点 | 1 |
| 非流式 handler + codec `renderResponseNonStreaming`（改） | G6 rawBody 补存 | 1 |
| `src/lib/history/sqlite/cache-write-backfill.ts`（新） | 从上游原始帧整份重算，靶向流式 OpenAI 家族行 | 2 |
| `src/lib/history/sqlite/migrations/<NNN>-cache-write-backfilled.ts`（新） | `cache_write_backfilled` 标记列 | 2 |
| `src/lib/history/state.ts`（改 `startHistoryBackfills`） | 串行接线，usage-normalize 之后 | 2 |
| `responses-to-cc.ts` / `responses-to-cc-stream.ts`（改） | 出向转发 cache_write | 3 |
| `docs/DESIGN.md`「类型架构」+ 相关 topic（改） | 活文档同步（双拥有点、backfill） | 3 |

---

## 各 Phase 计划文件

- [Phase 0 — 门控 PoC 净公式](plan-0-poc.md)
- [Phase 1 — fix-forward（类型 + 提取 + G6）](plan-1-fix-forward.md)
- [Phase 2 — 历史 backfill + 迁移](plan-2-backfill.md)
- [Phase 3 — 出向转发 + 文档同步](plan-3-forward-docs.md)
- [Kickoff prompts（复制即用）](plan-kickoff.md)

## 实施状态

> **已 rebase + FF 合并入 master**（tip `fe6b2aa6`，2026-07-12）。SHA 为 rebase 后。
- Phase 0：**已完成**——净公式=子集（live DB 无样本，fallback + backfill oracle 双重防护），见 [poc-conclusion.md](poc-conclusion.md)。
- Phase 1：**已完成**——fix-forward 全 8 task + 合并态审查抓到的 **Gemini 流式腿补捉**（第 4 腿，见 `fe6b2aa6`）。含 G6 偏离（局部 JSON.stringify 而非 transport 透传原始字节）。
- Phase 2：**部分完成**——Task 2.1 标记列**已完成并合并**；**Task 2.2 backfill leaf + 2.3 接线暂缓**（C2 高风险、本部署收益近零），已记入 [docs/todo/deferred-backlog.md](../../todo/deferred-backlog.md)，续做笔记 [RESUME-task-2.2.md](RESUME-task-2.2.md)。
- Phase 3：**部分**——Task 3.1 出向转发 cache_write **暂缓**（记入 backlog）；Task 3.2 文档同步 = 本次收尾。

**合并态审查结论**：write.ts INSERT 计数一致性（合并阻塞项）完全正确；抓到 1 HIGH（Gemini 流式漏 cache_write + born-marking 使其不可恢复）**已当场修复**（补 canonical usage 进 GeminiStreamMeta）；1 LOW（responseText 注释陈旧）已修。
