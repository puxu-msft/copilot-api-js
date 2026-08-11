# 合并前对抗式评审：`HistoryBodySnapshot` 所有权改动（Claude reviewer）

被评审对象：worktree `/home/xp/src/copilot-api-js/.worktrees/per-request-cpu-reduction-43045809`，分支 `perf/per-request-cpu-reduction-43045809`，基线 master `db4d16ef`，HEAD `dcfa73ec`（五个提交）。

本文件按调用方指定的命题逐条落盘。**本轮只完成第 3 条与第 2 条**，其余五条待续。纪律：全程只读，未改动 worktree 任何文件；未触碰 4141 端口 / PID 3868381。

---

## 第 3 条：WS 快照时点前移是否改变了 History 的 inbound 腿内容

**结论：不是回归。**

### 执行顺序证据（逐跳 `file:line`）

| # | 位置 | 发生的事 |
|---|---|---|
| 1 | `src/routes/responses/ws.ts:676` | `const payload = extractPayload(message)` —— WS `onMessage` 处理器内 |
| 2 | `src/routes/responses/ws.ts:101` / `:117` | `extractPayload()` 函数体内执行 `payload.stream = true` |
| 3 | `src/routes/responses/ws.ts:706` | `handleResponseCreate(ws, payload)` —— **在 676 之后**，把同一对象作为 `rawPayload` 传入 |
| 4 | `src/routes/responses/ws.ts:227` → `:236`–`:234` 区间 | `handleResponseCreate` 里 `withHistoryAdmission(..., async (r) => await handleResponseCreateV4(ws, rawPayload, clientAbort, r))` |
| 5 | `src/routes/responses/ws.ts:273` | `handleResponseCreateV4(ws, rawPayload, ...)` |
| 6 | `src/routes/responses/ws.ts:307`（`wireBody = { ...rawPayload, instructions: wireInstructions }`） | 浅展开，**不改写** `rawPayload` |
| 7 | `src/routes/responses/ws.ts:315` | **新快照点**：`originalBodyForHistory: snapshotHistoryBody(rawPayload)`（对象字面量实参，在 `driver.runRequest` 被调用前求值） |
| 8 | `src/lib/pipeline/driver.ts:299`–`:302` | `runRequest: (raw) => runRequest(deps, raw, generation, cb)` |
| 9 | `src/lib/pipeline/driver.ts:430` → **`:437`** | `async function runRequest(...)` 的**第一条语句**即 `const parsed = deps.codec.parse(raw)`，其前**没有任何 `await`**，故同步执行 |
| 10 | `src/lib/codec/openai-responses/codec.ts:428`–`:431`（master 对应 `:427`/`:430`：`clientBody = raw.originalBodyForHistory ?? raw.body` → `structuredClone(clientBody)`） | **旧快照点** |

### 依据

1. **`payload.stream = true`（`ws.ts:117`）在两个快照点之前都已发生。** 它由 `ws.ts:676` 的 `extractPayload` 调用触发，而 `handleResponseCreate` 直到 `ws.ts:706` 才被调用。因此新旧快照**都**包含 `stream: true`，此项**不构成差异**。（附带事实：WS 恒定改写客户端的 `stream`，History 记录的 inbound 腿因此恒为 `stream: true`——这是 master 上就有的既有行为，本次改动未触及。）
2. **新旧快照点之间不存在任何语句。** 新点是 `ws.ts:315` 的实参求值；随后执行的只有 `ws.ts:316`–`:322` 的其余字面量属性（`new Headers()` 与纯读取）、`driver.ts:299`→`:430` 的函数调用、以及 `driver.ts:437` 直接进入 `codec.parse`。这条链上**没有一处写 `rawPayload`**。
3. **`rawPayload` 在 `ws.ts` 全文无后续原地改写**（`ws.ts:273` 之后仅出现在 `operationIdentity` 构造、`rawPayload.model`、`rawPayload.instructions`、`{ ...rawPayload }` 等只读位置）。
4. 两个快照点的表达式**语义等价**：新点 `structuredClone(rawPayload)`（`types.ts:271` 内），旧点 `structuredClone(raw.originalBodyForHistory ?? raw.body)` 且 `originalBodyForHistory === rawPayload`。同一输入、同一深拷贝原语。

因此 History 记录的 inbound 腿内容**逐字节等价**，非回归。

---

## 第 2 条：三个 codec 的回退分支是否仍克隆 `raw.body`

**结论：三个 codec 的回退分支全部仍然克隆；改动后不存在任何把非私有对象直接存进 History 的路径。**

### 逐条

- `src/lib/codec/anthropic/codec.ts:422` — **回退分支克隆了**（`raw.originalBodyForHistory === undefined ?` 于 `:421`，真分支 `structuredClone(raw.body as MessagesPayload)`）
- `src/lib/codec/openai-cc/codec.ts:368` — **回退分支克隆了**（判据于 `:367`，真分支 `structuredClone(raw.body as ChatCompletionsPayload)`）
- `src/lib/codec/openai-responses/codec.ts:430` — **回退分支克隆了**（判据于 `:429`，真分支 `structuredClone(raw.body as ResponsesPayload)`）

### 「有没有哪条路径把非私有对象存进 History」的穷举核验

存入 History 的唯一入口是 `ctx.setOriginalRequest({ payload: ... })`。全仓 `rg -n "payload: (originalSnapshot|geminiSnapshot)" src/lib/codec/` 命中且仅命中四处，逐个核对来源：

| 调用点 | `payload` 的来源 | 私有性 |
|---|---|---|
| `src/lib/codec/anthropic/codec.ts:457` | `originalSnapshot`（`:420`–`:423`） | 分支①route 深拷贝的 `snapshot.body`；分支②`structuredClone(raw.body)` —— **两分支都私有** |
| `src/lib/codec/openai-cc/codec.ts:399` | `originalSnapshot`（`:366`–`:369`） | 同上，**都私有** |
| `src/lib/codec/openai-responses/codec.ts:469` | `originalSnapshot`（`:428`–`:431`） | 同上，**都私有** |
| `src/lib/codec/gemini/codec.ts:369` | `geminiSnapshot` = `structuredClone(raw.body)`（`:340`） | **无条件克隆**，私有 |

生产者侧同样穷举过：`rg -n "originalBodyForHistory" --type ts .` 在 `src/` 下只有两个生产者（`src/routes/messages/handler-v4.ts:757`、`src/routes/responses/ws.ts:315`），两者都经 `snapshotHistoryBody()` 构造；`src/routes/responses/handler-v4.ts:170`、`src/routes/chat-completions/handler-v4.ts:207`、`src/routes/gemini/handler-v4.ts:193`、`src/routes/debug/dry-run-pipeline.ts:267`/`:274` 均**不**传该字段，因此走回退分支的克隆。

### 附带发现（不影响本条结论，留待后续条目展开）

`src/lib/codec/gemini/codec.ts:340` 的 parse **完全忽略** `raw.originalBodyForHistory`，而同文件 `:346` 调用的 `resolveCodecModel` 却在 `src/lib/codec/model-resolution.ts:85` **读**该字段。新写的契约注释 `src/lib/pipeline/types.ts:313`–`:318` 声称「codecs retain this exact value as History ingress」，对 4 个 codec 中的 gemini 不成立。今天无 gemini 路由传该字段，故非现网缺陷；但若将来 gemini 路由按该注释传入快照，会得到「`model` 取自客户端原始别名、`payload` 却是 wire body」的自相矛盾 History 记录。建议列为 major 记入 `docs/todo/deferred-backlog.md`（或就地把 gemini 的 `:340` 改成与其余三者相同的三元式）。

---

## 第 6 条：发现基线是否内容正确（而不只是字节 canonical）

**结论：内容正确。相对基线 `db4d16ef`，`files` 的差异恰好只有新增 `tests/pipeline/history-body-snapshot.unit.test.ts` 一项，无任何误删或误加；其余四个字段（`schema_version` / `runner_git_blob` / `minimum_executed` / `allowed_skipped`）逐项相同。没有掩盖发现漂移。**

### 集合 diff 实际输出

`git show db4d16ef:tests/infra/entry-test-discovery-baseline.json` 与 `git show HEAD:...` 解析后做集合比较（Python，**不经**那条守卫测试）：

```
files count: old=758 new=759  (dupes: old=0 new=0)
ADDED  : ['tests/pipeline/history-body-snapshot.unit.test.ts']
REMOVED: []
schema_version: old=1 new=1 SAME
runner_git_blob: old='09a273247f2b2ef821dbc3b354d2bb350fcc861a' new='09a273247f2b2ef821dbc3b354d2bb350fcc861a' SAME
minimum_executed: old=7615 new=7615 SAME
allowed_skipped: old=45 new=45  identical=True
sorted by raw bytes (new): True
independent walk: 759 files; baseline-only=[]; walk-only=[]
```

### 三条独立佐证（不依赖 `tests/infra/entry-evidence-schema.unit.test.ts` 变绿）

1. **值层面的前后集合 diff**（上表）—— 直接回答「有没有别的增删」：`REMOVED` 为空、`ADDED` 恰好一项。
2. **独立重新发现**：用 Python `os.walk` + 后缀匹配（与守卫测试所用的 `Bun.Glob` 是**不同实现**）在 worktree 内枚举 `tests/**/*.{unit,it,http}.test.ts`，得 759 个文件，与基线 `files` **双向差集皆空**。这排除了「基线与守卫测试同源、互相印证」的假绿。
3. **排序与去重**：`files` 无重复项，且按 raw bytes 排序成立（与 `entry-evidence-schema.unit.test.ts` 断言的比较器一致）。

另核：`runner_git_blob` 仍等于 `git hash-object scripts/parallel-test.ts` 的当前输出 `09a2732…`（本分支未改 `scripts/`，`git diff db4d16ef..HEAD --stat -- scripts/` 为空），该 pin 未失配。

### 一处观察（minor，不影响本条结论）

`minimum_executed` 保持 7615 未上调，而本次新增了一个含 1 个用例的测试文件。它在 `scripts/validate-entry-evidence.ts:757` 的判据是 `actualExecuted < baseline.minimum_executed` —— **是下限**，不上调不会造成 false-red，但门比实际状态松了 1。实测当前后端档 `bun run test:backend` 输出 `16 shards · 7888 tests · 7888 pass · 0 fail · 7888 executed · 45 skipped · 67.10s`（rc=0，测于 `dcfa73ec`），其 `45 skipped` 与基线 `allowed_skipped` 的 45 条一致。是否上调下限由你裁决，我不自行判定。

---

*（待续：第 1、3、4、5、7 条已由你 / 其他 agent 完成；本 reviewer 侧剩余为整体 verdict 与其余发现汇总。）*
