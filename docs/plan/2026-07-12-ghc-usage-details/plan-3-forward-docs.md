# Phase 3 — 出向转发 + 文档同步

**Goal:** 出向翻译器在目标格式有槽位处转发 cache_write（对称既有 cached_tokens）；活文档同步双拥有点 + backfill 现状。

**前置：** Phase 1/2 完成。

---

### Task 3.1：出向转发 cache_write

**Files:**
- Modify: `src/lib/openai/translate/responses-to-cc.ts:98`（非流式）
- Modify: `src/lib/openai/translate/responses-to-cc-stream.ts:197`（流式）
- Test: `tests/responses-to-cc-usage.test.ts`（新）

**背景：** 这些翻译器把 Responses usage 转成 chat-completions usage，现已转发 `prompt_tokens_details.cached_tokens`（`responses-to-cc.ts:98`）。对称加 cache_write（**仅目标格式有槽位处**）。

- [ ] **Step 1：写测试（转发后含 cache_write_tokens）**

```ts
import { expect, test } from "bun:test"
// 喂一个 Responses usage { input_tokens, input_tokens_details: { cached_tokens: 600, cache_write_tokens: 300 } }
// 断言转出的 chat usage.prompt_tokens_details.cache_write_tokens === 300
```

- [ ] **Step 2：跑确认失败** → FAIL。

- [ ] **Step 3：改两翻译器**

`responses-to-cc.ts:98` 的 `prompt_tokens_details` 构建加：
```ts
      ...(nonNegOrUndef(usage.input_tokens_details?.cache_write_tokens) !== undefined && {
        cache_write_tokens: usage.input_tokens_details!.cache_write_tokens,
      }),
```
流式版 `responses-to-cc-stream.ts:197` 同样处理。

- [ ] **Step 4：跑测试 + typecheck** → PASS。

- [ ] **Step 5：提交**

```bash
git add -- src/lib/openai/translate/responses-to-cc.ts src/lib/openai/translate/responses-to-cc-stream.ts tests/responses-to-cc-usage.test.ts
git commit -F <msg> -- <路径>
# msg: "feat(translate): forward cache_write_tokens in responses->cc usage"
```

---

### Task 3.2：活文档同步

**Files:**
- Modify: `docs/DESIGN.md`（「类型架构」节）
- Modify: 相关 topic 文档（如 `docs/request-pipeline.md` 或 usage/telemetry 相关，grep 定位）
- Modify: `docs/plan/2026-07-12-ghc-usage-details/README.md`（实施状态回填）

- [ ] **Step 1：DESIGN.md 记双拥有点**

在「类型架构（SSOT-types）」节补一条：usage 形状有**两个拥有点**（`history/types.ts` `UsageData` + `context/types.ts` `ResponseData.usage` 内联），须锁步——这是踩过的坑（复审 C1），未来改 usage 字段必同步两处。

- [ ] **Step 2：DESIGN.md「活的架构现状」记 backfill 行**

在 backfill 清单加 `cache-write-backfill`（靶向流式 OpenAI 家族、整份重算、串行在 usage-normalize 后）。

- [ ] **Step 3：跨文档 grep 验证一致性**

Run: `grep -rn 'cache_write\|cache_creation_input_tokens\|usageFromTotalInput' docs/`
确认 spec / DESIGN / plan 措辞一致，无孤立矛盾。

- [ ] **Step 4：回填 README 实施状态 + 提交**

```bash
git add -- docs/DESIGN.md docs/<topic>.md docs/plan/2026-07-12-ghc-usage-details/README.md
git commit -F <msg> -- <路径>
# msg: "docs: sync DESIGN + plan status for GHC usage details capture"
```

---

### Task 3.3：收尾（session-closeout）

- [ ] **Step 1：subagent 合并态审查**

派 subagent 做 merged-state 审查（doc-vs-code 对账、全站点是否真的都改了、backfill 与 fix-forward 接缝、`typecheck:ui-v4`）。显式裁判轴：长远正确 + 完整。

- [ ] **Step 2：ui-v4 门**

Run: `bun run typecheck:ui-v4`
Expected: PASS（根 typecheck 不覆盖子项目，见记忆 [[feedback-verify-ui-with-build-not-just-typecheck]]）。

- [ ] **Step 3：用户实测门（no-auto-server）**

留言请用户：(1) 发一次真实 cache-create + cache-read 请求，确认新 history entry 的 `cache_creation_input_tokens` 非 0；(2) 观察 backfill 日志跑完、抽查一条历史流式行补正。

- [ ] **Step 4：worktree 收尾**

`bun install`（若动过 deps，本特性未动）→ rebase feat/ghc-usage-details onto master → FF 合并 → 删 worktree。

- [ ] **Step 5：记忆维护**

写一条 feedback 记忆：usage 类型双拥有点锁步（C1 教训）+ backfill 绝不二次减（C2 教训）——或并入既有 [[feedback-fix-all-comparison-sites]] 簇。更新 MEMORY.md 索引。

**Phase 3 完成判据：** 转发测试绿；DESIGN/plan 文档同步；subagent 合并态审查通过；用户实测确认 fix-forward + backfill 生效。
