# Phase 2 — 历史 backfill + 迁移

**Goal:** 把存量**流式** OpenAI 家族行的 `cache_creation_input_tokens` 从 0 补正（从上游原始帧整份重算），修历史成本聚合。**绝不二次减 input_tokens**（C2）。

**前置：** Phase 1 完成（类型 + 解析器形状就绪）；Phase 0 CONCLUSION.md 净公式已定。

**参照先例：** `src/lib/history/sqlite/usage-normalize-backfill.ts`（可恢复骨架、`hasSseEvents`/`isGeminiAlreadyNet` 检测、per-entry tx、off-tx 解压压缩）。

---

### Task 2.1：迁移加 `cache_write_backfilled` 标记列

**Files:**
- Create: `src/lib/history/sqlite/migrations/<NNN>-cache-write-backfilled.ts`（`<NNN>` = 现有最大编号 + 1）
- Test: `tests/migration-cache-write-backfilled.test.ts`（新）

- [ ] **Step 1：查现有迁移最大编号**

Run: `ls src/lib/history/sqlite/migrations/ | sort | tail -3`
Expected: 得知下一个编号（如现有到 `005` 则新建 `006`）。

- [ ] **Step 2：写迁移（partial-DDL wedge 幂等，参照现有迁移写法）**

读一个现有迁移文件学 hybrid forward-runner 的 `up` 结构，仿写：
```ts
// migrations/<NNN>-cache-write-backfilled.ts
export const up = (db: Database) => {
  const cols = db.prepare("PRAGMA table_info(entries_v2)").all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === "cache_write_backfilled")) {
    db.exec("ALTER TABLE entries_v2 ADD COLUMN cache_write_backfilled INTEGER NOT NULL DEFAULT 0")
  }
}
```

- [ ] **Step 3：写测试（迁移后列存在、默认 0、幂等重跑不报错）**

用测试 DB 跑迁移两次，断言列存在 + 幂等。

- [ ] **Step 4：跑测试**

Run: `bun test tests/migration-cache-write-backfilled.test.ts` → PASS。

- [ ] **Step 5：更新 serialize.ts 的 EntryRow「born-backfilled」标记**

新建行经 fix-forward 已正确，故 `buildHeadRow`（`serialize.ts`）应写 `cache_write_backfilled: 1`（对齐现有 `usage_normalized: 1` / `stages_migrated: 1`），backfill 才会跳过新行。在 `EntryRow` 类型 + `INSERT_ENTRY_SQL` + `buildHeadRow` 三处加（仿 `usage_normalized`）。

- [ ] **Step 6：跑全测试 + typecheck + 提交**

```bash
bun test && bun run typecheck
git add -- src/lib/history/sqlite/migrations/<NNN>-cache-write-backfilled.ts src/lib/history/sqlite/serialize.ts tests/migration-cache-write-backfilled.test.ts
git commit -F <msg> -- <路径>
# msg: "feat(history): add cache_write_backfilled marker column + born-backfilled on new rows"
```

---

### Task 2.2：backfill leaf——从上游原始帧整份重算

**Files:**
- Create: `src/lib/history/sqlite/cache-write-backfill.ts`
- Test: `tests/cache-write-backfill.test.ts`（新）

**Interfaces:**
- Produces: `runCacheWriteBackfill(db: Database): Promise<void>`、`stopCacheWriteBackfill(): void`、`resetCacheWriteBackfillForTests(): void`（对齐 usage-normalize-backfill 的导出三件套）。

- [ ] **Step 1：写 golden 测试（核心不变量：整份重算 + 不二次减）**

`tests/cache-write-backfill.test.ts`：
```ts
import { expect, test } from "bun:test"
// 用隔离测试 DB（参照现有 backfill 测试的 setup），插入一条“已被 usage-normalize 净化过”的
// 流式 chat 行：column input_tokens=100 (=1000-600-300 已净), cache_read=600, cache_creation=NULL,
// 且其 upstream sseEvents 末 usage 帧 raw = '{"usage":{"prompt_tokens":1000,"completion_tokens":50,
//   "prompt_tokens_details":{"cached_tokens":600,"cache_write_tokens":300}}}'
// 跑 backfill 后断言：
test("backfill recomputes cache_creation from raw frame, never re-subtracts", async () => {
  // ... 插入夹具 ...
  await runCacheWriteBackfill(db)
  // 子集分支：input 仍=100（1000-600-300），cache_creation 补=300，cache_read=600
  const row = db.prepare("SELECT input_tokens, cache_read, cache_creation, cache_write_backfilled FROM entries_v2 WHERE id=?").get(id)
  expect(row.input_tokens).toBe(100)      // 未被二次减（若错误地对已净列再减会变 -800→0）
  expect(row.cache_creation).toBe(300)
  expect(row.cache_read).toBe(600)
  expect(row.cache_write_backfilled).toBe(1)
})

test("backfill is idempotent (second run no-op)", async () => { /* 跑两次结果相同 */ })
test("backfill skips non-streaming rows (no source), marks them", async () => { /* 无 sseEvents 行 → 标记跳过 */ })
```

- [ ] **Step 2：跑确认失败**

Run: `bun test tests/cache-write-backfill.test.ts` → FAIL（模块不存在）。

- [ ] **Step 3：实现 backfill leaf**

仿 `usage-normalize-backfill.ts` 骨架（module-global `running`/`stopRequested`、keyset 游标、per-entry tx、off-tx 解压、meta version 守卫、never-throw）。关键差异：

- **靶向**：`WHERE cache_write_backfilled = 0 AND endpoint IN ('openai-chat-completions','openai-responses','gemini-generate-content')`。
- **取源**：复用 `hasSseEvents` 语义读上游原始 sseEvents（driver `sse_events` stage 或 legacy `inboundResponse.sseEvents`）。无 sseEvents → `markStmt`（标记跳过），不改数字。
- **帧扫描（M2）**：遍历全帧，`JSON.parse(raw)`（try/catch），取**最后一个** parsed body 含 `usage` 对象的帧。
- **分 endpoint 取字段（M3）**：chat/gemini 读 `usage.prompt_tokens`+`prompt_tokens_details.{cached_tokens,cache_write_tokens}`；responses 读 `usage.input_tokens`+`input_tokens_details.{cached_tokens,cache_write_tokens}`。
- **整份重算（C2）**：`cache_read = raw_cached`、`cache_creation = raw_cache_write`、`input = netInputTokens(raw_prompt, raw_cached, raw_cache_write)`（子集分支；additive 分支 `input = netInputTokens(raw_prompt, raw_cached)`）。若 raw_cache_write 为 null/0 → cache_creation 不写（保持 NULL），但仍标记 backfilled=1（已核验无 cache-write）。
- **双写**：column（`input_tokens`/`cache_creation`）+ usage blob（`cache_creation_input_tokens` + `input_tokens` + 挂 details）。仿 `prepareBlobRewrites` 处理 stage 行 vs legacy 单 blob。
- **oracle 自检（M1，可选断言/tripwire）**：子集分支 `input+cache_read+cache_creation == raw_prompt`；additive 分支 `input+cache_read == raw_prompt`。不符则 `counts.errors++` 且不标记（留待复查）。

- [ ] **Step 4：跑测试通过**

Run: `bun test tests/cache-write-backfill.test.ts && bun run typecheck` → PASS（含幂等、跳过非流式、不二次减三条）。

- [ ] **Step 5：注册测试 resetter**

在 RESETTERS 注册 `resetCacheWriteBackfillForTests`（仿 usage-normalize）。

- [ ] **Step 6：提交**

```bash
git add -- src/lib/history/sqlite/cache-write-backfill.ts tests/cache-write-backfill.test.ts <resetter 注册文件>
git commit -F <msg> -- <路径>
# msg: "feat(history): cache-write backfill recomputes cache_creation from raw upstream frames"
```

---

### Task 2.3：串行接线进 `startHistoryBackfills`（C2 排序）

**Files:**
- Modify: `src/lib/history/state.ts`（`startHistoryBackfills` + import + `stopCacheWriteBackfill` 加进 teardown）

- [ ] **Step 1：改串行链**

现有链：`runUsageNormalizeBackfill → .finally(startLegacyStageBackfill) → …`。cache-write-backfill 须在 **usage-normalize 之后**（C2）且 **legacy-stage 之后**（需新 stage 布局读 sseEvents）。把它插进链：在 `startLegacyStageBackfill` 内部链尾、或新增 `startCacheWriteBackfill()` 接在 legacy-stage 的 `.finally` 后。读 `state.ts:210-231` 现有 `start*Backfill` 模式仿写一个 `startCacheWriteBackfill`：
```ts
export function startCacheWriteBackfill(): void {
  if (!enabled || !isDatabaseOpen()) return
  void runCacheWriteBackfill(getDatabase())
    .catch((err: unknown) => consola.warn("[history] cache-write backfill failed", err))
    .finally(() => startSearchIndexBackfill()) // 或原链的下一环，保持顺序
}
```
并把 legacy-stage 完成后的 `.finally` 指向 `startCacheWriteBackfill`（而非直接 search-index），保持全链串行、顺序：usage-normalize → legacy-stage → **cache-write** → search-index → preview。

- [ ] **Step 2：teardown 加 stop**

在 `shutdownHistory`（`state.ts:127` 附近）加 `stopCacheWriteBackfill()`。

- [ ] **Step 3：typecheck + 全测试**

Run: `bun run typecheck && bun test` → PASS。**不启服务器**——串行链的运行期验证留给用户（Phase 3 收尾）。

- [ ] **Step 4：提交**

```bash
git add -- src/lib/history/state.ts
git commit -F <msg> -- src/lib/history/state.ts
# msg: "feat(history): wire cache-write backfill into serial chain after usage-normalize"
```

**Phase 2 完成判据：** backfill 三条 golden 测试绿（重算/幂等/跳过非流式）；串行链顺序正确；`bun test` 全绿。运行期 backfill 效果由用户跑（no-auto-server）。
