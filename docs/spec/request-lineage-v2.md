# RFC: Request Lineage v2 — 对话为一等公民 + Web-search 容错 + Schema 迁移 + 深度 UI 集成

> **⚠️ DEPRECATED / 已废弃（2026-06-23）**：本 v2 重构未实现——lineage 子系统已整体删除（见 [request-lineage.md](request-lineage.md) 顶部说明）。后继方向是持久运营 stats，见 [operational-stats-and-lineage-removal.md](operational-stats-and-lineage-removal.md)。本文仅作历史设计记录保留。

**Status:** v2 final（2 轮 review incorporate——第 1 轮 4 subagent + 第 2 轮主线亲自多视角；§12 open questions 用户 2026-06-16 采纳推荐默认值）— 实现就绪。
**Author:** ECC，grounded in 读码 + `localhost:4141` live history 实测（2026-06-16）。
**Builds on:**
- [request-lineage.md](request-lineage.md)（v1 内容寻址 lineage 内核，已落地于 **master**，7 commit `c001925..b8bd275`，lineage 实现 commit 为 `00be791`(含)→`b8bd275`）
- [activity-detail-main-outline.md](activity-detail-main-outline.md)（outline-as-main detail 重构，已落地于 **feat/activity-detail-outline-as-main**，43 commit）

**Driver:** 用户授权端到端最优重构——以"**对话（Conversation）作为一等公民**"重设 lineage 查询/API/UI 层，纳入 v1 §8 deferred 的 §8.4（web-search 容错）+ §8.6（schema 迁移），UI 深度融入 feat 新框架。

**明确不做（deferred 到 v3，§11 完整文档化）：** §8.2 跨模型回退、§8.3 /compact 续接。

> **修订说明（v2 draft）：** 第 1 轮 4 个对抗 reviewer + 主线逐条复核，推翻了初稿的两处核心误判——(1) web_search 链**纯靠 hash_only**（合成块不产生 tool_id 反向链），§3.2 mapper 是命脉非"窄影响"；(2) getConversation 拓扑重建不能简单"复用 v1 逻辑"，存在 deepest-match、reaper 孤儿误连、null 三态等真实陷阱。本版据此重写 §2/§3，并修正性能模型（blob 不压缩、N+1）、循环导入、文档债、focus 正交等 11 项。

---

## 0. 前提：两条分叉线必须先合并

git 拓扑（实测）：`merge-base master feat = 0c1233a`（lineage commit **之前**）。

| 分支 | 拥有 | 缺少 |
|---|---|---|
| **master** (`b8bd275`) | lineage 内核 v1 | activity-detail 大重构 |
| **feat** (`2b188b3`) | outline-as-main detail 框架 | 任何 lineage 后端 |

**合并冲突面实测：** master 的 lineage commit 改的文件 vs feat 改的文件，**`src/` 内交集为空**——feat 几乎纯 `ui/`，`src/` 内只改 `store.ts` 1 行（lineage 未碰 store.ts）；feat 另改 `package.json` + 2 个测试文件，均不与 lineage 重叠。`tests/helpers/` 两侧 `git diff` 为空（逐字相同）→ merge 后 lineage 测试不缺 helper。

→ **`master → feat` merge 零后端冲突**（commit 序列第 1 步，§9）。

---

## 1. 设计哲学：对话为一等公民

v1 查询层是**单 entry 邻域视角**（`getLineage(entryId)` → parent/children/siblings；`listConversations()` → rootHash 聚合列表）。"对话"只是 rootHash 聚合的副产品，**没有 API 一次返回整对话的 turn 序列 + 树拓扑 + 分支**。

v2 新增 **`getConversation(rootHash)`** —— 一次返回整对话的 `nodes`（每 turn 的 entry summary + turnIndex + 状态）+ `edges`（parent→child 邻接 + edgeType）+ 拓扑元数据。**纯拓扑、不含 focus**（focus 是视图状态，前端投影——§6.3）。

**保留 v1 内容寻址内核**（canonicalize/hash/digest/schema 表结构）——已实测验证（prefix-hash 0/679、tool_id 99%），无真实问题；重设它是零收益 churn（architecture-health-first）。v2 重设的是**内核之上的查询/聚合/API 层**。`getLineage`/`listConversations` 保留（已 live）。

---

## 2. 后端：对话一等 API（`getConversation`）

### 2.1 数据模型（focus 不入 tree）

```typescript
// src/lib/history/lineage/conversation.ts（NEW）

export interface ConversationNode {
  entryId: string
  summary: EntrySummary               // 复用现有投影（model/state/tokens/preview/timing）
  turnIndex: number                   // 0-based，按 started_at ASC（ties→entryId）
  /** Entry 生命周期状态（completed/failed/...）— 导航过滤 failed dead-end 用。来自 summary.state，提到 node 顶层便于消费。 */
  state: RequestLifecycleState
  postResponseHash: string | null     // null=failed/interrupted（可为 child 不可为 parent）
  /** True 当本 node 的 backToolUseId 非空但其 producer 行已不存在（reaper CASCADE 删）——孤儿信号，§2.3。 */
  orphanedParentRef: boolean
}

export interface ConversationEdge {
  from: string                        // parent entryId
  to: string                          // child entryId
  edgeType: "tool_id" | "hash_only"
}

export type ConversationShape = "empty" | "linear" | "branched"

export interface ConversationTree {
  rootHash: string
  count: number
  earliestAt: number
  latestAt: number
  models: Array<string>
  totalInputTokens: number
  totalOutputTokens: number
  nodes: Array<ConversationNode>
  edges: Array<ConversationEdge>
  shape: ConversationShape            // linear=每 node ≤1 parent ≤1 child；branched=≥1 fork/retry
  roots: Array<string>                // 无入边的 node（链起点 OR reaper 孤儿）
}
```

> **focus 移出 tree（第 1 轮 R3 HIGH-10）：** tree 是 focus-无关的纯拓扑。前端缓存 tree by rootHash，focus（高亮 + turn N/M + 上下导航锚点）在前端按 entryId 投影（O(1) Map 查）。同对话内切 turn 不重拉 tree、不需后端带 focus 重算。彻底解耦"拓扑数据"与"视图状态"。

### 2.2 边重建：findParent 增加内存集 DI（不重写判定）

第 1 轮 R1 CRITICAL-1/2 揭示：初稿 inline rebuildEdges 伪代码丢了 v1 `findParent` 的 deepest-match 去歧义。**裁决（第 2 轮裁决1 精化）：不发明并行的内存版边判定，而是给 v1 `findParent` 增加可选"内存 digest 集"DI 参数**——同一份判定逻辑（tool_id PRIMARY + hash_only deepest-match FALLBACK）既服务 v1 逐 entry DB 查询、也服务 getConversation 批量内存重建。判定规则一字不改，等价性由测试守卫。

```typescript
export function getConversation(rootHash: string): ConversationTree | null {
  const digests = loadRootDigestsBatched(rootHash)   // §2.4 — ONE query, no N+1
  if (digests.length === 0) return null
  const byId = new Map(digests.map((d) => [d.entryId, d]))
  const summaries = querySummariesByIds([...byId.keys()])  // §2.4 — ONE batched query

  const ordered = sortByStartedAtThenId(digests, summaries)  // turnIndex: started_at ASC, ties→entryId

  // 每 node 一次 findParent(node, id, byId) — 同一 v1 判定逻辑、走内存集而非 DB（新增可选 DI 参数）。
  // 孤儿检测在 findParent 内：backToolUseId 非空但 producer 不在 byId（reaper CASCADE 删）→
  //   不回退 hash_only，标 node.orphanedParentRef、不连边（§2.3）。
  const edges: Array<ConversationEdge> = []
  for (const node of ordered) {
    const parent = findParent(byId.get(node.entryId)!, node.entryId, byId)
    if (parent) edges.push({ from: parent.id, to: node.entryId, edgeType: parent.edgeType })
  }

  const inbound = new Set(edges.map((e) => e.to))           // O(n) roots（非 O(n²)）
  const roots = ordered.filter((n) => !inbound.has(n.entryId)).map((n) => n.entryId)
  const shape = classifyShape(ordered, edges)               // failed-only 分支不算 branched（见下）
  return assembleTree(rootHash, ordered, edges, shape, roots)
}
```

**`classifyShape`（第 2 轮裁决4）：** `branched` 当且仅当存在某 parent 拥有 **≥2 个 `state==='completed'` 的 child**（真分叉）。仅有 failed 重试 child（同 parent 多 child 但只 1 个 completed）**不改 shape**——否则"失败重试过一次"的正常线性对话会被误显示成树。failed 重试由 `node.state` 标注、前端区分 fork vs retry，shape 保持 `linear`。

### 2.3 reaper 孤儿：暴露 gap、不静默填补（第 1 轮 R3 HIGH-5 / 第 2 轮裁决2 简化）

**问题：** v1 `findParent` 的 hash_only FALLBACK（[query.ts:122-149](../../src/lib/history/lineage/query.ts#L122)）在链 A→B→C 里、B 被 reaper CASCADE 删后，会让 C 的 `turnHashes` 命中 A 的 postResponseHash（最深存活匹配）→ C 误连 A、跳过被删的 B、gap 不可见。

**裁决（简化）：** 初稿曾提"hash_only 候选须满足 offset 连续性"——但**该约束在 branched 对话里 ill-defined**（"直接前驱"不唯一，fork 时多候选前驱），且会拒掉合法的非相邻父边。**改为只做确定能做对的部分**：

- **tool_id 路径（主因）：** node 的 `backToolUseId` 非空但 producer **不在 byId（存活集）** → `findParent(inRoot)` **不回退 hash_only**，标 `orphanedParentRef = true`、该 node 成为 root。覆盖 reaper 删 tool_id parent 的**绝大多数**情况（Claude Code 99% 多消息 entry 是 tool_id 链，v1 §2.3），gap 可见。
- **纯文本 hash_only 链跨删误连：** 承认为**已知罕见限制**——需被删中段恰是 pure-text（无 backToolUseId）且被 reaper 选中（reaper 删最旧，pure-text 中段被删需特定时序）。此时 hash_only 可能把下游误连到更早存活 turn。**诚实文档化为已知限制**，不发明 ill-defined 约束强治。

> 修正 v1 §4.4 "UI shows the gap"：tool_id 父被删 → `orphanedParentRef` 暴露 gap（可见）；纯文本中段被删 → hash_only 可能填补（罕见、已知限制）。不再声称所有 gap 都可见。

### 2.4 性能：消除 N+1 + 不存在的批量 API（第 1 轮 R1 MEDIUM-2 / R3-7 / R4 H1）

初稿性能模型有三处错误，本版修正：

1. **`turn_hashes_blob` 不压缩**——`packTurnHashes`（[hash.ts:73-80](../../src/lib/history/lineage/hash.ts#L73)）是 raw 32-byte 拼接，`unpackTurnHashes` 是 `toString("hex")`，无 gzip。初稿"blob 解压主导"是事实错误。真实成本是 hex 解码 + Buffer 分配。
2. **N+1 必须消除**——v1 `rowToDigest`（[query.ts:74-90](../../src/lib/history/lineage/query.ts#L74)）对每个 digest 单独 `loadProducedToolIds`。getConversation 必须新增 `loadRootDigestsBatched(rootHash)`：一次 `SELECT * FROM entry_lineage WHERE root_hash=?` + 一次 `SELECT tool_use_id, entry_id FROM entry_produced_tool_ids WHERE entry_id IN (...)`（内存 group by），避免 N 次子查询。**IN 子句对超大 root（>999 entry，SQLite 默认 host-parameter 上限）须分批 chunk(999)；57 量级无虞，但实现须 chunk 防退化大 root。**
3. **`querySummariesByIds` 不存在，需新建**——read.ts 只有 `querySummaries(opts: QueryOptions)`（无 id-list 维度）+ 单条 `getSummary`。新增 `querySummariesByIds(ids: string[]): EntrySummary[]`（`WHERE id IN (placeholders)`，复用 read.ts:26 已有的 `IN` 批量模式）。列入 §13 cost（+~20 LOC + 测试）。

修正后性能：最大 entry-count root 实测 **57 entry**（非初稿误述的"681"——681 是单对话**消息数**、跨 5 entry；[v1 RFC §2.2](request-lineage.md)）。57-node root：3 次 indexed 批量查询 + O(n) 边重建（每 node 一次 findParent 内存判定）+ O(n·k) hash_only 候选扫描（k=同 root pure-text 数）。p99 << 50ms。即便退化的 100+ entry root 也远低于阈值。

### 2.5 路由 + handler（null 三态对齐 handleGetLineage）

第 1 轮 R1 CRITICAL-3：初稿 `/entries/:id/conversation` 的 `loadDigest(id).rootHash` 对无 lineage entry 会 null 崩溃。**裁决：明确三态，对齐已落地的 `handleGetLineage`（[handler.ts:76](../../src/routes/history/handler.ts#L76)）。**

| 路由 | 语义 |
|---|---|
| `GET /history/api/conversations/:rootHash` | 按已知 rootHash 取整树。`getConversation` 返回 null（root 无 lineage 行）→ 200 + `null`（UI 显示"无对话数据"）。 |
| `GET /history/api/entries/:id/conversation` | 按 entry 反查：`const d = loadDigest(id)`；`d === null`（entry 无 lineage 行：非 Anthropic/失败前/pre-backfill）→ **200 + `null`**（与 handleGetLineage 的"存在但无 lineage→digest:null"一致）；entry 本身不存在 → **404**（先 `getEntry(id)` 判存在性，与 handleGetLineage 一致）；否则 `getConversation(d.rootHash)`。 |

`ConversationTree` 整体可为 `null`（响应类型 `ConversationTree | null`），消除初稿"rootHash 必填 vs 空 tree"的类型冲突。

### 2.6 in-flight turn 不可见（第 1 轮 R4 M1，文档化）

lineage 行仅在 `finalizeEntry` 写入；进行中（in-flight）的 turn 无 lineage 行。`getConversation`/`listConversations` 都从 `entry_lineage` JOIN，**只见已 finalize 的 turn**。故对话正在生成第 N turn 时，tree 只含 turn 1..N-1，N/M 的 M 不含进行中 turn。**这是已知语义、非 bug**——§6 UI 在对话条注明"实时 turn 完成后出现"，列入验证计划已知行为。

### 2.7 类型 re-export（修正路径）

第 1 轮 R2/R4 M4：初稿写 `from "./lineage/query"` re-export `ConversationTree` 等——但它们在 NEW `conversation.ts`，不在 query.ts。**裁决：统一从 barrel `from "./lineage"` re-export**（lineage/index.ts 同时 re-export query.ts + conversation.ts），并显式补全 v1 遗漏的 lineage 类型（v1 从未把 `LineageResponse` 等加入 store barrel——grep 0 命中）：

```ts
// src/lib/history/store.ts
export type {
  ConversationTree, ConversationNode, ConversationEdge, ConversationShape,
  LineageResponse, LineageParent, LineageChild, LineageSibling, SiblingKind, RootSummary,
  ConversationSummary, ConversationsListResult, ConversationsListOptions, LineageDigest,
} from "./lineage"
```
前端 [ui/src/types/index.ts](../../ui/src/types/index.ts) re-export 同名。前端零本地定义（single-source-of-truth-types）。

---

## 3. §8.4 Web-search 双跳容错（重写：hash_only 是命脉）

### 3.1 父子链机制裁决（第 1 轮 R3 CRITICAL-1，已亲验）

**web_search turn 作为 parent，没有 tool_id 反向链路径，父子识别纯靠 hash_only：**

- 合成响应（[synthesize.ts:88-93](../../src/lib/anthropic/web-search/synthesize.ts#L88)）形状：`server_tool_use{web_search} → web_search_tool_result → ...thinking → text`。
- `extractProducedToolUseIds`（[digest.ts:51-60](../../src/lib/history/lineage/digest.ts#L51)）**只收 `tool_use`，不收 `server_tool_use`** → 合成的 `srvtoolu_*` id 永不进 `entry_produced_tool_ids`。
- 即便让它进（第 1 轮 R3 的修复建议），也**无效**：`extractBackToolUseId`（[digest.ts:67-76](../../src/lib/history/lineage/digest.ts#L67)）只看下一轮 `messages[-1]`（末尾 user turn）的 tool_result，而 web_search 块在 assistant turn——backToolUseId 永远指不到它。**故 R3 的 tool_id 修复方案被否决**（已读码裁决，empirical-verification）。

→ **web_search 父子链的唯一机制是 hash_only**：`A.postResponseHash`（含 web_search 块）`== B.turnHashes[A.len]`。**§3.2 的 canonicalize 归一化是这条链能否连上的命脉**，不是"PRIMARY 之外的窄影响兜底"。初稿 §3.4"窄影响面"判断**错误，本版修正**。

### 3.2 两侧形状 + 不对称源（thinking 块纳入）

**A 侧（parent `outboundResponse.content`）形状由代码确定：**
- `_brand` 已在 recording 阶段剥离（[recording.ts:38-44](../../src/lib/request/recording.ts#L38)）、`input` 经 `safeParseJson` 转 object（[recording.ts:81](../../src/lib/request/recording.ts#L81)）——不进 history。
- `web_search_result` item **永远** `encrypted_content:""` + `page_age:null`（[synthesize.ts:64-70](../../src/lib/anthropic/web-search/synthesize.ts#L64)）。
- **thinking 块**（[synthesize.ts:92](../../src/lib/anthropic/web-search/synthesize.ts#L92)）经第二跳收集后逐字注入，带 signature——A 侧含 thinking。

**B 侧（child echo）无法实测**（当前无真实 web_search 流量，实测确认）。

**不对称源（v1 RFC §2.5 称 thinking signature 自包含，但双跳路径未实测）：**
1. `encrypted_content:""` vs 省略 / `page_age:null` vs 省略 —— §3.3 mapper 处理。
2. **thinking 块**：双跳第二跳的 thinking 经 `buildContentBlockStart`（空 thinking start）+ `signature_delta` 重建（[synthesize.ts:192,225-230](../../src/lib/anthropic/web-search/synthesize.ts#L192)），与普通路径不同，**未实测 echo 稳定性**。列入"待校准不对称源"。
3. `web_search_tool_result_error` 分支（空结果 → error 对象，[synthesize.ts:62-63](../../src/lib/anthropic/web-search/synthesize.ts#L62)）：mapper 的 `!Array.isArray` guard 正确放行，但 error 链 echo 稳定性未分析——待校准。
4. searxng vs Copilot 后端的 result title 来源不同（正则 cleanTitle vs 原始），但 `buildSearchResultContent` 只取 title/url 归一为同形——合成块归一，title 客户端 echo trim 漂移待校准。

### 3.3 设计：canonicalize 条件剥离（不变）+ 范围声明

`stripWebSearchSynthArtifacts`（接 [canonicalize.ts:117-122](../../src/lib/history/lineage/canonicalize.ts#L117) map 链，image-digest 后、filter 前）：对 `web_search_tool_result.content[]` 的 `web_search_result` item，剥离值为空串的 `encrypted_content`、值为 null 的 `page_age`（条件剥离，不误伤真实 web_search；浅拷贝 `{...it}`+delete 顶层标量安全；幂等）。代码同初稿 §3.2，从略。

**范围边界声明（第 1 轮 R4 M2/M3）：**
- synth-artifact **仅来自 web_search 双跳合成**。`tool_search_tool_result`/`code_execution_tool_result` 是真实上游透传（[stream-accumulator.ts:261-262](../../src/lib/anthropic/stream-accumulator.ts#L261) accumulator 重建，非合成），A 侧 outbound 与 B 侧 echo 同源同形，无合成不对称。`tool_search`（`toolSearchEnabled` 默认 true）透传对称性待真实流量校准，本版不处理。
- **count_tokens 不写 history**（`count-tokens.ts` 显式 "no history entry"）→ 不产 lineage entry，§8.4 不涉及。

### 3.4 schema_version bump + 混版语义（修正紧迫性表述）

`LINEAGE_SCHEMA_VERSION` 1→2（[types.ts:17](../../src/lib/history/lineage/types.ts#L17)）。混版（v1+v2 并存）：

- **非 web_search 消息 v2 canonicalize 与 v1 逐字节相同**（mapper 对非 web_search 块 early-return）→ 这些 v1 digest 的 hash 等于 v2 重算值，跨版本链不断。**由 §3.6 测试 3 的非回归断言守卫**（不靠推理）。
- **web_search 链命脉在 hash_only**（§3.1）→ web_search entry 的 v1 digest（含 `encrypted_content:""`）与 v2（已剥离）hash 不同 → 混版期 web_search 链跨 v1/v2 边界断。这是**真实影响面**（非初稿"窄影响"轻描淡写），但仅限 web_search 链、且 `--rebuild` 后恢复。
- **§8.4 只保证空字段（encrypted_content/page_age）归一，不保证含 thinking 的 web_search 链连通**（第 2 轮裁决7）：thinking 块进合成响应（§3.2），其双跳 echo 稳定性未实测；若 thinking echo 漂移，即便同版本，web_search+thinking 链仍可能断。§3.6 测试4 标待校准，v3 实测裁决。
- **`getConversation`/边判定不读 `digest.v`**（实测 [query.ts](../../src/lib/history/lineage/query.ts) findParent/findChildren 不比较 schema_version，仅 rowToDigest:76 做 cast）。

### 3.5 backfill 升级语义（第 1 轮 R4 H3，强制说明）

**普通 `bun run scripts/backfill-lineage.ts`（无 `--rebuild`）只处理无 lineage 行的 entry**（[backfill-lineage.ts:90](../../scripts/backfill-lineage.ts#L90) `listEntryIds` 非 rebuild 时 `filter(has_lineage===0)`）——已有 v1 行的 web_search entry 被**跳过**，不升级。**只有 `--rebuild`（全量 `INSERT OR REPLACE`）把 v1 行重算到 v2。** §5（§8.6）的启动 warning 文案须明确 `--rebuild` 是必需的（不带则已有 v1 行原封不动）。

### 3.6 测试（fixture 驱动 + 待校准标注）

1. `stripWebSearchSynthArtifacts` 三态 + 非 web_search 块原样 + error 对象不动 + 幂等（含 web_search 消息 fuzz）。
2. 端到端 hash 匹配：真实 `buildWebSearchResponse`→`mapAnthropicContentBlocks`→A；构造两个 B echo 变体（保留/省略空值）；断言 canonicalize 逐字节相等 + postResponseHash==turnHash。
3. **非回归**：非 web_search 消息 v2 输出 === v1 输出（守卫 §3.4）。
4. **thinking 块待校准**：测试构造含 thinking 的合成响应 + 模拟 echo，断言当前是否匹配；若不匹配，标注为已知 gap（v3 校准）。
5. **标注**：B 侧 echo 形状基于协议推断，待真实 web_search 流量用 [[empirical-probe-via-history-api]] 校准。

---

## 4. （并入 §3）

---

## 5. §8.6 Schema 版本迁移检测（修正循环导入）

`--rebuild` 已存在。新增检测函数，第 1 轮 R4 C1 揭示循环导入风险（connection 经 barrel import → 拉入 query.ts → query.ts import connection）。

**裁决：检测函数定义在 `src/lib/history/lineage/schema-check.ts`（NOT re-exported by lineage/index.ts barrel）**，只 import `./types`（`LINEAGE_SCHEMA_VERSION`）+ 接受 `Database` 参数；connection.ts 用**深路径** `import { warnIfStaleLineageSchema } from "~/lib/history/lineage/schema-check"`（绕过 barrel，不触发 query.ts→connection）。

```ts
// lineage/schema-check.ts
export function warnIfStaleLineageSchema(database: Database): void {
  const hasTable = database.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='entry_lineage'`).get()
  if (!hasTable) return
  const row = database.prepare(`SELECT MIN(schema_version) AS min_v, COUNT(*) AS n FROM entry_lineage`).get() as { min_v: number | null; n: number }
  if (row.min_v === null || row.n === 0) return
  if (row.min_v < LINEAGE_SCHEMA_VERSION) {
    const stale = database.prepare(`SELECT COUNT(*) AS c FROM entry_lineage WHERE schema_version < ?`).get(LINEAGE_SCHEMA_VERSION) as { c: number }
    consola.warn(
      `[history/lineage] ${stale.c}/${row.n} digests are schema v${row.min_v} (current v${LINEAGE_SCHEMA_VERSION}). ` +
        `web_search 链可能跨版本断链。运行 \`bun run scripts/backfill-lineage.ts --rebuild\`（必须带 --rebuild，否则已有行不升级）重算到 v${LINEAGE_SCHEMA_VERSION}。`,
    )
  }
}
```

connection.ts 在 `openDatabase` 的 [connection.ts:52](../../src/lib/history/sqlite/connection.ts#L52) `reclaimOrphanedActiveRows` 之后调用。不自动 rebuild（大 DB 阻塞启动 + 未经同意改写派生行）。文案反映"建议性非紧急"（§3.4）。

---

## 6. UI：深度融入 feat 新框架

### 6.1 架构定位：对话导航是正交跨-entry 轴

feat 的 `useOutlineSelection`（[useOutlineSelection.ts:44-57](../../ui/src/composables/useOutlineSelection.ts#L44)）的 `Selection` union 全是单 entry 内部节点。对话（跨 entry）导航与之正交——不进 Selection union、不进 RelatedTabs、不进 OutlineTree，是 page-level 独立轴。

### 6.2 独立 `/conversations` 页

- **路由**（[router.ts](../../ui/src/router.ts) 懒加载）：`{ path: "/conversations", name: "conversations", component: () => import("@/pages/vuetify/VConversationsPage.vue") }`，选中态 `?root=<rootHash>`。
- **导航入口**（[NavBar.vue:37](../../ui/src/components/layout/NavBar.vue#L37) `navLinks`）加 Conversations。
- **store** `useConversations`（轻量 composable，仿 [useHistoryData](../../ui/src/composables/history-store/useHistoryData.ts) 的游标累积 + fetchSeq 防竞态）：`conversations` 列表 + `loadMore()` + `treeCache: Map<rootHash, ConversationTree>`（§6.3）。
- **单 entry root 策略（第 1 轮 R3 HIGH-9）：** 当前实测每 root count=1（真多 turn 对话尚未出现）。**裁决（我自主定）：`listConversations` 默认 `HAVING count > 1`（只显示真对话）+ 一个 "show single-turn" toggle。** 后端 `listConversations` 加可选 `minTurns?: number`（默认 2）参数。独立页空状态引导（"暂无多轮对话；勾选显示单轮"）。
- **页面结构**（VConversationsPage，SplitPane 复用 [SplitPane.vue](../../ui/src/components/ui/SplitPane.vue)）：左 ConversationList（游标分页）| 右 ConversationTree（选中 root 渲染整树，点 turn → router.push(/activity/:id)）。

### 6.3 detail page-level 对话条 + turn-tree 抽屉

**挂载点**：VDetailPage page-level（[VDetailPage.vue:384-393](../../ui/src/pages/vuetify/VDetailPage.vue#L384)，DiagnosticSummary/StageTabs 同层，DetailLayout 外）。

**新组件 `ConversationStrip`**（page-level，独立于 selection 系统）：
- **数据源**：通过 `GET /entries/:id/conversation`（一跳，§2.5）——**HistoryEntry 不携带 rootHash**（第 2 轮裁决5：rootHash 在 lineage digest 里），故由该端点反查、并在响应里带回 rootHash + tree。前端维护 `entryId→rootHash` 映射 + `treeCache: Map<rootHash, tree>`。同对话内切 turn（rootHash 不变）复用缓存、不重拉（第 1 轮 R3 HIGH-10）。
- **focus 前端投影**：turn N/M（focus node 的 turnIndex+1 / count）、高亮、上/下导航锚点全部由前端从缓存 tree + 当前 entry.id 派生（O(1)）。focus 切换零网络。
- **上/下导航**：沿 focus 的 edges——parent=上、children=下。**多 child 过滤（第 1 轮 R3 HIGH-8）：** "下一 turn" 默认只列 `state==='completed'` 的 child；failed child 折叠/标注 "failed retry"。**fallback（第 2 轮裁决6）：若全部 child 都 failed（连续失败重试、尚无成功），仍列出 failed child（标 dead-end），避免菜单空、用户卡死。** 过滤只用 `node.state`（不需 siblingKind）。`router.replace`（[VDetailPage.vue:218](../../ui/src/pages/vuetify/VDetailPage.vue#L218) `goToEntry` 模式）。
- **与 j/k 关系（第 1 轮 R1 HIGH-2 订正）：** **不是"正交"**——对话条上/下导航与 j/k 都触发 `router.replace` 换 `:id` → 同一 VDetailPage 实例（不重 mount）→ `useOutlineSelection` Watch 1（[useOutlineSelection.ts:483](../../ui/src/composables/useOutlineSelection.ts#L483)）fire → 共享 sticky-degrade。二者是**同一 entry-change 轴的两个触发源**，对话条自动继承 sticky-degrade。验证项须确认跨对话切到 failed turn 时 selection 行为符合预期（degrade vs re-autoselect）。
- **in-flight 提示（§2.6）：** 对话条注明 M 不含进行中 turn。
- **rootHash 变化检测**：因 entry 不带 rootHash（见数据源），每次 entry 变化都调 `/entries/:id/conversation`；响应 rootHash 命中 treeCache 则复用（同对话内、零额外网络成本仅一次轻量反查），否则缓存新 tree（跨对话）。focus 始终前端按 entryId 投影。

### 6.4 ConversationTree 组件复用 + 孤儿/断裂可视化

`ConversationTree.vue` 单组件（独立页右栏 + 对话条抽屉共用）。props `tree: ConversationTree`、`focusEntryId?`。渲染：
- `shape==="linear"` → 竖直 turn 链（turnIndex 序，focus 高亮）。
- `shape==="branched"` → 缩进树，fork/retry 按"同 parent 的 children 的 state 组合"前端推导区分（全 completed=fork 实线分叉；含 failed=retry，failed 支 dim + "failed" 标）。
- `roots.length>1` 或任一 node `orphanedParentRef` → "上游 turn 已被清理/断裂" 提示（§2.3，reaper gap 可见）。
- 空 tree（`null`）→ 占位。

### 6.5 不接 WebSocket

lineage 只读派生元数据（v1 §9 non-goal "Real-time lineage push over WebSocket"——实测确认 [request-lineage.md:645](request-lineage.md#L645)）。entry 切换时自然重拉/复用缓存。

---

## 7. （并入 §6）

## 8. （并入 §3）

## 9. Commit 序列（invariants，在 feat 分支）

每 commit 终态：typecheck + lint + 测试全绿，无功能回归（[[methodology-commit-invariants]]）。

| # | Commit | 终态不变量 |
|---|---|---|
| 1 | `merge: master (lineage v1) into feat` | 后端零冲突（§0 实测）。**merge 后带入的 lineage 7 测试文件随 `bun run test:backend` 通过**（实测自包含、不缺 feat helper）；后端 `typecheck` 绿；**feat 既有 ui 测试无回归**（merge 不碰 ui，故非"因 lineage 受影响"，仅确认无回归）。 |
| 2 | `feat(lineage): web_search synth-artifact canonicalization + schema v2` | `stripWebSearchSynthArtifacts` 接入；`LINEAGE_SCHEMA_VERSION`→2；unit（三态+端到端 hash 匹配+非回归+幂等+thinking 待校准标注）绿。 |
| 3 | `feat(lineage): warnIfStaleLineageSchema (schema-check.ts, deep-import)` | 检测函数在 schema-check.ts（非 barrel），connection 深路径调用；fresh/全v2/混版三态 it 测试绿；纯 log。 |
| 4a | `feat(history): querySummariesByIds + loadRootDigestsBatched（sqlite 批量基础）` | read.ts 新增按 id-list 批量查 summary（消 N+1）；`loadRootDigestsBatched` 一次取 root 全 digest + produced-tool-ids（IN 分批 chunk 999）。单元测试。无对话消费者。 |
| 4b | `feat(lineage): getConversation + conversation.ts + findParent 内存集 DI` | findParent 加可选内存集参数（等价性测试守卫）；`getConversation`（孤儿不误连、focus-无关纯拓扑、classifyShape failed-only、O(n) roots）。后端测试（linear/branched/多根/reaper 孤儿/空/非 Anthropic/无环）绿。 |
| 4c | `feat(lineage): conversation routes + listConversations minTurns` | `/conversations/:rootHash` + `/entries/:id/conversation`（null 三态）+ handler；listConversations 加 `minTurns`（默认 2，HAVING count>1）。.it 测试（直调 handler + initHistory，置 tests/history/lineage/）。 |
| 5 | `feat(history): re-export lineage+conversation types from store barrel` | store.ts + ui/types re-export（从 `./lineage` barrel，含补全 v1 类型）；typecheck:ui 绿；无运行时改动。 |
| 6 | `feat(ui): conversations api + useConversations(treeCache) + ConversationTree` | api/http.ts 加 fetchConversations(minTurns)/fetchConversationTree/fetchEntryConversation；useConversations（游标 + treeCache）；ConversationTree（linear/branched/多根/孤儿/空 各 vitest + focus 前端投影）；未挂载。 |
| 7 | `feat(ui): VConversationsPage + route + NavBar entry` | 独立页 + 路由 + 入口；单 entry root toggle；列表↔树联动；点 turn 跳 detail。vitest + e2e（可选）。 |
| 8 | `feat(ui): ConversationStrip in VDetailPage` | 对话条 page-level；focus 前端投影 N/M + 上/下导航（failed sibling 过滤）+ 展开抽屉（复用 ConversationTree）；继承 Watch1 sticky-degrade（非正交）；仅 entry 有 lineage 显示；in-flight 提示。vitest（无 lineage 隐藏 / fork 多 child 过滤 / 缓存复用 / 跨对话 sticky-degrade）。 |
| 9 | `docs: DESIGN.md (v1+v2 lineage 全量) + ui CLAUDE.md + RFC final` | DESIGN.md `history/` 模块树补 `lineage/`（canonicalize/hash/digest/query/types/index/conversation/schema-check 八文件）+ 路由表补**全部** lineage 端点（v1 的 `/entries/:id/lineage`、`/api/conversations` + v2 的 3 个）+ 注明 entry_lineage/entry_produced_tool_ids 两表；ui/CLAUDE.md 路由表加 /conversations。 |

commit 1 合并基线；2-5 后端；6-8 前端（8 是对话条，用户主要验证点）；9 文档（清 v1 文档债 + v2）。

---

## 10. 验证计划

1. **merge 基线**：feat merge master 后 `test:backend`（含 lineage 7 文件）+ `typecheck` + feat ui 测试全绿。
2. **§8.4**：fixture hash 匹配 + 非回归（非 web_search v2≡v1）+ 幂等 + error 分支 + thinking 待校准。
3. **§8.6**：检测三态 + rebuild 闭环（断言不带 --rebuild 混版仍在、带 --rebuild 后全 v2）。
4. **getConversation**：linear/branched(fork/retry)/多根/**reaper 孤儿不误连**(A→B→C 删 B，断言 C 标 orphanedParentRef 成 root 而非误连 A)/空/非 Anthropic/无环/turnIndex 序/classifyShape failed-only 不算 branched。
5. **性能**：57-entry root（实测最大）getConversation p99 < 50ms；无 N+1（断言查询次数为常数 3）。
6. **UI 独立页**：游标累积 + minTurns toggle + 点 root 树加载 + 点 turn router.push。
7. **UI 对话条**：无 lineage 隐藏；focus 前端投影 N/M 正确；缓存复用（同对话切 entry 不重拉）；failed sibling 过滤；跨对话 sticky-degrade 行为；in-flight 提示。
8. **回归**：feat 现有 vitest + e2e 全绿（对话条不破坏 selection/outline/related）。

---

## 11. 明确不做（deferred 到 v3，完整文档化 per architecture-health-first）

### 11.1 §8.2 跨模型回退链探测
根因/理想架构/为何暂缓同初稿（启发式需真实回退流量标定，无标注集验证，假阳性污染 cryptographic 信誉）。

### 11.2 §8.3 /compact 续接提示
根因/理想架构/为何暂缓同初稿（手动关联 UX 需独立 brainstorming；加字段再 bump schema 应合并规划）。

### 11.3 对话拓扑物化（turn_index 缓存 vs parent_edge）
第 1 轮 R3 指出初稿把 turn_index 与 parent_edge 捆绑暂缓论证不成立——**turn_index 是 started_at 纯函数、无一致性陷阱；parent_edge 才有（乱序 finalize、reaper 悬空）**。当前裁决：**前端 treeCache by rootHash（§6.3）已覆盖"反复切同对话"热点，零 schema 变更**，比物化更简洁。若未来 root 规模或后端无缓存场景成为真实瓶颈，优先级：root 级结果缓存 > turn_index 物化 > parent_edge 物化（后者最后，因一致性成本）。

### 11.4 reaper 部分淘汰使 listConversations 聚合失真（第 1 轮 R4 M5）
reaper 按全局 success/failure 桶 `ORDER BY started_at ASC` 淘汰最旧 entry，会优先删一个对话的最早 turn → `listConversations` 的 count/totalTokens/earliestAt 偏低/偏移，且**纯前段被删时仍单根、无残缺标记**（中段被删才多根/孤儿可见）。getConversation 的 `roots`/`orphanedParentRef` 只暴露中段 gap。理想：给 `ConversationSummary` 加 `partiallyReaped` 启发式（如 turnIndex 不连续）。暂缓——失真有界且罕见（reaper 阈值默认 success 50/failure 200，多数对话不触顶）。

---

## 12. 已决议（用户 2026-06-16 采纳推荐默认值）

1. **单 entry root 默认 `HAVING count>1`**（§6.2）—— ✅ 采纳：默认隐藏单轮对话 + "show single-turn" toggle。
2. **reaper 孤儿处理**（§2.3）—— ✅ 采纳：tool_id 父被删 → `orphanedParentRef` 暴露 gap；纯文本中段被删 → hash_only 可能误连，承认为已知罕见限制（不发明 ill-defined 的 offset 连续性约束）。
3. **ConversationTree 视觉**（§6.4）—— ✅ 留实现期定（linear 竖直链 / branched 缩进树），按 Vuetify 4 能力选最优。
4. **thinking 块双跳 echo 稳定性**（§3.2）—— ✅ 列待校准；无真实流量，v3 实测裁决；若漂移则 mapper 扩展或 thinking 块在 web_search 路径特殊归一。

---

## 13. Cost summary

| 资源 | v2 估算 |
|---|---|
| 合并 | master→feat，后端零冲突（实测） |
| 后端 | conversation.ts ~180（findParent DI + 孤儿 + classifyShape + O(n) roots）+ loadRootDigestsBatched ~40 + querySummariesByIds ~20 + schema-check ~30 + §8.4 ~25 + 路由/handler ~50 + 测试 ~340 |
| 前端 | api ~35 + useConversations(treeCache) ~110 + ConversationTree ~170 + VConversationsPage ~120 + ConversationStrip(focus 投影) ~150 + 类型 ~15 + 测试 ~320 |
| Schema | 无新表/列（仅 `LINEAGE_SCHEMA_VERSION` bump；拓扑前端缓存不物化） |
| 风险 | §8.4 B 侧 echo（含 thinking）未实测——fixture + 待校准兜底；其余读码/实测验证 |

---

## 14. Acknowledgements

第 1 轮 4 reviewer + 主线逐条复核（含**纠正 reviewer**：否决"server_tool_use 进 producedToolUseIds"无效修复——backToolUseId 语义所限）。关键裁决全部读码/实测：
- web_search 纯 hash_only（digest.ts:51-60 + 67-76）、thinking 进合成（synthesize.ts:92）、blob 不压缩（hash.ts:73-80）、loadDigest null（query.ts:92-97）、hash_only 跨删误连（query.ts:139-148 + reaper）、querySummariesByIds 不存在（read.ts）、循环导入（query.ts:17）、v1 文档债（grep 0）、普通 backfill 不升级（backfill-lineage.ts:90）、in-flight 不可见（finalizeEntry only）。

方法论：[[feedback_reviewer_verify_critically]]（reviewer 结论逐条复核、否决无效建议）、[[feedback-architecture-health-is-user-need]]（对话一等公民 + focus 正交）、[[feedback_complete_root_cause_fix]]（孤儿不误连是根因修复）、[[methodology-commit-invariants]]（merge 基线 + 每 commit 独立绿）、[[empirical-probe-via-history-api]]（web_search echo 待真实流量校准）。
