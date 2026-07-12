# Spec：GHC 升级版 usage 明细的完整捕获（cache_write + 模态/prediction 分解）

状态：**设计已获用户批准（2026-07-12）** · 待 subagent 对抗审查定稿 · 实施计划见 `docs/plan/2026-07-12-ghc-usage-details/`（待建）· 日期：2026-07-12 · 归属：`docs/spec/`

关联：ADR `docs/decisions/2026-07-05-richest-data-flow.md`（后端完整存、不为 YAGNI 裁剪——本 spec 的价值轴）· `docs/DESIGN.md`「类型架构」节（SSOT-types：类型只在拥有方定义一次）· `docs/decisions/2026-07-05-internal-tool-security-posture.md`（usage 全量暴露）· 既有 `src/lib/history/sqlite/usage-normalize-backfill.ts`（净化 backfill 的先例与骨架）· `docs/todo/deferred-backlog.md`（Group-B 标量迁移，若加列则相关）。

> 本 spec 描述**目标态与为何**，不是实施步骤（plan 职责）。所有价值判断以 richest-data-flow + cost-fidelity + long-term-wins 为轴，**不**用 YAGNI 降级正确捕获。

---

## 1. 背景与问题（Why）

### 1.1 实证触发

GHC 的 OpenAI-format usage 载荷升级，新增嵌套明细字段（用户实测样本）：

```jsonc
{
  "total_tokens": 438019,
  "prompt_tokens": 437256,
  "completion_tokens": 763,
  "prompt_tokens_details": {
    "text_tokens": null, "audio_tokens": null, "image_tokens": null, "video_tokens": null,
    "cached_tokens": 436157,
    "cache_write_tokens": null        // ← 新字段，非 OpenAI 标准
  },
  "completion_tokens_details": {
    "text_tokens": null, "audio_tokens": null, "image_tokens": null, "video_tokens": null,
    "reasoning_tokens": 0,
    "accepted_prediction_tokens": null,   // ← 新字段
    "rejected_prediction_tokens": null    // ← 新字段
  }
}
```

样本自洽校验：`prompt_tokens(437256) = cached_tokens(436157) + 净输入(1099)`，且 `total(438019) = prompt(437256) + completion(763)`——证明 `cached_tokens` 是 `prompt_tokens` 的**子集**。

### 1.2 现状：canonical `UsageData` 只有 5 个字段，新明细被丢弃

存储用的规范形状 `src/lib/history/types.ts` `UsageData`：`input_tokens` / `output_tokens` / `cache_read_input_tokens?` / `cache_creation_input_tokens?` / `output_tokens_details?.reasoning_tokens`。

OpenAI/Responses/Gemini 三腿经 `src/lib/request/usage-normalize.ts` 的 `usageFromTotalInput` 归一化，**只抽两个字段**：

| GHC 字段 | 当前处理 | 归宿 |
|---|---|---|
| `prompt_tokens_details.cached_tokens` | ✅ 抽取 | `cache_read_input_tokens` |
| `completion_tokens_details.reasoning_tokens` | ✅ 抽取 | `output_tokens_details.reasoning_tokens` |
| **`prompt_tokens_details.cache_write_tokens`** | ❌ **丢弃** | 无（本 spec Tier 1） |
| `prompt_tokens_details.{text,audio,image,video}_tokens` | ❌ 无槽位 | 无（本 spec Tier 2） |
| `completion_tokens_details.{text,audio,image,video}_tokens` | ❌ 无槽位 | 无（本 spec Tier 2） |
| `completion_tokens_details.{accepted,rejected}_prediction_tokens` | ❌ 无槽位 | 无（本 spec Tier 2） |

### 1.3 为何 cache_write 是承重缺口（Tier 1）

`cache_creation_input_tokens` 的**基础设施已全线接好**，只缺数据源接线：

- **schema**：`src/lib/history/sqlite/serialize.ts` 已有 `cache_creation` 去规范化列。
- **telemetry**：`src/lib/request-telemetry.ts` 已有 `cacheCreationInputTokens` 累积 + `costCacheCreationInputTokens`（乘 multiplier 的成本因子）。
- **stats**：`src/lib/history/stats.ts` 已把 `cache_creation_input_tokens` 计入 token 总额。
- **Anthropic 原生腿**已正常填（实测 live DB 一条 `cache_creation_input_tokens: 1946`）。

唯一断点：OpenAI 家族腿从不提取 `cache_write_tokens`，`usageFromTotalInput` 的 `cacheCreation` 恒传 0。`usage-normalize.ts` 注释「OpenAI-family upstreams have no cache-creation concept → callers pass 0」——**该假设已被 GHC 升级推翻**。

**双重偏差**（若 §3 PoC 证 cache_write 是 `prompt_tokens` 子集）：当前净公式 `input = prompt − cached` 会把 cache-write 的量并进 `input_tokens`（高估净输入），同时 `cache_creation_input_tokens` 停在 0（低估缓存创建）。二者都损害成本核算保真度。

### 1.4 两个佐证：这是 GHC 新扩展、非标准

1. **OpenAI SDK 类型看不见**：我们的 chat-completions usage 类型来自 `openai` SDK `CompletionUsage`，其 `PromptTokensDetails` 只声明 `audio_tokens`/`cached_tokens`（`node_modules/openai/resources/completions.d.ts:142`），无 `cache_write_tokens`/模态字段。
2. **GHC 自己的实现也没跟上**：`refs/ghc-api-py/ghc_api/translator.py:275` 与 `refs/vscode-copilot-chat/.../chatMLFetcher.ts` 均只处理 `cached_tokens`——`cache_write_tokens` 是新的服务端字段，连 Microsoft 官方客户端都未消费。

---

## 2. 目标与非目标

**目标：**
- G1（Tier 1，承重）接线 `cache_write_tokens → cache_creation_input_tokens`，修正 OpenAI/Responses/Gemini 三腿的净输入 + 缓存创建计费。
- G2（Tier 2，richest-data-flow）在 `UsageData` 扩出模态分解（text/audio/image/video）与 prediction tokens（accepted/rejected）槽位，**blob-only 存储**，全量捕获不丢。
- G3（历史保真）backfill 存量 OpenAI 家族行：从原始 usage blob 重导出 cache_write，补 `cache_creation` 列并按净公式重算 `input_tokens`。
- G4（类型 SSOT）为 GHC 扩展 usage 建**自有类型**，不 module-augment SDK 类型。
- G5（对称转发）出向翻译器在目标格式有槽位处转发 cache_write（对称既有 cached_tokens 转发）。

**非目标：**
- N1 **不**为 Tier 2 模态/prediction 字段加 SQLite 列、不 backfill 它们（用户裁决：blob-only；无 SQL 聚合消费者前不加列——见 §7 未采纳记录）。
- N2 不改 Anthropic 原生腿的 usage 构建（已正确，且 `usage-normalize.ts` 明确不经它）。
- N3 不改成本定价表/multiplier 逻辑（仅补齐喂给它的 token 数）。

---

## 3. 门控 PoC：净输入公式（empirical-verification）

**未知**：GHC 的 `prompt_tokens` 是否把 `cache_write_tokens` 也算作子集（像 `cached_tokens`）？

**强证据（非断言）**：§1.1 样本证 `cached_tokens` 是 `prompt_tokens` 子集；cache_write 语义是「处理时写入缓存的输入」，几乎必然同为子集 → `input = prompt − cached − cache_write`。Anthropic 原生模型里 `cache_creation_input_tokens` 与 `input_tokens` 本就 disjoint，Copilot 转 OpenAI 格式时把三者并进 `prompt_tokens` 是最自然的映射。

**门控动作**（实现第一步）：跑一个真实 cache-create 请求（首访新会话，触发缓存写），取回 GHC 原始 usage，验证 `prompt_tokens == fresh + cached + cache_write` 是否成立。
- **若成立（子集）**：forward 与 backfill 都执行 `input = prompt − cached − cache_write`（`netInputTokens` 已支持三参）。
- **若不成立（additive）**：只填 `cache_creation` 列、**不**从 input 再减 cache_write，且在 spec/plan 记录反证。

此 PoC **门控** §5 的 forward 减法与 §6 的 backfill 重算；PoC 结论落 `exp/ghc-cache-write/` 或 plan 头部。

---

## 4. 类型架构（G4，SSOT-types）

新建 `src/types/api/ghc-usage.ts`，定义 GHC 扩展 usage 形状：

- `GhcPromptTokensDetails`：`cached_tokens?`（既有）+ `cache_write_tokens?` + `{text,audio,image,video}_tokens?`。
- `GhcCompletionTokensDetails`：`reasoning_tokens?`（既有）+ `{text,audio,image,video}_tokens?` + `{accepted,rejected}_prediction_tokens?`。

提取点把 SDK 的 `CompletionUsage` 与该扩展类型交叉读取（结构化访问 `usage.prompt_tokens_details?.cache_write_tokens` 等）。

**不做**：不 module-augment `openai` SDK 类型（会污染全局、且这是 GHC 特有非 OpenAI 标准，混入 SDK 命名空间违背 SSOT——GHC 扩展的拥有方是本项目，不是 OpenAI SDK）。

---

## 5. canonical `UsageData` 扩形与提取（G1/G2，fix-forward）

### 5.1 `UsageData` 扩形（blob-only）

`src/lib/history/types.ts` `UsageData` 扩为（全部可选、非零/非空才挂，沿用现有 `if cached else {}` 风格）：

- `cache_creation_input_tokens?`（**已存在**）← 承接 cache_write。
- `input_tokens_details?: { text?, audio?, image?, video? }`（新）。
- `output_tokens_details` 从 `{ reasoning_tokens }` 扩为 `{ reasoning_tokens?, text?, audio?, image?, video?, accepted_prediction_tokens?, rejected_prediction_tokens? }`（`reasoning_tokens` 转可选，与既有非零才挂一致；消费者已用 `?.reasoning_tokens ?? 0`）。

这些新字段**只进压缩 usage blob**（`upstreamResponse.usage` / `OutboundResponseData.usage`），**不加 SQLite 列、不改 schema**。SQL 聚合仍只用现有 5 列。

### 5.2 提取 + 累积

- `src/lib/request/usage-normalize.ts` `usageFromTotalInput`：新增 `cacheCreation`（来自 cache_write）入参 + 一个 details 直通包（把模态/prediction 明细原样挂上，非零/非空才挂）。净公式按 §3 PoC 结论。
- 4 个非流式提取点：`src/routes/chat-completions/handler-v4.ts:256`、`src/routes/responses/handler-v4.ts:229`、`src/routes/gemini/handler-v4.ts:216`、`src/routes/responses/ws.ts:365`——读 cache_write + 模态/prediction 明细传入。
- 2 个 stream accumulator：`src/lib/openai/stream-accumulator.ts`、`src/lib/openai/responses-stream-accumulator.ts`——新增字段累积（cache_write + 模态 + prediction），终帧 usage 到达时读取（现有 cachedTokens/reasoningTokens 同址）。
- `src/types/api/openai-responses.ts:207` `ResponsesUsage.input_tokens_details` 对称加 cache_write（若 GHC Responses 也发；PoC 顺带确认）。

---

## 6. 历史 backfill（G3）

新 leaf `src/lib/history/sqlite/cache-write-backfill.ts`，遵循 history-backfill skill 铁律：

- **幂等标记列**：新增 `cache_write_backfilled INTEGER NOT NULL DEFAULT 0`（Umzug 迁移，hybrid forward-runner，只追 001+）。
- **靶向**：只扫 OpenAI 家族行（endpoint ∈ `openai-chat-completions`/`openai-responses`/`gemini-generate-content`）且标记=0；**精确解压** usage blob（非 `SELECT *`——4.2G 库 `SELECT *` 曾卡 3m53s），从原始 `cache_write_tokens` 重导出。
- **双写**：`cache_creation` 列 + usage blob 内 `cache_creation_input_tokens`（防 list/detail 分叉），并按 §3 PoC 结论重算净 `input_tokens`（列 + blob 双写）。
- **可恢复骨架**：`(started_at,id)` keyset 续跑、协作 stop 匹配 shutdown phase、非阻塞分批、never-throw、history_meta version 守卫。
- **等价性 oracle**：backfill 后 `input + cache_read + cache_creation` 应等于原始 `prompt_tokens`（子集情形）；dedup-ratio tripwire 防异常。
- 接线进 `src/lib/state.ts`，与既有 `usage-normalize-backfill` 并列（同类先例）。

---

## 7. 出向转发（G5，richest-data-flow）

`src/lib/openai/translate/responses-to-cc.ts:98` 及流式版 `responses-to-cc-stream.ts:197` 等出向翻译器：目标是 OpenAI/Anthropic 兼容格式、GHC 确会发 cache_write 时，一并转发 `prompt_tokens_details.cache_write_tokens`（对称既有 cached_tokens 转发）。**仅在目标格式有对应槽位处做**，无槽位不强塞。

---

## 8. 测试（TDD）

- **单元**：`usageFromTotalInput` 净公式（子集/additive 两分支）+ details 挂载（非零/非空才挂）；两 accumulator 提取 cache_write/模态/prediction；每 handler 提取点。
- **backfill**：幂等（跑两次结果相同）、靶向（只碰 OpenAI 家族行）、等价 oracle、resume（中断续跑）、标记列翻转、双写一致（列 == blob）。
- **PoC**：真实 cache-create 样本证子集/additive（§3）。
- **回归**：Anthropic 原生腿 usage 不受影响（不经 `usage-normalize`）。

---

## 9. 影响面与执行

**触及文件约 12 个**：3 类型（新 `ghc-usage.ts` + `types.ts` UsageData + `openai-responses.ts`）+ 1 normalize + 4 handler + 2 accumulator + 1 backfill leaf + 1 migration + `state.ts` 接线，加测试与出向翻译器。

**执行方式**：大特性走 spec→plan→执行三步；实现用隔离 worktree（`.worktrees/`）+ 独立分支，收尾 rebase+FF 回 master。分阶段：
- **Phase 0**：门控 PoC（净公式）。
- **Phase 1**：类型 + `UsageData` 扩形 + `usage-normalize` + 提取/累积（fix-forward）。
- **Phase 2**：历史 backfill + 迁移。
- **Phase 3**：出向转发 + 文档同步（`DESIGN.md`「类型架构」节 + 相关 topic 文档）。

---

## 10. 审查采纳/未采纳记录

（待 subagent 对抗审查后填充。）

**用户裁决（设计阶段）：**
- Tier 2 存储深度 = **blob-only**（扩 UsageData JSON，不加 SQLite 列、不 backfill 模态/prediction）。未采纳「Full 去规范化加列」（当前无 SQL 聚合消费者、字段多为 null，加列 + 7.8G backfill 属过早去规范化）与「折中：仅 prediction 加列」。
- 历史 backfill = **fix-forward + 补历史 backfill**（Tier 1 cache_write）。未采纳「仅 fix-forward」（长期成本聚合仍偏低，且原始 blob 已有数据可无损重导出，符合 long-term-wins/cost-fidelity）。
