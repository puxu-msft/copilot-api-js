# Phase 0 — 后端 scoped delete

**依赖**：无（可先行/并行 Phase 1）。**消费方**：Phase 4 清空历史。

**Goal:** 新增 `deleteEntries(filters)`（照 `deleteSession` 的 CASCADE + orphan-GC 模式）+ `handleDeleteEntries` 参数化（有筛选→scoped、无筛选→clear-all）+ `api.delete` 返回删除计数。

**红线**：绝不用 `clearAllEntries` 的无 WHERE 全表删；带 `status NOT IN ('pending','executing','streaming')` 不删 in-flight head；不豁免 pinned（沿用 `deleteSession`）。

---

### Task 0.1: `deleteEntries(filters)` — 后端 scoped delete 原语

**Files:**
- Modify: [src/lib/history/sqlite/read.ts](../../../src/lib/history/sqlite/read.ts)（export `applyWhere`）
- Modify: [src/lib/history/sqlite/write.ts](../../../src/lib/history/sqlite/write.ts)（新增 `deleteEntries`）
- Test: `tests/history/sqlite/scoped-delete.unit.test.ts`（新建）

**Interfaces:**
- Consumes: `applyWhere(opts: QueryOptions): { sql: string; params: Array<SqlBinding> }`（read.ts，本 task 改为 export）；`GC_ORPHAN_MSG_BLOB_SQL`、`getDatabase`（write.ts 现有）。
- Produces: `deleteEntries(filters: QueryOptions): number` —— 删除并返回**终态** entry 行数。

- [ ] **Step 1: 写失败测试** — `tests/history/sqlite/scoped-delete.unit.test.ts`

```ts
import { beforeEach, describe, expect, test } from "bun:test"

import type { HistoryEntry } from "~/lib/history/types"

import { closeDatabase, openInMemoryDatabase } from "~/lib/history/sqlite/connection"
import { queryEntryCount, querySummaries } from "~/lib/history/sqlite/read"
import { deleteEntries, insertCompletedEntry, upsertHeadRow } from "~/lib/history/sqlite/write"

function makeEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: `id-${Math.random().toString(36).slice(2)}`,
    endpoint: "anthropic-messages",
    startedAt: Date.now(),
    endedAt: Date.now() + 100,
    durationMs: 100,
    state: "completed",
    active: false,
    lastUpdatedAt: Date.now() + 100,
    transport: "http",
    inboundRequest: { model: "claude-opus-4-7", messages: [{ role: "user", content: "hello world" }] },
    outboundResponse: {
      success: true,
      model: "claude-opus-4-7",
      usage: { input_tokens: 1, output_tokens: 2 },
      content: { role: "assistant", content: "ok" },
    },
    ...overrides,
  } as HistoryEntry
}

describe("deleteEntries (scoped)", () => {
  beforeEach(async () => {
    closeDatabase()
    openInMemoryDatabase()
  })

  test("deletes only entries matching the endpoint filter, leaves others", async () => {
    await insertCompletedEntry(makeEntry({ id: "a1", endpoint: "anthropic-messages" }))
    await insertCompletedEntry(makeEntry({ id: "o1", endpoint: "openai-chat-completions" }))
    const deleted = deleteEntries({ endpoint: "anthropic-messages" })
    expect(deleted).toBe(1)
    expect(queryEntryCount()).toBe(1)
    expect(querySummaries()[0]?.id).toBe("o1")
  })

  test("filters by model / sessionId / pid / state", async () => {
    await insertCompletedEntry(makeEntry({ id: "m1", inboundRequest: { model: "claude-opus-4-7" }, sessionId: "s1", pid: 111 }))
    await insertCompletedEntry(makeEntry({ id: "m2", inboundRequest: { model: "gpt-5" }, sessionId: "s2", pid: 222, state: "failed", outboundResponse: { success: false, model: "gpt-5", usage: { input_tokens: 0, output_tokens: 0 }, content: { role: "assistant", content: "" } } }))
    expect(deleteEntries({ model: "opus" })).toBe(1)
    expect(querySummaries().map((s) => s.id)).toEqual(["m2"])
    expect(deleteEntries({ state: "failed" })).toBe(1)
    expect(queryEntryCount()).toBe(0)
  })

  test("does NOT delete in-flight persisted head rows (status=streaming)", async () => {
    await insertCompletedEntry(makeEntry({ id: "done", endpoint: "anthropic-messages" }))
    upsertHeadRow(makeEntry({ id: "live", endpoint: "anthropic-messages" }), "streaming")
    const deleted = deleteEntries({ endpoint: "anthropic-messages" })
    expect(deleted).toBe(1) // only the terminal one
    expect(querySummaries().some((s) => s.id === "live")).toBe(true)
  })

  test("no filters deletes all terminal rows", async () => {
    await insertCompletedEntry(makeEntry({ id: "x1" }))
    await insertCompletedEntry(makeEntry({ id: "x2" }))
    expect(deleteEntries({})).toBe(2)
    expect(queryEntryCount()).toBe(0)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/history/sqlite/scoped-delete.unit.test.ts`
Expected: FAIL —— `deleteEntries` not exported / undefined。

- [ ] **Step 3: export `applyWhere`** — read.ts

把 `function applyWhere(` 改为 `export function applyWhere(`（[read.ts:40](../../../src/lib/history/sqlite/read.ts)）。不改其它。

- [ ] **Step 4: 实现 `deleteEntries`** — write.ts（紧邻 `deleteSession` 后）

```ts
/**
 * Scoped delete: remove terminal entries matching the SAME filter set the list
 * query uses (reuses read.ts `applyWhere` for single-source WHERE), never the
 * in-flight persisted head rows (status NOT IN active states, so a streaming
 * request being finalized isn't yanked out from under the writer). Mirrors
 * `deleteSession`: DELETE FROM entries_v2 cascades req_msg/req_aux/entry_stages
 * (FK ON DELETE CASCADE); the now-orphaned content-addressed msg_blob rows are
 * swept by GC_ORPHAN_MSG_BLOB_SQL. Pinned rows are NOT exempt (deliberate delete
 * ignores pin, matching clear-all + deleteSession). Returns terminal rows deleted.
 */
export function deleteEntries(filters: QueryOptions): number {
  const db = getDatabase()
  const { sql: whereSql, params } = applyWhere(filters)
  const terminalGuard = "status NOT IN ('pending','executing','streaming')"
  const where = whereSql ? `${whereSql} AND ${terminalGuard}` : `WHERE ${terminalGuard}`
  let deleted = 0
  const tx = db.transaction(() => {
    // Count head rows BEFORE delete: entry_stages/req_msg/req_aux cascade, so
    // run().changes would include cascade rows and can't be the entry count.
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM entries_v2 ${where}`).get(...params) as { n: number }
    deleted = n
    db.prepare(`DELETE FROM entries_v2 ${where}`).run(...params)
    if (deleted > 0) db.prepare(GC_ORPHAN_MSG_BLOB_SQL).run()
  })
  tx()
  return deleted
}
```

需在 write.ts 顶部 import `applyWhere`：`import { applyWhere } from "./read"`（若已从 read import 其它则并入）；确认 `QueryOptions` 已在 type import 内。

- [ ] **Step 5: 跑测试确认通过**

Run: `bun test tests/history/sqlite/scoped-delete.unit.test.ts`
Expected: PASS（4 test）。

- [ ] **Step 6: 门禁 + 提交**

Run: `bun run typecheck`（仓库根）→ 绿。
```bash
git add -- src/lib/history/sqlite/read.ts src/lib/history/sqlite/write.ts tests/history/sqlite/scoped-delete.unit.test.ts
git commit -F <msgfile> -- src/lib/history/sqlite/read.ts src/lib/history/sqlite/write.ts tests/history/sqlite/scoped-delete.unit.test.ts
# msg: "feat(history): scoped deleteEntries(filters) via deleteSession CASCADE pattern"
```

---

### Task 0.2: `handleDeleteEntries` 参数化 + `store` re-export

**Files:**
- Modify: [src/routes/history/handler.ts](../../../src/routes/history/handler.ts)（`handleDeleteEntries`）
- Modify: [src/lib/history/store.ts](../../../src/lib/history/store.ts)（re-export `deleteEntries`）
- Test: `tests/history/history-api.it.test.ts`（追加 case）

**Interfaces:**
- Consumes: `deleteEntries`（Task 0.1）；`clearHistory`（现有）。
- Produces: `DELETE /history/api/entries?<filters>` → `{ success: true, deleted: N }`（有筛选）或 `{ success: true, message: "History cleared" }`（无筛选）。

- [ ] **Step 1: 写失败测试** — 追加到 `tests/history/history-api.it.test.ts`（沿用该文件既有 app/harness；若无则参考 `history-store.it.test.ts` 建 in-memory + 调 handler）

```ts
test("DELETE /api/entries?endpoint= deletes only matching, returns count", async () => {
  // seed two entries with different endpoints via the file's existing helper
  await seedEntry({ id: "a1", endpoint: "anthropic-messages" })
  await seedEntry({ id: "o1", endpoint: "openai-chat-completions" })
  const res = await app.request("/history/api/entries?endpoint=anthropic-messages", { method: "DELETE" })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ success: true, deleted: 1 })
  const list = await (await app.request("/history/api/entries?terminalOnly=true")).json()
  expect(list.entries.map((e: { id: string }) => e.id)).toEqual(["o1"])
})

test("DELETE /api/entries with no filters clears all", async () => {
  await seedEntry({ id: "x1" })
  const res = await app.request("/history/api/entries", { method: "DELETE" })
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.success).toBe(true)
})
```

> 注：`seedEntry`/`app` 用该测试文件已有的 fixture；若命名不同，照文件现有 seed 方式适配（勿新造 harness）。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/history/history-api.it.test.ts`
Expected: FAIL —— 现 handler 恒 clear-all，返回 `{ success, message }` 无 `deleted`，且 `o1` 也被删。

- [ ] **Step 3: 实现** — handler.ts 替换 `handleDeleteEntries`

```ts
export function handleDeleteEntries(c: Context) {
  if (!isHistoryEnabled()) {
    return c.json({ error: "History recording is not enabled" }, 400)
  }
  const query = c.req.query()
  const filters: QueryOptions = {
    model: query.model || undefined,
    endpoint: query.endpoint as EndpointType | undefined,
    success: query.success ? query.success === "true" : undefined,
    state: (query.state as QueryOptions["state"]) || undefined,
    from: query.from ? Number.parseInt(query.from, 10) : undefined,
    to: query.to ? Number.parseInt(query.to, 10) : undefined,
    search: query.search || undefined,
    sessionId: query.sessionId || undefined,
    agentId: query.agentId || undefined,
    mainAgentOnly: query.mainAgentOnly === "true" ? true : undefined,
    pid: query.pid ? Number.parseInt(query.pid, 10) : undefined,
  }
  const hasFilter = Object.values(filters).some((v) => v !== undefined)
  if (!hasFilter) {
    clearHistory()
    return c.json({ success: true, message: "History cleared" })
  }
  const deleted = deleteEntries(filters)
  return c.json({ success: true, deleted })
}
```

在 handler.ts import 补 `deleteEntries`（从 `~/lib/history/store` 或直接 sqlite/write，按文件现有 import 源）。store.ts 的 write re-export 块加 `deleteEntries`。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/history/history-api.it.test.ts`
Expected: PASS。

- [ ] **Step 5: 门禁 + 提交**

```bash
git add -- src/routes/history/handler.ts src/lib/history/store.ts tests/history/history-api.it.test.ts
git commit -F <msgfile> -- src/routes/history/handler.ts src/lib/history/store.ts tests/history/history-api.it.test.ts
# msg: "feat(history): parameterize DELETE /api/entries — scoped vs clear-all"
```

---

### Task 0.3: `api.delete` 返回删除计数（前端 client）

**Files:**
- Modify: [ui-v4/src/lib/api.ts](../../src/lib/api.ts):37-39
- Test: 现有 api 测试（若有）或随 Phase 4 消费点覆盖

**Interfaces:**
- Produces: `api.delete<T = void>(path: string): Promise<T>` —— 返回解析后的 JSON（如 `{ success, deleted }`）；旧 `await api.delete(path)` 调用点向后兼容（忽略返回值）。

- [ ] **Step 1: 改实现** — api.ts

```ts
    delete: <T = void>(path: string): Promise<T> => request<T>(path, { method: "DELETE" }),
```
（原实现 `await request<unknown>(...)` 后丢弃返回；`request` 本就 `res.json()`，改为返回它即可。）

- [ ] **Step 2: 核对现有 delete 调用点向后兼容**

Run: `cd ui-v4 && grep -rn "api.delete\|\.delete(" src/`
确认所有现有 `api.delete(...)` 调用点不依赖 void（`await` 忽略返回值即可）。若有依赖 void 的类型断言，`<T = void>` 默认已兼容。

- [ ] **Step 3: 门禁 + 提交**

Run: `cd ui-v4 && bun run typecheck` → 绿。
```bash
git add -- ui-v4/src/lib/api.ts
git commit -F <msgfile> -- ui-v4/src/lib/api.ts
# msg: "feat(ui-v4): api.delete returns parsed JSON (delete count)"
```

---

**Phase 0 完成判据**：`deleteEntries` 按各维删终态子集、不删 in-flight head、返回计数；`DELETE /api/entries` 参数化；`api.delete` 返回计数。全部 bun test + typecheck 绿。
