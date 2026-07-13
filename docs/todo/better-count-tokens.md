# 任务交接:auto-truncate calibration 从成功请求学习 + history backfill

> **✅ 已实施（Phase 1，2026-07-11）**——本交接文档描述的任务已完成。权威见 spec [docs/spec/2026-07-11-size-aware-calibration-learning.md](../spec/2026-07-11-size-aware-calibration-learning.md) + plan [docs/plan/2026-07-11-size-aware-calibration-learning.md](../plan/2026-07-11-size-aware-calibration-learning.md) + [docs/DESIGN.md](../DESIGN.md)「活的架构现状」calibration 行。落地时经 subagent 复审对本交接的若干设计决策做了改进（成功腿走 observability `CalibrationSink` 而非 `onSuccessfulRequest`；factor 由单标量升为 **size-aware per-bucket**；EWMA 改 cumulative tok-weighted 滑动窗）。**下文保留原始交接叙事作认知底稿 / 决策史**，其中「设计决策」6 问的最终裁决见 spec §12。**pre-flight（决策 #6）为 Phase 2、尚未实施**。

## 背景与目标

copilot-api-js 的 auto-truncate 用本地 o200k(gpt-tokenizer)估算 Anthropic 请求的 token 数，
但 o200k 对 Claude 模型系统性低估，靠一个 per-model **calibration factor** 校正。
**当前 calibration 只从 400 token-limit 错误学习**（`onTokenLimitExceeded`），
而 400 只发生在**巨型超限请求**上——这是一个采样偏差。

**核心洞察（已实测证实）**：成功请求的 `usage` 里也有真实 input token 数，
是比稀有 400 丰富得多、且无采样偏差的学习信号。目标：
1. 让 calibration **也从成功请求学习**（用已存的真实 token 列）。
2. **backfill 现有 history**（3434 条 opus-4.8 completed）引导 factor 冷启动。

## 已确认的事实（不要重新质疑，都经实测/官方文档裁决）

### 真根因（重要，别再走弯路）
- factor ≈ 2x 的主因是 **o200k tokenizer 与 Claude 原生 tokenizer 的 vocabulary mismatch**，
  **不是**结构开销（我上个月一度误判为结构开销、做了 structured-counting 探索，被 subagent 实测证伪，已放弃）。
- **官方文档证实**（platform.claude.com/docs/en/docs/build-with-claude/token-counting）：
  "Claude Opus 4.7 and later use a newer tokenizer... approximately 30% more tokens than earlier models"。
  叠加 o200k vs Claude 本身的差异 → 复合成实测的 ~2.2x。
- **不存在 Claude 3/4 的本地 tokenizer 库**（`@anthropic-ai/tokenizer` 只到 Claude 1/2）。
- ~~**GHC API 没有 count_tokens 端点**（查 microsoft/vscode 最新源码零结果；官方 Copilot 客户端也是本地 tiktoken 估算）。~~ **⚠️ 此「事实」已被实测证伪（2026-07-13）**：源码 grep 只证明 vscode 扩展**内部**用本地 tokenizer，并不能证明 GHC **REST 上游**无此端点。实测 curl `POST https://api.githubcopilot.com/v1/messages/count_tokens`（复用 copilot token）**返回 `{"input_tokens":N}` HTTP 200**，支持边界=账号 live `/models` 目录、完全容忍真实 wire。**这是「实测 > 文档推断」的典型教训**——见 spec [docs/spec/2026-07-13-ghc-count-tokens-default.md](../spec/2026-07-13-ghc-count-tokens-default.md) + 探针 `exp/ghc-count-tokens-probe/`。**count_tokens 端点现已默认走 GHC 上游**（本地 o200k + factor 估算降级为「目录外模型 / 上游失败」的兜底）。本文档描述的 size-aware calibration 因此只服务于**兜底路径**的精度，不再是主路径。
- Anthropic count_tokens API（api.anthropic.com）曾作为 Claude 模型的直连渠道，**已退役**（对本代理而言 GHC count 更贴近真实消耗，且无需独立 key）。

### 实测数据（40 条随机 opus-4.8 completed，可复现）
- factor（= real_input / local_o200k_estimate）**不是常数**：
  min **1.236**、median **1.444**、mean **1.529**、max **2.174**、stddev **0.216**。
- **随请求规模上升**：小请求(9-46 msgs) ~1.28-1.32；大请求(300-670 msgs) ~1.8-2.2。
- tool-block **百分比**不相关（相关系数 ≈0，因几乎全是高 tool 密度）；是**绝对规模**驱动
  （大请求累积大量 code/tool 输出，o200k 对结构化/代码文本比 Claude tokenizer 稀疏）。
- reasoning_tokens 全为 0（这些样本），排除"不可见 reasoning token"干扰。
- 当前 `~/.local/share/copilot-api/learned-limits.json`：opus-4.8 **factor 2.202, samples 397**
  ——只从 400 学的、偏向巨型请求、系统性高估典型请求约 1.6x。

### 一个诚实的限制
factor 本质上**不是单个标量**（随组成在 1.24-2.17 变动）。所以：
- 从成功请求学一个全局标量 factor → 落在请求混合的加权均值（比"只学 2.2"准得多，但仍有损）。
- 真正 per-request 准确的只有**反应式 ratio**（每次 400 现算 `reportedCurrent/gptCount`），但只在失败时触发。
- 更理想是 **size/组成感知的 factor**（第二步，非首步）。

## 代码现状（一个月内被其他会话大改，务必先读现状）

### calibration 架构（都在）
- `src/lib/auto-truncate/engine.ts`：
  - `ModelLimits { tokenLimit, calibrationFactor, sampleCount, updatedAt }`
  - `learnedLimits` Map、`getLearnedLimits`、`calibrate(modelId, gptEstimate)`（× factor）
  - `updateCalibration(modelId, actualTokens, estimatedTokens)`：EWMA alpha=0.3，clamp [0.5, 3.0]
  - `onTokenLimitExceeded(...)`：**当前唯一学习入口，只从 400 学**
  - `LearnedLimitsFile { version, limits }`、`persistLimits`、`loadPersistedLimits`（持久化到 learned-limits.json）
- `src/lib/request/strategies/auto-truncate.ts`：反应式 strategy，
  `gptCount = await countTokens(currentPayload, model)`、
  `ratio = reportedCurrent / gptCount`（per-request，line ~140），
  `targetTokenLimit = limit × target_factor × gptCount / reportedCurrent`。
- `countTokens` 闭包接线在 `src/lib/anthropic/pipeline.ts`（`countTokens: (p, model) => countTotalTokens(p, model)`）。
- pre-check `checkNeedsCompactionAnthropic`（auto-truncate.ts）用 `calibrate()`，
  **但只被 count_tokens route + debug route 调用，不在主 /v1/messages 路径**（已确认）。
  ⚠️ 这意味着：若只改 learned factor 而不加主路径 pre-flight，对主路径截断无直接影响。
  完整价值需配合 pre-flight（见下"设计决策"）。

### token 计数
- `src/lib/anthropic/auto-truncate/token-counting.ts`：`countTotalTokens(payload, model)`、
  `countMessagesTokens`、`countPerMessageTokens`、`contentToText`（仍是拍平版，flat）。
  底层 `countTextTokens` 用 o200k（claude 模型 `capabilities.tokenizer='o200k_base'`）。

### history schema（大改成 content-addressed，用 zstd）
- blob 是 **zstd**（不是 gzip！用 `Bun.zstdDecompressSync(blob_gz)`）。
- `entries_v2` 有专门列：`input_tokens, cache_read, cache_creation, reasoning_tokens`（真实上游计数，现成）。
  **真实 prompt tokens = input_tokens + cache_read + cache_creation**。
- payload 在 `entry_stages` 表：`stage='client_request'`（inbound）有 messages/tools/system；
  `stage='upstream_response'`（per attempt）有 usage；`stage='request_group'` 是发往 GHC 的 **wire payload**。
- 内容寻址表 `msg_blob / req_msg / req_aux`。
- 读取重建：`src/lib/history/queries.ts:getEntry(id)`、`src/lib/history/sqlite/read.ts:getEntryById`。

## 设计决策（新会话需定，建议用 AskUserQuestion）

1. **学习入口**：新增 `onSuccessfulRequest(modelId, realTokens, localEstimate)`，
   在 `reqCtx.complete` 后调用，喂 `updateCalibration`。与 `onTokenLimitExceeded` 并列。
2. **用哪个 payload 估算**（关键精度点）：
   - inbound（client_request）：客户端原始，缺 preprocessTools 注入的 tool_search 等 → 与真实 wire 有偏差。
   - wire（request_group / outbound）：真实发送的，与 usage 口径一致，**更准**。
   - 实测探针用的是 inbound（简单），生产学习应优先 wire（handler 里有 wire payload）。
3. **单标量 vs 组成感知**：factor 随规模变（1.24-2.17）。
   首步建议单标量 + 从成功学（消除 400 偏差，已是大改善）；组成感知作第二步暂缓项。
4. **成功样本 vs 400 样本是否共用一个 factor**：
   400 是极端大请求（2.2），成功是全谱（1.3-2.2）。混入 EWMA 会把 factor 拉向请求混合均值。
   考虑：是否给成功样本单独 factor，或加权。需权衡"pre-check 用在什么规模的请求上"。
5. **backfill**：从 3434 条 history 引导。用 skill `history-backfill` 的模式
   （可恢复骨架、history_meta version 守卫、(started_at,id) keyset 续跑、协作 stop、非阻塞分批、never-throw）。
   每条算 factor 喂 EWMA。注意 backfill 用 history 里的 payload（client_request 或 request_group）。
6. **是否加主路径 pre-flight**（决定这整件事的价值大小）：
   当前主路径是"发→400→反应式截断"，learned factor 不在主路径生效。
   若加 pre-flight（发送前用 learned factor 判超限、预截断），才能省掉那次必然失败的 400 往返（几十秒）。
   这是用户几轮前选过的"pre-flight + 反应式兑底"方向。是否纳入本次范围需用户定。

## 工作纪律（本项目 + 用户规则）

- **no-auto-server**：不运行 `bun run dev/start`、不 kill 本项目实例；可跑 `bun run typecheck`/`lint:all`/`bun test`。
- **实测优先**：探针裁决而非推断。history DB 只读 `new Database(path, { readonly: true })`。
  探针复用项目函数（countTotalTokens 等），别手搓 tokenizer。
- **subagent review**：设计方案实施前过对抗式 subagent 审查（本项目纪律，用户会要求）；
  实现后再派 subagent 核验。审查 prompt 里显式写裁判轴（长远正确 + 完整），亲自复核 reviewer 的裁决性断言。
- **plan-first**：复杂改动先进 plan mode 写方案（`docs/plan/` 或 `~/.claude/plans/`），过 review 再实现。
- **TDD**：先写测试。测试隔离用 `autoRestoreState()` / `resetAllLimitsForTesting()`，
  never 碰真实 $HOME（skill `test-isolation`）。calibration 持久化改动看 skill `persistence-async-invariants`。
- **conventional commits**、细粒度每阶段提交、显式 pathspec、无模型署名。
- 文档归属：spec→`docs/spec/`、plan→`docs/plan/`、ADR→`docs/decisions/`、
  暂缓项→`docs/todo/deferred-backlog.md`。token 计数认知可归 `docs/sync-ghc-api/`。

## 复现探针（验证起点）

```bash
# 真实 factor 分布（成功请求）
cd /home/xp/src/copilot-api-js
bun -e "
const { Database } = require('bun:sqlite')
const db = new Database(process.env.HOME + '/.local/share/copilot-api/history.db', { readonly: true })
const { countTotalTokens } = await import('./src/lib/anthropic/auto-truncate/token-counting.ts')
const model = { id:'claude-opus-4-8', capabilities:{ tokenizer:'o200k_base' }}
const rows = db.query(\"SELECT id, input_tokens, cache_read, cache_creation, message_count FROM entries_v2 WHERE model='claude-opus-4.8' AND status='completed' AND input_tokens IS NOT NULL AND message_count>5 ORDER BY RANDOM() LIMIT 40\").all()
for (const r of rows) {
  const real=(r.input_tokens||0)+(r.cache_read||0)+(r.cache_creation||0); if(real<1000)continue
  const cr=db.query(\"SELECT blob_gz FROM entry_stages WHERE entry_id=? AND stage='client_request' LIMIT 1\").get(r.id); if(!cr)continue
  const p=JSON.parse(Buffer.from(Bun.zstdDecompressSync(cr.blob_gz)).toString())
  const est=await countTotalTokens(p, model); if(est<500)continue
  console.log('msgs='+r.message_count, 'real='+real, 'est='+est, 'factor='+(real/est).toFixed(3))
}
" 2>&1 | grep -v 'ℹ\|WARN'
```

## 第一步建议

读现状：engine.ts calibration、strategy、pipeline 接线、handler 主路径、token-counting、history read。
进 plan mode，用 AskUserQuestion 定上面 6 个决策（尤其 #2 payload、#6 是否加 pre-flight——这决定价值）。
写方案 → subagent 对抗审查 → 实现（含 backfill）→ subagent 核验 → 测试 → 提交。

---

这个交接连同"真根因 + 现架构分析 + 实测数据" 同时被落到 `docs/sync-ghc-api/token-counting.md` 完整记录:
- 真根因(tokenizer vocabulary mismatch,非结构开销)+ 官方文档证据(opus-4.7+ 换了更密的 tokenizer,+30%)
- 穷举所有方案(无本地 Claude tokenizer、无 GHC count_tokens 端点、count_tokens API 的代价)
- 记录了那段"结构化"弯路(被实测证伪,避免后续重走)
- 现有 "o200k + calibration + 反应式 ratio" 架构为何正确
- 待改进:从成功请求学习的实测数据(factor 1.24-2.17 随规模变、当前 400-only 采样偏差、3434 条可 backfill)+ 实现要点
